import { SKIN_ORDER, type SkinId } from './constants';

/**
 * Player identity. Leaderboard is keyed by a stable id — the wallet when
 * connected, otherwise a persistent guest device id — so two players sharing a
 * nickname are still distinguished (football-style: nick is display only).
 */
const NICK_KEY = 'tf-nick';
const SKIN_KEY = 'tf-skin';
const DEVICE_KEY = 'tf-device';

function randomTag(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

export class Identity {
  private _nick: string;
  private _skin: SkinId;
  readonly deviceId: string;
  walletAddress: string | null = null;

  constructor() {
    this._nick = localStorage.getItem(NICK_KEY) ?? `Operator-${randomTag()}`;
    const savedSkin = localStorage.getItem(SKIN_KEY) as SkinId | null;
    this._skin = savedSkin && SKIN_ORDER.includes(savedSkin) ? savedSkin : 'olive';
    let device = localStorage.getItem(DEVICE_KEY);
    if (!device) {
      device = `guest-${randomTag()}${randomTag()}`;
      localStorage.setItem(DEVICE_KEY, device);
    }
    this.deviceId = device;
  }

  get nick(): string {
    return this._nick;
  }

  setNick(v: string): void {
    const clean = v.trim().slice(0, 16) || `Operator-${randomTag()}`;
    this._nick = clean;
    localStorage.setItem(NICK_KEY, clean);
  }

  get skin(): SkinId {
    return this._skin;
  }

  setSkin(v: SkinId): void {
    this._skin = v;
    localStorage.setItem(SKIN_KEY, v);
  }

  /** stable leaderboard key: wallet if connected, else guest device id */
  get identityKey(): string {
    return this.walletAddress ?? this.deviceId;
  }

  /** short display tag so same-nick players are distinguishable */
  get shortTag(): string {
    const k = this.identityKey;
    return this.walletAddress ? `${k.slice(0, 4)}…${k.slice(-4)}` : k.replace('guest-', '#');
  }
}
