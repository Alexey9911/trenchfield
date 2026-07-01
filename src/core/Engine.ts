import * as THREE from 'three';
import { PALETTE, RENDER } from '../game/constants';

/** Owns renderer, scene, camera, resize and the frame loop. */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private rafId = 0;
  private fallbackTimer = 0;
  private running = false;
  private lastTime = 0;
  private onFrame: (dt: number, elapsed: number) => void = () => {};
  frame = 0;
  elapsed = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = RENDER.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.dprCap));

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x8a5a3d, RENDER.fogNear, RENDER.fogFar);

    this.camera = new THREE.PerspectiveCamera(
      RENDER.fov,
      window.innerWidth / window.innerHeight,
      0.08,
      320,
    );
    this.camera.position.set(0, 12, 0);

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  setFrameHandler(handler: (dt: number, elapsed: number) => void): void {
    this.onFrame = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.scheduleNext(tick);
      // sub-step slow frames so simulation time tracks real time
      const dtRaw = Math.min((now - this.lastTime) / 1000, 0.45);
      this.lastTime = now;
      const steps = Math.min(Math.max(Math.ceil(dtRaw / 0.05), 1), 9);
      const dt = dtRaw / steps;
      for (let s = 0; s < steps; s++) {
        this.elapsed += dt;
        this.frame += 1;
        this.onFrame(dt, this.elapsed);
      }
      this.renderer.render(this.scene, this.camera);
    };
    this.scheduleNext(tick);
  }

  /** rAF when visible; setTimeout fallback keeps headless/hidden pages alive. */
  private scheduleNext(tick: (now: number) => void): void {
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.fallbackTimer);
    this.rafId = requestAnimationFrame((now) => {
      window.clearTimeout(this.fallbackTimer);
      tick(now);
    });
    this.fallbackTimer = window.setTimeout(() => {
      cancelAnimationFrame(this.rafId);
      tick(performance.now());
    }, 300);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.fallbackTimer);
  }

  private resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.dprCap));
  };

  rendererInfo(): {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
  }
}

export const AMBIENT_TINT = PALETTE.skyMid;
