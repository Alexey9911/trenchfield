import * as THREE from 'three';
import { RENDER, WORLD, type MapTheme } from '../game/constants';

/**
 * Themed sky: gradient dome shader with sun/moon disc, silhouette hill ring,
 * drifting cloud cards, optional stars, and the key/fill light rig.
 */
export class Sky {
  readonly group = new THREE.Group();
  readonly sunDir: THREE.Vector3;
  readonly keyLight: THREE.DirectionalLight;
  private clouds: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, theme: MapTheme) {
    this.group.name = 'sky';
    this.sunDir = new THREE.Vector3(-0.55, theme.sunDirY, -0.79).normalize();
    const center = new THREE.Vector3(WORLD.sizeX / 2, 0, WORLD.sizeZ / 2);

    // --- gradient dome -----------------------------------------------------
    const domeGeo = new THREE.SphereGeometry(240, 24, 14);
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(theme.zenith) },
        mid: { value: new THREE.Color(theme.mid) },
        horizon: { value: new THREE.Color(theme.horizon) },
        sunDir: { value: this.sunDir.clone() },
        sunColor: { value: new THREE.Color(theme.discColor) },
        haze: { value: new THREE.Vector3(...theme.hazeColor) },
        corePow: { value: theme.discCorePow },
        coreStrength: { value: theme.discCoreStrength },
        haloPow: { value: theme.discHaloPow },
        haloStrength: { value: theme.discHaloStrength },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith;
        uniform vec3 mid;
        uniform vec3 horizon;
        uniform vec3 sunDir;
        uniform vec3 sunColor;
        uniform vec3 haze;
        uniform float corePow;
        uniform float coreStrength;
        uniform float haloPow;
        uniform float haloStrength;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -0.05, 1.0);
          vec3 col = h < 0.22
            ? mix(horizon, mid, smoothstep(-0.05, 0.22, h))
            : mix(mid, zenith, smoothstep(0.22, 0.85, h));
          float sunAmt = max(dot(normalize(vDir), sunDir), 0.0);
          col += sunColor * pow(sunAmt, haloPow) * haloStrength;
          col += sunColor * pow(sunAmt, corePow) * coreStrength;
          col = mix(col, haze, smoothstep(0.16, 0.0, h) * 0.35);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.position.copy(center);
    dome.renderOrder = -10;
    this.group.add(dome);

    // --- silhouette hills ring ---------------------------------------------
    const hillMat = new THREE.MeshBasicMaterial({
      color: theme.hillColor,
      fog: false,
      side: THREE.BackSide,
    });
    const hillGeo = new THREE.CylinderGeometry(150, 150, 26, 64, 4, true);
    const pos = hillGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = pos.getY(i);
      const a = Math.atan2(z, x);
      if (y > 0) {
        const ridge =
          Math.sin(a * 3.0 + 1.7) * 4 + Math.sin(a * 7.0) * 2.5 + Math.sin(a * 13.0 + 0.4) * 1.2;
        pos.setY(i, y + ridge);
      }
    }
    hillGeo.computeVertexNormals();
    const hills = new THREE.Mesh(hillGeo, hillMat);
    hills.position.set(center.x, 4, center.z);
    hills.renderOrder = -9;
    this.group.add(hills);

    // --- stars (night) -------------------------------------------------------
    if (theme.stars) {
      const starCount = 420;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        // upper hemisphere only
        const u = Math.random();
        const v = Math.random() * 0.85 + 0.08;
        const phi = u * Math.PI * 2;
        const y = v;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        starPos[i * 3] = center.x + Math.cos(phi) * r * 225;
        starPos[i * 3 + 1] = y * 225;
        starPos[i * 3 + 2] = center.z + Math.sin(phi) * r * 225;
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      const stars = new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({
          color: 0xd8e2ff,
          size: 1.4,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.85,
          fog: false,
          depthWrite: false,
        }),
      );
      stars.renderOrder = -9;
      this.group.add(stars);
    }

    // --- cloud cards ---------------------------------------------------------
    const cloudTex = Sky.makeCloudTexture();
    for (let i = 0; i < 7; i++) {
      const w = 60 + Math.random() * 70;
      const cloudMat = new THREE.MeshBasicMaterial({
        map: cloudTex,
        transparent: true,
        opacity: theme.cloudOpacity,
        depthWrite: false,
        fog: false,
        color: i % 2 === 0 ? theme.cloudColorA : theme.cloudColorB,
      });
      const cloud = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.28), cloudMat);
      const a = (i / 7) * Math.PI * 2 + Math.random();
      cloud.position.set(
        center.x + Math.cos(a) * (120 + Math.random() * 60),
        38 + Math.random() * 30,
        center.z + Math.sin(a) * (120 + Math.random() * 60),
      );
      cloud.lookAt(center.x, cloud.position.y, center.z);
      cloud.renderOrder = -8;
      this.clouds.push(cloud);
      this.group.add(cloud);
    }

    // --- lighting rig --------------------------------------------------------
    this.keyLight = new THREE.DirectionalLight(theme.keyColor, theme.keyIntensity);
    this.keyLight.position.copy(center.clone().addScaledVector(this.sunDir, 90));
    this.keyLight.target.position.copy(center);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    this.keyLight.shadow.camera.near = 20;
    this.keyLight.shadow.camera.far = 190;
    const s = 58;
    this.keyLight.shadow.camera.left = -s;
    this.keyLight.shadow.camera.right = s;
    this.keyLight.shadow.camera.top = s;
    this.keyLight.shadow.camera.bottom = -s;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.03;
    this.group.add(this.keyLight, this.keyLight.target);

    const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity);
    this.group.add(hemi);

    const rim = new THREE.DirectionalLight(theme.rimColor, theme.rimIntensity);
    rim.position.copy(center.clone().add(new THREE.Vector3(40, 30, 70)));
    rim.target.position.copy(center);
    this.group.add(rim, rim.target);

    scene.add(this.group);
  }

  private static makeCloudTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 128, 64);
      for (let i = 0; i < 11; i++) {
        const x = 26 + Math.random() * 76;
        const y = 24 + Math.random() * 16;
        const r = 7 + Math.random() * 13;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.16)');
        g.addColorStop(0.6, 'rgba(255,255,255,0.07)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  update(dt: number): void {
    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      cloud.position.x += dt * (0.4 + i * 0.07);
      if (cloud.position.x > WORLD.sizeX / 2 + 200) cloud.position.x -= 400;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
  }
}
