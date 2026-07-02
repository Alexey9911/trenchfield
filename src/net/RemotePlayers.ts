import * as THREE from 'three';
import { BOT_ARCHETYPES, damp } from '../game/constants';
import { createBotBody, type BotBody } from '../entities/BotBodyFactory';
import type { SnapshotPlayer } from './NetClient';

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

interface Remote {
  id: string;
  nick: string;
  body: BotBody;
  buffer: Snap[];
  alive: boolean;
  hp: number;
  weapon: string;
  walkPhase: number;
  lastPos: THREE.Vector3;
  deathTime: number;
}

const INTERP_DELAY_MS = 110;

/** Renders and interpolates other players using the voxel soldier bodies. */
export class RemotePlayers {
  private remotes = new Map<string, Remote>();
  private clockOffset = 0;
  private offsetInit = false;

  constructor(private scene: THREE.Scene) {}

  addPlayer(id: string, nick: string): void {
    if (this.remotes.has(id)) return;
    const archetypes = [BOT_ARCHETYPES.rifleman, BOT_ARCHETYPES.scout, BOT_ARCHETYPES.shock];
    const body = createBotBody(archetypes[this.remotes.size % archetypes.length], nick);
    this.scene.add(body.root);
    this.remotes.set(id, {
      id,
      nick,
      body,
      buffer: [],
      alive: true,
      hp: 100,
      weapon: 'rifle',
      walkPhase: 0,
      lastPos: new THREE.Vector3(),
      deathTime: 0,
    });
  }

  removePlayer(id: string): void {
    const r = this.remotes.get(id);
    if (r) {
      this.scene.remove(r.body.root);
      this.remotes.delete(id);
    }
  }

  clear(): void {
    for (const r of this.remotes.values()) this.scene.remove(r.body.root);
    this.remotes.clear();
  }

  ids(): string[] {
    return [...this.remotes.keys()];
  }

  /** world position of a remote's chest (for hit tests / VFX) */
  chestPosition(id: string): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    if (!r || !r.alive) return null;
    return r.body.root.position.clone().add(new THREE.Vector3(0, 1.2, 0));
  }

  headPosition(id: string): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    if (!r || !r.alive) return null;
    return r.body.root.position.clone().add(new THREE.Vector3(0, 1.55, 0));
  }

  muzzlePosition(id: string): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    if (!r) return null;
    const yaw = r.body.root.rotation.y;
    return r.body.root.position
      .clone()
      .add(new THREE.Vector3(-Math.sin(yaw) * 0.5, 1.3, -Math.cos(yaw) * 0.5));
  }

  /** Ray-vs-remote AABB. Returns {id, point, head} of the nearest hit. */
  intersectRay(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
  ): { id: string; point: THREE.Vector3; head: boolean; dist: number } | null {
    let best: { id: string; point: THREE.Vector3; head: boolean; dist: number } | null = null;
    const ray = new THREE.Ray(origin, dir);
    for (const r of this.remotes.values()) {
      if (!r.alive) continue;
      const p = r.body.root.position;
      const box = new THREE.Box3(
        new THREE.Vector3(p.x - 0.4, p.y, p.z - 0.4),
        new THREE.Vector3(p.x + 0.4, p.y + 1.9, p.z + 0.4),
      );
      const hit = new THREE.Vector3();
      if (ray.intersectBox(box, hit)) {
        const d = hit.distanceTo(origin);
        if (d <= maxDist && (!best || d < best.dist)) {
          best = { id: r.id, point: hit.clone(), head: hit.y > p.y + 1.42, dist: d };
        }
      }
    }
    return best;
  }

  applySnapshot(players: SnapshotPlayer[]): void {
    const now = performance.now();
    const seen = new Set<string>();
    for (const sp of players) {
      seen.add(sp.id);
      let r = this.remotes.get(sp.id);
      if (!r) continue; // players are registered at matchStart
      r = r as Remote;
      const wasAlive = r.alive;
      r.alive = sp.alive;
      r.hp = sp.hp;
      r.weapon = sp.w;
      if (!wasAlive && sp.alive) r.deathTime = 0;
      r.buffer.push({ t: now, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: sp.pitch });
      if (r.buffer.length > 24) r.buffer.shift();
    }
    void this.offsetInit;
    void this.clockOffset;
  }

  update(dt: number): void {
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for (const r of this.remotes.values()) {
      const root = r.body.root;
      if (!r.alive) {
        // death: keel over like bots do
        r.deathTime += dt;
        const t = Math.min(r.deathTime / 0.5, 1);
        root.rotation.x = (-Math.PI / 2) * t * t;
        root.visible = r.deathTime < 3.2;
        continue;
      }
      root.visible = true;
      root.rotation.x = 0;

      // interpolate between the two snapshots bracketing renderTime
      const buf = r.buffer;
      if (buf.length === 0) continue;
      let a = buf[0];
      let b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= renderTime && buf[i + 1].t >= renderTime) {
          a = buf[i];
          b = buf[i + 1];
          break;
        }
      }
      const span = Math.max(b.t - a.t, 1);
      const k = Math.min(Math.max((renderTime - a.t) / span, 0), 1);
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      const z = a.z + (b.z - a.z) * k;

      // walk animation from actual displacement
      const speed = root.position.distanceTo(r.lastPos) / Math.max(dt, 0.001);
      r.lastPos.copy(root.position);
      root.position.set(x, y, z);

      let yaw = a.yaw + shortestAngle(a.yaw, b.yaw) * k;
      root.rotation.y = yaw + Math.PI; // body faces view direction

      const j = r.body.joints;
      if (speed > 0.6) {
        r.walkPhase += dt * Math.min(speed, 8) * 2.4;
        const swing = Math.sin(r.walkPhase) * 0.6;
        j.legL.rotation.x = swing;
        j.legR.rotation.x = -swing;
        j.armL.rotation.x = -swing * 0.7;
      } else {
        j.legL.rotation.x = damp(j.legL.rotation.x, 0, 8, dt);
        j.legR.rotation.x = damp(j.legR.rotation.x, 0, 8, dt);
        j.armL.rotation.x = damp(j.armL.rotation.x, 0, 8, dt);
      }
      // aim arm follows pitch
      const pitch = a.pitch + (b.pitch - a.pitch) * k;
      j.armR.rotation.x = damp(j.armR.rotation.x, -Math.PI / 2 - pitch, 10, dt);
      j.head.rotation.x = damp(j.head.rotation.x, -pitch * 0.7, 8, dt);
      yaw = 0;
    }
  }

  flashHit(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    for (const m of r.body.flashables) {
      m.emissive.setRGB(0.4, 0.12, 0.08);
    }
    setTimeout(() => {
      for (const m of r.body.flashables) m.emissive.setRGB(0, 0, 0);
    }, 120);
  }
}

function shortestAngle(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
