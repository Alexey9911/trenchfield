import * as THREE from 'three';
import { BOTS, PLAYER, WORLD, clamp, damp, lerp, rand, randInt, type BotArchetype } from '../game/constants';
import type { VoxelWorld } from '../world/VoxelWorld';
import { createBotBody, type BotBody } from './BotBodyFactory';

export interface TargetInfo {
  id: string;
  position: THREE.Vector3; // chest height
  headPosition: THREE.Vector3;
  alive: boolean;
}

export interface BotContext {
  world: VoxelWorld;
  targets: TargetInfo[];
  hasLineOfSight: (from: THREE.Vector3, to: THREE.Vector3) => boolean;
  fireShot: (bot: Bot, origin: THREE.Vector3, dir: THREE.Vector3) => void;
  waypoints: THREE.Vector3[];
}

type BotState = 'patrol' | 'engage' | 'dead';

const BOT_RADIUS = 0.32;
const BOT_HEIGHT = 1.78;
const EYE = 1.55;

export class Bot {
  readonly id: string;
  readonly name: string;
  readonly archetype: BotArchetype;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  health: number;
  state: BotState = 'patrol';
  kills = 0;
  deaths = 0;
  score = 0;
  streak = 0;
  respawnTimer = 0;
  private body: BotBody;
  private targetId: string | null = null;
  private lostTargetFor = 0;
  private waypoint: THREE.Vector3 | null = null;
  private waypointTimer = 0;
  private burstShots = 0;
  private burstCooldown = 0;
  private aimTime = 0;
  private walkPhase = 0;
  private hitFlash = 0;
  private deathTime = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private onGround = false;
  private lookPitch = 0;
  private blindTimer = 0;

  constructor(id: string, name: string, archetype: BotArchetype, scene: THREE.Scene) {
    this.id = id;
    this.name = name;
    this.archetype = archetype;
    this.health = archetype.health;
    this.body = createBotBody(archetype, name);
    scene.add(this.body.root);
  }

  get root(): THREE.Group {
    return this.body.root;
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get chestPosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + 1.2, this.position.z);
  }

  get headPosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + EYE, this.position.z);
  }

  get muzzlePosition(): THREE.Vector3 {
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return this.headPosition.addScaledVector(f, 0.5).add(new THREE.Vector3(0, -0.25, 0));
  }

  targetInfo(): TargetInfo {
    return {
      id: this.id,
      position: this.chestPosition,
      headPosition: this.headPosition,
      alive: this.alive,
    };
  }

  spawnAt(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.health = this.archetype.health;
    this.state = 'patrol';
    this.targetId = null;
    this.waypoint = null;
    this.streak = 0;
    this.hitFlash = 0;
    this.body.root.visible = true;
    this.body.root.rotation.set(0, 0, 0);
    this.body.root.position.copy(pos);
    this.yaw = rand(0, Math.PI * 2);
  }

  /** Flashbang hit: can't aim or fire while blind. */
  blind(duration: number): void {
    if (!this.alive) return;
    this.blindTimer = Math.max(this.blindTimer, duration);
    this.hitFlash = 1;
  }

  get isBlind(): boolean {
    return this.blindTimer > 0;
  }

  /** @returns true when this damage killed the bot */
  takeDamage(amount: number, isHead: boolean): boolean {
    if (!this.alive) return false;
    this.health -= amount * (isHead ? 1.6 : 1);
    this.hitFlash = 1;
    if (this.health <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  private die(): void {
    this.state = 'dead';
    this.deaths += 1;
    this.streak = 0;
    this.deathTime = 0;
    this.respawnTimer = BOTS.respawnDelay;
    this.targetId = null;
  }

  update(dt: number, ctx: BotContext): void {
    if (this.state === 'dead') {
      this.updateDeath(dt);
      return;
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
    this.blindTimer = Math.max(0, this.blindTimer - dt);
    this.think(dt, ctx);
    this.move(dt, ctx.world);
    this.animate(dt);
    this.applyFlash();
  }

  private think(dt: number, ctx: BotContext): void {
    const eye = this.headPosition;

    // acquire / validate target
    let target: TargetInfo | null = null;
    if (this.targetId) {
      target = ctx.targets.find((t) => t.id === this.targetId && t.alive) ?? null;
    }
    if (target) {
      const visible =
        eye.distanceTo(target.position) < BOTS.viewRange &&
        ctx.hasLineOfSight(eye, target.headPosition);
      if (!visible) {
        this.lostTargetFor += dt;
        if (this.lostTargetFor > BOTS.loseTargetTime) {
          this.targetId = null;
          target = null;
        }
      } else {
        this.lostTargetFor = 0;
      }
    }
    if (!target) {
      let bestDist: number = BOTS.viewRange;
      for (const t of ctx.targets) {
        if (!t.alive || t.id === this.id) continue;
        const d = eye.distanceTo(t.position);
        if (d < bestDist && ctx.hasLineOfSight(eye, t.headPosition)) {
          bestDist = d;
          target = t;
        }
      }
      if (target) {
        this.targetId = target.id;
        this.aimTime = 0;
        this.lostTargetFor = 0;
      }
    }

    this.state = target ? 'engage' : 'patrol';

    if (target && this.lostTargetFor === 0) {
      this.engage(dt, ctx, target);
    } else if (target) {
      // lost sight: push toward last known position
      this.seek(target.position, this.archetype.speed);
      this.faceVelocity(dt);
    } else {
      this.patrol(dt, ctx);
    }
  }

  private engage(dt: number, ctx: BotContext, target: TargetInfo): void {
    this.aimTime += dt;
    const eye = this.headPosition;
    const toTarget = target.position.clone().sub(this.position);
    toTarget.y = 0;
    const dist = toTarget.length();

    // face the target
    const desiredYaw = Math.atan2(-toTarget.x, -toTarget.z);
    let deltaYaw = desiredYaw - this.yaw;
    while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
    while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
    this.yaw += clamp(deltaYaw, -BOTS.turnRate * dt, BOTS.turnRate * dt);

    const aimPoint = target.position.clone().lerp(target.headPosition, 0.35);
    this.lookPitch = Math.atan2(aimPoint.y - eye.y, Math.max(dist, 0.01));

    // strafe + range control
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      this.strafeTimer = rand(0.8, 1.9);
    }
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    const idealRange = this.archetype.fireRange * 0.6;
    if (dist > idealRange + 3) wish.add(fwd);
    else if (dist < idealRange - 4) wish.sub(fwd);
    wish.addScaledVector(right, this.strafeDir * 0.8);
    if (wish.lengthSq() > 0.01) {
      wish.normalize();
      this.velocity.x = lerp(this.velocity.x, wish.x * this.archetype.speed, 6 * dt);
      this.velocity.z = lerp(this.velocity.z, wish.z * this.archetype.speed, 6 * dt);
    }

    // blinded: stumble sideways, no shooting
    if (this.blindTimer > 0) {
      this.velocity.x = lerp(this.velocity.x, this.strafeDir * this.archetype.speed * 0.7, 4 * dt);
      this.velocity.z = lerp(this.velocity.z, -this.strafeDir * this.archetype.speed * 0.4, 4 * dt);
      return;
    }

    // fire control
    if (dist < this.archetype.fireRange && Math.abs(deltaYaw) < 0.35) {
      this.burstCooldown -= dt;
      if (this.burstCooldown <= 0) {
        if (this.burstShots <= 0) {
          this.burstShots = randInt(this.archetype.burstShots[0], this.archetype.burstShots[1]);
        }
        // fire one shot
        const err = THREE.MathUtils.degToRad(
          this.archetype.aimErrorDeg * clamp(1.25 - this.aimTime * 0.25, 0.45, 1.25),
        );
        const dir = aimPoint.clone().sub(this.muzzlePosition).normalize();
        dir.x += rand(-err, err);
        dir.y += rand(-err, err) * 0.7;
        dir.z += rand(-err, err);
        dir.normalize();
        ctx.fireShot(this, this.muzzlePosition, dir);
        this.burstShots -= 1;
        this.burstCooldown =
          this.burstShots > 0 ? 0.13 : rand(this.archetype.burstPause[0], this.archetype.burstPause[1]);
      }
    }
  }

  private patrol(dt: number, ctx: BotContext): void {
    this.lookPitch = damp(this.lookPitch, 0, 4, dt);
    this.waypointTimer -= dt;
    if (
      !this.waypoint ||
      this.waypointTimer <= 0 ||
      this.position.distanceTo(this.waypoint) < 1.6
    ) {
      this.waypoint = ctx.waypoints[randInt(0, ctx.waypoints.length - 1)].clone();
      this.waypointTimer = rand(8, 14);
    }
    this.seek(this.waypoint, this.archetype.speed * 0.75);
    this.faceVelocity(dt);
  }

  private seek(point: THREE.Vector3, speed: number): void {
    const to = point.clone().sub(this.position);
    to.y = 0;
    if (to.lengthSq() < 0.04) return;
    to.normalize();
    this.velocity.x = lerp(this.velocity.x, to.x * speed, 0.12);
    this.velocity.z = lerp(this.velocity.z, to.z * speed, 0.12);
  }

  private faceVelocity(dt: number): void {
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp < 0.4) return;
    const desired = Math.atan2(-this.velocity.x, -this.velocity.z);
    let d = desired - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += clamp(d, -BOTS.turnRate * dt, BOTS.turnRate * dt);
  }

  private move(dt: number, world: VoxelWorld): void {
    this.velocity.y -= WORLD.gravity * dt;
    this.velocity.y = Math.max(this.velocity.y, -38);

    const min = new THREE.Vector3();
    const max = new THREE.Vector3();
    const eps = 0.001;
    const setBox = (px: number, py: number, pz: number): void => {
      min.set(px - BOT_RADIUS, py, pz - BOT_RADIUS);
      max.set(px + BOT_RADIUS, py + BOT_HEIGHT, pz + BOT_RADIUS);
    };

    let blocked = false;

    let nx = this.position.x + this.velocity.x * dt;
    setBox(nx, this.position.y + eps, this.position.z);
    if (world.boxCollides(min, max)) {
      blocked = true;
      nx = this.position.x;
      this.velocity.x = 0;
    }
    this.position.x = nx;

    let nz = this.position.z + this.velocity.z * dt;
    setBox(this.position.x, this.position.y + eps, nz);
    if (world.boxCollides(min, max)) {
      blocked = true;
      nz = this.position.z;
      this.velocity.z = 0;
    }
    this.position.z = nz;

    let ny = this.position.y + this.velocity.y * dt;
    setBox(this.position.x, ny, this.position.z);
    this.onGround = false;
    if (world.boxCollides(min, max)) {
      if (this.velocity.y <= 0) {
        ny = Math.floor(min.y) + 1 + eps;
        this.onGround = true;
      }
      this.velocity.y = 0;
    }
    this.position.y = ny;

    // auto-jump over 1-block obstacles
    if (blocked && this.onGround) {
      this.velocity.y = PLAYER.jumpSpeed * 0.82;
      this.onGround = false;
    }

    this.position.x = clamp(this.position.x, 1.5, WORLD.sizeX - 1.5);
    this.position.z = clamp(this.position.z, 1.5, WORLD.sizeZ - 1.5);
    if (this.position.y < -6) this.position.y = WORLD.sizeY;

    this.body.root.position.copy(this.position);
    this.body.root.rotation.y = this.yaw;
  }

  private animate(dt: number): void {
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    const j = this.body.joints;
    if (sp > 0.4) {
      this.walkPhase += dt * sp * 2.6;
      const swing = Math.sin(this.walkPhase) * clamp(sp / 4, 0.3, 1) * 0.65;
      j.legL.rotation.x = swing;
      j.legR.rotation.x = -swing;
      j.armL.rotation.x = -swing * 0.8;
      if (this.state !== 'engage') j.armR.rotation.x = swing * 0.8;
    } else {
      j.legL.rotation.x = damp(j.legL.rotation.x, 0, 8, dt);
      j.legR.rotation.x = damp(j.legR.rotation.x, 0, 8, dt);
      j.armL.rotation.x = damp(j.armL.rotation.x, 0, 8, dt);
      if (this.state !== 'engage') j.armR.rotation.x = damp(j.armR.rotation.x, 0, 8, dt);
    }

    if (this.state === 'engage') {
      // raise weapon arm toward aim pitch
      j.armR.rotation.x = damp(j.armR.rotation.x, -Math.PI / 2 - this.lookPitch, 10, dt);
      j.head.rotation.x = damp(j.head.rotation.x, -this.lookPitch * 0.7, 8, dt);
    } else {
      j.head.rotation.x = damp(j.head.rotation.x, 0, 6, dt);
      j.head.rotation.y = Math.sin(this.walkPhase * 0.23) * 0.28;
    }
  }

  private applyFlash(): void {
    const f = this.hitFlash * 0.4;
    for (const m of this.body.flashables) {
      m.emissive.setRGB(f, f * 0.28, f * 0.18);
      m.emissiveIntensity = 1;
    }
  }

  private updateDeath(dt: number): void {
    this.deathTime += dt;
    const t = Math.min(this.deathTime / 0.5, 1);
    // keel over
    this.body.root.rotation.x = (-Math.PI / 2) * t * t;
    this.body.root.position.y = this.position.y + 0.12 * Math.sin(t * Math.PI);
    if (this.deathTime > 2.2) {
      // sink away
      this.body.root.position.y -= dt * 1.2;
    }
    if (this.deathTime > 3.0) this.body.root.visible = false;
  }

  /** True when the given world-space point is inside the head box. */
  isHeadHit(point: THREE.Vector3): boolean {
    const h = this.headPosition;
    return (
      Math.abs(point.x - h.x) < 0.3 &&
      Math.abs(point.z - h.z) < 0.3 &&
      point.y > this.position.y + 1.38
    );
  }

  /** Ray vs body capsule-ish AABB. Returns hit point or null. */
  intersectRay(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): THREE.Vector3 | null {
    if (!this.alive) return null;
    const min = new THREE.Vector3(
      this.position.x - BOT_RADIUS - 0.06,
      this.position.y,
      this.position.z - BOT_RADIUS - 0.06,
    );
    const max = new THREE.Vector3(
      this.position.x + BOT_RADIUS + 0.06,
      this.position.y + BOT_HEIGHT + 0.12,
      this.position.z + BOT_RADIUS + 0.06,
    );
    const box = new THREE.Box3(min, max);
    const ray = new THREE.Ray(origin, dir);
    const hit = new THREE.Vector3();
    if (ray.intersectBox(box, hit) && hit.distanceTo(origin) <= maxDist) return hit;
    return null;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.body.root);
  }
}
