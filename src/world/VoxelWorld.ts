import * as THREE from 'three';
import { BlockAtlas, TILE, type TileId } from './BlockAtlas';
import { WORLD } from '../game/constants';

export const BLOCK = {
  air: 0,
  dirt: 1,
  mud: 2,
  sod: 3,
  sandbag: 4,
  plank: 5,
  duckboard: 6,
  stone: 7,
  metal: 8,
  char: 9,
  concrete: 10,
  brick: 11,
} as const;

export type BlockId = (typeof BLOCK)[keyof typeof BLOCK];

/** face order: +x, -x, +y, -y, +z, -z */
const BLOCK_TILES: Record<number, [TileId, TileId, TileId, TileId, TileId, TileId]> = {
  [BLOCK.dirt]: [TILE.dirt, TILE.dirt, TILE.dirt, TILE.dirt, TILE.dirt, TILE.dirt],
  [BLOCK.mud]: [TILE.mud, TILE.mud, TILE.mud, TILE.mud, TILE.mud, TILE.mud],
  [BLOCK.sod]: [TILE.sodSide, TILE.sodSide, TILE.sodTop, TILE.dirt, TILE.sodSide, TILE.sodSide],
  [BLOCK.sandbag]: [TILE.sandbag, TILE.sandbag, TILE.sandbag, TILE.sandbag, TILE.sandbag, TILE.sandbag],
  [BLOCK.plank]: [TILE.plank, TILE.plank, TILE.plank, TILE.plank, TILE.plank, TILE.plank],
  [BLOCK.duckboard]: [TILE.plank, TILE.plank, TILE.duckboard, TILE.plank, TILE.plank, TILE.plank],
  [BLOCK.stone]: [TILE.stone, TILE.stone, TILE.stone, TILE.stone, TILE.stone, TILE.stone],
  [BLOCK.metal]: [TILE.metal, TILE.metal, TILE.metal, TILE.metal, TILE.metal, TILE.metal],
  [BLOCK.char]: [TILE.char, TILE.char, TILE.char, TILE.char, TILE.char, TILE.char],
  [BLOCK.concrete]: [TILE.concrete, TILE.concrete, TILE.concrete, TILE.concrete, TILE.concrete, TILE.concrete],
  [BLOCK.brick]: [TILE.brick, TILE.brick, TILE.brick, TILE.brick, TILE.brick, TILE.brick],
};

/** Blocks a grenade can excavate. */
const SOFT = new Set<number>([BLOCK.dirt, BLOCK.mud, BLOCK.sod, BLOCK.sandbag, BLOCK.char]);

interface FaceDef {
  dir: [number, number, number];
  corners: Array<[number, number, number]>;
  shade: number;
}

// corner order chosen so uv (0,0)(1,0)(1,1)(0,1) maps sensibly per face
const FACES: FaceDef[] = [
  { dir: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.86 },
  { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.86 },
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.0 },
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.55 },
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.92 },
  { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.78 },
];

const AO_LEVELS = [0.52, 0.7, 0.86, 1.0];

export interface VoxelHit {
  x: number;
  y: number;
  z: number;
  block: number;
  distance: number;
  normal: THREE.Vector3;
  point: THREE.Vector3;
}

export class VoxelWorld {
  readonly sx = WORLD.sizeX;
  readonly sy = WORLD.sizeY;
  readonly sz = WORLD.sizeZ;
  private data: Uint8Array;
  private chunkMeshes = new Map<string, THREE.Mesh>();
  private dirtyChunks = new Set<string>();
  private material: THREE.MeshStandardMaterial;
  readonly group = new THREE.Group();
  readonly atlas: BlockAtlas;

  constructor() {
    this.data = new Uint8Array(this.sx * this.sy * this.sz);
    this.atlas = new BlockAtlas();
    this.material = new THREE.MeshStandardMaterial({
      map: this.atlas.texture,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0,
    });
    this.group.name = 'voxelWorld';
  }

  private idx(x: number, y: number, z: number): number {
    return (y * this.sz + z) * this.sx + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.sx && y >= 0 && y < this.sy && z >= 0 && z < this.sz;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return BLOCK.air;
    return this.data[this.idx(x, y, z)];
  }

  set(x: number, y: number, z: number, block: number): void {
    if (!this.inBounds(x, y, z)) return;
    const i = this.idx(x, y, z);
    if (this.data[i] === block) return;
    this.data[i] = block;
    const cx = Math.floor(x / WORLD.chunk);
    const cz = Math.floor(z / WORLD.chunk);
    this.dirtyChunks.add(`${cx},${cz}`);
    // neighbours at chunk borders
    if (x % WORLD.chunk === 0) this.dirtyChunks.add(`${cx - 1},${cz}`);
    if (x % WORLD.chunk === WORLD.chunk - 1) this.dirtyChunks.add(`${cx + 1},${cz}`);
    if (z % WORLD.chunk === 0) this.dirtyChunks.add(`${cx},${cz - 1}`);
    if (z % WORLD.chunk === WORLD.chunk - 1) this.dirtyChunks.add(`${cx},${cz + 1}`);
  }

  isSolid(x: number, y: number, z: number): boolean {
    if (y < 0) return true; // bedrock below the map
    return this.get(x, y, z) !== BLOCK.air;
  }

  isSoft(x: number, y: number, z: number): boolean {
    return SOFT.has(this.get(x, y, z));
  }

  highestSolidY(x: number, z: number): number {
    for (let y = this.sy - 1; y >= 0; y--) {
      if (this.get(Math.floor(x), y, Math.floor(z)) !== BLOCK.air) return y;
    }
    return 0;
  }

  buildAll(): void {
    const chunksX = Math.ceil(this.sx / WORLD.chunk);
    const chunksZ = Math.ceil(this.sz / WORLD.chunk);
    for (let cx = 0; cx < chunksX; cx++) {
      for (let cz = 0; cz < chunksZ; cz++) {
        this.buildChunk(cx, cz);
      }
    }
    this.dirtyChunks.clear();
  }

  rebuildDirty(): void {
    for (const key of this.dirtyChunks) {
      const [cx, cz] = key.split(',').map(Number);
      if (cx >= 0 && cz >= 0 && cx * WORLD.chunk < this.sx && cz * WORLD.chunk < this.sz) {
        this.buildChunk(cx, cz);
      }
    }
    this.dirtyChunks.clear();
  }

  private buildChunk(cx: number, cz: number): void {
    const key = `${cx},${cz}`;
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.chunkMeshes.delete(key);
    }

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    const x0 = cx * WORLD.chunk;
    const z0 = cz * WORLD.chunk;
    const x1 = Math.min(x0 + WORLD.chunk, this.sx);
    const z1 = Math.min(z0 + WORLD.chunk, this.sz);

    for (let y = 0; y < this.sy; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const block = this.get(x, y, z);
          if (block === BLOCK.air) continue;
          const tiles = BLOCK_TILES[block];
          if (!tiles) continue;

          for (let f = 0; f < 6; f++) {
            const face = FACES[f];
            const nx = x + face.dir[0];
            const ny = y + face.dir[1];
            const nz = z + face.dir[2];
            if (ny >= 0 && this.isSolid(nx, ny, nz)) continue;

            const tile = tiles[f];
            const { u0, v0, u1, v1 } = this.atlas.uv(tile);
            const faceUV: Array<[number, number]> = [
              [u0, v0],
              [u1, v0],
              [u1, v1],
              [u0, v1],
            ];

            const base = positions.length / 3;
            const ao: number[] = [];
            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c];
              positions.push(x + corner[0], y + corner[1], z + corner[2]);
              normals.push(face.dir[0], face.dir[1], face.dir[2]);
              uvs.push(faceUV[c][0], faceUV[c][1]);
              const aoV = this.vertexAO(x, y, z, face, corner);
              ao.push(aoV);
              const shade = face.shade * AO_LEVELS[aoV];
              colors.push(shade, shade, shade);
            }
            // flip quad to keep AO smooth
            if (ao[0] + ao[2] > ao[1] + ao[3]) {
              indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            } else {
              indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
            }
          }
        }
      }
    }

    if (indices.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `chunk_${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.chunkMeshes.set(key, mesh);
    this.group.add(mesh);
  }

  private vertexAO(
    x: number,
    y: number,
    z: number,
    face: FaceDef,
    corner: [number, number, number],
  ): number {
    const [dx, dy, dz] = face.dir;
    // For the vertex, find the two side neighbours + corner neighbour on the face plane.
    const cx = corner[0] === 1 ? 1 : -1;
    const cy = corner[1] === 1 ? 1 : -1;
    const cz = corner[2] === 1 ? 1 : -1;

    let s1 = false;
    let s2 = false;
    let c = false;
    if (dy !== 0) {
      s1 = this.isSolid(x + cx, y + dy, z);
      s2 = this.isSolid(x, y + dy, z + cz);
      c = this.isSolid(x + cx, y + dy, z + cz);
    } else if (dx !== 0) {
      s1 = this.isSolid(x + dx, y + cy, z);
      s2 = this.isSolid(x + dx, y, z + cz);
      c = this.isSolid(x + dx, y + cy, z + cz);
    } else {
      s1 = this.isSolid(x + cx, y, z + dz);
      s2 = this.isSolid(x, y + cy, z + dz);
      c = this.isSolid(x + cx, y + cy, z + dz);
    }
    if (s1 && s2) return 0;
    return 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (c ? 1 : 0));
  }

  /** Amanatides & Woo voxel traversal. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): VoxelHit | null {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;

    const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;

    const fracX = origin.x - x;
    const fracY = origin.y - y;
    const fracZ = origin.z - z;
    let tMaxX = dir.x !== 0 ? (dir.x > 0 ? (1 - fracX) * tDeltaX : fracX * tDeltaX) : Infinity;
    let tMaxY = dir.y !== 0 ? (dir.y > 0 ? (1 - fracY) * tDeltaY : fracY * tDeltaY) : Infinity;
    let tMaxZ = dir.z !== 0 ? (dir.z > 0 ? (1 - fracZ) * tDeltaZ : fracZ * tDeltaZ) : Infinity;

    let dist = 0;
    let normal = new THREE.Vector3();

    while (dist <= maxDist) {
      if (y >= 0 && this.get(x, y, z) !== BLOCK.air) {
        return {
          x,
          y,
          z,
          block: this.get(x, y, z),
          distance: dist,
          normal: normal.clone(),
          point: origin.clone().addScaledVector(dir, dist),
        };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        dist = tMaxX;
        tMaxX += tDeltaX;
        x += stepX;
        normal = new THREE.Vector3(-stepX, 0, 0);
      } else if (tMaxY < tMaxZ) {
        dist = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
        normal = new THREE.Vector3(0, -stepY, 0);
      } else {
        dist = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
        normal = new THREE.Vector3(0, 0, -stepZ);
      }
      if (y < 0 || y >= this.sy + 8) break;
    }
    return null;
  }

  /** True if any solid voxel overlaps the AABB. */
  boxCollides(min: THREE.Vector3, max: THREE.Vector3): boolean {
    const x0 = Math.floor(min.x);
    const x1 = Math.floor(max.x);
    const y0 = Math.floor(min.y);
    const y1 = Math.floor(max.y);
    const z0 = Math.floor(min.z);
    const z1 = Math.floor(max.z);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (this.isSolid(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  /** Carve a spherical crater of soft blocks. Returns count removed. */
  carveCrater(center: THREE.Vector3, radius: number): number {
    let removed = 0;
    const r = Math.ceil(radius);
    const cx = Math.floor(center.x);
    const cy = Math.floor(center.y);
    const cz = Math.floor(center.z);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let z = cz - r; z <= cz + r; z++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (y <= 1) continue; // keep the floor of the world
          const d = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y, z + 0.5 - center.z);
          if (d > radius) continue;
          if (this.isSoft(x, y, z)) {
            this.set(x, y, z, BLOCK.air);
            removed++;
          } else if (d < radius * 0.8 && this.get(x, y, z) === BLOCK.sod) {
            this.set(x, y, z, BLOCK.char);
          }
        }
      }
    }
    // char the crater rim
    for (let z = cz - r - 1; z <= cz + r + 1; z++) {
      for (let x = cx - r - 1; x <= cx + r + 1; x++) {
        const topY = this.highestSolidY(x, z);
        const d = Math.hypot(x + 0.5 - center.x, z + 0.5 - center.z);
        if (d <= radius + 0.8 && topY > 1) {
          const b = this.get(x, topY, z);
          if (b === BLOCK.sod || b === BLOCK.dirt) this.set(x, topY, z, BLOCK.char);
        }
      }
    }
    this.rebuildDirty();
    return removed;
  }

  diagnostics(): { chunks: number } {
    return { chunks: this.chunkMeshes.size };
  }
}
