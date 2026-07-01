import * as THREE from 'three';
import {
  GRENADE,
  RENDER,
  WEAPONS,
  clamp,
  damp,
  lerp,
  rand,
  type WeaponSpec,
} from '../game/constants';
import type { InputIntents } from '../core/Input';

export interface ShotRay {
  dir: THREE.Vector3;
}

export interface WeaponEvents {
  onFire: (spec: WeaponSpec, rays: ShotRay[], muzzleWorld: THREE.Vector3) => void;
  onDryFire: () => void;
  onReloadStart: (spec: WeaponSpec) => void;
  onReloadEnd: (spec: WeaponSpec) => void;
  onSwitch: (spec: WeaponSpec) => void;
  onGrenadeThrow: (origin: THREE.Vector3, dir: THREE.Vector3) => void;
}

interface WeaponRuntime {
  spec: WeaponSpec;
  mag: number;
  reserve: number;
  model: THREE.Group;
}

/** Viewmodel + firing logic + weapon feel (bob, sway, recoil, ADS). */
export class WeaponSystem {
  readonly rig = new THREE.Group();
  private weapons: Record<'rifle' | 'scattergun', WeaponRuntime>;
  private currentId: 'rifle' | 'scattergun' = 'rifle';
  private cooldown = 0;
  private reloadTimer = 0;
  private switchTimer = 0;
  reloading = false;
  private triggerWasDown = false;
  grenadeCooldown = 0;
  private recoil = 0;
  private swayX = 0;
  private swayY = 0;
  private kickZ = 0;
  adsBlend = 0;
  private muzzle = new THREE.Object3D();
  private baseFov = RENDER.fov;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private events: WeaponEvents,
  ) {
    this.rig.name = 'weaponRig';
    camera.add(this.rig);
    this.muzzle.position.set(0, 0, -0.62);
    this.rig.add(this.muzzle);

    // keeps the viewmodel readable when facing away from the sun
    const fill = new THREE.PointLight(0xffd9b0, 0.65, 2.2, 1.6);
    fill.position.set(-0.15, 0.22, 0.15);
    this.rig.add(fill);

    this.weapons = {
      rifle: {
        spec: WEAPONS.rifle,
        mag: WEAPONS.rifle.magSize,
        reserve: WEAPONS.rifle.reserve,
        model: WeaponSystem.buildFallbackRifle(),
      },
      scattergun: {
        spec: WEAPONS.scattergun,
        mag: WEAPONS.scattergun.magSize,
        reserve: WEAPONS.scattergun.reserve,
        model: WeaponSystem.buildFallbackScattergun(),
      },
    };
    for (const w of Object.values(this.weapons)) {
      w.model.visible = false;
      this.rig.add(w.model);
    }
    this.weapons[this.currentId].model.visible = true;
  }

  get current(): WeaponRuntime {
    return this.weapons[this.currentId];
  }

  get currentSpec(): WeaponSpec {
    return this.current.spec;
  }

  ammoState(): { mag: number; reserve: number } {
    return { mag: this.current.mag, reserve: this.current.reserve };
  }

  addReserve(id: 'rifle' | 'scattergun', amount: number): void {
    this.weapons[id].reserve += amount;
  }

  /** Replace a fallback viewmodel with an imported (Meshy) model. */
  setImportedModel(id: 'rifle' | 'scattergun', group: THREE.Group): void {
    const w = this.weapons[id];
    const wasVisible = w.model.visible;
    this.rig.remove(w.model);
    w.model = group;
    w.model.visible = wasVisible;
    this.rig.add(w.model);
  }

  setRigVisible(visible: boolean): void {
    this.rig.visible = visible;
  }

  reset(): void {
    for (const w of Object.values(this.weapons)) {
      w.mag = w.spec.magSize;
      w.reserve = w.spec.reserve;
    }
    this.switchTo('rifle', true);
    this.grenadeCooldown = 0;
    this.reloading = false;
    this.cooldown = 0;
  }

  private switchTo(id: 'rifle' | 'scattergun', instant = false): void {
    if (this.currentId === id && !instant) return;
    this.weapons[this.currentId].model.visible = false;
    this.currentId = id;
    this.weapons[id].model.visible = true;
    this.reloading = false;
    this.reloadTimer = 0;
    this.switchTimer = instant ? 0 : 0.4;
    if (!instant) this.events.onSwitch(this.weapons[id].spec);
  }

  update(
    dt: number,
    intents: InputIntents,
    lookDelta: { yaw: number; pitch: number },
    moveBob: number,
    eyeDir: THREE.Vector3,
    eyePos: THREE.Vector3,
    firingAllowed: boolean,
  ): void {
    const w = this.current;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.switchTimer = Math.max(0, this.switchTimer - dt);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);

    // weapon switching
    if (intents.weaponSlot === 1) this.switchTo('rifle');
    if (intents.weaponSlot === 2) this.switchTo('scattergun');

    // reload
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const need = w.spec.magSize - w.mag;
        const take = Math.min(need, w.reserve);
        w.mag += take;
        w.reserve -= take;
        this.reloading = false;
        this.events.onReloadEnd(w.spec);
      }
    } else if (
      firingAllowed &&
      (intents.reload || (intents.fire && w.mag === 0)) &&
      w.mag < w.spec.magSize &&
      w.reserve > 0 &&
      this.switchTimer <= 0
    ) {
      this.reloading = true;
      this.reloadTimer = w.spec.reloadTime;
      this.events.onReloadStart(w.spec);
    }

    // ADS blend
    const wantAds = intents.ads && !this.reloading && firingAllowed;
    this.adsBlend = damp(this.adsBlend, wantAds ? 1 : 0, 12, dt);
    this.camera.fov = lerp(this.baseFov, w.spec.adsFov, this.adsBlend);
    this.camera.updateProjectionMatrix();

    // firing
    const triggerDown = intents.fire && firingAllowed;
    const canFire =
      triggerDown &&
      !this.reloading &&
      this.switchTimer <= 0 &&
      this.cooldown <= 0 &&
      (w.spec.auto || !this.triggerWasDown);
    if (canFire) {
      if (w.mag > 0) {
        this.fire(eyeDir, eyePos);
      } else if (!this.triggerWasDown) {
        this.events.onDryFire();
      }
    }
    this.triggerWasDown = triggerDown;

    // grenade
    if (intents.grenade && this.grenadeCooldown <= 0 && firingAllowed) {
      this.grenadeCooldown = GRENADE.cooldown;
      const dir = eyeDir.clone();
      dir.y += 0.18;
      dir.normalize();
      this.events.onGrenadeThrow(eyePos.clone().addScaledVector(eyeDir, 0.4), dir);
    }

    this.animateViewmodel(dt, lookDelta, moveBob);
  }

  private fire(eyeDir: THREE.Vector3, eyePos: THREE.Vector3): void {
    const w = this.current;
    w.mag -= 1;
    this.cooldown = 60 / w.spec.rpm;
    this.recoil = Math.min(this.recoil + 1, 3);
    this.kickZ = Math.min(this.kickZ + (w.spec.id === 'scattergun' ? 0.14 : 0.05), 0.2);

    const spreadDeg = lerp(w.spec.spreadDeg, w.spec.adsSpreadDeg, this.adsBlend);
    const spread = THREE.MathUtils.degToRad(spreadDeg);
    const rays: ShotRay[] = [];
    const right = new THREE.Vector3().crossVectors(eyeDir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, eyeDir).normalize();
    for (let i = 0; i < w.spec.pellets; i++) {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * spread;
      const dir = eyeDir
        .clone()
        .addScaledVector(right, Math.cos(a) * r)
        .addScaledVector(up, Math.sin(a) * r)
        .normalize();
      rays.push({ dir });
    }

    const muzzleWorld = new THREE.Vector3();
    this.muzzle.getWorldPosition(muzzleWorld);
    void eyePos;
    this.events.onFire(w.spec, rays, muzzleWorld);
  }

  /** Camera pitch kick amount for this frame, consumed by CameraFx. */
  consumeRecoilKick(): number {
    const spec = this.current.spec;
    const k = this.recoil > 0 ? spec.recoilKick * this.recoil : 0;
    this.recoil = Math.max(0, this.recoil - 0.55);
    return k;
  }

  private animateViewmodel(
    dt: number,
    lookDelta: { yaw: number; pitch: number },
    moveBob: number,
  ): void {
    // sway from look
    this.swayX = damp(this.swayX, clamp(-lookDelta.yaw * 4, -0.05, 0.05), 10, dt);
    this.swayY = damp(this.swayY, clamp(lookDelta.pitch * 4, -0.04, 0.04), 10, dt);
    this.kickZ = damp(this.kickZ, 0, 9, dt);

    const t = performance.now() / 1000;
    const bobX = Math.sin(t * 8.2) * 0.011 * moveBob * (1 - this.adsBlend * 0.85);
    const bobY = Math.abs(Math.cos(t * 8.2)) * 0.013 * moveBob * (1 - this.adsBlend * 0.85);

    const hipPos = new THREE.Vector3(0.24, -0.22, -0.45);
    const adsPos = new THREE.Vector3(0, -0.148, -0.34);
    const pos = hipPos.clone().lerp(adsPos, this.adsBlend);

    // reload dip
    let reloadDip = 0;
    let reloadTilt = 0;
    if (this.reloading) {
      const p = 1 - this.reloadTimer / this.current.spec.reloadTime;
      reloadDip = Math.sin(Math.min(p * 1.25, 1) * Math.PI) * 0.13;
      reloadTilt = Math.sin(Math.min(p * 1.25, 1) * Math.PI) * 0.7;
    }
    // switch raise
    const raise = this.switchTimer > 0 ? this.switchTimer / 0.4 : 0;

    this.rig.position.set(
      pos.x + this.swayX + bobX,
      pos.y + this.swayY + bobY - reloadDip - raise * 0.25,
      pos.z + this.kickZ,
    );
    this.rig.rotation.set(
      this.swayY * 2 - this.kickZ * 1.2 - reloadTilt - raise * 0.8,
      this.swayX * 2,
      this.swayX,
    );
  }

  // ------------------------------------------------------------------
  // Procedural voxel fallback viewmodels (used until Meshy GLBs load)
  // ------------------------------------------------------------------

  private static gunMats(): {
    metal: THREE.MeshStandardMaterial;
    dark: THREE.MeshStandardMaterial;
    wood: THREE.MeshStandardMaterial;
    accent: THREE.MeshStandardMaterial;
  } {
    return {
      metal: new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.45, metalness: 0.7 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x25282e, roughness: 0.55, metalness: 0.6 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x5c4128, roughness: 0.8, metalness: 0.05 }),
      accent: new THREE.MeshStandardMaterial({
        color: 0xe8963f,
        roughness: 0.4,
        metalness: 0.3,
        emissive: 0xe8963f,
        emissiveIntensity: 0.25,
      }),
    };
  }

  private static vbox(
    mats: THREE.MeshStandardMaterial,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    m.position.set(x, y, z);
    return m;
  }

  static buildFallbackRifle(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'rifle_fallback';
    const m = WeaponSystem.gunMats();
    const v = WeaponSystem.vbox;
    g.add(
      v(m.dark, 0.05, 0.07, 0.34, 0, 0, -0.18), // receiver
      v(m.metal, 0.032, 0.032, 0.3, 0, 0.012, -0.46), // barrel
      v(m.dark, 0.045, 0.05, 0.06, 0, 0.005, -0.62), // muzzle brake
      v(m.wood, 0.05, 0.06, 0.16, 0, -0.01, 0.02), // stock front
      v(m.wood, 0.05, 0.09, 0.1, 0, -0.045, 0.1), // stock butt
      v(m.dark, 0.03, 0.1, 0.05, 0, -0.075, -0.14), // magazine
      v(m.dark, 0.028, 0.06, 0.045, 0, -0.055, 0.0), // grip
      v(m.metal, 0.012, 0.03, 0.012, 0, 0.05, -0.34), // front sight
      v(m.metal, 0.03, 0.028, 0.03, 0, 0.048, -0.06), // rear sight
      v(m.accent, 0.052, 0.012, 0.012, 0, 0.028, -0.18), // amber charge strip
      v(m.wood, 0.054, 0.03, 0.14, 0, -0.028, -0.32), // handguard
    );
    for (const c of g.children) (c as THREE.Mesh).castShadow = false;
    return g;
  }

  static buildFallbackScattergun(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'scattergun_fallback';
    const m = WeaponSystem.gunMats();
    const v = WeaponSystem.vbox;
    g.add(
      v(m.dark, 0.055, 0.075, 0.26, 0, 0, -0.1), // receiver
      v(m.metal, 0.042, 0.042, 0.32, 0, 0.014, -0.38), // barrel
      v(m.metal, 0.036, 0.036, 0.26, 0, -0.03, -0.36), // tube mag
      v(m.wood, 0.05, 0.05, 0.12, 0, -0.03, -0.3), // pump
      v(m.wood, 0.05, 0.085, 0.14, 0, -0.03, 0.1), // stock
      v(m.dark, 0.03, 0.06, 0.05, 0, -0.06, 0.0), // grip
      v(m.metal, 0.014, 0.03, 0.014, 0, 0.05, -0.5), // sight
      v(m.accent, 0.058, 0.012, 0.012, 0, 0.032, -0.08), // amber strip
    );
    for (const c of g.children) (c as THREE.Mesh).castShadow = false;
    return g;
  }
}
