// TrenchField realtime server — lobbies, state relay, server-validated combat,
// Solana wagers, chat with moderation. Architecture mirrors SOLBALL (socket.io
// relay + on-chain escrow) with FPS-specific validation.
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import crypto from 'node:crypto';
import {
  WEAPONS,
  GRENADE_KINDS,
  GRENADE_COOLDOWNS,
  PLAYER_MAX_HP,
  RESPAWN_SECONDS,
  MAX_SPEED,
} from './weapons.js';
import * as db from './db.js';
import * as sol from './solana.js';
import {
  chatRateOk,
  isGibberish,
  isRepeatSpam,
  nickAllowed,
  startLlmModeration,
} from './moderation.js';

const PORT = Number(process.env.PORT || 8123);
const TICK_HZ = 20; // snapshot broadcast rate
const ALLOWED_STAKES = [0.01, 0.05];
const KILL_GAIN_FRACTION = 0.1; // each kill moves stake*0.1 victim -> killer
const MATCH_SECONDS = 300;
const ALLOWED_MAX_PLAYERS = [2, 4, 6, 8];
const RECONNECT_GRACE_MS = 45_000;

const app = express();
app.get('/health', (_req, res) =>
  res.json({ ok: true, wagers: sol.wagersEnabled, cluster: sol.cluster, db: db.dbEnabled }),
);
app.get('/', (_req, res) => res.json({ name: 'trenchfield-server', ok: true }));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** @type {Map<string, Lobby>} */
const lobbies = new Map();
const sessions = new Map(); // socket.id -> {nick, wallet, authed, lobbyCode, ip}
const nonces = new Map(); // wallet -> nonce
const usedDepositSigs = new Set();
const msgIpIndex = new Map(); // chat message id -> ip (for moderation bans)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

function makeLobby(opts, hostId) {
  return {
    code: genCode(),
    title: String(opts.title || 'TRENCH LOBBY').slice(0, 24),
    hostId,
    mode: opts.mode === 'wager' && sol.wagersEnabled ? 'wager' : 'free',
    stake: ALLOWED_STAKES.includes(Number(opts.stake)) ? Number(opts.stake) : ALLOWED_STAKES[0],
    map: opts.map === 'night' ? 'night' : 'day',
    maxPlayers: ALLOWED_MAX_PLAYERS.includes(Number(opts.maxPlayers)) ? Number(opts.maxPlayers) : 4,
    status: 'waiting', // waiting | playing | settling
    countdownEnds: null,
    countdownTimer: null,
    matchEndsAt: 0,
    matchTimer: null,
    players: [], // see joinLobby
    chat: [],
    emptySince: null,
  };
}

function publicLobby(l) {
  return {
    code: l.code,
    title: l.title,
    hostId: l.hostId,
    mode: l.mode,
    stake: l.stake,
    map: l.map,
    maxPlayers: l.maxPlayers,
    status: l.status,
    countdownEnds: l.countdownEnds,
    matchEndsAt: l.matchEndsAt,
    players: l.players.map((p) => ({
      id: p.id,
      nick: p.nick,
      wallet: shortWallet(p.wallet),
      ready: p.ready,
      escrowed: p.escrowed,
      kills: p.kills,
      deaths: p.deaths,
      gone: Boolean(p.gone),
    })),
  };
}

function shortWallet(w) {
  return w ? `${w.slice(0, 4)}…${w.slice(-4)}` : null;
}

function pushLobby(l) {
  io.to(`lobby:${l.code}`).emit('lobbyUpdate', publicLobby(l));
  broadcastMeta();
}

// ---------------------------------------------------------------------------
// meta (landing page: lobby list + leaderboards)
// ---------------------------------------------------------------------------

let leaderKills = [];
let leaderSol = [];
let metaTimer = null;

async function refreshLeaderboards() {
  try {
    leaderKills = await db.topKillers(10);
    leaderSol = await db.topSolWon(10);
  } catch (err) {
    console.error('[db] leaderboard refresh failed:', err.message);
  }
}

function metaPayload() {
  return {
    online: io.engine.clientsCount,
    wagersEnabled: sol.wagersEnabled,
    cluster: sol.cluster,
    escrow: sol.escrowAddress,
    stakes: ALLOWED_STAKES,
    lobbies: [...lobbies.values()].map((l) => ({
      code: l.code,
      title: l.title,
      mode: l.mode,
      stake: l.stake,
      map: l.map,
      count: l.players.filter((p) => !p.gone).length,
      maxPlayers: l.maxPlayers,
      status: l.status,
      joinable: l.status === 'waiting' && l.players.filter((p) => !p.gone).length < l.maxPlayers,
    })),
    leaderKills,
    leaderSol,
  };
}

function broadcastMeta() {
  if (metaTimer) return;
  metaTimer = setTimeout(() => {
    metaTimer = null;
    io.emit('meta', metaPayload());
  }, 500);
}

// ---------------------------------------------------------------------------
// lobby lifecycle
// ---------------------------------------------------------------------------

function evaluateCountdown(l) {
  const active = l.players.filter((p) => !p.gone);
  const allReady =
    active.length >= 2 &&
    active.every((p) => p.ready && (l.mode !== 'wager' || p.escrowed));
  if (allReady && l.status === 'waiting' && !l.countdownTimer) {
    l.countdownEnds = Date.now() + 4000;
    l.countdownTimer = setTimeout(() => startMatch(l), 4000);
    pushLobby(l);
  } else if (!allReady && l.countdownTimer) {
    clearTimeout(l.countdownTimer);
    l.countdownTimer = null;
    l.countdownEnds = null;
    pushLobby(l);
  }
}

function spawnPoint(i) {
  // matches client layout spawn ring (72x72 arena)
  const SPAWNS = [
    [10.5, 12.5], [60.5, 12.5], [10.5, 60.5], [60.5, 60.5],
    [35.5, 8.5], [35.5, 63.5], [6.5, 36.5], [65.5, 36.5],
  ];
  const [x, z] = SPAWNS[i % SPAWNS.length];
  return { x, y: 12, z };
}

function startMatch(l) {
  l.countdownTimer = null;
  l.countdownEnds = null;
  l.status = 'playing';
  l.matchEndsAt = Date.now() + MATCH_SECONDS * 1000;
  const active = l.players.filter((p) => !p.gone);
  active.forEach((p, i) => {
    p.hp = PLAYER_MAX_HP;
    p.alive = true;
    p.kills = 0;
    p.deaths = 0;
    p.pot = l.mode === 'wager' ? l.stake : 0;
    p.spawn = spawnPoint(i);
    p.pos = { ...p.spawn };
    p.lastStateAt = Date.now();
    p.shotTimes = {};
    p.grenadeTimes = {};
    p.shots = 0;
    p.hits = 0;
    p.headHits = 0;
    p.speedStrikes = 0;
    p.aimFlags = 0;
  });
  l.matchTimer = setTimeout(() => endMatch(l, 'time'), MATCH_SECONDS * 1000);
  io.to(`lobby:${l.code}`).emit('matchStart', {
    code: l.code,
    map: l.map,
    endsAt: l.matchEndsAt,
    mode: l.mode,
    stake: l.stake,
    killGain: l.stake * KILL_GAIN_FRACTION,
    players: active.map((p, i) => ({
      id: p.id,
      nick: p.nick,
      wallet: shortWallet(p.wallet),
      spawn: spawnPoint(i),
    })),
  });
  pushLobby(l);
  console.log(`[lobby ${l.code}] match started (${active.length} players, ${l.mode})`);
}

async function endMatch(l, reason) {
  if (l.status !== 'playing') return;
  clearTimeout(l.matchTimer);
  l.matchTimer = null;
  l.status = 'settling';
  pushLobby(l);

  const participants = l.players.filter((p) => p.pot !== undefined);
  const standings = [...participants]
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .map((p) => ({
      id: p.id,
      nick: p.nick,
      wallet: shortWallet(p.wallet),
      kills: p.kills,
      deaths: p.deaths,
      pot: Number((p.pot ?? 0).toFixed(4)),
      net: l.mode === 'wager' ? Number(((p.pot ?? 0) - l.stake).toFixed(4)) : 0,
    }));

  // persist stats
  for (const p of participants) {
    if (p.wallet) {
      db.addKillsDeaths(p.wallet, p.kills, p.deaths).catch(() => {});
    }
  }
  db.recordMatch(l.code, l.map, l.mode, l.stake, standings).catch(() => {});

  // wager settlement: pay each player their pot (ledger before pay)
  const payouts = [];
  if (l.mode === 'wager') {
    for (const p of participants) {
      if (!p.wallet || !p.escrowed) continue;
      const amount = Number((p.pot ?? 0).toFixed(6));
      const net = amount - l.stake;
      if (p.betId) await db.updateBetStatus(p.betId, amount > 0 ? 'paying' : 'lost').catch(() => {});
      if (amount > 0) {
        const sig = await sol.payout(p.wallet, amount);
        if (sig) {
          if (p.betId) await db.updateBetStatus(p.betId, 'paid').catch(() => {});
          payouts.push({ nick: p.nick, amount, sig });
        } else if (p.betId) {
          await db.updateBetStatus(p.betId, 'payout_failed').catch(() => {});
        }
      }
      await db.addSolWon(p.wallet, net).catch(() => {});
      p.escrowed = false;
      p.betId = null;
    }
  }

  io.to(`lobby:${l.code}`).emit('matchEnd', { reason, standings, payouts, mode: l.mode, stake: l.stake });
  await refreshLeaderboards();

  l.status = 'waiting';
  for (const p of l.players) {
    p.ready = false;
    p.pot = undefined;
  }
  pushLobby(l);
  console.log(`[lobby ${l.code}] match ended (${reason})`);
}

// lobby cleanup: user lobbies die after 5 empty minutes
setInterval(() => {
  const now = Date.now();
  for (const l of lobbies.values()) {
    // purge long-gone players
    for (let i = l.players.length - 1; i >= 0; i--) {
      const p = l.players[i];
      if (p.gone && now - p.gone > RECONNECT_GRACE_MS) {
        l.players.splice(i, 1);
        pushLobby(l);
      }
    }
    const active = l.players.filter((p) => !p.gone).length;
    if (active === 0) {
      l.emptySince ??= now;
      if (now - l.emptySince > 5 * 60_000) {
        clearTimeout(l.countdownTimer);
        clearTimeout(l.matchTimer);
        lobbies.delete(l.code);
        broadcastMeta();
        console.log(`[lobby ${l.code}] deleted (empty)`);
      }
    } else {
      l.emptySince = null;
    }
  }
}, 15_000);

// ---------------------------------------------------------------------------
// snapshot loop (per-lobby relay @ TICK_HZ)
// ---------------------------------------------------------------------------

setInterval(() => {
  for (const l of lobbies.values()) {
    if (l.status !== 'playing') continue;
    const players = l.players
      .filter((p) => !p.gone && p.lastState)
      .map((p) => ({
        id: p.id,
        ...p.lastState,
        hp: p.hp,
        alive: p.alive,
        k: p.kills,
        d: p.deaths,
      }));
    io.to(`lobby:${l.code}`).volatile.emit('snapshot', { t: Date.now(), players });
  }
}, 1000 / TICK_HZ);

// ---------------------------------------------------------------------------
// combat validation
// ---------------------------------------------------------------------------

function fireRateOk(p, weaponId) {
  const spec = WEAPONS[weaponId];
  if (!spec) return false;
  const minInterval = (60_000 / spec.rpm) * 0.75; // tolerance for jitter
  const last = p.shotTimes[weaponId] ?? 0;
  const now = Date.now();
  if (now - last < minInterval) return false;
  p.shotTimes[weaponId] = now;
  return true;
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0), a.z - b.z);
}

function applyKill(l, killer, victim) {
  killer.kills += 1;
  victim.deaths += 1;
  victim.alive = false;
  victim.hp = 0;

  let solDelta = 0;
  if (l.mode === 'wager') {
    const gain = Math.min(l.stake * KILL_GAIN_FRACTION, victim.pot ?? 0);
    victim.pot = (victim.pot ?? 0) - gain;
    killer.pot = (killer.pot ?? 0) + gain;
    solDelta = gain;
  }

  io.to(`lobby:${l.code}`).emit('killfeed', {
    killer: killer.nick,
    victim: victim.nick,
    killerId: killer.id,
    victimId: victim.id,
    solDelta: Number(solDelta.toFixed(4)),
  });

  // schedule respawn
  setTimeout(() => {
    if (l.status !== 'playing' || victim.gone) return;
    victim.hp = PLAYER_MAX_HP;
    victim.alive = true;
    const sp = spawnPoint(Math.floor(Math.random() * 8));
    victim.pos = { ...sp };
    victim.respawnNonce = (victim.respawnNonce ?? 0) + 1;
    io.to(victim.id).emit('respawn', { spawn: sp });
  }, RESPAWN_SECONDS * 1000);
}

// ---------------------------------------------------------------------------
// sockets
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  const ip =
    socket.handshake.headers['fly-client-ip'] ||
    socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    socket.handshake.address;
  sessions.set(socket.id, { nick: 'operator', wallet: null, authed: false, lobbyCode: null, ip });
  socket.emit('meta', metaPayload());
  broadcastMeta();

  const sess = () => sessions.get(socket.id);
  const currentLobby = () => {
    const s = sess();
    return s?.lobbyCode ? lobbies.get(s.lobbyCode) : null;
  };
  const me = () => {
    const l = currentLobby();
    return l?.players.find((p) => p.id === socket.id) ?? null;
  };

  socket.on('hello', (data, cb) => {
    const s = sess();
    const nick = String(data?.nick || 'operator').slice(0, 16);
    s.nick = nickAllowed(nick) ? nick : 'operator';
    if (data?.wallet && data?.token) {
      const expect = crypto.createHmac('sha256', SESSION_SECRET).update(String(data.wallet)).digest('hex');
      if (data.token === expect) {
        s.wallet = String(data.wallet);
        s.authed = true;
        db.upsertPlayer(s.wallet, s.nick).catch(() => {});
      }
    }
    cb?.({ ok: true, authed: s.authed });
  });

  // --- wallet auth (nonce + ed25519 signature) ---
  socket.on('wallet-nonce', (data, cb) => {
    const wallet = String(data?.wallet || '');
    if (!wallet) return cb?.({ error: 'no wallet' });
    const nonce = crypto.randomBytes(16).toString('hex');
    nonces.set(wallet, nonce);
    cb?.({ nonce, message: `TrenchField login\nwallet: ${wallet}\nnonce: ${nonce}` });
  });

  socket.on('wallet-auth', (data, cb) => {
    try {
      const wallet = String(data?.wallet || '');
      const nonce = nonces.get(wallet);
      if (!nonce || nonce !== data?.nonce) return cb?.({ error: 'bad nonce' });
      const msg = new TextEncoder().encode(`TrenchField login\nwallet: ${wallet}\nnonce: ${nonce}`);
      const ok = nacl.sign.detached.verify(msg, bs58.decode(String(data.signature)), bs58.decode(wallet));
      if (!ok) return cb?.({ error: 'bad signature' });
      nonces.delete(wallet);
      const s = sess();
      s.wallet = wallet;
      s.authed = true;
      db.upsertPlayer(wallet, s.nick).catch(() => {});
      const token = crypto.createHmac('sha256', SESSION_SECRET).update(wallet).digest('hex');
      cb?.({ token });
    } catch (err) {
      cb?.({ error: err.message });
    }
  });

  // --- lobbies ---
  socket.on('createLobby', (opts, cb) => {
    const s = sess();
    if (s.lobbyCode) return cb?.({ error: 'already in a lobby' });
    if (opts?.mode === 'wager' && !s.authed) return cb?.({ error: 'connect wallet for wager lobbies' });
    const l = makeLobby(opts ?? {}, socket.id);
    lobbies.set(l.code, l);
    joinLobbyInternal(l, socket, cb);
    console.log(`[lobby ${l.code}] created by ${s.nick} (${l.mode}${l.mode === 'wager' ? ` ${l.stake}` : ''}, ${l.map})`);
  });

  socket.on('joinLobby', (data, cb) => {
    const s = sess();
    if (s.lobbyCode) return cb?.({ error: 'already in a lobby' });
    const l = lobbies.get(String(data?.code || '').toUpperCase());
    if (!l) return cb?.({ error: 'lobby not found' });
    if (l.mode === 'wager' && !s.authed) return cb?.({ error: 'connect wallet for wager lobbies' });

    // reconnect grace: reclaim my old slot by wallet
    const goneSlot = s.wallet ? l.players.find((p) => p.gone && p.wallet === s.wallet) : null;
    if (goneSlot) {
      const oldId = goneSlot.id;
      goneSlot.id = socket.id;
      goneSlot.gone = null;
      s.lobbyCode = l.code;
      socket.join(`lobby:${l.code}`);
      if (l.hostId === oldId) l.hostId = socket.id;
      pushLobby(l);
      return cb?.({ ok: true, lobby: publicLobby(l), rejoined: l.status === 'playing' });
    }

    if (l.status !== 'waiting') return cb?.({ error: 'match in progress' });
    if (l.players.filter((p) => !p.gone).length >= l.maxPlayers) return cb?.({ error: 'lobby full' });
    if (s.wallet && l.players.some((p) => !p.gone && p.wallet === s.wallet))
      return cb?.({ error: 'wallet already in lobby' });
    joinLobbyInternal(l, socket, cb);
  });

  function joinLobbyInternal(l, sck, cb) {
    const s = sessions.get(sck.id);
    l.players.push({
      id: sck.id,
      nick: s.nick,
      wallet: s.wallet,
      ready: false,
      escrowed: false,
      betId: null,
      kills: 0,
      deaths: 0,
      hp: PLAYER_MAX_HP,
      alive: true,
      pos: { x: 36, y: 12, z: 36 },
      lastState: null,
      lastStateAt: 0,
      gone: null,
      shotTimes: {},
      grenadeTimes: {},
      shots: 0,
      hits: 0,
      headHits: 0,
      speedStrikes: 0,
      aimFlags: 0,
    });
    s.lobbyCode = l.code;
    sck.join(`lobby:${l.code}`);
    l.emptySince = null;
    // lobby chat history
    sck.emit('lobbyChatHistory', l.chat.slice(-30));
    pushLobby(l);
    cb?.({ ok: true, lobby: publicLobby(l) });
  }

  socket.on('leaveLobby', () => leaveLobby(socket, true));

  socket.on('setReady', (ready) => {
    const l = currentLobby();
    const p = me();
    if (!l || !p || l.status !== 'waiting') return;
    if (l.mode === 'wager' && ready && !p.escrowed) return; // must stake first
    if (l.mode === 'wager' && !ready && p.escrowed) return; // staked = committed
    p.ready = Boolean(ready);
    pushLobby(l);
    evaluateCountdown(l);
  });

  // --- wager escrow ---
  socket.on('escrowDeposit', async (data, cb) => {
    const l = currentLobby();
    const p = me();
    const s = sess();
    try {
      if (!l || !p || l.mode !== 'wager') return cb?.({ error: 'not a wager lobby' });
      if (!s.authed || !s.wallet) return cb?.({ error: 'wallet not authenticated' });
      if (p.escrowed) return cb?.({ error: 'already staked' });
      const sig = String(data?.sig || '');
      if (!sig) return cb?.({ error: 'missing signature' });
      if (usedDepositSigs.has(sig) || (await db.depositSigUsed(sig)))
        return cb?.({ error: 'signature already used' });
      usedDepositSigs.add(sig);

      const other = await db.findOpenStake(s.wallet);
      if (other && other.lobby_code !== l.code)
        return cb?.({ error: 'you already have an active stake elsewhere' });

      const verified = await sol.verifyDeposit(sig, s.wallet, l.stake);
      if (!verified) {
        usedDepositSigs.delete(sig);
        return cb?.({ error: 'deposit not found on-chain yet — retry in a few seconds' });
      }
      p.betId = await db.recordBet(l.code, s.wallet, l.stake, sig, 'escrowed');
      p.escrowed = true;
      p.ready = true;
      pushLobby(l);
      evaluateCountdown(l);
      cb?.({ ok: true });
      console.log(`[lobby ${l.code}] ${p.nick} staked ${l.stake} SOL`);
    } catch (err) {
      cb?.({ error: err.message });
    }
  });

  socket.on('unstake', async (_data, cb) => {
    const l = currentLobby();
    const p = me();
    const s = sess();
    if (!l || !p || !p.escrowed) return cb?.({ error: 'no active stake' });
    if (l.status !== 'waiting') return cb?.({ error: 'match locked' });
    p.escrowed = false;
    p.ready = false;
    if (p.betId) await db.updateBetStatus(p.betId, 'refunding').catch(() => {});
    const sig = await sol.payout(s.wallet, l.stake);
    if (sig) {
      if (p.betId) await db.updateBetStatus(p.betId, 'refunded').catch(() => {});
      p.betId = null;
      pushLobby(l);
      cb?.({ ok: true, sig });
    } else {
      p.escrowed = true; // keep claim; retry later
      if (p.betId) await db.updateBetStatus(p.betId, 'escrowed').catch(() => {});
      cb?.({ error: 'refund transfer failed — stake is safe, retry later' });
    }
  });

  // --- gameplay relay ---
  socket.on('state', (st) => {
    const l = currentLobby();
    const p = me();
    if (!l || !p || l.status !== 'playing' || !p.alive) return;
    const now = Date.now();
    const dt = Math.min((now - (p.lastStateAt || now)) / 1000, 0.5);
    const nx = Number(st?.x), ny = Number(st?.y), nz = Number(st?.z);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return;

    // speed check (rubber-band on violation)
    if (p.lastStateAt && dt > 0) {
      const d = dist3({ x: nx, y: ny, z: nz }, p.pos);
      const respawned = st?.rn !== p.lastRespawnNonce;
      if (!respawned && d > MAX_SPEED * dt + 0.8) {
        p.speedStrikes += 1;
        if (p.speedStrikes > 6) {
          socket.emit('kicked', { reason: 'movement validation failed' });
          leaveLobby(socket, true);
          return;
        }
        io.to(socket.id).emit('rubberband', { pos: p.pos });
        return;
      }
    }
    p.lastRespawnNonce = st?.rn;
    p.pos = { x: nx, y: ny, z: nz };
    p.lastStateAt = now;
    p.lastState = {
      x: Number(nx.toFixed(2)),
      y: Number(ny.toFixed(2)),
      z: Number(nz.toFixed(2)),
      yaw: Number(Number(st?.yaw ?? 0).toFixed(3)),
      pitch: Number(Number(st?.pitch ?? 0).toFixed(3)),
      w: WEAPONS[st?.w] ? st.w : 'rifle',
      f: st?.f & 0xff, // anim flags bitmask
    };
  });

  socket.on('shot', (data) => {
    const l = currentLobby();
    const p = me();
    if (!l || !p || l.status !== 'playing' || !p.alive) return;
    const w = String(data?.w || '');
    if (!WEAPONS[w] || !fireRateOk(p, w)) return;
    p.shots += 1;
    socket.to(`lobby:${l.code}`).emit('shot', { id: socket.id, w, o: data?.o, d: data?.d });
  });

  socket.on('grenade', (data) => {
    const l = currentLobby();
    const p = me();
    if (!l || !p || l.status !== 'playing' || !p.alive) return;
    const kind = String(data?.kind || '');
    if (!GRENADE_KINDS.has(kind)) return;
    const now = Date.now();
    const last = p.grenadeTimes[kind] ?? 0;
    if (now - last < GRENADE_COOLDOWNS[kind] * 1000 * 0.9) return;
    p.grenadeTimes[kind] = now;
    socket.to(`lobby:${l.code}`).emit('grenade', { id: socket.id, kind, o: data?.o, d: data?.d });
  });

  socket.on('hit', (data) => {
    const l = currentLobby();
    const p = me();
    if (!l || !p || l.status !== 'playing' || !p.alive) return;
    const w = String(data?.w || '');
    const spec = WEAPONS[w];
    if (!spec) return;
    const victim = l.players.find((v) => v.id === data?.victim && !v.gone);
    if (!victim || !victim.alive || victim.id === socket.id) return;

    // range sanity vs both last known positions
    if (dist3(p.pos, victim.pos) > spec.range * 1.2 + 4) return;

    // hit-rate sanity: pellets can register multiple hits per trigger pull, cap per second
    const now = Date.now();
    p.hitWindow = (p.hitWindow ?? []).filter((t) => now - t < 1000);
    if (p.hitWindow.length >= Math.max(4, (spec.rpm / 60) * spec.pellets * 1.4)) return;
    p.hitWindow.push(now);

    p.hits += 1;
    const head = Boolean(data?.head);
    if (head) p.headHits += 1;

    // aimbot heuristic: sustained impossible accuracy
    if (p.shots > 40 && p.hits / p.shots > 0.9 && p.headHits / p.hits > 0.7) {
      p.aimFlags += 1;
      if (p.aimFlags > 2) {
        socket.emit('kicked', { reason: 'combat validation failed' });
        leaveLobby(socket, true);
        return;
      }
    }

    const dmg = Math.round(spec.damage * (head ? spec.headshotMul : 1));
    victim.hp = Math.max(0, victim.hp - dmg);
    io.to(victim.id).emit('damaged', { by: socket.id, dmg, hp: victim.hp, head });
    io.to(socket.id).emit('hitConfirm', { victim: victim.id, dmg, hp: victim.hp, head });
    if (victim.hp <= 0) applyKill(l, p, victim);
  });

  socket.on('fragDamage', (data) => {
    // frag grenade AoE against a victim, validated by distance to blast
    const l = currentLobby();
    const p = me();
    if (!l || !p || l.status !== 'playing') return;
    const victim = l.players.find((v) => v.id === data?.victim && !v.gone);
    if (!victim || !victim.alive) return;
    const blast = data?.at;
    if (!blast || dist3(blast, victim.pos) > 6.5) return;
    const dmg = Math.min(118, Math.max(0, Number(data?.dmg) || 0));
    if (dmg <= 0) return;
    victim.hp = Math.max(0, victim.hp - dmg);
    io.to(victim.id).emit('damaged', { by: socket.id, dmg, hp: victim.hp, head: false });
    if (victim.hp <= 0) {
      if (victim.id === socket.id) {
        victim.deaths += 1;
        victim.alive = false;
        io.to(`lobby:${l.code}`).emit('killfeed', {
          killer: victim.nick, victim: victim.nick, killerId: victim.id, victimId: victim.id, solDelta: 0,
        });
        setTimeout(() => {
          if (l.status !== 'playing' || victim.gone) return;
          victim.hp = PLAYER_MAX_HP;
          victim.alive = true;
          const sp = spawnPoint(Math.floor(Math.random() * 8));
          victim.pos = { ...sp };
          io.to(victim.id).emit('respawn', { spawn: sp });
        }, RESPAWN_SECONDS * 1000);
      } else {
        applyKill(l, p, victim);
      }
    }
  });

  // --- chat ---
  socket.on('chat', async (data) => {
    const s = sess();
    const msg = String(data?.msg || '').trim().slice(0, 200);
    const scope = data?.scope === 'lobby' ? 'lobby' : 'global';
    if (!msg) return;
    if (!chatRateOk(socket.id)) return socket.emit('chatError', { error: 'slow down' });
    if (await db.isIpBanned(s.ip)) return socket.emit('chatError', { error: 'muted' });
    if (isGibberish(msg) || isRepeatSpam(socket.id, msg)) {
      await db.banIp(s.ip, 60, 'spam');
      return socket.emit('chatError', { error: 'muted for spam' });
    }
    const entry = { nick: s.nick, wallet: shortWallet(s.wallet), msg, ts: Date.now(), scope };
    if (scope === 'lobby') {
      const l = currentLobby();
      if (!l) return;
      l.chat.push(entry);
      if (l.chat.length > 50) l.chat.shift();
      io.to(`lobby:${l.code}`).emit('chat', entry);
    } else {
      const id = await db.saveChat(s.nick, s.wallet, msg, s.ip).catch(() => null);
      if (id !== null) {
        msgIpIndex.set(Number(id), s.ip);
        if (msgIpIndex.size > 2000) msgIpIndex.delete(msgIpIndex.keys().next().value);
      }
      io.emit('chat', { ...entry, id });
    }
  });

  socket.on('chatHistory', async (_data, cb) => {
    const rows = await db.recentChat(40).catch(() => []);
    cb?.(
      rows.map((r) => ({
        id: Number(r.id),
        nick: r.nick,
        wallet: shortWallet(r.wallet),
        msg: r.msg,
        ts: new Date(r.created_at).getTime(),
        scope: 'global',
      })),
    );
  });

  socket.on('disconnect', () => {
    leaveLobby(socket, false);
    sessions.delete(socket.id);
    broadcastMeta();
  });

  function leaveLobby(sck, immediate) {
    const s = sessions.get(sck.id);
    if (!s?.lobbyCode) return;
    const l = lobbies.get(s.lobbyCode);
    s.lobbyCode = null;
    sck.leave(`lobby:${l?.code}`);
    if (!l) return;
    const p = l.players.find((x) => x.id === sck.id);
    if (!p) return;

    if (immediate || l.status === 'waiting') {
      // refund pending stake on clean exit from waiting room
      if (p.escrowed && p.wallet && l.status === 'waiting') {
        const wallet = p.wallet;
        const stake = l.stake;
        const betId = p.betId;
        (async () => {
          const sig = await sol.payout(wallet, stake);
          if (betId) await db.updateBetStatus(betId, sig ? 'refunded' : 'escrowed').catch(() => {});
          console.log(`[lobby ${l.code}] auto-refund ${stake} SOL to ${shortWallet(wallet)}: ${sig ?? 'FAILED'}`);
        })();
      }
      const i = l.players.indexOf(p);
      if (i >= 0) l.players.splice(i, 1);
    } else {
      // mid-match: grace slot for reconnect (forfeits pot if never returns)
      p.gone = Date.now();
      p.alive = false;
    }
    if (l.hostId === sck.id) {
      const next = l.players.find((x) => !x.gone);
      if (next) l.hostId = next.id;
    }
    // end match early if fewer than 2 alive participants remain
    if (l.status === 'playing' && l.players.filter((x) => !x.gone).length < 2) {
      endMatch(l, 'abandoned');
    }
    evaluateCountdown(l);
    pushLobby(l);
  }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

await db.ensureSchema().catch((err) => console.error('[db] schema init failed:', err.message));
await refreshLeaderboards();
setInterval(refreshLeaderboards, 30_000);

startLlmModeration({
  onRemoved: (ids) => io.emit('chatRemoved', { ids }),
  getIpForMessage: (id) => msgIpIndex.get(id),
});

server.listen(PORT, () => {
  console.log(`🪖 TrenchField server on :${PORT} (db=${db.dbEnabled} wagers=${sol.wagersEnabled} cluster=${sol.cluster})`);
});
