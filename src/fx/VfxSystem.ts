import * as THREE from 'three';
import { clamp, rand } from '../game/constants';

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

interface Flash {
  sprite: THREE.Sprite;
  life: number;
}

interface Puff {
  sprite: THREE.Sprite;
  life: number;
  maxLife: number;
  vel: THREE.Vector3;
  grow: number;
}

interface DebrisState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  scale: number;
  color: THREE.Color;
}

export type SurfaceKind = 'dirt' | 'stone' | 'metal' | 'wood' | 'flesh' | 'sand';

const SURFACE_COLORS: Record<SurfaceKind, number[]> = {
  dirt: [0x6b5138, 0x4a3628, 0x7a6244],
  sand: [0x968460, 0xb0a078, 0x86745a],
  stone: [0x767472, 0x8a8886, 0x5e5c5a],
  metal: [0xffd27a, 0xffb04a, 0x8a8a92],
  wood: [0x6c4e30, 0x8a6a44, 0x5a4028],
  flesh: [0x8c2f22, 0x6e2118, 0xa04030],
};

/** Pooled, event-driven effects. No permanent allocations in hot paths. */
export class VfxSystem {
  readonly group = new THREE.Group();
  private tracers: Tracer[] = [];
  private flashes: Flash[] = [];
  private puffs: Puff[] = [];
  private debris: DebrisState[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private muzzleLight: THREE.PointLight;
  private explosionLight: THREE.PointLight;
  private dust: THREE.Points;
  private dustVel: Float32Array;
  private smokeEmitters: Array<{ pos: THREE.Vector3; timer: number }> = [];
  /** tactical smoke clouds: dense emitters with a lifetime, used for LOS blocking */
  readonly smokeClouds: Array<{ pos: THREE.Vector3; radius: number; ttl: number; timer: number }> =
    [];
  private muzzleCone: THREE.Mesh;
  private muzzleConeLife = 0;
  private flashTex: THREE.Texture;
  private puffTex: THREE.Texture;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();

  private static readonly MAX_DEBRIS = 320;
  private static readonly MAX_TRACERS = 48;
  private static readonly MAX_FLASHES = 10;
  private static readonly MAX_PUFFS = 90;

  constructor(scene: THREE.Scene, worldCenter: THREE.Vector3) {
    this.group.name = 'vfx';
    scene.add(this.group);

    this.flashTex = VfxSystem.radialTexture(1, 0.15);
    this.puffTex = VfxSystem.radialTexture(0.5, 0.7);

    // tracers
    const tracerGeo = new THREE.BoxGeometry(0.022, 0.022, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffc46b,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    for (let i = 0; i < VfxSystem.MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    // muzzle flashes
    for (let i = 0; i < VfxSystem.MAX_FLASHES; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.flashTex,
          color: 0xffd9a0,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      this.group.add(sprite);
      this.flashes.push({ sprite, life: 0 });
    }

    // smoke puffs
    for (let i = 0; i < VfxSystem.MAX_PUFFS; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.puffTex,
          color: 0x8a8078,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      this.group.add(sprite);
      this.puffs.push({
        sprite,
        life: 0,
        maxLife: 1,
        vel: new THREE.Vector3(),
        grow: 1,
      });
    }

    // debris cubes
    const cubeGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    const cubeMat = new THREE.MeshLambertMaterial();
    this.debrisMesh = new THREE.InstancedMesh(cubeGeo, cubeMat, VfxSystem.MAX_DEBRIS);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(VfxSystem.MAX_DEBRIS * 3),
      3,
    );
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.group.add(this.debrisMesh);

    // lights
    this.muzzleLight = new THREE.PointLight(0xffc46b, 0, 9, 2);
    this.explosionLight = new THREE.PointLight(0xff9a3d, 0, 22, 2);
    this.group.add(this.muzzleLight, this.explosionLight);

    // short-lived muzzle fire cone
    this.muzzleCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.055, 0.3, 7, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffcf7d,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      }),
    );
    this.muzzleCone.visible = false;
    this.group.add(this.muzzleCone);

    // ambient drifting dust/ash
    const dustCount = 240;
    const dustPos = new Float32Array(dustCount * 3);
    this.dustVel = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      dustPos[i * 3] = worldCenter.x + rand(-38, 38);
      dustPos[i * 3 + 1] = rand(6, 20);
      dustPos[i * 3 + 2] = worldCenter.z + rand(-38, 38);
      this.dustVel[i * 3] = rand(0.15, 0.5);
      this.dustVel[i * 3 + 1] = rand(-0.12, 0.06);
      this.dustVel[i * 3 + 2] = rand(-0.1, 0.1);
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    this.dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        color: 0xc4a276,
        size: 0.055,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  private static radialTexture(hardness: number, softness: number): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
      g.addColorStop(0, `rgba(255,255,255,${hardness})`);
      g.addColorStop(softness, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  addSmokeColumn(pos: THREE.Vector3): void {
    this.smokeEmitters.push({ pos: pos.clone(), timer: rand(0, 0.5) });
  }

  clearSmokeColumns(): void {
    this.smokeEmitters.length = 0;
    this.smokeClouds.length = 0;
  }

  setDustColor(color: number): void {
    (this.dust.material as THREE.PointsMaterial).color.setHex(color);
  }

  muzzleFlash(pos: THREE.Vector3, big = false, dir?: THREE.Vector3): void {
    const f = this.flashes.find((x) => x.life <= 0);
    if (f) {
      f.life = 0.055;
      f.sprite.visible = true;
      f.sprite.position.copy(pos);
      f.sprite.scale.setScalar(big ? rand(0.7, 0.95) : rand(0.35, 0.52));
      (f.sprite.material as THREE.SpriteMaterial).opacity = 1;
      (f.sprite.material as THREE.SpriteMaterial).rotation = rand(0, Math.PI * 2);
    }
    this.muzzleLight.position.copy(pos);
    this.muzzleLight.intensity = big ? 30 : 18;

    if (dir) {
      // fire cone pointing downrange
      this.muzzleConeLife = 0.045;
      this.muzzleCone.visible = true;
      this.muzzleCone.position.copy(pos).addScaledVector(dir, 0.16);
      this.muzzleCone.scale.setScalar(big ? 1.6 : 1);
      this.muzzleCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      (this.muzzleCone.material as THREE.MeshBasicMaterial).opacity = 0.85;

      // hot sparks + a smoke wisp
      const sparkCount = big ? 4 : 2;
      for (let i = 0; i < sparkCount; i++) {
        this.spawnDebris(
          pos.clone(),
          dir
            .clone()
            .multiplyScalar(rand(4, 9))
            .add(new THREE.Vector3(rand(-1.4, 1.4), rand(0.4, 1.8), rand(-1.4, 1.4))),
          [0xffd27a, 0xffb04a][i % 2],
          rand(0.14, 0.3),
          rand(0.3, 0.5),
        );
      }
      this.puff(
        pos.clone().addScaledVector(dir, 0.22),
        dir.clone().multiplyScalar(rand(0.6, 1.2)).add(new THREE.Vector3(0, rand(0.4, 0.8), 0)),
        0x9a9086,
        rand(0.4, 0.65),
        0.28,
        2.2,
      );
    }
  }

  /** Tactical smoke: lingering dense cloud that blocks bot line of sight. */
  spawnSmokeCloud(pos: THREE.Vector3, radius: number, duration: number): void {
    this.smokeClouds.push({ pos: pos.clone(), radius, ttl: duration, timer: 0 });
    // initial dense burst
    for (let i = 0; i < 14; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(0, radius * 0.7);
      this.puff(
        pos.clone().add(new THREE.Vector3(Math.cos(a) * r, rand(0.2, 1.6), Math.sin(a) * r)),
        new THREE.Vector3(rand(-0.4, 0.4), rand(0.3, 0.9), rand(-0.4, 0.4)),
        0x9aa0a8,
        rand(2.2, 3.6),
        rand(1.6, 2.6),
        1.8,
      );
    }
  }

  /** True if the segment from a to b crosses any active smoke cloud. */
  segmentBlockedBySmoke(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const c of this.smokeClouds) {
      // closest point on segment to cloud center
      const ab = b.clone().sub(a);
      const t = clamp(c.pos.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 0.0001), 0, 1);
      const closest = a.clone().addScaledVector(ab, t);
      if (closest.distanceTo(c.pos) < c.radius) return true;
    }
    return false;
  }

  /** Flashbang burst: hard white flash + light. */
  flashBang(pos: THREE.Vector3): void {
    this.explosionLight.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0));
    this.explosionLight.intensity = 140;
    const f = this.flashes.find((x) => x.life <= 0);
    if (f) {
      f.life = 0.12;
      f.sprite.visible = true;
      f.sprite.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0));
      f.sprite.scale.setScalar(6);
      (f.sprite.material as THREE.SpriteMaterial).opacity = 1;
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers.find((x) => x.life <= 0);
    if (!t) return;
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.5) return;
    t.life = 0.07;
    t.mesh.visible = true;
    t.mesh.position.copy(from).addScaledVector(dir, 0.5);
    t.mesh.scale.set(1, 1, len);
    t.mesh.lookAt(to);
  }

  impact(pos: THREE.Vector3, normal: THREE.Vector3, surface: SurfaceKind): void {
    const colors = SURFACE_COLORS[surface];
    const count = surface === 'flesh' ? 9 : 7;
    for (let i = 0; i < count; i++) {
      this.spawnDebris(
        pos,
        normal
          .clone()
          .multiplyScalar(rand(1.4, 3.4))
          .add(new THREE.Vector3(rand(-1.6, 1.6), rand(0.6, 3.0), rand(-1.6, 1.6))),
        colors[i % colors.length],
        rand(0.4, 0.95),
        surface === 'flesh' ? rand(0.6, 1) : rand(0.5, 0.9),
      );
    }
    if (surface === 'metal' || surface === 'stone') {
      // quick spark flash
      const f = this.flashes.find((x) => x.life <= 0);
      if (f) {
        f.life = 0.04;
        f.sprite.visible = true;
        f.sprite.position.copy(pos).addScaledVector(normal, 0.06);
        f.sprite.scale.setScalar(0.22);
        (f.sprite.material as THREE.SpriteMaterial).opacity = 0.9;
      }
    }
    // dust puff
    this.puff(
      pos.clone().addScaledVector(normal, 0.12),
      normal.clone().multiplyScalar(0.7),
      surface === 'flesh' ? 0x6e2118 : 0x9a8a74,
      rand(0.35, 0.6),
      0.35,
      1.6,
    );
  }

  bodyBurst(pos: THREE.Vector3, clothColor: number): void {
    for (let i = 0; i < 16; i++) {
      const palette = i % 3 === 0 ? 0x8c2f22 : clothColor;
      this.spawnDebris(
        pos,
        new THREE.Vector3(rand(-3, 3), rand(1.5, 5), rand(-3, 3)),
        palette,
        rand(0.7, 1.4),
        rand(0.8, 1.3),
      );
    }
  }

  explosion(pos: THREE.Vector3): void {
    this.explosionLight.position.copy(pos).add(new THREE.Vector3(0, 0.8, 0));
    this.explosionLight.intensity = 90;

    const f = this.flashes.find((x) => x.life <= 0);
    if (f) {
      f.life = 0.09;
      f.sprite.visible = true;
      f.sprite.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0));
      f.sprite.scale.setScalar(4.2);
      (f.sprite.material as THREE.SpriteMaterial).opacity = 1;
    }

    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2);
      const up = rand(1.2, 7);
      this.spawnDebris(
        pos.clone().add(new THREE.Vector3(0, 0.4, 0)),
        new THREE.Vector3(Math.cos(a) * rand(1, 6), up, Math.sin(a) * rand(1, 6)),
        [0x4a3628, 0x6b5138, 0x2c2624, 0xd97a2b][i % 4],
        rand(0.8, 1.6),
        rand(1, 2.2),
      );
    }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.puff(
        pos.clone().add(new THREE.Vector3(Math.cos(a) * 0.8, rand(0.2, 1.4), Math.sin(a) * 0.8)),
        new THREE.Vector3(Math.cos(a) * rand(1, 2.4), rand(1, 2.6), Math.sin(a) * rand(1, 2.4)),
        i % 2 === 0 ? 0x3a322c : 0x776a58,
        rand(1.0, 1.9),
        rand(1.4, 2.4),
        2.6,
      );
    }
  }

  private puff(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    color: number,
    life: number,
    scale: number,
    grow: number,
  ): void {
    const p = this.puffs.find((x) => x.life <= 0);
    if (!p) return;
    p.life = life;
    p.maxLife = life;
    p.vel.copy(vel);
    p.grow = grow;
    p.sprite.visible = true;
    p.sprite.position.copy(pos);
    p.sprite.scale.setScalar(scale);
    const mat = p.sprite.material as THREE.SpriteMaterial;
    mat.color.setHex(color);
    mat.opacity = 0.55;
    mat.rotation = rand(0, Math.PI * 2);
  }

  private spawnDebris(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    color: number,
    life: number,
    scale: number,
  ): void {
    if (this.debris.length >= VfxSystem.MAX_DEBRIS) this.debris.shift();
    this.debris.push({
      pos: pos.clone(),
      vel,
      life,
      scale,
      color: new THREE.Color(color),
    });
  }

  update(dt: number, elapsed: number): void {
    // tracers
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
    // flashes
    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        (f.sprite.material as THREE.SpriteMaterial).opacity = Math.max(f.life / 0.06, 0);
        if (f.life <= 0) f.sprite.visible = false;
      }
    }
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 260);
    this.explosionLight.intensity = Math.max(0, this.explosionLight.intensity - dt * 300);

    // puffs
    for (const p of this.puffs) {
      if (p.life > 0) {
        p.life -= dt;
        p.sprite.position.addScaledVector(p.vel, dt);
        p.vel.y += dt * 0.4;
        p.vel.multiplyScalar(1 - dt * 0.8);
        p.sprite.scale.multiplyScalar(1 + p.grow * dt * 0.55);
        const k = Math.max(p.life / p.maxLife, 0);
        (p.sprite.material as THREE.SpriteMaterial).opacity = 0.5 * k;
        if (p.life <= 0) p.sprite.visible = false;
      }
    }

    // muzzle cone fade
    if (this.muzzleConeLife > 0) {
      this.muzzleConeLife -= dt;
      (this.muzzleCone.material as THREE.MeshBasicMaterial).opacity = Math.max(
        (this.muzzleConeLife / 0.045) * 0.85,
        0,
      );
      if (this.muzzleConeLife <= 0) this.muzzleCone.visible = false;
    }

    // tactical smoke clouds: continuous dense emission while alive
    for (let i = this.smokeClouds.length - 1; i >= 0; i--) {
      const c = this.smokeClouds[i];
      c.ttl -= dt;
      if (c.ttl <= 0) {
        this.smokeClouds.splice(i, 1);
        continue;
      }
      c.timer -= dt;
      if (c.timer <= 0) {
        c.timer = 0.14;
        const a = rand(0, Math.PI * 2);
        const r = rand(0, c.radius * 0.75);
        this.puff(
          c.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, rand(0.2, 2.0), Math.sin(a) * r)),
          new THREE.Vector3(rand(-0.3, 0.5), rand(0.25, 0.7), rand(-0.3, 0.3)),
          0x9aa0a8,
          rand(2.0, 3.2),
          rand(1.7, 2.6),
          1.5,
        );
      }
    }

    // smoke columns
    for (const e of this.smokeEmitters) {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.timer = rand(0.5, 0.85);
        this.puff(
          e.pos.clone().add(new THREE.Vector3(rand(-0.3, 0.3), 0, rand(-0.3, 0.3))),
          new THREE.Vector3(rand(0.2, 0.6), rand(1.0, 1.6), rand(-0.2, 0.2)),
          0x2e2a28,
          rand(2.4, 3.6),
          rand(0.9, 1.5),
          1.5,
        );
      }
    }

    // debris
    let count = 0;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.debris.splice(i, 1);
        continue;
      }
      d.vel.y -= 14 * dt;
      d.pos.addScaledVector(d.vel, dt);
      if (d.pos.y < 0.5) {
        d.pos.y = 0.5;
        d.vel.y *= -0.3;
        d.vel.x *= 0.7;
        d.vel.z *= 0.7;
      }
      const s = d.scale * Math.min(d.life * 3, 1);
      this.tmpQ.setFromEuler(new THREE.Euler(d.life * 6, d.life * 4, 0));
      this.tmpS.setScalar(s);
      this.tmpM.compose(d.pos, this.tmpQ, this.tmpS);
      this.debrisMesh.setMatrixAt(count, this.tmpM);
      this.debrisMesh.setColorAt(count, d.color);
      count++;
    }
    this.debrisMesh.count = count;
    if (count > 0) {
      this.debrisMesh.instanceMatrix.needsUpdate = true;
      if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
    }

    // ambient dust drift
    const dp = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < dp.count; i++) {
      let x = dp.getX(i) + this.dustVel[i * 3] * dt;
      let y = dp.getY(i) + this.dustVel[i * 3 + 1] * dt + Math.sin(elapsed * 0.7 + i) * dt * 0.06;
      const z = dp.getZ(i) + this.dustVel[i * 3 + 2] * dt;
      if (x > 74) x = -2;
      if (y < 2) y = 20;
      if (y > 22) y = 3;
      dp.setXYZ(i, x, y, z);
    }
    dp.needsUpdate = true;
  }
}
