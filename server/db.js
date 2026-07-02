// Neon Postgres layer. Falls back to in-memory storage when DATABASE_URL is absent
// so local dev works without a database.
import pg from 'pg';

const { Pool } = pg;
const url = process.env.DATABASE_URL || '';
export const dbEnabled = Boolean(url);

const pool = dbEnabled
  ? new Pool({
      connectionString: url,
      max: 8,
      ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
    })
  : null;

// --- in-memory fallback (dev only) ---
const mem = {
  players: new Map(), // wallet -> {nick, kills, deaths, sol_won}
  bets: [],
  chat: [],
  ipBans: new Map(),
  nextId: 1,
};

export async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tf_players (
      wallet text PRIMARY KEY,
      nick text NOT NULL DEFAULT 'operator',
      kills integer NOT NULL DEFAULT 0,
      deaths integer NOT NULL DEFAULT 0,
      sol_won numeric NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tf_matches (
      id bigserial PRIMARY KEY,
      code text,
      map text,
      mode text,
      stake numeric NOT NULL DEFAULT 0,
      players jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tf_bets (
      id bigserial PRIMARY KEY,
      lobby_code text,
      wallet text NOT NULL,
      amount numeric NOT NULL,
      tx_sig text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tf_bets_wallet_status ON tf_bets (wallet, status);
    CREATE INDEX IF NOT EXISTS tf_bets_sig ON tf_bets (tx_sig);
    CREATE TABLE IF NOT EXISTS tf_chat (
      id bigserial PRIMARY KEY,
      nick text,
      wallet text,
      msg text NOT NULL,
      ip text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tf_chat_created ON tf_chat (created_at DESC);
    CREATE TABLE IF NOT EXISTS tf_chat_ip_bans (
      ip text PRIMARY KEY,
      ban_until timestamptz NOT NULL,
      reason text
    );
  `);
}

export async function upsertPlayer(wallet, nick) {
  if (!wallet) return;
  if (!pool) {
    const p = mem.players.get(wallet) ?? { nick, kills: 0, deaths: 0, sol_won: 0 };
    p.nick = nick || p.nick;
    mem.players.set(wallet, p);
    return;
  }
  await pool.query(
    `INSERT INTO tf_players (wallet, nick) VALUES ($1, $2)
     ON CONFLICT (wallet) DO UPDATE SET nick = EXCLUDED.nick, updated_at = now()`,
    [wallet, (nick || 'operator').slice(0, 20)],
  );
}

export async function addKillsDeaths(wallet, kills, deaths) {
  if (!wallet) return;
  if (!pool) {
    const p = mem.players.get(wallet) ?? { nick: 'operator', kills: 0, deaths: 0, sol_won: 0 };
    p.kills += kills;
    p.deaths += deaths;
    mem.players.set(wallet, p);
    return;
  }
  await pool.query(
    `INSERT INTO tf_players (wallet, kills, deaths) VALUES ($1, $2, $3)
     ON CONFLICT (wallet) DO UPDATE
       SET kills = tf_players.kills + $2, deaths = tf_players.deaths + $3, updated_at = now()`,
    [wallet, kills, deaths],
  );
}

export async function addSolWon(wallet, delta) {
  if (!wallet || !delta) return;
  if (!pool) {
    const p = mem.players.get(wallet) ?? { nick: 'operator', kills: 0, deaths: 0, sol_won: 0 };
    p.sol_won += delta;
    mem.players.set(wallet, p);
    return;
  }
  await pool.query(
    `INSERT INTO tf_players (wallet, sol_won) VALUES ($1, $2)
     ON CONFLICT (wallet) DO UPDATE SET sol_won = tf_players.sol_won + $2, updated_at = now()`,
    [wallet, delta],
  );
}

export async function topKillers(limit = 10) {
  if (!pool) {
    return [...mem.players.entries()]
      .map(([wallet, p]) => ({ wallet, nick: p.nick, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills)
      .slice(0, limit);
  }
  const r = await pool.query(
    `SELECT wallet, nick, kills, deaths FROM tf_players ORDER BY kills DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function topSolWon(limit = 10) {
  if (!pool) {
    return [...mem.players.entries()]
      .map(([wallet, p]) => ({ wallet, nick: p.nick, sol_won: p.sol_won }))
      .filter((p) => p.sol_won > 0)
      .sort((a, b) => b.sol_won - a.sol_won)
      .slice(0, limit);
  }
  const r = await pool.query(
    `SELECT wallet, nick, sol_won FROM tf_players WHERE sol_won > 0 ORDER BY sol_won DESC LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({ ...row, sol_won: Number(row.sol_won) }));
}

export async function recordMatch(code, map, mode, stake, players) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO tf_matches (code, map, mode, stake, players) VALUES ($1,$2,$3,$4,$5)`,
    [code, map, mode, stake, JSON.stringify(players)],
  );
}

// --- bets ledger (durability: write before paying) ---

export async function recordBet(lobbyCode, wallet, amount, txSig, status) {
  if (!pool) {
    const id = mem.nextId++;
    mem.bets.push({ id, lobby_code: lobbyCode, wallet, amount, tx_sig: txSig, status });
    return id;
  }
  const r = await pool.query(
    `INSERT INTO tf_bets (lobby_code, wallet, amount, tx_sig, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [lobbyCode, wallet, amount, txSig, status],
  );
  return r.rows[0].id;
}

export async function updateBetStatus(id, status) {
  if (!pool) {
    const b = mem.bets.find((x) => x.id === id);
    if (b) b.status = status;
    return;
  }
  await pool.query(`UPDATE tf_bets SET status = $2 WHERE id = $1`, [id, status]);
}

export async function depositSigUsed(sig) {
  if (!pool) return mem.bets.some((b) => b.tx_sig === sig);
  const r = await pool.query(`SELECT 1 FROM tf_bets WHERE tx_sig = $1 LIMIT 1`, [sig]);
  return r.rowCount > 0;
}

export async function findOpenStake(wallet) {
  if (!pool) return mem.bets.find((b) => b.wallet === wallet && b.status === 'escrowed') ?? null;
  const r = await pool.query(
    `SELECT id, lobby_code, amount FROM tf_bets WHERE wallet = $1 AND status = 'escrowed' ORDER BY id DESC LIMIT 1`,
    [wallet],
  );
  return r.rows[0] ?? null;
}

// --- chat ---

export async function saveChat(nick, wallet, msg, ip) {
  if (!pool) {
    const id = mem.nextId++;
    mem.chat.push({ id, nick, wallet, msg, created_at: new Date() });
    if (mem.chat.length > 200) mem.chat.shift();
    return id;
  }
  const r = await pool.query(
    `INSERT INTO tf_chat (nick, wallet, msg, ip) VALUES ($1,$2,$3,$4) RETURNING id`,
    [nick, wallet, msg, ip],
  );
  return r.rows[0].id;
}

export async function recentChat(limit = 40) {
  if (!pool) return mem.chat.slice(-limit);
  const r = await pool.query(
    `SELECT id, nick, wallet, msg, created_at FROM tf_chat ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return r.rows.reverse();
}

export async function deleteChat(ids) {
  if (ids.length === 0) return;
  if (!pool) {
    for (const id of ids) {
      const i = mem.chat.findIndex((c) => c.id === id);
      if (i >= 0) mem.chat.splice(i, 1);
    }
    return;
  }
  await pool.query(`DELETE FROM tf_chat WHERE id = ANY($1::bigint[])`, [ids]);
}

export async function newChatSince(sinceId, limit = 25) {
  if (!pool) return mem.chat.filter((c) => c.id > sinceId).slice(0, limit);
  const r = await pool.query(
    `SELECT id, nick, msg FROM tf_chat WHERE id > $1 ORDER BY id ASC LIMIT $2`,
    [sinceId, limit],
  );
  return r.rows;
}

export async function banIp(ip, seconds, reason) {
  const until = new Date(Date.now() + seconds * 1000);
  if (!pool) {
    mem.ipBans.set(ip, until);
    return;
  }
  await pool.query(
    `INSERT INTO tf_chat_ip_bans (ip, ban_until, reason) VALUES ($1,$2,$3)
     ON CONFLICT (ip) DO UPDATE SET ban_until = EXCLUDED.ban_until, reason = EXCLUDED.reason`,
    [ip, until, reason],
  );
}

export async function isIpBanned(ip) {
  if (!pool) {
    const until = mem.ipBans.get(ip);
    return until ? until.getTime() > Date.now() : false;
  }
  const r = await pool.query(
    `SELECT 1 FROM tf_chat_ip_bans WHERE ip = $1 AND ban_until > now() LIMIT 1`,
    [ip],
  );
  return r.rowCount > 0;
}
