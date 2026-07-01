import * as THREE from 'three';
import { GRENADE, WORLD } from '../game/constants';
import type { VoxelWorld } from '../world/VoxelWorld';

export class Grenade {
  readonly mesh: THREE.Group;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  fuse = GRENADE.fuse;
  exploded = false;
  readonly ownerId: string;

  constructor(origin: THREE.Vector3, dir: THREE.Vector3, ownerId: string) {
    this.ownerId = ownerId;
    this.position = origin.clone();
    this.velocity = dir.clone().multiplyScalar(GRENADE.throwSpeed);
    this.mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.18, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x3c4432, roughness: 0.6, metalness: 0.3 }),
    );
    const lever = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.1, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x8a8a92, roughness: 0.4, metalness: 0.7 }),
    );
    lever.position.set(0.05, 0.12, 0);
    const fuseLight = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.04, 0.04),
      new THREE.MeshStandardMaterial({
        color: 0xff5a2e,
        emissive: 0xff5a2e,
        emissiveIntensity: 2,
      }),
    );
    fuseLight.position.y = 0.12;
    fuseLight.name = 'fuseLight';
    this.mesh.add(body, lever, fuseLight);
    this.mesh.castShadow = true;
    this.mesh.position.copy(this.position);
  }

  /** @returns true when it explodes this frame */
  update(dt: number, world: VoxelWorld): boolean {
    this.fuse -= dt;
    if (this.fuse <= 0) {
      this.exploded = true;
      return true;
    }

    this.velocity.y -= WORLD.gravity * 0.72 * dt;

    // integrate + bounce per axis
    const next = this.position.clone().addScaledVector(this.velocity, dt);
    if (world.isSolid(Math.floor(next.x), Math.floor(this.position.y), Math.floor(this.position.z))) {
      this.velocity.x *= -GRENADE.bounce;
      next.x = this.position.x;
    }
    if (world.isSolid(Math.floor(next.x), Math.floor(this.position.y), Math.floor(next.z))) {
      this.velocity.z *= -GRENADE.bounce;
      next.z = this.position.z;
    }
    if (world.isSolid(Math.floor(next.x), Math.floor(next.y), Math.floor(next.z))) {
      if (this.velocity.y < 0) {
        this.velocity.x *= 0.72;
        this.velocity.z *= 0.72;
      }
      this.velocity.y *= -GRENADE.bounce;
      next.y = this.position.y;
      if (Math.abs(this.velocity.y) < 1.2) this.velocity.y = 0;
    }
    this.position.copy(next);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.x += dt * 7;
    this.mesh.rotation.z += dt * 5;

    // blinking fuse accelerates
    const blink = Math.sin((GRENADE.fuse - this.fuse) * (10 + (GRENADE.fuse - this.fuse) * 14));
    const light = this.mesh.getObjectByName('fuseLight') as THREE.Mesh | null;
    if (light) {
      (light.material as THREE.MeshStandardMaterial).emissiveIntensity = blink > 0 ? 2.6 : 0.4;
    }
    return false;
  }
}
