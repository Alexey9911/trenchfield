import * as THREE from 'three';
import { BLOCK, VoxelWorld } from './VoxelWorld';
import { WORLD } from '../game/constants';

export interface PropPlacement {
  position: THREE.Vector3;
  rotationY: number;
  scale?: number;
}

export interface MapLayout {
  spawns: THREE.Vector3[];
  waypoints: THREE.Vector3[];
  crates: PropPlacement[];
  barrels: PropPlacement[];
  wirePosts: PropPlacement[];
  tank: PropPlacement;
  pickupSpots: THREE.Vector3[];
  smokeColumns: THREE.Vector3[];
}

/** Deterministic pseudo-random for stable map layout. */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export function buildTrenchArena(world: VoxelWorld, seed = 1917, variant: 0 | 1 = 0): MapLayout {
  const rng = makeRng(seed);
  const G = WORLD.groundLevel;
  const SX = world.sx;
  const SZ = world.sz;

  const heightAt = (x: number, z: number): number => {
    const n =
      Math.sin(x * 0.11 + 2.1) * Math.cos(z * 0.09 + 1.4) * 1.1 +
      Math.sin(x * 0.31 + z * 0.23) * 0.55;
    return Math.round(G + n);
  };

  // --- base terrain -------------------------------------------------------
  for (let x = 0; x < SX; x++) {
    for (let z = 0; z < SZ; z++) {
      const h = heightAt(x, z);
      for (let y = 0; y <= h; y++) {
        let b: number = BLOCK.dirt;
        if (y <= 1) b = BLOCK.stone;
        else if (y === h) b = BLOCK.sod;
        else if (y >= h - 1 && rng() < 0.18) b = BLOCK.mud;
        world.set(x, z >= 0 ? y : y, z, b);
      }
    }
  }

  // --- perimeter berm ------------------------------------------------------
  for (let x = 0; x < SX; x++) {
    for (let z = 0; z < SZ; z++) {
      const edge = Math.min(x, z, SX - 1 - x, SZ - 1 - z);
      if (edge < 3) {
        const rise = 3 - edge + (edge === 0 ? 1 : 0);
        const h = heightAt(x, z);
        for (let y = h + 1; y <= h + rise; y++) {
          world.set(x, y, z, y === h + rise ? BLOCK.sod : BLOCK.dirt);
        }
      }
    }
  }

  // --- trench digger -------------------------------------------------------
  const digTrench = (points: Array<[number, number]>): THREE.Vector3[] => {
    const floorPts: THREE.Vector3[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
      for (let s = 0; s <= steps; s++) {
        const t = steps === 0 ? 0 : s / steps;
        const cx = Math.round(ax + (bx - ax) * t);
        const cz = Math.round(az + (bz - az) * t);
        const h = heightAt(cx, cz);
        const floorY = h - 2;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const x = cx + dx;
            const z = cz + dz;
            if (x < 2 || z < 2 || x >= SX - 2 || z >= SZ - 2) continue;
            // dig
            for (let y = floorY + 1; y <= h + 2; y++) world.set(x, y, z, BLOCK.air);
            world.set(x, floorY, z, BLOCK.duckboard);
            world.set(x, floorY - 1, z, BLOCK.mud);
          }
        }
        // sandbag parapets on the outer rim
        for (const side of [-2, 2]) {
          for (const [px, pz] of [
            [cx + side, cz],
            [cx, cz + side],
          ]) {
            if (px < 2 || pz < 2 || px >= SX - 2 || pz >= SZ - 2) continue;
            const ph = heightAt(px, pz);
            if (world.get(px, ph + 1, pz) === BLOCK.air && world.get(px, ph, pz) !== BLOCK.air) {
              if ((px * 7 + pz * 13) % 5 !== 0) world.set(px, ph + 1, pz, BLOCK.sandbag);
            }
          }
        }
        if (s % 6 === 0) floorPts.push(new THREE.Vector3(cx + 0.5, floorY + 1, cz + 0.5));
      }
    }
    return floorPts;
  };

  // two opposing zigzag trench lines (layout varies per map)
  const northTrench = digTrench(
    variant === 0
      ? [[8, 22], [18, 26], [28, 21], [40, 25], [52, 20], [64, 24]]
      : [[8, 18], [20, 23], [34, 18], [44, 24], [58, 19], [64, 26]],
  );
  const southTrench = digTrench(
    variant === 0
      ? [[8, 50], [20, 46], [32, 52], [44, 47], [56, 51], [64, 48]]
      : [[8, 54], [18, 49], [30, 54], [46, 50], [54, 55], [64, 50]],
  );
  // communication trench connecting the lines (west on day, east on night)
  const commTrench = digTrench(
    variant === 0
      ? [[14, 26], [12, 34], [16, 42], [14, 48]]
      : [[58, 26], [60, 34], [56, 44], [58, 50]],
  );

  // --- central crater field + tank wreck -----------------------------------
  const craterAt = (cx: number, cz: number, r: number, depth: number): void => {
    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        if (x < 3 || z < 3 || x >= SX - 3 || z >= SZ - 3) continue;
        const d = Math.hypot(x - cx, z - cz);
        if (d > r) continue;
        const h = heightAt(x, z);
        const dig = Math.round(depth * (1 - d / r));
        for (let y = h - dig + 1; y <= h + 3; y++) world.set(x, y, z, BLOCK.air);
        const floorY = h - dig;
        world.set(x, floorY, z, d < r * 0.7 ? BLOCK.char : BLOCK.mud);
      }
    }
  };

  craterAt(36, 36, 7, 2);
  craterAt(24, 33, 3, 1);
  craterAt(47, 40, 4, 2);
  craterAt(30, 44, 3, 1);
  craterAt(44, 28, 3, 1);
  craterAt(56, 34, 3, 1);
  craterAt(18, 38, 3, 1);

  // --- bunkers --------------------------------------------------------------
  const bunkerDoors: THREE.Vector3[] = [];
  const buildBunker = (bx: number, bz: number, faceSouth: boolean): void => {
    const h = heightAt(bx + 3, bz + 2);
    const y0 = h + 1;
    for (let x = 0; x < 7; x++) {
      for (let z = 0; z < 5; z++) {
        for (let y = 0; y < 4; y++) {
          const isWall = x === 0 || x === 6 || z === 0 || z === 4;
          const isRoof = y === 3;
          const gx = bx + x;
          const gz = bz + z;
          if (isRoof) {
            world.set(gx, y0 + y, gz, BLOCK.concrete);
          } else if (isWall) {
            // door opening + firing slits
            const doorZ = faceSouth ? 4 : 0;
            const isDoor = z === doorZ && (x === 2 || x === 3) && y < 2;
            const isSlit = y === 1 && ((z === 0 || z === 4) ? x % 2 === 1 && x > 0 && x < 6 : false);
            if (!isDoor && !isSlit) world.set(gx, y0 + y, gz, x % 3 === 0 ? BLOCK.concrete : BLOCK.brick);
            else world.set(gx, y0 + y, gz, BLOCK.air);
          } else {
            world.set(gx, y0 + y, gz, BLOCK.air);
          }
        }
        // level interior floor
        world.set(bx + x, y0 - 1, bz + z, BLOCK.plank);
      }
    }
    // sandbag rim on the roof
    for (let x = 0; x < 7; x++) {
      world.set(bx + x, y0 + 4, bz, BLOCK.sandbag);
      world.set(bx + x, y0 + 4, bz + 4, BLOCK.sandbag);
    }
    bunkerDoors.push(new THREE.Vector3(bx + 2.5, y0, bz + (faceSouth ? 5.5 : -0.5)));
  };

  buildBunker(8, 8, true);
  buildBunker(56, 8, true);
  buildBunker(8, 58, false);
  buildBunker(56, 58, false);

  // --- watchtowers -----------------------------------------------------------
  const towerTops: THREE.Vector3[] = [];
  const buildTower = (tx: number, tz: number): void => {
    const h = heightAt(tx, tz);
    const legH = 5;
    for (const [lx, lz] of [
      [0, 0], [3, 0], [0, 3], [3, 3],
    ]) {
      for (let y = 1; y <= legH; y++) world.set(tx + lx, h + y, tz + lz, BLOCK.plank);
    }
    // platform
    for (let x = -1; x <= 4; x++) {
      for (let z = -1; z <= 4; z++) {
        world.set(tx + x, h + legH + 1, tz + z, BLOCK.plank);
      }
    }
    // sandbag rim
    for (let x = -1; x <= 4; x++) {
      world.set(tx + x, h + legH + 2, tz - 1, BLOCK.sandbag);
      world.set(tx + x, h + legH + 2, tz + 4, BLOCK.sandbag);
    }
    for (let z = 0; z <= 3; z++) {
      world.set(tx - 1, h + legH + 2, tz + z, BLOCK.sandbag);
      world.set(tx + 4, h + legH + 2, tz + z, BLOCK.sandbag);
    }
    // crate-stair ramp up the west side so the platform is reachable
    for (let s = 1; s <= legH + 1; s++) {
      const sx = tx - 1 - (legH + 1) + s; // walks toward the tower
      for (let y = 1; y <= s; y++) {
        world.set(sx, h + y, tz + 1, BLOCK.plank);
      }
    }
    towerTops.push(new THREE.Vector3(tx + 1.5, h + legH + 2, tz + 1.5));
  };

  buildTower(20, 12);
  buildTower(50, 56);

  // --- prop placements -------------------------------------------------------
  const crates: PropPlacement[] = [];
  const barrels: PropPlacement[] = [];
  const wirePosts: PropPlacement[] = [];

  const groundSpot = (x: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(x + 0.5, world.highestSolidY(x, z) + 1, z + 0.5);

  const crateClusters: Array<[number, number, number]> = [
    [16, 16, 3], [54, 14, 4], [14, 54, 3], [55, 52, 3], [34, 20, 2], [40, 54, 3], [26, 58, 2], [60, 30, 3],
  ];
  for (const [cx, cz, n] of crateClusters) {
    for (let i = 0; i < n; i++) {
      const x = cx + Math.floor(rng() * 3) - 1;
      const z = cz + Math.floor(rng() * 3) - 1;
      const pos = groundSpot(x, z);
      crates.push({ position: pos, rotationY: rng() * Math.PI * 2, scale: 0.9 + rng() * 0.25 });
      if (i === 0 && rng() < 0.6) {
        crates.push({
          position: pos.clone().add(new THREE.Vector3(0, 0.95, 0)),
          rotationY: rng() * Math.PI * 2,
          scale: 0.8,
        });
      }
    }
  }

  const barrelSpots: Array<[number, number]> = [
    [18, 20], [52, 24], [30, 56], [58, 44], [12, 30], [44, 12], [62, 60], [24, 40],
  ];
  for (const [x, z] of barrelSpots) {
    barrels.push({ position: groundSpot(x, z), rotationY: rng() * Math.PI * 2 });
    if (rng() < 0.5) barrels.push({ position: groundSpot(x + 1, z), rotationY: rng() * Math.PI * 2 });
  }

  // no-man's land barbed wire posts
  for (let i = 0; i < 26; i++) {
    const x = 8 + Math.floor(rng() * 56);
    const z = 28 + Math.floor(rng() * 16);
    wirePosts.push({ position: groundSpot(x, z), rotationY: rng() * Math.PI * 2 });
  }

  // --- spawns / waypoints / pickups ------------------------------------------
  const spawns: THREE.Vector3[] = [
    groundSpot(10, 12), groundSpot(60, 12), groundSpot(10, 60), groundSpot(60, 60),
    groundSpot(35, 8), groundSpot(35, 63), groundSpot(6, 36), groundSpot(65, 36),
  ];

  const waypoints: THREE.Vector3[] = [
    ...northTrench,
    ...southTrench,
    ...commTrench,
    ...bunkerDoors,
    ...towerTops,
    groundSpot(36, 36),
    groundSpot(24, 30), groundSpot(48, 30), groundSpot(24, 42), groundSpot(48, 42),
    groundSpot(36, 16), groundSpot(36, 56), groundSpot(16, 36), groundSpot(56, 36),
  ];

  const pickupSpots: THREE.Vector3[] = [
    groundSpot(36, 36).add(new THREE.Vector3(0, 0.1, 0)),
    groundSpot(12, 24), groundSpot(60, 24), groundSpot(12, 48), groundSpot(60, 48),
    groundSpot(36, 12), groundSpot(36, 60),
    towerTops[0].clone().add(new THREE.Vector3(0, 1, 0)),
  ];

  const tankPos = groundSpot(36, 35);
  tankPos.y = world.highestSolidY(36, 35) + 1;

  return {
    spawns,
    waypoints,
    crates,
    barrels,
    wirePosts,
    tank: { position: tankPos, rotationY: -0.6 },
    pickupSpots,
    smokeColumns: [
      tankPos.clone().add(new THREE.Vector3(0.5, 1.6, 0.5)),
      groundSpot(47, 40),
      groundSpot(18, 38),
    ],
  };
}
