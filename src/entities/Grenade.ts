import * as THREE from 'three';
import { GRENADES, WORLD, type GrenadeKind, type GrenadeSpec } from '../game/constants';
import type { VoxelWorld } from '../world/VoxelWorld';

const BODY_COLORS: Record<GrenadeKind, number> = {
  frag: 0x3c4432,
  smoke: 0x7a7f85,
  flash: 0xd8d2c0,
};

const FUSE_COLORS: Record<GrenadeKind, number> = {
  frag: 0xff5a2e,
  smoke: 0x9fb8e8,
  flash: 0xfff2c0,
};

export class Grenade {
  readonly kind: GrenadeKind;
  readonly spec: GrenadeSpec;
  readonly mesh: THREE.Group;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  fuse: number;
  exploded = false;
  readonly ownerId: string;

  constructor(kind: GrenadeKind, origin: THREE.Vector3, dir: THREE.Vector3, ownerId: string) {
    this.kind = kind;
    this.spec = GRENADES[kind];
    this.fuse = this.spec.fuse;
    this.ownerId = ownerId;
    this.position = origin.clone();
    this.velocity = dir.clone().multiplyScalar(this.spec.throwSpeed);
    this.mesh = new THREE.Group();
    const isCanister = kind !== 'frag';
    const body = new THREE.Mesh(
      isCanister
        ? new THREE.CylinderGeometry(0.07, 0.07, 0.2, 8)
        : new THREE.BoxGeometry(0.14, 0.18, 0.14),
      new THREE.MeshStandardMaterial({
        color: BODY_COLORS[kind],
        roughness: 0.55,
        metalness: 0.35,
      }),
    );
    const lever = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.1, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x8a8a92, roughness: 0.4, metalness: 0.7 }),
    );
    lever.position.set(0.05, 0.12, 0);
    const fuseLight = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.04, 0.04),
      new THREE.MeshStandardMaterial({
        color: FUSE_COLORS[kind],
        emissive: FUSE_COLORS[kind],
        emissiveIntensity: 2,
      }),
    );
    fuseLight.position.y = 0.12;
    fuseLight.name = 'fuseLight';
    this.mesh.add(body, lever, fuseLight);
    this.mesh.castShadow = true;
    this.mesh.position.copy(this.position);
  }

  /** @returns true when it detonates this frame */
  update(dt: number, world: VoxelWorld): boolean {
    this.fuse -= dt;
    if (this.fuse <= 0) {
      this.exploded = true;
      return true;
    }

    this.velocity.y -= WORLD.gravity * 0.72 * dt;

    const next = this.position.clone().addScaledVector(this.velocity, dt);
    if (world.isSolid(Math.floor(next.x), Math.floor(this.position.y), Math.floor(this.position.z))) {
      this.velocity.x *= -this.spec.bounce;
      next.x = this.position.x;
    }
    if (world.isSolid(Math.floor(next.x), Math.floor(this.position.y), Math.floor(next.z))) {
      this.velocity.z *= -this.spec.bounce;
      next.z = this.position.z;
    }
    if (world.isSolid(Math.floor(next.x), Math.floor(next.y), Math.floor(next.z))) {
      if (this.velocity.y < 0) {
        this.velocity.x *= 0.72;
        this.velocity.z *= 0.72;
      }
      this.velocity.y *= -this.spec.bounce;
      next.y = this.position.y;
      if (Math.abs(this.velocity.y) < 1.2) this.velocity.y = 0;
    }
    this.position.copy(next);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.x += dt * 7;
    this.mesh.rotation.z += dt * 5;

    const blink = Math.sin((this.spec.fuse - this.fuse) * (10 + (this.spec.fuse - this.fuse) * 14));
    const light = this.mesh.getObjectByName('fuseLight') as THREE.Mesh | null;
    if (light) {
      (light.material as THREE.MeshStandardMaterial).emissiveIntensity = blink > 0 ? 2.6 : 0.4;
    }
    return false;
  }
}
