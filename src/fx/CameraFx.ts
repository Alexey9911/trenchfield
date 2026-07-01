import * as THREE from 'three';
import { clamp, damp } from '../game/constants';

/** Trauma-based shake + recoil pitch + landing dip, applied after camera pose. */
export class CameraFx {
  private trauma = 0;
  private recoilPitch = 0;
  private recoilRecovery = 0;
  private landDip = 0;
  private damageRoll = 0;

  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  addRecoil(pitchKick: number): void {
    this.recoilPitch += pitchKick;
    this.recoilRecovery = 0;
  }

  addLanding(impact: number): void {
    this.landDip = clamp(impact * 0.012, 0, 0.16);
  }

  addDamageRoll(): void {
    this.damageRoll = (Math.random() < 0.5 ? -1 : 1) * 0.035;
  }

  /** Returns pitch offset to add to look pitch; applies roll/pos jitter to camera. */
  apply(camera: THREE.PerspectiveCamera, dt: number, elapsed: number): number {
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const shake = this.trauma * this.trauma;
    const roll =
      shake * 0.045 * Math.sin(elapsed * 41) + this.damageRoll;
    const jitterX = shake * 0.05 * Math.sin(elapsed * 53 + 1);
    const jitterY = shake * 0.05 * Math.cos(elapsed * 47 + 2);

    this.recoilRecovery += dt;
    this.recoilPitch = damp(this.recoilPitch, 0, this.recoilRecovery > 0.06 ? 11 : 2.5, dt);
    this.landDip = damp(this.landDip, 0, 8, dt);
    this.damageRoll = damp(this.damageRoll, 0, 7, dt);

    camera.rotation.z += roll;
    camera.position.y -= this.landDip;
    camera.position.x += jitterX;
    camera.position.y += jitterY;

    return this.recoilPitch;
  }
}
