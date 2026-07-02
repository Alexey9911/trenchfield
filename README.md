# TrenchField

A browser-playable voxel arena shooter. Compact 5-minute deathmatch in a WW1-style
voxel trench arena — **solo vs bots** or **realtime multiplayer with SOL wagers**. Pick a
day or night map, drop in, and fight. Earn Trench Points solo, or stake real SOL in wager
lobbies where every kill takes a slice of your victim's pot.

## Run

```bash
# client
npm install
npm run dev        # http://127.0.0.1:5188
npm run build      # static production build (dist/)
npm run preview    # serve the build at http://127.0.0.1:4188
npm test           # Playwright QA suite

# realtime server (multiplayer + wagers + chat)
cd server
npm install
node index.js      # :8123  (needs server/.env — see below)
```

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Aim · left click fire · right click sights (sniper = scope) |
| `Shift` | Sprint · `Space` jump · `C` crouch |
| `R` | Reload |
| `1 / 2 / 3` | Rifle / Scattergun / Sniper |
| `G / F / X` | Frag / Smoke / Flash grenade |
| `Tab` | Scoreboard · `Esc` pause |

## Modes

- **Solo (default)** — 6 AI soldiers in free-for-all, Trench Points banked locally.
- **Multiplayer lobbies** — create or join a lobby (2–8 players, day or night map).
  - *Friendly*: no stakes.
  - *Wager*: stake SOL once to join. Each kill transfers 10% of the stake from victim
    to killer; cash out your pot when the match ends. Server-authoritative, on-chain
    escrow via a dedicated hot wallet.

## What's inside

- **Voxel world**: 72×72 chunked arena, procedural pixel-art atlas (mipmapped), baked
  per-vertex AO, zigzag trenches, bunkers, watchtowers, crater field, destructible soft
  terrain. Two themed maps — **Daybreak** (bright) and **Midnight** (blue moonlight).
- **Weapons**: M-27 rifle, S-12 scattergun, W-14 bolt sniper (scoped) — Meshy-generated
  viewmodels. Frag (craters), smoke (blocks bot LOS), flash (blinds player + bots).
- **Bots**: 3 archetypes with distinct voxel bodies + AI (LOS acquisition, strafing
  bursts, auto-jump, free-for-all).
- **3D assets**: rifle / shotgun / sniper / tank from Meshy, remeshed + meshopt/WebP
  compressed (66 MB raw → ~2.3 MB shipped).
- **Audio**: Kenney CC0 arcade weapon sounds + ElevenLabs SFX/ambience/announcer, grouped
  Web Audio with distance attenuation.
- **Realtime backend** (`server/`): socket.io relay @ 20 Hz, server-validated combat
  (fire-rate, range, speed, aimbot heuristics), lobbies with reconnect grace, Solana
  escrow (deposit verification + payouts), Neon Postgres (players/matches/bets/chat),
  global + lobby chat with 3-tier moderation (rate-limit → heuristics → Cerebras LLM),
  kills + SOL-won leaderboards.

## Server env (`server/.env`)

```
DATABASE_URL=postgresql://…neon.tech/neondb?sslmode=require
HELIUS_API_KEY=…                 # Solana RPC
HOUSE_WALLET_SECRET=…            # base58 secret of the escrow hot wallet
SOLANA_CLUSTER=mainnet-beta
CEREBRAS_API_KEYS=csk-…,csk-…    # optional; LLM chat moderation (heuristics work without)
PORT=8123
```

The client points at the server via `VITE_SOCKET_URL` (falls back to `localhost:8123` in
dev). Without a reachable server the client runs solo-only and hides the lobby UI.

## Deploy

- **Client**: static `dist/` on Vercel (`git push` auto-deploys). Set `VITE_SOCKET_URL`.
- **Server**: single always-on Fly.io machine (`fly deploy`). Escrow + lobbies live in
  RAM — never scale count > 1. Neon (US-East) is region-matched to Fly `iad`.

## Verification hooks

- `?test=1` — auto-deploys solo, exposes QA hooks (`__TEST_AIM_AT_BOT__`,
  `__TEST_TELEPORT_TO_BOT__`, `__TEST_GOD__`, `__TEST_SET_TIME__`). Add `&mp=1` for the
  multiplayer flow (`__TEST_AIM_AT_REMOTE__`).
- `window.__THREE_GAME_DIAGNOSTICS__` — frame, state, renderer counts, player, bots.
- `node scripts/capture.mjs` — screenshot evidence · `node scripts/mptest.mjs` — 2-client
  multiplayer E2E · `node scripts/playtest.mjs` — solo combat playtest.
