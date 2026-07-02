/**
 * TrenchField — central tunables.
 * Art direction: "Dusk over the trenches" — low amber sun, violet shadow fill,
 * mud + olive + rust world, bone-cream stencil UI, Solana-green points glint.
 */

export const PALETTE = {
  mudDeep: 0x3d2c1e,
  mud: 0x4a3628,
  mudLight: 0x6b5138,
  olive: 0x6b7040,
  oliveDark: 0x4a4e2c,
  duskAmber: 0xe8963f,
  duskEmber: 0xd97a2b,
  rust: 0xb4502e,
  bone: 0xe8dcc3,
  nightSteel: 0x2b3140,
  steelDark: 0x1c212e,
  skyZenith: 0x2a2440,
  skyMid: 0x6e4a63,
  skyHorizon: 0xd9772f,
  solana: 0x14f195,
  blood: 0x8c2f22,
} as const;

export const WORLD = {
  sizeX: 72,
  sizeZ: 72,
  sizeY: 24,
  chunk: 12,
  groundLevel: 8,
  gravity: 26,
} as const;

export const PLAYER = {
  eyeHeight: 1.62,
  crouchEyeHeight: 1.05,
  radius: 0.34,
  height: 1.8,
  crouchHeight: 1.25,
  walkSpeed: 5.4,
  sprintSpeed: 7.6,
  crouchSpeed: 2.6,
  adsSpeedMul: 0.62,
  accel: 42,
  airAccel: 9,
  friction: 11,
  jumpSpeed: 8.6,
  maxHealth: 100,
  regenDelay: 4.2,
  regenRate: 26,
  stepInterval: 0.42,
  sprintStepInterval: 0.31,
} as const;

export type WeaponId = 'rifle' | 'scattergun' | 'sniper';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  auto: boolean;
  rpm: number;
  damage: number;
  headshotMul: number;
  pellets: number;
  spreadDeg: number;
  adsSpreadDeg: number;
  magSize: number;
  reserve: number;
  reloadTime: number;
  range: number;
  recoilKick: number;
  adsFov: number;
  tracerEvery: number;
  /** true = telescopic sight: hide viewmodel + scope overlay at full ADS */
  scoped?: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  rifle: {
    id: 'rifle',
    name: 'M-27 TRENCH RIFLE',
    auto: true,
    rpm: 540,
    damage: 17,
    headshotMul: 2.0,
    pellets: 1,
    spreadDeg: 0.85,
    adsSpreadDeg: 0.2,
    magSize: 30,
    reserve: 150,
    reloadTime: 1.85,
    range: 90,
    recoilKick: 0.011,
    adsFov: 52,
    tracerEvery: 1,
  },
  scattergun: {
    id: 'scattergun',
    name: 'S-12 SCATTERGUN',
    auto: false,
    rpm: 82,
    damage: 11,
    headshotMul: 1.5,
    pellets: 8,
    spreadDeg: 5.2,
    adsSpreadDeg: 3.4,
    magSize: 6,
    reserve: 30,
    reloadTime: 2.5,
    range: 34,
    recoilKick: 0.03,
    adsFov: 58,
    tracerEvery: 2,
  },
  sniper: {
    id: 'sniper',
    name: 'W-14 LONGSHOT',
    auto: false,
    rpm: 38,
    damage: 80,
    headshotMul: 1.75,
    pellets: 1,
    spreadDeg: 6.5,
    adsSpreadDeg: 0.04,
    magSize: 5,
    reserve: 20,
    reloadTime: 3.1,
    range: 150,
    recoilKick: 0.055,
    adsFov: 24,
    tracerEvery: 1,
    scoped: true,
  },
};

export type GrenadeKind = 'frag' | 'smoke' | 'flash';

export interface GrenadeSpec {
  kind: GrenadeKind;
  cooldown: number;
  fuse: number;
  throwSpeed: number;
  radius: number;
  maxDamage: number;
  bounce: number;
}

export const GRENADES: Record<GrenadeKind, GrenadeSpec> = {
  frag: {
    kind: 'frag',
    cooldown: 7,
    fuse: 2.2,
    throwSpeed: 15,
    radius: 5.2,
    maxDamage: 118,
    bounce: 0.38,
  },
  smoke: {
    kind: 'smoke',
    cooldown: 14,
    fuse: 1.5,
    throwSpeed: 13,
    radius: 4.6, // cloud radius; blocks bot line of sight
    maxDamage: 0,
    bounce: 0.3,
  },
  flash: {
    kind: 'flash',
    cooldown: 11,
    fuse: 1.4,
    throwSpeed: 16,
    radius: 16, // blind radius with LOS + facing check
    maxDamage: 0,
    bounce: 0.42,
  },
};

export const SMOKE_CLOUD = {
  duration: 9,
  botBlindRadiusMul: 1.0,
} as const;

export const FLASH = {
  playerMaxDuration: 2.4,
  botBlindDuration: 2.6,
} as const;

export const BOTS = {
  count: 6,
  respawnDelay: 3.2,
  maxHealth: 100,
  viewRange: 44,
  fireRange: 34,
  loseTargetTime: 3.5,
  turnRate: 5.2,
} as const;

export const MATCH = {
  durationSec: 300,
  pointsKill: 100,
  pointsHeadshot: 50,
  pointsStreakStep: 25,
  creatorCutPct: 5,
} as const;

export const RENDER = {
  fov: 74,
  dprCap: 1.75,
  fogNear: 26,
  fogFar: 120,
  exposure: 1.14,
  shadowMapSize: 2048,
} as const;

export type MapId = 'day' | 'night';

export interface MapTheme {
  id: MapId;
  label: string;
  tagline: string;
  seed: number;
  variant: 0 | 1;
  /** sky dome gradient */
  zenith: number;
  mid: number;
  horizon: number;
  hazeColor: [number, number, number];
  /** sun (day) or moon (night) */
  discColor: number;
  discCorePow: number;
  discCoreStrength: number;
  discHaloPow: number;
  discHaloStrength: number;
  sunDirY: number;
  /** lights */
  keyColor: number;
  keyIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  rimColor: number;
  rimIntensity: number;
  /** atmosphere */
  fogColor: number;
  fogNear: number;
  fogFar: number;
  exposure: number;
  stars: boolean;
  cloudColorA: number;
  cloudColorB: number;
  cloudOpacity: number;
  hillColor: number;
  dustColor: number;
}

export const MAPS: Record<MapId, MapTheme> = {
  day: {
    id: 'day',
    label: 'DAYBREAK SALIENT',
    tagline: 'clear morning · open sightlines',
    seed: 1917,
    variant: 0,
    zenith: 0x3f7ec2,
    mid: 0x8ab4dc,
    horizon: 0xe8dcb8,
    hazeColor: [0.78, 0.74, 0.62],
    discColor: 0xfff4d6,
    discCorePow: 340,
    discCoreStrength: 2.0,
    discHaloPow: 32,
    discHaloStrength: 0.4,
    sunDirY: 0.72,
    keyColor: 0xfff1da,
    keyIntensity: 3.1,
    hemiSky: 0x9fbede,
    hemiGround: 0x8a7454,
    hemiIntensity: 1.7,
    rimColor: 0xcfe0f5,
    rimIntensity: 0.4,
    fogColor: 0xc4c3ae,
    fogNear: 42,
    fogFar: 170,
    exposure: 1.06,
    stars: false,
    cloudColorA: 0xffffff,
    cloudColorB: 0xf2ece0,
    cloudOpacity: 0.75,
    hillColor: 0x5d7256,
    dustColor: 0xd8cfae,
  },
  night: {
    id: 'night',
    label: 'MIDNIGHT SECTOR',
    tagline: 'blue moonlight · close-quarters fights',
    seed: 2044,
    variant: 1,
    zenith: 0x0a1228,
    mid: 0x1d2c52,
    horizon: 0x33497a,
    hazeColor: [0.14, 0.2, 0.36],
    discColor: 0xdce8ff,
    discCorePow: 420,
    discCoreStrength: 1.9,
    discHaloPow: 40,
    discHaloStrength: 0.5,
    sunDirY: 0.55,
    keyColor: 0x8fb2f2,
    keyIntensity: 2.6,
    hemiSky: 0x4a5f9e,
    hemiGround: 0x39415c,
    hemiIntensity: 1.75,
    rimColor: 0x7e9ae0,
    rimIntensity: 0.8,
    fogColor: 0x243252,
    fogNear: 30,
    fogFar: 140,
    exposure: 1.22,
    stars: true,
    cloudColorA: 0x4a5a80,
    cloudColorB: 0x39466a,
    cloudOpacity: 0.45,
    hillColor: 0x141c30,
    dustColor: 0x8a9ac0,
  },
};

export const BOT_NAMES = [
  'Sgt. Voxel',
  'Mudcrawler',
  'Cpl. Blocks',
  'Wire-Cutter',
  'Old Shrapnel',
  'Duckboard Dan',
  'Whizz-Bang',
  'Periscope Pete',
] as const;

export type BotArchetypeId = 'rifleman' | 'shock' | 'scout';

export interface BotArchetype {
  id: BotArchetypeId;
  label: string;
  health: number;
  speed: number;
  damage: number;
  burstShots: [number, number];
  burstPause: [number, number];
  aimErrorDeg: number;
  fireRange: number;
  cloth: number;
  clothDark: number;
  helmet: number;
  skin: number;
}

export const BOT_ARCHETYPES: Record<BotArchetypeId, BotArchetype> = {
  rifleman: {
    id: 'rifleman',
    label: 'RIFLEMAN',
    health: 100,
    speed: 3.6,
    damage: 8,
    burstShots: [3, 5],
    burstPause: [0.7, 1.3],
    aimErrorDeg: 2.4,
    fireRange: 36,
    cloth: PALETTE.olive,
    clothDark: PALETTE.oliveDark,
    helmet: 0x555a3a,
    skin: 0xc9906b,
  },
  shock: {
    id: 'shock',
    label: 'SHOCKTROOPER',
    health: 150,
    speed: 2.9,
    damage: 14,
    burstShots: [1, 2],
    burstPause: [1.1, 1.7],
    aimErrorDeg: 3.6,
    fireRange: 20,
    cloth: 0x5a4032,
    clothDark: 0x3d2b22,
    helmet: 0x33363c,
    skin: 0xb5825e,
  },
  scout: {
    id: 'scout',
    label: 'SCOUT',
    health: 70,
    speed: 4.9,
    damage: 6,
    burstShots: [2, 3],
    burstPause: [0.5, 0.9],
    aimErrorDeg: 3.0,
    fireRange: 40,
    cloth: 0x9a8a62,
    clothDark: 0x6e6244,
    helmet: 0x7a6f4e,
    skin: 0xd4a179,
  },
};

export const rand = (min: number, max: number): number => min + Math.random() * (max - min);
export const randInt = (min: number, max: number): number => Math.floor(rand(min, max + 1));
export const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));
