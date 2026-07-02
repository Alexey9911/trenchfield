// Server-authoritative weapon specs. Damage is NEVER trusted from the client.
export const WEAPONS = {
  rifle: { damage: 17, headshotMul: 2.0, rpm: 540, range: 90, pellets: 1 },
  scattergun: { damage: 11, headshotMul: 1.5, rpm: 82, range: 34, pellets: 8 },
  sniper: { damage: 80, headshotMul: 1.75, rpm: 38, range: 150, pellets: 1 },
};

export const GRENADE_KINDS = new Set(['frag', 'smoke', 'flash']);
export const GRENADE_COOLDOWNS = { frag: 7, smoke: 14, flash: 11 };
export const FRAG_MAX_DAMAGE = 118;
export const FRAG_RADIUS = 5.2;

export const PLAYER_MAX_HP = 100;
export const RESPAWN_SECONDS = 3;
/** sprint 7.6 m/s + generous jitter margin for the speed check */
export const MAX_SPEED = 11.5;
