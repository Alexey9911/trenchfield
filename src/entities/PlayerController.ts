import * as THREE from 'three';
import { PLAYER, WORLD, clamp, damp } from '../game/constants';
import type { VoxelWorld } from '../world/VoxelWorld';
import type { InputIntents } from '../core/Input';

export interface PlayerEvents {
  onFootstep: (sprinting: boolean) => void;
  onLand: (impact: number) => void;
  onJump: () => void;
}

/** First-person controller with swept AABB voxel collision. */
export class PlayerController {
  readonly position = new THREE.Vector3(); // feet position
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  crouching = false;
  sprinting = false;
  moving = false;
  health: number = PLAYER.maxHealth;
  alive = true;
  private timeSinceDamage = 99;
  private stepTimer = 0;
  private wasOnGround = true;
  private fallSpeedPeak = 0;
  private bobPhase = 0;
  bobAmount = 0;

  constructor(
    private world: VoxelWorld,
    private events: PlayerEvents,
  ) {}

  respawnAt(spawn: THREE.Vector3, yaw: number): void {
    this.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = PLAYER.maxHealth;
    this.alive = true;
    this.timeSinceDamage = 99;
    this.crouching = false;
  }

  applyLook(yawDelta: number, pitchDelta: number): void {
    this.yaw += yawDelta;
    this.pitch = clamp(this.pitch + pitchDelta, -1.45, 1.45);
  }

  get eyeHeight(): number {
    return this.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
  }

  get eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(
      this.position.x,
      this.position.y + this.eyeHeight + this.bobOffset(),
      this.position.z,
    );
  }

  private bobOffset(): number {
    return Math.sin(this.bobPhase * 2) * 0.028 * this.bobAmount;
  }

  get forwardDir(): THREE.Vector3 {
    return new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    ).normalize();
  }

  takeDamage(amount: number): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.timeSinceDamage = 0;
    if (this.health <= 0) this.alive = false;
  }

  heal(amount: number): void {
    this.health = Math.min(PLAYER.maxHealth, this.health + amount);
  }

  update(dt: number, intents: InputIntents, adsHeld: boolean): void {
    if (!this.alive) return;

    // health regen
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > PLAYER.regenDelay && this.health < PLAYER.maxHealth) {
      this.health = Math.min(PLAYER.maxHealth, this.health + PLAYER.regenRate * dt);
    }

    this.crouching = intents.crouch;
    this.sprinting = intents.sprint && intents.forward > 0 && !this.crouching && !adsHeld;

    // wish direction in world space
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const wishX = -sinY * intents.forward + cosY * intents.strafe;
    const wishZ = -cosY * intents.forward - sinY * intents.strafe;
    const wishLen = Math.hypot(wishX, wishZ);

    let maxSpeed = this.crouching
      ? PLAYER.crouchSpeed
      : this.sprinting
        ? PLAYER.sprintSpeed
        : PLAYER.walkSpeed;
    if (adsHeld) maxSpeed *= PLAYER.adsSpeedMul;

    const accel = this.onGround ? PLAYER.accel : PLAYER.airAccel;
    if (wishLen > 0.01) {
      const nx = wishX / wishLen;
      const nz = wishZ / wishLen;
      this.velocity.x += nx * accel * dt;
      this.velocity.z += nz * accel * dt;
    }

    // ground friction
    if (this.onGround) {
      const f = Math.max(0, 1 - PLAYER.friction * dt);
      if (wishLen < 0.01) {
        this.velocity.x *= f;
        this.velocity.z *= f;
      }
    }

    // clamp horizontal speed
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed > maxSpeed) {
      const k = maxSpeed / hSpeed;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }

    // jump
    if (intents.jump && this.onGround) {
      this.velocity.y = PLAYER.jumpSpeed;
      this.onGround = false;
      this.events.onJump();
    }

    // gravity
    this.velocity.y -= WORLD.gravity * dt;
    this.velocity.y = Math.max(this.velocity.y, -40);
    if (this.velocity.y < this.fallSpeedPeak) this.fallSpeedPeak = this.velocity.y;

    this.moveWithCollision(dt);

    // landing
    if (this.onGround && !this.wasOnGround) {
      const impact = Math.abs(this.fallSpeedPeak);
      if (impact > 6) this.events.onLand(impact);
      this.fallSpeedPeak = 0;
    }
    this.wasOnGround = this.onGround;

    // footsteps + view bob
    this.moving = hSpeed > 1.2 && this.onGround;
    if (this.moving) {
      this.bobPhase += dt * (this.sprinting ? 11 : 8);
      this.bobAmount = damp(this.bobAmount, 1, 8, dt);
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = this.sprinting ? PLAYER.sprintStepInterval : PLAYER.stepInterval;
        this.events.onFootstep(this.sprinting);
      }
    } else {
      this.bobAmount = damp(this.bobAmount, 0, 6, dt);
      this.stepTimer = 0.1;
    }
  }

  private moveWithCollision(dt: number): void {
    const height = this.crouching ? PLAYER.crouchHeight : PLAYER.height;
    const r = PLAYER.radius;
    const min = new THREE.Vector3();
    const max = new THREE.Vector3();
    const eps = 0.001;

    const setBox = (px: number, py: number, pz: number): void => {
      min.set(px - r, py, pz - r);
      max.set(px + r, py + height, pz + r);
    };

    // X axis
    let nx = this.position.x + this.velocity.x * dt;
    setBox(nx, this.position.y + eps, this.position.z);
    if (this.world.boxCollides(min, max)) {
      if (this.velocity.x > 0) nx = Math.floor(max.x) - r - eps;
      else nx = Math.floor(min.x) + 1 + r + eps;
      this.velocity.x = 0;
    }
    this.position.x = nx;

    // Z axis
    let nz = this.position.z + this.velocity.z * dt;
    setBox(this.position.x, this.position.y + eps, nz);
    if (this.world.boxCollides(min, max)) {
      if (this.velocity.z > 0) nz = Math.floor(max.z) - r - eps;
      else nz = Math.floor(min.z) + 1 + r + eps;
      this.velocity.z = 0;
    }
    this.position.z = nz;

    // Y axis
    let ny = this.position.y + this.velocity.y * dt;
    setBox(this.position.x, ny, this.position.z);
    this.onGround = false;
    if (this.world.boxCollides(min, max)) {
      if (this.velocity.y <= 0) {
        ny = Math.floor(min.y) + 1 + eps;
        this.onGround = true;
      } else {
        ny = Math.floor(max.y) - height - eps;
      }
      this.velocity.y = 0;
    }
    this.position.y = ny;

    // world bounds
    this.position.x = clamp(this.position.x, 1.5, WORLD.sizeX - 1.5);
    this.position.z = clamp(this.position.z, 1.5, WORLD.sizeZ - 1.5);
    if (this.position.y < -6) {
      this.position.y = WORLD.sizeY;
      this.velocity.set(0, 0, 0);
    }
  }
}
