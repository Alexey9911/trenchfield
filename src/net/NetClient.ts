import { io, type Socket } from 'socket.io-client';
import type { MapId, WeaponId } from '../game/constants';
import type { GrenadeKind } from '../game/constants';

export interface LobbySummary {
  code: string;
  title: string;
  mode: 'free' | 'wager';
  stake: number;
  map: MapId;
  count: number;
  maxPlayers: number;
  status: string;
  joinable: boolean;
}

export interface MetaPayload {
  online: number;
  wagersEnabled: boolean;
  cluster: string;
  escrow: string | null;
  stakes: number[];
  lobbies: LobbySummary[];
  leaderKills: Array<{ wallet: string; nick: string; kills: number; deaths: number }>;
  leaderSol: Array<{ wallet: string; nick: string; sol_won: number }>;
}

export interface LobbyPlayer {
  id: string;
  nick: string;
  wallet: string | null;
  ready: boolean;
  escrowed: boolean;
  kills: number;
  deaths: number;
  gone: boolean;
}

export interface LobbyState {
  code: string;
  title: string;
  hostId: string;
  mode: 'free' | 'wager';
  stake: number;
  map: MapId;
  maxPlayers: number;
  status: string;
  countdownEnds: number | null;
  matchEndsAt: number;
  players: LobbyPlayer[];
}

export interface MatchStartInfo {
  code: string;
  map: MapId;
  endsAt: number;
  mode: 'free' | 'wager';
  stake: number;
  killGain: number;
  players: Array<{ id: string; nick: string; wallet: string | null; spawn: { x: number; y: number; z: number } }>;
}

export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  w: WeaponId;
  f: number;
  hp: number;
  alive: boolean;
  k: number;
  d: number;
}

export interface ChatMessage {
  id?: number;
  nick: string;
  wallet: string | null;
  msg: string;
  ts: number;
  scope: 'global' | 'lobby';
}

export interface NetEvents {
  onMeta: (meta: MetaPayload) => void;
  onLobbyUpdate: (lobby: LobbyState) => void;
  onMatchStart: (info: MatchStartInfo) => void;
  onSnapshot: (players: SnapshotPlayer[]) => void;
  onShot: (id: string, w: WeaponId, o: number[], d: number[]) => void;
  onGrenade: (id: string, kind: GrenadeKind, o: number[], d: number[]) => void;
  onKillfeed: (ev: { killer: string; victim: string; killerId: string; victimId: string; solDelta: number }) => void;
  onDamaged: (ev: { by: string; dmg: number; hp: number; head: boolean }) => void;
  onHitConfirm: (ev: { victim: string; dmg: number; hp: number; head: boolean }) => void;
  onRespawn: (spawn: { x: number; y: number; z: number }) => void;
  onRubberband: (pos: { x: number; y: number; z: number }) => void;
  onMatchEnd: (ev: {
    reason: string;
    mode: 'free' | 'wager';
    stake: number;
    standings: Array<{ id: string; nick: string; wallet: string | null; kills: number; deaths: number; pot: number; net: number }>;
    payouts: Array<{ nick: string; amount: number; sig: string }>;
  }) => void;
  onChat: (msg: ChatMessage) => void;
  onChatRemoved: (ids: number[]) => void;
  onLobbyChatHistory: (msgs: ChatMessage[]) => void;
  onKicked: (reason: string) => void;
  onConnectionChange: (connected: boolean) => void;
}

const SERVER_URL = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? '';

export class NetClient {
  private socket: Socket | null = null;
  readonly myId = (): string => this.socket?.id ?? '';
  connected = false;
  meta: MetaPayload | null = null;
  lobby: LobbyState | null = null;

  constructor(private events: Partial<NetEvents>) {}

  get available(): boolean {
    return SERVER_URL.length > 0 || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  connect(): void {
    if (this.socket) return;
    const url = SERVER_URL || 'http://127.0.0.1:8123';
    this.socket = io(url, { transports: ['websocket', 'polling'] });
    const s = this.socket;
    s.on('connect', () => {
      this.connected = true;
      this.events.onConnectionChange?.(true);
    });
    s.on('disconnect', () => {
      this.connected = false;
      this.events.onConnectionChange?.(false);
    });
    s.on('meta', (m: MetaPayload) => {
      this.meta = m;
      this.events.onMeta?.(m);
    });
    s.on('lobbyUpdate', (l: LobbyState) => {
      this.lobby = l;
      this.events.onLobbyUpdate?.(l);
    });
    s.on('matchStart', (i: MatchStartInfo) => this.events.onMatchStart?.(i));
    s.on('snapshot', (snap: { players: SnapshotPlayer[] }) => this.events.onSnapshot?.(snap.players));
    s.on('shot', (d: { id: string; w: WeaponId; o: number[]; d: number[] }) =>
      this.events.onShot?.(d.id, d.w, d.o, d.d),
    );
    s.on('grenade', (d: { id: string; kind: GrenadeKind; o: number[]; d: number[] }) =>
      this.events.onGrenade?.(d.id, d.kind, d.o, d.d),
    );
    s.on('killfeed', (e) => this.events.onKillfeed?.(e));
    s.on('damaged', (e) => this.events.onDamaged?.(e));
    s.on('hitConfirm', (e) => this.events.onHitConfirm?.(e));
    s.on('respawn', (e: { spawn: { x: number; y: number; z: number } }) => this.events.onRespawn?.(e.spawn));
    s.on('rubberband', (e: { pos: { x: number; y: number; z: number } }) => this.events.onRubberband?.(e.pos));
    s.on('matchEnd', (e) => this.events.onMatchEnd?.(e));
    s.on('chat', (m: ChatMessage) => this.events.onChat?.(m));
    s.on('chatRemoved', (e: { ids: number[] }) => this.events.onChatRemoved?.(e.ids));
    s.on('lobbyChatHistory', (msgs: ChatMessage[]) => this.events.onLobbyChatHistory?.(msgs));
    s.on('kicked', (e: { reason: string }) => this.events.onKicked?.(e.reason));
  }

  private emitCb<T = Record<string, unknown>>(event: string, data?: unknown): Promise<T> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ error: 'not connected' } as T);
      this.socket.timeout(10_000).emit(event, data, (err: unknown, res: T) => {
        resolve(err ? ({ error: 'timeout' } as T) : res);
      });
    });
  }

  hello(nick: string, wallet: string | null, token: string | null): Promise<{ ok?: boolean; authed?: boolean }> {
    return this.emitCb('hello', { nick, wallet, token });
  }

  walletNonce(wallet: string): Promise<{ nonce?: string; message?: string; error?: string }> {
    return this.emitCb('wallet-nonce', { wallet });
  }

  walletAuth(wallet: string, signature: string, nonce: string): Promise<{ token?: string; error?: string }> {
    return this.emitCb('wallet-auth', { wallet, signature, nonce });
  }

  createLobby(opts: {
    title: string;
    mode: 'free' | 'wager';
    stake: number;
    map: MapId;
    maxPlayers: number;
  }): Promise<{ ok?: boolean; lobby?: LobbyState; error?: string }> {
    return this.emitCb('createLobby', opts);
  }

  joinLobby(code: string): Promise<{ ok?: boolean; lobby?: LobbyState; rejoined?: boolean; error?: string }> {
    return this.emitCb('joinLobby', { code });
  }

  leaveLobby(): void {
    this.socket?.emit('leaveLobby');
    this.lobby = null;
  }

  setReady(ready: boolean): void {
    this.socket?.emit('setReady', ready);
  }

  escrowDeposit(sig: string): Promise<{ ok?: boolean; error?: string }> {
    return this.emitCb('escrowDeposit', { sig });
  }

  unstake(): Promise<{ ok?: boolean; sig?: string; error?: string }> {
    return this.emitCb('unstake');
  }

  sendState(st: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    w: WeaponId;
    f: number;
    rn: number;
  }): void {
    this.socket?.volatile.emit('state', st);
  }

  sendShot(w: WeaponId, o: number[], d: number[]): void {
    this.socket?.emit('shot', { w, o, d });
  }

  sendGrenade(kind: GrenadeKind, o: number[], d: number[]): void {
    this.socket?.emit('grenade', { kind, o, d });
  }

  sendHit(victim: string, w: WeaponId, head: boolean): void {
    this.socket?.emit('hit', { victim, w, head });
  }

  sendFragDamage(victim: string, dmg: number, at: { x: number; y: number; z: number }): void {
    this.socket?.emit('fragDamage', { victim, dmg, at });
  }

  sendChat(msg: string, scope: 'global' | 'lobby'): void {
    this.socket?.emit('chat', { msg, scope });
  }

  chatHistory(): Promise<ChatMessage[]> {
    return this.emitCb('chatHistory');
  }
}
