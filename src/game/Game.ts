import * as THREE from 'three';
import { Engine } from '../core/Engine';
import { Input } from '../core/Input';
import { AudioManager } from '../core/AudioManager';
import { VoxelWorld, BLOCK } from '../world/VoxelWorld';
import { buildTrenchArena, type MapLayout } from '../world/MapBuilder';
import { Sky } from '../world/Sky';
import { PropsKit } from '../world/PropsKit';
import { Pickups } from '../entities/Pickups';
import { PlayerController } from '../entities/PlayerController';
import { WeaponSystem, type ShotRay } from '../entities/WeaponSystem';
import { Bot, type TargetInfo } from '../entities/Bot';
import { Grenade } from '../entities/Grenade';
import { VfxSystem, type SurfaceKind } from '../fx/VfxSystem';
import { CameraFx } from '../fx/CameraFx';
import { Match } from './Match';
import { Hud } from '../ui/Hud';
import { Screens } from '../ui/Screens';
import {
  BOTS,
  BOT_ARCHETYPES,
  BOT_NAMES,
  GRENADE,
  PLAYER,
  WORLD,
  clamp,
  lerp,
  rand,
  type WeaponSpec,
} from './constants';
import { loadTankModel, loadWeaponModel, importDiagnostics } from '../assets/ImportedAssets';

type GameState = 'menu' | 'playing' | 'dead' | 'ended';

const PLAYER_ID = 'player';

export class Game {
  private engine: Engine;
  private input: Input;
  private audio = new AudioManager();
  private world = new VoxelWorld();
  private layout: MapLayout;
  private sky: Sky;
  private props: PropsKit;
  private pickups: Pickups;
  private player: PlayerController;
  private weapons: WeaponSystem;
  private bots: Bot[] = [];
  private grenades: Grenade[] = [];
  private vfx: VfxSystem;
  private cameraFx = new CameraFx();
  private match: Match;
  private hud: Hud;
  private screens: Screens;
  private state: GameState = 'menu';
  private respawnTimer = 0;
  private menuCamAngle = 0;
  private testMode = false;
  private announcedLead = false;
  private spreadPx = 12;

  constructor(canvas: HTMLCanvasElement) {
    this.testMode = new URLSearchParams(location.search).has('test');
    this.engine = new Engine(canvas);
    this.input = new Input(canvas);
    this.input.testMode = this.testMode;

    // --- world ---
    this.layout = buildTrenchArena(this.world);
    this.world.buildAll();
    this.engine.scene.add(this.world.group);
    this.sky = new Sky(this.engine.scene);
    this.props = new PropsKit(this.world.atlas, this.layout);
    this.engine.scene.add(this.props.group);
    this.pickups = new Pickups(this.engine.scene, this.world.atlas, this.layout.pickupSpots);
    this.vfx = new VfxSystem(
      this.engine.scene,
      new THREE.Vector3(WORLD.sizeX / 2, 10, WORLD.sizeZ / 2),
    );
    for (const s of this.layout.smokeColumns) this.vfx.addSmokeColumn(s);

    // --- player + weapons ---
    this.player = new PlayerController(this.world, {
      onFootstep: (sprinting) =>
        this.audio.play('footstep', { volume: sprinting ? 0.75 : 0.5, pitchJitter: 0.12 }),
      onLand: (impact) => {
        this.audio.play('land', { volume: clamp(impact / 18, 0.3, 1) });
        this.cameraFx.addLanding(impact);
      },
      onJump: () => this.audio.play('jump', { volume: 0.45 }),
    });
    this.engine.scene.add(this.engine.camera);
    this.weapons = new WeaponSystem(this.engine.camera, {
      onFire: (spec, rays, muzzle) => this.resolvePlayerShot(spec, rays, muzzle),
      onDryFire: () => this.audio.play('dryFire', { volume: 0.6 }),
      onReloadStart: () => {
        this.hud.setReloading(true);
        this.audio.play('reload', { volume: 0.8 });
      },
      onReloadEnd: () => this.hud.setReloading(false),
      onSwitch: () => this.audio.play('uiClick', { volume: 0.4, pitchJitter: 0.1 }),
      onGrenadeThrow: (origin, dir) => {
        const g = new Grenade(origin, dir, PLAYER_ID);
        this.grenades.push(g);
        this.engine.scene.add(g.mesh);
        this.audio.play('grenadeThrow', { volume: 0.7 });
      },
    });

    // --- match ---
    this.match = new Match({
      onKillFeed: (ev) => this.hud.addKillFeed(ev),
      onPlayerScore: (points, reason) => {
        this.hud.showScorePop(points, reason);
        this.hud.setPoints(
          Match.walletBalance() + this.match.pointsEarned,
          this.match.pointsEarned,
        );
        if (!this.announcedLead && this.match.playerPlacement() === 1) {
          this.announcedLead = true;
          this.audio.play('voOnTop', { volume: 0.9 });
        }
      },
      onStreak: (streak) => {
        if (streak === 2) {
          this.hud.showStreakBanner('DOUBLE KILL');
          this.audio.play('voDoubleKill', { volume: 0.95 });
        } else if (streak === 3) {
          this.hud.showStreakBanner('KILLING SPREE');
          this.audio.play('voKillingSpree', { volume: 0.95 });
        } else if (streak > 3) {
          this.hud.showStreakBanner(`RAMPAGE x${streak}`);
        }
      },
      onMatchEnd: () => this.endMatch(),
    });

    this.hud = new Hud();
    this.screens = new Screens({
      onDeploy: () => this.deploy(),
      onResume: () => this.resume(),
      onQuitToMenu: () => this.quitToMenu(),
      onPlayAgain: () => {
        this.quitToMenu();
        this.deploy();
      },
      onSensitivity: (v) => (this.input.sensitivity = v),
      onVolume: (v) => this.audio.setVolume(v),
      onMute: (m) => this.audio.setMuted(m),
      onUiClick: () => {
        this.audio.unlock();
        this.audio.play('uiClick', { volume: 0.5 });
      },
    });

    // --- bots ---
    this.match.register(PLAYER_ID, 'YOU', true, 'OPERATOR');
    const archetypeOrder = ['rifleman', 'shock', 'scout', 'rifleman', 'scout', 'shock'] as const;
    for (let i = 0; i < BOTS.count; i++) {
      const archetype = BOT_ARCHETYPES[archetypeOrder[i % archetypeOrder.length]];
      const bot = new Bot(
        `bot-${i}`,
        BOT_NAMES[i % BOT_NAMES.length],
        archetype,
        this.engine.scene,
      );
      bot.spawnAt(this.layout.spawns[(i + 1) % this.layout.spawns.length].clone());
      this.bots.push(bot);
      this.match.register(bot.id, bot.name, false, archetype.label);
    }

    this.input.onPause = () => {
      if (this.state === 'playing') this.screens.show('pause');
    };

    this.loadImportedAssets();

    this.engine.setFrameHandler((dt, elapsed) => this.update(dt, elapsed));
    this.screens.show('landing');
    this.hud.setVisible(false);
    this.weapons.setRigVisible(false);

    if (this.testMode) {
      window.setTimeout(() => this.deploy(), 300);
      // deterministic look control for automated QA
      (window as unknown as Record<string, unknown>).__TEST_LOOK__ = (
        yaw: number,
        pitch: number,
      ) => {
        this.player.yaw = yaw;
        this.player.pitch = pitch;
      };
      (window as unknown as Record<string, unknown>).__TEST_SET_TIME__ = (t: number) => {
        this.match.timeLeft = t;
      };
      (window as unknown as Record<string, unknown>).__TEST_TELEPORT_TO_BOT__ = (dist = 5) => {
        for (const bot of this.bots.filter((b) => b.alive)) {
          for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const px = bot.position.x + Math.cos(angle) * dist;
            const pz = bot.position.z + Math.sin(angle) * dist;
            const py = this.world.highestSolidY(px, pz) + 1;
            const eye = new THREE.Vector3(px, py + PLAYER.eyeHeight, pz);
            const chest = bot.chestPosition;
            const to = chest.clone().sub(eye);
            const d = to.length();
            if (this.world.raycast(eye, to.clone().normalize(), d - 0.4)) continue;
            this.player.position.set(px, py, pz);
            this.player.velocity.set(0, 0, 0);
            this.player.yaw = Math.atan2(-to.x, -to.z);
            this.player.pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
            return true;
          }
        }
        return false;
      };
      (window as unknown as Record<string, unknown>).__TEST_TRACE_SHOT__ = () => {
        const eye = this.engine.camera.getWorldPosition(new THREE.Vector3());
        const dir = this.player.forwardDir;
        const voxelHit = this.world.raycast(eye, dir, 90);
        const bots = this.bots.map((b) => {
          const p = b.intersectRay(eye, dir, 999);
          return {
            id: b.id,
            alive: b.alive,
            dist: Number(b.position.distanceTo(this.player.position).toFixed(2)),
            rayHit: p ? Number(p.distanceTo(eye).toFixed(2)) : null,
            pos: { x: Number(b.position.x.toFixed(1)), y: Number(b.position.y.toFixed(1)), z: Number(b.position.z.toFixed(1)) },
          };
        });
        return {
          eye: { x: Number(eye.x.toFixed(1)), y: Number(eye.y.toFixed(1)), z: Number(eye.z.toFixed(1)) },
          dir: { x: Number(dir.x.toFixed(2)), y: Number(dir.y.toFixed(2)), z: Number(dir.z.toFixed(2)) },
          voxelHitDist: voxelHit ? Number(voxelHit.distance.toFixed(2)) : null,
          voxelHitBlock: voxelHit?.block ?? null,
          bots,
        };
      };
      (window as unknown as Record<string, unknown>).__TEST_AIM_AT_BOT__ = () => {
        const eye = this.player.eyePosition;
        const candidates = this.bots
          .filter((b) => b.alive)
          .sort(
            (a, b) => a.position.distanceTo(this.player.position) - b.position.distanceTo(this.player.position),
          );
        for (const bot of candidates) {
          const chest = bot.chestPosition;
          const to = chest.clone().sub(eye);
          const dist = to.length();
          const dir = to.clone().normalize();
          const blocked = this.world.raycast(eye, dir, dist - 0.4);
          if (blocked) continue;
          this.player.yaw = Math.atan2(-to.x, -to.z);
          this.player.pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
          return true;
        }
        return false;
      };
    }
  }

  private loadImportedAssets(): void {
    // each asset swaps in independently the moment it finishes loading
    void loadWeaponModel('/models/rifle.glb', 'rifle', 0.52).then((rifle) => {
      if (rifle) {
        rifle.rotation.set(0.02, -0.06, 0); // classic FPS cant
        this.weapons.setImportedModel('rifle', rifle);
      }
    });
    void loadWeaponModel('/models/shotgun.glb', 'scattergun', 0.5).then((scattergun) => {
      if (scattergun) {
        scattergun.rotation.set(0.02, -0.06, 0);
        this.weapons.setImportedModel('scattergun', scattergun);
      }
    });
    void loadTankModel('/models/tank.glb', 5.2).then((tank) => {
      if (tank) {
        tank.position.copy(this.layout.tank.position);
        tank.rotation.y = this.layout.tank.rotationY;
        this.engine.scene.add(tank);
      } else {
        this.addFallbackTank();
      }
    });
  }

  private addFallbackTank(): void {
    // voxel wreck silhouette so the crater centerpiece never reads empty
    const g = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x4c4a38,
      roughness: 0.85,
      metalness: 0.25,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2e2c22, roughness: 0.9 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.3, 2.6), hullMat);
    hull.position.y = 0.85;
    const turret = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 1.7), hullMat);
    turret.position.set(-0.3, 1.8, 0.1);
    turret.rotation.z = 0.16;
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.22, 0.22), darkMat);
    barrel.position.set(1.4, 1.95, 0.1);
    barrel.rotation.z = -0.12;
    const trackL = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.9, 0.5), darkMat);
    trackL.position.set(0, 0.45, 1.35);
    const trackR = trackL.clone();
    trackR.position.z = -1.35;
    g.add(hull, turret, barrel, trackL, trackR);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    g.position.copy(this.layout.tank.position);
    g.rotation.y = this.layout.tank.rotationY;
    this.engine.scene.add(g);
  }

  start(): void {
    this.engine.start();
  }

  // ------------------------------------------------------------------
  // state transitions
  // ------------------------------------------------------------------

  private deploy(): void {
    this.audio.unlock();
    this.audio.startAmbience();
    if (this.state === 'menu' || this.state === 'ended') {
      this.match.start();
      this.announcedLead = false;
      this.weapons.reset();
      for (let i = 0; i < this.bots.length; i++) {
        this.bots[i].spawnAt(this.layout.spawns[(i + 1) % this.layout.spawns.length].clone());
      }
      this.hud.reset();
      this.audio.play('voWelcome', { volume: 0.9 });
    }
    this.spawnPlayer();
    this.state = 'playing';
    this.weapons.setRigVisible(true);
    this.screens.show(null);
    this.hud.setVisible(true);
    this.hud.setPoints(Match.walletBalance() + this.match.pointsEarned, this.match.pointsEarned);
    this.audio.play('uiDeploy', { volume: 0.8 });
    this.input.requestLock();
  }

  private spawnPlayer(): void {
    // pick the spawn farthest from living bots
    let best = this.layout.spawns[0];
    let bestScore = -1;
    for (const s of this.layout.spawns) {
      let minD = Infinity;
      for (const b of this.bots) {
        if (b.alive) minD = Math.min(minD, s.distanceTo(b.position));
      }
      if (minD > bestScore) {
        bestScore = minD;
        best = s;
      }
    }
    // face the arena center
    const yaw = Math.atan2(-(WORLD.sizeX / 2 - best.x), -(WORLD.sizeZ / 2 - best.z));
    this.player.respawnAt(best.clone(), -yaw + Math.PI);
    const toCenter = new THREE.Vector3(WORLD.sizeX / 2 - best.x, 0, WORLD.sizeZ / 2 - best.z);
    this.player.yaw = Math.atan2(-toCenter.x, -toCenter.z);
  }

  private resume(): void {
    if (this.state === 'playing') {
      this.screens.show(null);
      this.input.requestLock();
    }
  }

  private quitToMenu(): void {
    this.state = 'menu';
    this.weapons.setRigVisible(false);
    this.input.releaseLock();
    this.screens.show('landing');
    this.hud.setVisible(false);
    this.audio.stopAmbience();
  }

  private endMatch(): void {
    this.state = 'ended';
    this.weapons.setRigVisible(false);
    this.input.releaseLock();
    Match.addToWallet(this.match.pointsEarned);
    this.screens.setEndResults(
      this.match.standings(),
      this.match.playerPlacement(),
      this.match.pointsEarned,
      this.match.creatorCut(),
    );
    this.screens.show('end');
    this.hud.setVisible(false);
    this.audio.play('voMatchOver', { volume: 1 });
  }

  private onPlayerDeath(killerName: string): void {
    this.state = 'dead';
    this.respawnTimer = 3;
    this.audio.play('playerDeath', { volume: 0.9 });
    this.screens.setDeathInfo(killerName);
    this.screens.show('death');
    this.cameraFx.addTrauma(0.8);
  }

  // ------------------------------------------------------------------
  // combat resolution
  // ------------------------------------------------------------------

  private surfaceForBlock(block: number): SurfaceKind {
    switch (block) {
      case BLOCK.stone:
      case BLOCK.concrete:
      case BLOCK.brick:
        return 'stone';
      case BLOCK.metal:
        return 'metal';
      case BLOCK.plank:
      case BLOCK.duckboard:
        return 'wood';
      case BLOCK.sandbag:
        return 'sand';
      default:
        return 'dirt';
    }
  }

  private resolvePlayerShot(spec: WeaponSpec, rays: ShotRay[], muzzleWorld: THREE.Vector3): void {
    // gameplay rays originate from the player's eye, decoupled from camera shake
    const eye = this.player.eyePosition;
    this.audio.play(spec.id === 'rifle' ? 'rifleShot' : 'scattergunShot', {
      volume: 0.85,
      pitchJitter: 0.06,
    });
    this.vfx.muzzleFlash(muzzleWorld, spec.id === 'scattergun');
    this.cameraFx.addRecoil(this.weapons.consumeRecoilKick());
    this.cameraFx.addTrauma(spec.id === 'scattergun' ? 0.22 : 0.08);
    this.spreadPx = Math.min(this.spreadPx + (spec.id === 'scattergun' ? 14 : 5), 40);

    let anyHit = false;
    let anyHead = false;
    let killed = false;

    for (let i = 0; i < rays.length; i++) {
      const dir = rays[i].dir;
      const voxelHit = this.world.raycast(eye, dir, spec.range);
      const voxelDist = voxelHit ? voxelHit.distance : spec.range;

      let hitBot: Bot | null = null;
      let hitPoint: THREE.Vector3 | null = null;
      let hitDist = voxelDist;
      for (const bot of this.bots) {
        const p = bot.intersectRay(eye, dir, hitDist);
        if (p) {
          const d = p.distanceTo(eye);
          if (d < hitDist) {
            hitDist = d;
            hitBot = bot;
            hitPoint = p;
          }
        }
      }

      const tracerEnd = hitPoint ?? voxelHit?.point ?? eye.clone().addScaledVector(dir, spec.range);
      if (i % spec.tracerEvery === 0) this.vfx.tracer(muzzleWorld, tracerEnd);

      if (hitBot && hitPoint) {
        anyHit = true;
        const head = hitBot.isHeadHit(hitPoint);
        anyHead = anyHead || head;
        this.vfx.impact(hitPoint, dir.clone().negate(), 'flesh');
        const dmg = spec.damage * (head ? spec.headshotMul : 1);
        if (hitBot.takeDamage(dmg, false)) {
          killed = true;
          this.onBotKilled(hitBot, PLAYER_ID, head);
        }
      } else if (voxelHit) {
        this.vfx.impact(voxelHit.point, voxelHit.normal, this.surfaceForBlock(voxelHit.block));
      }
    }

    if (anyHit) {
      this.hud.hitmarker(anyHead);
      this.audio.play(anyHead ? 'headshot' : 'hitmarker', { volume: 0.65 });
    }
    if (killed) this.audio.play('killConfirm', { volume: 0.85 });
    if (this.testMode) {
      const w = window as unknown as Record<string, unknown>;
      w.__TEST_SHOTS__ = ((w.__TEST_SHOTS__ as number) ?? 0) + 1;
      if (anyHit) w.__TEST_HITS__ = ((w.__TEST_HITS__ as number) ?? 0) + 1;
      const d0 = rays[0].dir;
      const vh = this.world.raycast(eye, d0, spec.range);
      const botHits = this.bots
        .map((b) => {
          const p = b.intersectRay(eye, d0, 999);
          return p ? Number(p.distanceTo(eye).toFixed(2)) : null;
        })
        .filter((x) => x !== null);
      w.__TEST_LAST_SHOT__ = {
        eye: { x: Number(eye.x.toFixed(2)), y: Number(eye.y.toFixed(2)), z: Number(eye.z.toFixed(2)) },
        dir: { x: Number(d0.x.toFixed(3)), y: Number(d0.y.toFixed(3)), z: Number(d0.z.toFixed(3)) },
        voxelDist: vh ? Number(vh.distance.toFixed(2)) : null,
        botRayHits: botHits,
        anyHit,
      };
    }
  }

  private onBotKilled(bot: Bot, killerId: string, headshot: boolean): void {
    this.vfx.bodyBurst(bot.chestPosition, bot.archetype.cloth);
    this.match.recordKill(killerId, bot.id, headshot);
  }

  private botFireShot(bot: Bot, origin: THREE.Vector3, dir: THREE.Vector3): void {
    const eye = this.engine.camera.getWorldPosition(new THREE.Vector3());
    const distToPlayer = origin.distanceTo(eye);
    this.audio.play(bot.archetype.id === 'shock' ? 'scattergunShot' : 'rifleShot', {
      volume: 0.9,
      pitchJitter: 0.1,
      distance: distToPlayer,
    });
    this.vfx.muzzleFlash(origin, bot.archetype.id === 'shock');

    const range = bot.archetype.fireRange + 12;
    const voxelHit = this.world.raycast(origin, dir, range);
    let maxDist = voxelHit ? voxelHit.distance : range;
    let hitPlayer = false;
    let hitBot: Bot | null = null;
    let hitPoint: THREE.Vector3 | null = null;

    if (this.player.alive && this.state === 'playing') {
      const pMin = new THREE.Vector3(
        this.player.position.x - PLAYER.radius,
        this.player.position.y,
        this.player.position.z - PLAYER.radius,
      );
      const pMax = new THREE.Vector3(
        this.player.position.x + PLAYER.radius,
        this.player.position.y + PLAYER.height,
        this.player.position.z + PLAYER.radius,
      );
      const ray = new THREE.Ray(origin, dir);
      const p = new THREE.Vector3();
      if (ray.intersectBox(new THREE.Box3(pMin, pMax), p)) {
        const d = p.distanceTo(origin);
        if (d < maxDist) {
          maxDist = d;
          hitPlayer = true;
          hitPoint = p.clone();
        }
      }
    }

    for (const other of this.bots) {
      if (other === bot) continue;
      const p = other.intersectRay(origin, dir, maxDist);
      if (p) {
        const d = p.distanceTo(origin);
        if (d < maxDist) {
          maxDist = d;
          hitBot = other;
          hitPoint = p;
          hitPlayer = false;
        }
      }
    }

    const tracerEnd = hitPoint ?? voxelHit?.point ?? origin.clone().addScaledVector(dir, range);
    this.vfx.tracer(origin, tracerEnd);

    if (hitPlayer && hitPoint) {
      this.player.takeDamage(bot.archetype.damage);
      this.hud.setHealth(this.player.health, PLAYER.maxHealth);
      this.hud.damageFlash();
      this.cameraFx.addDamageRoll();
      this.cameraFx.addTrauma(0.18);
      this.audio.play('damageGrunt', { volume: 0.55, pitchJitter: 0.15 });
      if (!this.player.alive) {
        this.match.recordKill(bot.id, PLAYER_ID, false);
        this.onPlayerDeath(bot.name);
      }
    } else if (hitBot && hitPoint) {
      this.vfx.impact(hitPoint, dir.clone().negate(), 'flesh');
      if (hitBot.takeDamage(bot.archetype.damage, false)) {
        this.onBotKilled(hitBot, bot.id, false);
      }
    } else if (voxelHit) {
      this.vfx.impact(voxelHit.point, voxelHit.normal, this.surfaceForBlock(voxelHit.block));
    }
  }

  private explodeGrenade(g: Grenade): void {
    this.vfx.explosion(g.position);
    this.audio.play('explosion', {
      volume: 1,
      distance: g.position.distanceTo(this.player.eyePosition),
      maxDistance: 70,
    });
    this.world.carveCrater(g.position, 2.6);
    this.cameraFx.addTrauma(clamp(1.4 - g.position.distanceTo(this.player.position) / 18, 0, 0.85));

    const damageAt = (targetPos: THREE.Vector3): number => {
      const d = targetPos.distanceTo(g.position);
      if (d > GRENADE.radius) return 0;
      return GRENADE.maxDamage * (1 - d / GRENADE.radius);
    };

    if (this.player.alive && this.state === 'playing') {
      const dmg = damageAt(this.player.position.clone().add(new THREE.Vector3(0, 0.9, 0)));
      if (dmg > 0) {
        this.player.takeDamage(dmg);
        this.hud.setHealth(this.player.health, PLAYER.maxHealth);
        this.hud.damageFlash();
        if (!this.player.alive) {
          this.match.recordKill(g.ownerId, PLAYER_ID, false);
          this.onPlayerDeath(g.ownerId === PLAYER_ID ? 'your own grenade' : g.ownerId);
        }
      }
    }
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const dmg = damageAt(bot.chestPosition);
      if (dmg > 0 && bot.takeDamage(dmg, false)) {
        this.onBotKilled(bot, g.ownerId, false);
      }
    }
  }

  // ------------------------------------------------------------------
  // per-frame update
  // ------------------------------------------------------------------

  private update(dt: number, elapsed: number): void {
    const intents = this.input.consume();

    if (this.state === 'menu' || this.state === 'ended') {
      this.updateMenuCamera(dt);
    } else {
      this.updatePlaying(dt, intents, elapsed);
    }

    this.sky.update(dt);
    this.vfx.update(dt, elapsed);

    const paused = this.screens.current === 'pause';
    if (!paused) {
      const botCtx = {
        world: this.world,
        targets: this.collectTargets(),
        hasLineOfSight: (from: THREE.Vector3, to: THREE.Vector3) => {
          const dir = to.clone().sub(from);
          const dist = dir.length();
          dir.normalize();
          return this.world.raycast(from, dir, dist) === null;
        },
        fireShot: (bot: Bot, origin: THREE.Vector3, dir: THREE.Vector3) =>
          this.botFireShot(bot, origin, dir),
        waypoints: this.layout.waypoints,
      };
      for (const bot of this.bots) {
        bot.update(dt, botCtx);
        if (!bot.alive) {
          bot.respawnTimer -= dt;
          if (bot.respawnTimer <= 0 && this.match.running) {
            bot.spawnAt(this.layout.spawns[Math.floor(rand(0, this.layout.spawns.length))].clone());
          }
        }
      }

      for (let i = this.grenades.length - 1; i >= 0; i--) {
        const g = this.grenades[i];
        if (g.update(dt, this.world)) {
          this.explodeGrenade(g);
          this.engine.scene.remove(g.mesh);
          this.grenades.splice(i, 1);
        }
      }

      if (this.state === 'playing' || this.state === 'dead') this.match.update(dt);
    }

    this.publishDiagnostics();
  }

  private updateMenuCamera(dt: number): void {
    this.menuCamAngle += dt * 0.06;
    const cx = WORLD.sizeX / 2;
    const cz = WORLD.sizeZ / 2;
    const r = 44;
    const cam = this.engine.camera;
    cam.position.set(
      cx + Math.cos(this.menuCamAngle) * r,
      24 + Math.sin(this.menuCamAngle * 0.6) * 3,
      cz + Math.sin(this.menuCamAngle) * r,
    );
    cam.rotation.order = 'YXZ';
    cam.lookAt(cx, 7, cz);
    if (cam.fov !== 58) {
      cam.fov = 58;
      cam.updateProjectionMatrix();
    }
  }

  private updatePlaying(
    dt: number,
    intents: ReturnType<Input['consume']>,
    elapsed: number,
  ): void {
    if (this.state === 'dead') {
      this.respawnTimer -= dt;
      this.screens.setDeathCountdown(Math.max(0, this.respawnTimer));
      // corpse-cam sink + tilt
      this.engine.camera.position.y = Math.max(
        this.engine.camera.position.y - dt * 0.6,
        this.player.position.y + 0.4,
      );
      this.engine.camera.rotation.z = lerp(this.engine.camera.rotation.z, 0.35, dt * 2);
      if (this.respawnTimer <= 0 && this.testMode) this.deploy();
      return;
    }
    if (this.state !== 'playing') return;
    if (this.screens.current === 'pause') return;

    const look = this.input.consumeLook();
    this.player.applyLook(look.yaw, look.pitch);
    this.player.update(dt, intents, this.weapons.adsBlend > 0.5);

    const cam = this.engine.camera;
    const eye = this.player.eyePosition;
    cam.position.copy(eye);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(0, this.player.yaw, 0);
    const recoilPitch = this.cameraFx.apply(cam, dt, elapsed);
    cam.rotation.x = this.player.pitch + recoilPitch;

    this.weapons.update(
      dt,
      intents,
      look,
      this.player.bobAmount,
      this.player.forwardDir,
      eye,
      this.player.alive,
    );

    const moveSpread = this.player.moving ? (this.player.sprinting ? 16 : 8) : 0;
    this.spreadPx = lerp(this.spreadPx, 8 + moveSpread, 1 - Math.exp(-8 * dt));
    this.hud.setCrosshairSpread(this.spreadPx, this.weapons.adsBlend);

    const got = this.pickups.update(dt, elapsed, this.player.position);
    if (got === 'medkit') {
      this.player.heal(50);
      this.hud.showToast('FIELD MEDKIT +50');
      this.audio.play('pickupHealth', { volume: 0.7 });
    } else if (got === 'ammo') {
      this.weapons.addReserve('rifle', 60);
      this.weapons.addReserve('scattergun', 12);
      this.hud.showToast('AMMO CACHE RESTOCKED');
      this.audio.play('pickupAmmo', { volume: 0.7 });
    }

    const ammo = this.weapons.ammoState();
    this.hud.setHealth(this.player.health, PLAYER.maxHealth);
    this.hud.setAmmo(
      ammo.mag,
      ammo.reserve,
      this.weapons.currentSpec.name,
      1 - this.weapons.grenadeCooldown / GRENADE.cooldown,
    );
    this.hud.setTimer(this.match.formatTime(), this.match.timeLeft < 30);
    this.hud.setScoreboard(this.match.standings(), intents.scoreboard);
  }

  private collectTargets(): TargetInfo[] {
    const targets: TargetInfo[] = this.bots.map((b) => b.targetInfo());
    targets.push({
      id: PLAYER_ID,
      position: this.player.position.clone().add(new THREE.Vector3(0, 1.2, 0)),
      headPosition: this.player.eyePosition,
      alive: this.player.alive && this.state === 'playing',
    });
    return targets;
  }

  private publishDiagnostics(): void {
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.engine.frame,
      state: this.state,
      renderer: this.engine.rendererInfo(),
      player: {
        position: {
          x: this.player.position.x,
          y: this.player.position.y,
          z: this.player.position.z,
        },
        health: this.player.health,
        alive: this.player.alive,
      },
      bots: { alive: this.bots.filter((b) => b.alive).length, total: this.bots.length },
      match: { timeLeft: this.match.timeLeft, running: this.match.running },
      audio: this.audio.diagnostics(),
      imports: importDiagnostics,
      chunks: this.world.diagnostics().chunks,
    };
  }

  dispose(): void {
    this.engine.dispose();
    this.input.dispose();
    for (const bot of this.bots) bot.dispose(this.engine.scene);
    this.props.dispose();
  }
}
