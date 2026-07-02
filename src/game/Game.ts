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
  FLASH,
  GRENADES,
  MAPS,
  PLAYER,
  SMOKE_CLOUD,
  WORLD,
  type MapId,
  clamp,
  lerp,
  rand,
  type WeaponSpec,
} from './constants';
import { loadTankModel, loadWeaponModel, importDiagnostics } from '../assets/ImportedAssets';
import { NetClient, type MatchStartInfo, type SnapshotPlayer } from '../net/NetClient';
import { RemotePlayers } from '../net/RemotePlayers';
import { MultiplayerUI } from '../ui/MultiplayerUI';

type GameState = 'menu' | 'playing' | 'dead' | 'ended';

const PLAYER_ID = 'player';

export class Game {
  private engine: Engine;
  private input: Input;
  private audio = new AudioManager();
  private world!: VoxelWorld;
  private layout!: MapLayout;
  private sky!: Sky;
  private props!: PropsKit;
  private pickups!: Pickups;
  private mapId: MapId = 'day';
  private tankModel: THREE.Group | null = null;
  // --- multiplayer ---
  private net!: NetClient;
  private remotes!: RemotePlayers;
  private mpUI!: MultiplayerUI;
  private mpActive = false;
  private mpEndsAt = 0;
  private mpRespawnNonce = 0;
  private mpStateAccum = 0;
  private mpStandings: SnapshotPlayer[] = [];
  private mpNicks = new Map<string, string>();
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
    const savedMap = localStorage.getItem('trenchfield-map');
    this.mapId = savedMap === 'night' ? 'night' : 'day';
    this.vfx = new VfxSystem(
      this.engine.scene,
      new THREE.Vector3(WORLD.sizeX / 2, 10, WORLD.sizeZ / 2),
    );
    this.buildWorld(this.mapId);

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
      onGrenadeThrow: (kind, origin, dir) => {
        const g = new Grenade(kind, origin, dir, PLAYER_ID);
        this.grenades.push(g);
        this.engine.scene.add(g.mesh);
        this.audio.play('grenadeThrow', { volume: 0.7 });
        if (this.mpActive) {
          this.net.sendGrenade(kind, [origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z]);
        }
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
      onMapSelect: (id) => this.setMap(id),
      onUiClick: () => {
        this.audio.unlock();
        this.audio.play('uiClick', { volume: 0.5 });
      },
    });
    this.screens.setSelectedMap(this.mapId);

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

    this.setupMultiplayer();
    this.loadImportedAssets();

    this.engine.setFrameHandler((dt, elapsed) => this.update(dt, elapsed));
    this.screens.show('landing');
    this.hud.setVisible(false);
    this.weapons.setRigVisible(false);

    if (this.testMode) {
      const mpTest = new URLSearchParams(location.search).has('mp');
      if (!mpTest) window.setTimeout(() => this.deploy(), 300);
      (window as unknown as Record<string, unknown>).__TEST_AIM_AT_REMOTE__ = () => {
        const eye = this.player.eyePosition;
        for (const rid of this.remotes.ids()) {
          const chest = this.remotes.chestPosition(rid);
          if (!chest) continue;
          const to = chest.clone().sub(eye);
          this.player.yaw = Math.atan2(-to.x, -to.z);
          this.player.pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
          return rid;
        }
        return null;
      };
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
      (window as unknown as Record<string, unknown>).__TEST_SCENE_INFO__ = () => {
        const fog = this.engine.scene.fog as THREE.Fog;
        const lights: Array<Record<string, unknown>> = [];
        this.engine.scene.traverse((o) => {
          const l = o as THREE.Light;
          if ((l as THREE.DirectionalLight).isDirectionalLight || (l as THREE.HemisphereLight).isHemisphereLight) {
            lights.push({
              type: l.type,
              color: l.color.getHexString(),
              intensity: l.intensity,
              ground: (l as THREE.HemisphereLight).groundColor?.getHexString?.(),
            });
          }
        });
        return {
          mapId: this.mapId,
          fog: { color: fog.color.getHexString(), near: fog.near, far: fog.far },
          exposure: this.engine.renderer.toneMappingExposure,
          skyGroups: this.engine.scene.children.filter((c) => c.name === 'sky').length,
          worldGroups: this.engine.scene.children.filter((c) => c.name === 'voxelWorld').length,
          lights,
        };
      };
      const origTakeDamage = this.player.takeDamage.bind(this.player);
      (window as unknown as Record<string, unknown>).__TEST_GOD__ = (on: boolean) => {
        this.player.takeDamage = on ? () => {} : origTakeDamage;
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

  // ------------------------------------------------------------------
  // multiplayer
  // ------------------------------------------------------------------

  private setupMultiplayer(): void {
    this.remotes = new RemotePlayers(this.engine.scene);
    this.net = new NetClient({
      onConnectionChange: (c) => {
        this.mpUI.setConnection(c);
        if (c) {
          void this.mpUI.tryResumeSession();
          void this.net.chatHistory().then((msgs) => this.mpUI.setGlobalChatHistory(msgs));
        }
      },
      onMeta: (m) => this.mpUI.renderMeta(m),
      onLobbyUpdate: (l) => this.mpUI.renderLobby(l),
      onMatchStart: (info) => this.startMpMatch(info),
      onSnapshot: (players) => this.onMpSnapshot(players),
      onShot: (id, w, o, d) => this.onRemoteShot(id, w, o, d),
      onGrenade: (id, kind, o, d) => {
        const origin = new THREE.Vector3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0);
        const dir = new THREE.Vector3(d[0] ?? 0, d[1] ?? 0, d[2] ?? -1);
        const g = new Grenade(kind, origin, dir, id);
        this.grenades.push(g);
        this.engine.scene.add(g.mesh);
      },
      onKillfeed: (ev) => {
        this.hud.addKillFeed({
          killerName: ev.killerId === this.net.myId() ? 'YOU' : ev.killer,
          victimName: ev.victimId === this.net.myId() ? 'YOU' : ev.victim,
          headshot: false,
          killerIsPlayer: ev.killerId === this.net.myId(),
          victimIsPlayer: ev.victimId === this.net.myId(),
        });
        if (ev.killerId === this.net.myId()) {
          this.audio.play('killConfirm', { volume: 0.85 });
          if (ev.solDelta > 0) this.hud.showScorePop(ev.solDelta * 1000, `+◎${ev.solDelta.toFixed(3)} SOL`);
          else this.hud.showScorePop(100, 'KILL CONFIRMED');
        }
        if (ev.victimId === this.net.myId() && this.mpActive) {
          this.onMpDeath(ev.killerId === this.net.myId() ? 'yourself' : ev.killer);
        }
      },
      onDamaged: (ev) => {
        if (!this.mpActive) return;
        this.player.health = ev.hp;
        this.hud.setHealth(ev.hp, PLAYER.maxHealth);
        this.hud.damageFlash();
        this.cameraFx.addDamageRoll();
        this.cameraFx.addTrauma(0.18);
        this.audio.play('damageGrunt', { volume: 0.55, pitchJitter: 0.15 });
      },
      onHitConfirm: (ev) => {
        this.hud.hitmarker(ev.head);
        this.audio.play(ev.head ? 'headshot' : 'hitmarker', { volume: 0.65 });
        this.remotes.flashHit(ev.victim);
      },
      onRespawn: (spawn) => {
        if (!this.mpActive) return;
        this.mpRespawnNonce += 1;
        this.player.respawnAt(new THREE.Vector3(spawn.x, spawn.y, spawn.z), Math.PI);
        this.weapons.reset();
        this.state = 'playing';
        this.weapons.setRigVisible(true);
        this.screens.show(null);
        this.hud.setVisible(true);
        if (!this.testMode) this.input.requestLock();
      },
      onRubberband: (pos) => {
        this.player.position.set(pos.x, pos.y, pos.z);
        this.player.velocity.set(0, 0, 0);
      },
      onMatchEnd: (ev) => this.endMpMatch(ev),
      onChat: (m) => this.mpUI.addChat(m),
      onChatRemoved: (ids) => this.mpUI.removeChat(ids),
      onLobbyChatHistory: (msgs) => this.mpUI.setLobbyChatHistory(msgs),
      onKicked: (reason) => {
        this.mpUI.toast(`kicked: ${reason}`);
        this.quitToMenu();
      },
    });
    this.mpUI = new MultiplayerUI(this.net, {
      onUiClick: () => {
        this.audio.unlock();
        this.audio.play('uiClick', { volume: 0.5 });
      },
      getNick: () => localStorage.getItem('tf-nick') ?? `operator-${Math.floor(Math.random() * 999)}`,
    });
    if (this.net.available) this.net.connect();
    else this.mpUI.setConnection(false);
  }

  private startMpMatch(info: MatchStartInfo): void {
    this.mpUI.showLobbyRoom(false);
    this.audio.unlock();
    this.audio.startAmbience();
    if (info.map !== this.mapId) this.buildWorld(info.map);

    // bots off, remotes on
    this.mpActive = true;
    for (const bot of this.bots) bot.root.visible = false;
    this.remotes.clear();
    const myId = this.net.myId();
    this.mpNicks.clear();
    for (const p of info.players) {
      this.mpNicks.set(p.id, p.nick);
      if (p.id !== myId) this.remotes.addPlayer(p.id, p.nick);
    }
    const mySpawn = info.players.find((p) => p.id === myId)?.spawn ?? { x: 36, y: 12, z: 36 };
    this.player.respawnAt(new THREE.Vector3(mySpawn.x, mySpawn.y, mySpawn.z), Math.PI);
    this.weapons.reset();
    this.mpEndsAt = info.endsAt;
    this.mpStandings = [];
    this.hud.reset();

    this.state = 'playing';
    this.weapons.setRigVisible(true);
    this.screens.show(null);
    this.hud.setVisible(true);
    this.audio.play('uiDeploy', { volume: 0.8 });
    this.audio.play('voWelcome', { volume: 0.9 });
    if (!this.testMode) this.input.requestLock();
  }

  private onMpSnapshot(players: SnapshotPlayer[]): void {
    if (!this.mpActive) return;
    this.mpStandings = players;
    this.remotes.applySnapshot(players.filter((p) => p.id !== this.net.myId()));
  }

  private onRemoteShot(id: string, w: string, o: number[], d: number[]): void {
    const origin =
      this.remotes.muzzlePosition(id) ?? new THREE.Vector3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0);
    const dir = new THREE.Vector3(d[0] ?? 0, d[1] ?? 0, d[2] ?? -1).normalize();
    const hit = this.world.raycast(origin, dir, 90);
    const end = hit?.point ?? origin.clone().addScaledVector(dir, 60);
    this.vfx.muzzleFlash(origin, w !== 'rifle', dir);
    this.vfx.tracer(origin, end);
    if (hit) this.vfx.impact(hit.point, hit.normal, this.surfaceForBlock(hit.block));
    const distToMe = origin.distanceTo(this.player.eyePosition);
    this.audio.play(w === 'scattergun' ? 'scattergunShot' : w === 'sniper' ? 'sniperShot' : 'rifleShot', {
      volume: 0.9,
      pitchJitter: 0.08,
      distance: distToMe,
    });
  }

  private onMpDeath(killerName: string): void {
    this.state = 'dead';
    this.audio.play('playerDeath', { volume: 0.9 });
    this.screens.setDeathInfo(killerName);
    this.screens.show('death');
    this.screens.setDeathCountdown(3);
    this.cameraFx.addTrauma(0.8);
  }

  private endMpMatch(ev: {
    reason: string;
    mode: 'free' | 'wager';
    stake: number;
    standings: Array<{ id: string; nick: string; kills: number; deaths: number; pot: number; net: number }>;
    payouts: Array<{ nick: string; amount: number; sig: string }>;
  }): void {
    if (!this.mpActive) return;
    this.mpActive = false;
    this.remotes.clear();
    for (const bot of this.bots) bot.root.visible = true;
    this.state = 'ended';
    this.weapons.setRigVisible(false);
    this.input.releaseLock();

    const myId = this.net.myId();
    const placement = ev.standings.findIndex((s) => s.id === myId) + 1;
    const mine = ev.standings.find((s) => s.id === myId);
    this.screens.setEndResults(
      ev.standings.map((s) => ({
        id: s.id,
        name: s.id === myId ? 'YOU' : s.nick,
        isPlayer: s.id === myId,
        archetypeLabel: 'OPERATOR',
        kills: s.kills,
        deaths: s.deaths,
        score: ev.mode === 'wager' ? Math.round(s.pot * 1000) : s.kills * 100,
        streak: 0,
      })),
      Math.max(placement, 1),
      mine ? (ev.mode === 'wager' ? Math.round(mine.pot * 1000) : mine.kills * 100) : 0,
      0,
    );
    if (ev.mode === 'wager' && mine) {
      this.mpUI.toast(
        mine.net >= 0
          ? `match over — you cashed out ◎${mine.pot.toFixed(3)} (net +◎${mine.net.toFixed(3)})`
          : `match over — you cashed out ◎${mine.pot.toFixed(3)} (net -◎${Math.abs(mine.net).toFixed(3)})`,
      );
    }
    this.screens.show('end');
    this.hud.setVisible(false);
    this.audio.play('voMatchOver', { volume: 1 });
  }

  /** Build (or rebuild) the arena for a map theme. Safe to call from the menu. */
  private buildWorld(id: MapId): void {
    const theme = MAPS[id];
    this.mapId = id;
    localStorage.setItem('trenchfield-map', id);

    // tear down the previous bundle
    if (this.world) this.engine.scene.remove(this.world.group);
    if (this.sky) this.sky.dispose(this.engine.scene);
    if (this.props) {
      this.engine.scene.remove(this.props.group);
      this.props.dispose();
    }
    if (this.pickups) this.pickups.dispose(this.engine.scene);
    this.vfx.clearSmokeColumns();
    for (const g of this.grenades) this.engine.scene.remove(g.mesh);
    this.grenades.length = 0;

    // build fresh
    this.world = new VoxelWorld();
    this.layout = buildTrenchArena(this.world, theme.seed, theme.variant);
    this.world.buildAll();
    this.engine.scene.add(this.world.group);
    this.sky = new Sky(this.engine.scene, theme);
    this.props = new PropsKit(this.world.atlas, this.layout);
    this.engine.scene.add(this.props.group);
    this.pickups = new Pickups(this.engine.scene, this.world.atlas, this.layout.pickupSpots);
    for (const s of this.layout.smokeColumns) this.vfx.addSmokeColumn(s);
    this.vfx.setDustColor(theme.dustColor);

    // atmosphere
    const fog = this.engine.scene.fog as THREE.Fog;
    fog.color.setHex(theme.fogColor);
    fog.near = theme.fogNear;
    fog.far = theme.fogFar;
    this.engine.renderer.toneMappingExposure = theme.exposure;

    // reposition the tank wreck on the new crater
    if (this.tankModel) {
      this.tankModel.position.copy(this.layout.tank.position);
      this.tankModel.rotation.y = this.layout.tank.rotationY;
    }

    // bots need valid ground on the new terrain
    if (this.bots.length > 0) {
      for (let i = 0; i < this.bots.length; i++) {
        this.bots[i].spawnAt(this.layout.spawns[(i + 1) % this.layout.spawns.length].clone());
      }
    }
  }

  setMap(id: MapId): void {
    if (id === this.mapId) return;
    if (this.state !== 'menu' && this.state !== 'ended') return;
    this.buildWorld(id);
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
    void loadWeaponModel('/models/sniper.glb', 'sniper', 0.72).then((sniper) => {
      if (sniper) {
        sniper.rotation.set(0.02, -0.06, 0);
        this.weapons.setImportedModel('sniper', sniper);
      }
    });
    void loadTankModel('/models/tank.glb', 5.2).then((tank) => {
      if (tank) {
        tank.position.copy(this.layout.tank.position);
        tank.rotation.y = this.layout.tank.rotationY;
        this.engine.scene.add(tank);
        this.tankModel = tank;
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
    this.tankModel = g;
  }

  start(): void {
    this.engine.start();
  }

  // ------------------------------------------------------------------
  // state transitions
  // ------------------------------------------------------------------

  private deploy(): void {
    if (this.mpActive) return; // multiplayer respawns are server-driven
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
    if (this.mpActive || this.net?.lobby) {
      this.net.leaveLobby();
      this.remotes.clear();
      this.mpActive = false;
      for (const bot of this.bots) bot.root.visible = true;
      this.mpUI.showLobbyRoom(false);
    }
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
    const shotSound =
      spec.id === 'rifle' ? 'rifleShot' : spec.id === 'scattergun' ? 'scattergunShot' : 'sniperShot';
    this.audio.play(shotSound, {
      volume: spec.id === 'sniper' ? 0.95 : 0.85,
      pitchJitter: 0.06,
    });
    this.vfx.muzzleFlash(muzzleWorld, spec.id !== 'rifle', rays[0]?.dir);
    this.cameraFx.addRecoil(this.weapons.consumeRecoilKick());
    this.cameraFx.addTrauma(spec.id === 'scattergun' ? 0.22 : 0.08);
    this.spreadPx = Math.min(this.spreadPx + (spec.id === 'scattergun' ? 14 : 5), 40);

    // --- multiplayer path: hits vs remote players, claims validated server-side
    if (this.mpActive) {
      this.net.sendShot(spec.id, [muzzleWorld.x, muzzleWorld.y, muzzleWorld.z], [
        rays[0].dir.x,
        rays[0].dir.y,
        rays[0].dir.z,
      ]);
      for (let i = 0; i < rays.length; i++) {
        const dir = rays[i].dir;
        const voxelHit = this.world.raycast(eye, dir, spec.range);
        const voxelDist = voxelHit ? voxelHit.distance : spec.range;
        const remoteHit = this.remotes.intersectRay(eye, dir, voxelDist);
        const tracerEnd =
          remoteHit?.point ?? voxelHit?.point ?? eye.clone().addScaledVector(dir, spec.range);
        if (i % spec.tracerEvery === 0) this.vfx.tracer(muzzleWorld, tracerEnd);
        if (remoteHit) {
          this.vfx.impact(remoteHit.point, dir.clone().negate(), 'flesh');
          this.net.sendHit(remoteHit.id, spec.id, remoteHit.head);
        } else if (voxelHit) {
          this.vfx.impact(voxelHit.point, voxelHit.normal, this.surfaceForBlock(voxelHit.block));
        }
      }
      return;
    }

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
      const hpBefore = this.player.health;
      this.player.takeDamage(bot.archetype.damage);
      if (this.player.health < hpBefore) {
        this.hud.setHealth(this.player.health, PLAYER.maxHealth);
        this.hud.damageFlash();
        this.cameraFx.addDamageRoll();
        this.cameraFx.addTrauma(0.18);
        this.audio.play('damageGrunt', { volume: 0.55, pitchJitter: 0.15 });
      }
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
    if (g.kind === 'smoke') {
      this.vfx.spawnSmokeCloud(g.position, g.spec.radius * SMOKE_CLOUD.botBlindRadiusMul, SMOKE_CLOUD.duration);
      this.audio.play('explosion', {
        volume: 0.22,
        pitchJitter: 0.2,
        distance: g.position.distanceTo(this.player.eyePosition),
        maxDistance: 40,
      });
      return;
    }

    if (g.kind === 'flash') {
      this.vfx.flashBang(g.position);
      this.audio.play('explosion', {
        volume: 0.55,
        pitchJitter: 0.3,
        distance: g.position.distanceTo(this.player.eyePosition),
        maxDistance: 60,
      });
      this.applyFlashbang(g);
      return;
    }

    this.vfx.explosion(g.position);
    this.audio.play('explosion', {
      volume: 1,
      distance: g.position.distanceTo(this.player.eyePosition),
      maxDistance: 70,
    });
    this.world.carveCrater(g.position, 2.6);
    this.cameraFx.addTrauma(clamp(1.4 - g.position.distanceTo(this.player.position) / 18, 0, 0.85));

    // multiplayer: my frag sends validated damage claims; remote frags are visual-only
    if (this.mpActive) {
      if (g.ownerId === PLAYER_ID) {
        const at = { x: g.position.x, y: g.position.y, z: g.position.z };
        for (const rid of this.remotes.ids()) {
          const chest = this.remotes.chestPosition(rid);
          if (!chest) continue;
          const d = chest.distanceTo(g.position);
          if (d <= g.spec.radius) {
            this.net.sendFragDamage(rid, Math.round(g.spec.maxDamage * (1 - d / g.spec.radius)), at);
          }
        }
        const selfD = this.player.position
          .clone()
          .add(new THREE.Vector3(0, 0.9, 0))
          .distanceTo(g.position);
        if (selfD <= g.spec.radius) {
          this.net.sendFragDamage(
            this.net.myId(),
            Math.round(g.spec.maxDamage * (1 - selfD / g.spec.radius)),
            at,
          );
        }
      }
      return;
    }

    const damageAt = (targetPos: THREE.Vector3): number => {
      const d = targetPos.distanceTo(g.position);
      if (d > g.spec.radius) return 0;
      return g.spec.maxDamage * (1 - d / g.spec.radius);
    };

    if (this.player.alive && this.state === 'playing') {
      const dmg = damageAt(this.player.position.clone().add(new THREE.Vector3(0, 0.9, 0)));
      if (dmg > 0) {
        const hpBefore = this.player.health;
        this.player.takeDamage(dmg);
        if (this.player.health < hpBefore) {
          this.hud.setHealth(this.player.health, PLAYER.maxHealth);
          this.hud.damageFlash();
        }
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

  private applyFlashbang(g: Grenade): void {
    const blastPos = g.position.clone().add(new THREE.Vector3(0, 0.5, 0));

    // player: needs LOS + rough facing toward the blast
    if (this.player.alive && this.state === 'playing') {
      const eye = this.player.eyePosition;
      const toBlast = blastPos.clone().sub(eye);
      const dist = toBlast.length();
      if (dist < g.spec.radius) {
        const dir = toBlast.clone().normalize();
        const losBlocked = this.world.raycast(eye, dir, dist - 0.3) !== null;
        if (!losBlocked) {
          const facing = this.player.forwardDir.dot(dir); // 1 = staring at it
          const facingFactor = clamp((facing + 0.35) / 1.35, 0, 1);
          const intensity = clamp(1 - dist / g.spec.radius, 0, 1) * (0.35 + 0.65 * facingFactor);
          if (intensity > 0.08) {
            this.hud.flashBang(intensity, FLASH.playerMaxDuration * (0.5 + intensity * 0.5));
            this.cameraFx.addTrauma(intensity * 0.5);
          }
        }
      }
    }

    // bots: blind if close with LOS
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const head = bot.headPosition;
      const toBlast = blastPos.clone().sub(head);
      const dist = toBlast.length();
      if (dist > g.spec.radius * 0.85) continue;
      const dir = toBlast.clone().normalize();
      if (this.world.raycast(head, dir, dist - 0.3) === null) {
        bot.blind(FLASH.botBlindDuration * clamp(1.15 - dist / g.spec.radius, 0.4, 1));
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

    // multiplayer: interpolate remotes + stream my state at 20 Hz
    if (this.mpActive) {
      this.remotes.update(dt);
      if (this.state === 'playing') {
        this.mpStateAccum += dt;
        if (this.mpStateAccum >= 0.05) {
          this.mpStateAccum = 0;
          this.net.sendState({
            x: this.player.position.x,
            y: this.player.position.y,
            z: this.player.position.z,
            yaw: this.player.yaw,
            pitch: this.player.pitch,
            w: this.weapons.currentSpec.id,
            f: (this.player.moving ? 1 : 0) | (this.player.sprinting ? 2 : 0) | (this.player.crouching ? 4 : 0),
            rn: this.mpRespawnNonce,
          });
        }
      }
      // server hp is authoritative
      const mine = this.mpStandings.find((p) => p.id === this.net.myId());
      if (mine && this.state === 'playing') this.player.health = mine.hp;
    }

    const paused = this.screens.current === 'pause';
    if (!paused && !this.mpActive) {
      const botCtx = {
        world: this.world,
        targets: this.collectTargets(),
        hasLineOfSight: (from: THREE.Vector3, to: THREE.Vector3) => {
          if (this.vfx.segmentBlockedBySmoke(from, to)) return false;
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

      if (this.state === 'playing' || this.state === 'dead') this.match.update(dt);
    }

    if (!paused) {
      for (let i = this.grenades.length - 1; i >= 0; i--) {
        const g = this.grenades[i];
        if (g.update(dt, this.world)) {
          this.explodeGrenade(g);
          this.engine.scene.remove(g.mesh);
          this.grenades.splice(i, 1);
        }
      }
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
      if (this.mpActive) {
        // corpse-cam only; the server sends the respawn event
        this.engine.camera.position.y = Math.max(
          this.engine.camera.position.y - dt * 0.6,
          this.player.position.y + 0.4,
        );
        this.engine.camera.rotation.z = lerp(this.engine.camera.rotation.z, 0.35, dt * 2);
        return;
      }
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
      this.weapons.addReserve('sniper', 8);
      this.hud.showToast('AMMO CACHE RESTOCKED');
      this.audio.play('pickupAmmo', { volume: 0.7 });
    }

    const ammo = this.weapons.ammoState();
    this.hud.setHealth(this.player.health, PLAYER.maxHealth);
    this.hud.setAmmo(ammo.mag, ammo.reserve, this.weapons.currentSpec.name, {
      frag: 1 - this.weapons.grenadeCooldowns.frag / GRENADES.frag.cooldown,
      smoke: 1 - this.weapons.grenadeCooldowns.smoke / GRENADES.smoke.cooldown,
      flash: 1 - this.weapons.grenadeCooldowns.flash / GRENADES.flash.cooldown,
    });
    this.hud.setScope(this.weapons.scopeAmount);
    if (this.mpActive) {
      const left = Math.max(0, (this.mpEndsAt - Date.now()) / 1000);
      const m = Math.floor(left / 60);
      const s = Math.floor(left % 60);
      this.hud.setTimer(`${m}:${String(s).padStart(2, '0')}`, left < 30);
      this.hud.setScoreboard(
        [...this.mpStandings]
          .sort((a, b) => b.k - a.k || a.d - b.d)
          .map((p) => ({
            id: p.id,
            name: p.id === this.net.myId() ? 'YOU' : (this.mpNicks.get(p.id) ?? 'operator'),
            isPlayer: p.id === this.net.myId(),
            archetypeLabel: 'OPERATOR',
            kills: p.k,
            deaths: p.d,
            score: p.k * 100,
            streak: 0,
          })),
        intents.scoreboard,
      );
    } else {
      this.hud.setTimer(this.match.formatTime(), this.match.timeLeft < 30);
      this.hud.setScoreboard(this.match.standings(), intents.scoreboard);
    }
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
