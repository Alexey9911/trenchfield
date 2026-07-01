import * as THREE from 'three';

/**
 * Procedural 16px pixel-art block atlas, painted at load time.
 * 8 x 4 tiles. NearestFilter keeps the chunky voxel read.
 */
export const TILE = {
  dirt: 0,
  mud: 1,
  sodTop: 2,
  sodSide: 3,
  sandbag: 4,
  plank: 5,
  duckboard: 6,
  stone: 7,
  metal: 8,
  char: 9,
  crate: 10,
  crateTop: 11,
  barrel: 12,
  barrelTop: 13,
  concrete: 14,
  medkit: 15,
  ammo: 16,
  brick: 17,
} as const;

export type TileId = (typeof TILE)[keyof typeof TILE];

const COLS = 8;
const ROWS = 4;
const TS = 16;

type Painter = (px: (x: number, y: number, c: string) => void) => void;

function noiseFill(
  px: (x: number, y: number, c: string) => void,
  base: [number, number, number],
  jitter: number,
  seedMul = 1,
): void {
  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      const n = (Math.sin(x * 12.9898 * seedMul + y * 78.233) * 43758.5453) % 1;
      const j = (Math.abs(n) - 0.5) * 2 * jitter;
      const r = Math.round(base[0] + j);
      const g = Math.round(base[1] + j * 0.9);
      const b = Math.round(base[2] + j * 0.8);
      px(x, y, `rgb(${r},${g},${b})`);
    }
  }
}

const painters: Record<number, Painter> = {
  [TILE.dirt]: (px) => {
    noiseFill(px, [110, 82, 56], 16, 1.3);
    for (let i = 0; i < 9; i++) {
      const x = (i * 5 + 3) % TS;
      const y = (i * 7 + 2) % TS;
      px(x, y, 'rgb(84,60,40)');
      px((x + 1) % TS, y, 'rgb(84,60,40)');
    }
  },
  [TILE.mud]: (px) => {
    noiseFill(px, [78, 58, 40], 12, 2.1);
    for (let i = 0; i < 7; i++) {
      const x = (i * 6 + 1) % TS;
      const y = (i * 4 + 5) % TS;
      px(x, y, 'rgb(56,42,30)');
      px(x, (y + 1) % TS, 'rgb(60,44,31)');
      px((x + 1) % TS, y, 'rgb(96,74,52)');
    }
  },
  [TILE.sodTop]: (px) => {
    noiseFill(px, [122, 112, 62], 18, 3.7);
    for (let i = 0; i < 12; i++) {
      const x = (i * 3 + 2) % TS;
      const y = (i * 5 + 1) % TS;
      px(x, y, 'rgb(96,88,46)');
      px(x, (y + 1) % TS, 'rgb(140,128,70)');
    }
  },
  [TILE.sodSide]: (px) => {
    noiseFill(px, [110, 82, 56], 16, 1.3);
    for (let x = 0; x < TS; x++) {
      const h = 3 + ((x * 7) % 3);
      for (let y = 0; y < h; y++) px(x, y, y < h - 1 ? 'rgb(118,108,58)' : 'rgb(96,88,46)');
    }
  },
  [TILE.sandbag]: (px) => {
    noiseFill(px, [162, 146, 108], 9, 5.3);
    for (let y = 0; y < TS; y++) {
      const inRow = y % 5;
      for (let x = 0; x < TS; x++) {
        // soft rounded bulge per bag row: highlight top, shade bottom seam
        if (inRow === 0) px(x, y, 'rgb(178,162,122)');
        else if (inRow === 4) px(x, y, 'rgb(128,112,80)');
      }
    }
    // sparse stitch ticks instead of hard vertical seams
    for (let i = 0; i < 5; i++) {
      const x = (i * 6 + 3) % TS;
      const y = 2 + ((i * 5) % 10);
      px(x, y, 'rgb(140,124,90)');
      px(x + 1 < TS ? x + 1 : 0, y, 'rgb(140,124,90)');
    }
  },
  [TILE.plank]: (px) => {
    noiseFill(px, [108, 78, 48], 9, 7.9);
    for (let y = 0; y < TS; y++) {
      if (y % 4 === 3) for (let x = 0; x < TS; x++) px(x, y, 'rgb(70,50,30)');
      for (let x = 0; x < TS; x++) {
        if ((x * 13 + y * 3) % 29 === 0) px(x, y, 'rgb(88,62,38)');
      }
    }
    px(2, 1, 'rgb(50,38,26)');
    px(13, 9, 'rgb(50,38,26)');
  },
  [TILE.duckboard]: (px) => {
    noiseFill(px, [96, 70, 44], 8, 4.2);
    for (let x = 0; x < TS; x++) {
      if (x % 4 === 3)
        for (let y = 0; y < TS; y++) px(x, y, 'rgb(52,40,28)');
    }
    for (let x = 0; x < TS; x++) {
      px(x, 2, 'rgb(112,84,54)');
      px(x, 12, 'rgb(112,84,54)');
    }
  },
  [TILE.stone]: (px) => {
    noiseFill(px, [118, 116, 112], 12, 6.1);
    const cracks: Array<[number, number]> = [
      [2, 3], [3, 4], [4, 4], [5, 5], [10, 9], [11, 10], [12, 10], [12, 11], [7, 13], [8, 13],
    ];
    for (const [x, y] of cracks) px(x, y, 'rgb(86,84,80)');
  },
  [TILE.metal]: (px) => {
    noiseFill(px, [96, 100, 108], 7, 8.8);
    for (let y = 0; y < TS; y++) {
      px(0, y, 'rgb(70,74,82)');
      px(15, y, 'rgb(70,74,82)');
    }
    px(2, 2, 'rgb(140,144,150)');
    px(13, 2, 'rgb(140,144,150)');
    px(2, 13, 'rgb(140,144,150)');
    px(13, 13, 'rgb(140,144,150)');
    for (let i = 0; i < 5; i++) px(4 + i, 8, 'rgb(150,96,58)');
  },
  [TILE.char]: (px) => {
    noiseFill(px, [46, 40, 38], 10, 9.4);
    for (let i = 0; i < 6; i++) {
      const x = (i * 5 + 2) % TS;
      const y = (i * 7 + 4) % TS;
      px(x, y, 'rgb(88,52,34)');
    }
  },
  [TILE.crate]: (px) => {
    noiseFill(px, [122, 90, 54], 8, 11.7);
    for (let i = 0; i < TS; i++) {
      px(i, 0, 'rgb(80,58,34)');
      px(i, 15, 'rgb(80,58,34)');
      px(0, i, 'rgb(80,58,34)');
      px(15, i, 'rgb(80,58,34)');
      px(i, i, 'rgb(96,70,42)');
      px(i, 15 - i, 'rgb(96,70,42)');
    }
  },
  [TILE.crateTop]: (px) => {
    noiseFill(px, [130, 96, 58], 8, 12.3);
    for (let i = 0; i < TS; i++) {
      px(i, 0, 'rgb(84,60,36)');
      px(i, 15, 'rgb(84,60,36)');
      px(0, i, 'rgb(84,60,36)');
      px(15, i, 'rgb(84,60,36)');
    }
    // stencil mark
    for (let x = 4; x < 12; x++) px(x, 7, 'rgb(60,44,28)');
    for (let x = 5; x < 11; x++) px(x, 9, 'rgb(60,44,28)');
  },
  [TILE.barrel]: (px) => {
    noiseFill(px, [92, 66, 46], 8, 13.1);
    for (let x = 0; x < TS; x++) {
      px(x, 3, 'rgb(58,60,66)');
      px(x, 12, 'rgb(58,60,66)');
    }
  },
  [TILE.barrelTop]: (px) => {
    noiseFill(px, [70, 72, 78], 6, 14.9);
    for (let i = 0; i < TS; i++) {
      px(i, 0, 'rgb(50,52,58)');
      px(i, 15, 'rgb(50,52,58)');
      px(0, i, 'rgb(50,52,58)');
      px(15, i, 'rgb(50,52,58)');
    }
    px(7, 7, 'rgb(120,124,130)');
    px(8, 7, 'rgb(120,124,130)');
  },
  [TILE.concrete]: (px) => {
    noiseFill(px, [128, 124, 116], 8, 15.7);
    for (let x = 0; x < TS; x++) px(x, 7, 'rgb(104,100,94)');
    for (let i = 0; i < 4; i++) px(3 + i * 3, 11, 'rgb(96,92,86)');
  },
  [TILE.medkit]: (px) => {
    noiseFill(px, [216, 206, 184], 6, 16.3);
    for (let y = 5; y < 11; y++) for (let x = 7; x < 9; x++) px(x, y, 'rgb(180,80,46)');
    for (let x = 5; x < 11; x++) for (let y = 7; y < 9; y++) px(x, y, 'rgb(180,80,46)');
    for (let i = 0; i < TS; i++) {
      px(i, 0, 'rgb(150,140,118)');
      px(i, 15, 'rgb(150,140,118)');
      px(0, i, 'rgb(150,140,118)');
      px(15, i, 'rgb(150,140,118)');
    }
  },
  [TILE.ammo]: (px) => {
    noiseFill(px, [96, 100, 66], 7, 17.9);
    for (let i = 0; i < 4; i++) {
      for (let y = 5; y < 11; y++) px(3 + i * 3, y, 'rgb(212,160,70)');
      px(3 + i * 3, 4, 'rgb(160,110,50)');
    }
    for (let i = 0; i < TS; i++) {
      px(i, 0, 'rgb(66,70,44)');
      px(i, 15, 'rgb(66,70,44)');
      px(0, i, 'rgb(66,70,44)');
      px(15, i, 'rgb(66,70,44)');
    }
  },
  [TILE.brick]: (px) => {
    noiseFill(px, [134, 84, 62], 10, 18.4);
    for (let y = 0; y < TS; y++) {
      if (y % 4 === 3) for (let x = 0; x < TS; x++) px(x, y, 'rgb(94,74,64)');
      const off = Math.floor(y / 4) % 2 === 0 ? 0 : 4;
      for (let x = 0; x < TS; x++) {
        if ((x + off) % 8 === 0 && y % 4 !== 3) px(x, y, 'rgb(94,74,64)');
      }
    }
  },
};

export class BlockAtlas {
  readonly texture: THREE.Texture;
  readonly canvas: HTMLCanvasElement;
  /** pixel-art upscale factor: keeps chunky look while allowing clean mipmaps */
  private static readonly UP = 4;

  constructor() {
    const up = BlockAtlas.UP;
    this.canvas = document.createElement('canvas');
    this.canvas.width = COLS * TS * up;
    this.canvas.height = ROWS * TS * up;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (const [idStr, paint] of Object.entries(painters)) {
      const id = Number(idStr);
      const ox = (id % COLS) * TS * up;
      const oy = Math.floor(id / COLS) * TS * up;
      paint((x, y, c) => {
        ctx.fillStyle = c;
        ctx.fillRect(ox + x * up, oy + y * up, up, up);
      });
    }

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
  }

  /** UV rect for a tile, inset slightly to avoid bleeding. */
  uv(tile: TileId): { u0: number; v0: number; u1: number; v1: number } {
    const eps = 0.02 / COLS;
    const col = tile % COLS;
    const row = Math.floor(tile / COLS);
    const u0 = col / COLS + eps;
    const u1 = (col + 1) / COLS - eps;
    // canvas v is flipped for three uv space
    const v1 = 1 - row / ROWS - eps;
    const v0 = 1 - (row + 1) / ROWS + eps;
    return { u0, v0, u1, v1 };
  }
}
