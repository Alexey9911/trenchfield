# TrenchField

A browser-playable voxel arena shooter prototype. Five-minute deathmatch against six AI
soldiers in a dusk-lit WW1-style trench arena. Earn **Trench Points** for kills, streaks
and headshots — banked to a local wallet, with a mocked Solana creator-room economy
(room owner earns a 5% cut of all TP generated in the room).

**Single-player vs bots.** Multiplayer and on-chain settlement are on the roadmap; this
prototype prioritises the visual identity, the gameplay feel and instant browser access.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5188
npm run build      # production build (dist/)
npm run preview    # serve production build at http://127.0.0.1:4188
npm test           # Playwright QA suite (landing + gameplay, desktop + mobile)
```

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Aim · left click fire · right click iron sights |
| `Shift` | Sprint |
| `Space` / `C` | Jump / crouch |
| `R` | Reload |
| `G` | Frag grenade (carves real craters in soft terrain) |
| `1` / `2` | M-27 Trench Rifle / S-12 Scattergun |
| `Tab` | Scoreboard |
| `Esc` | Pause |

## What's inside

- **Voxel world**: 72×72 chunked arena, procedural pixel-art texture atlas, per-vertex
  ambient occlusion, zigzag trench lines with duckboards and sandbag parapets, four
  bunkers, two watchtowers, crater field, barbed wire, destructible soft terrain.
- **Bots**: three archetypes (Rifleman / Shocktrooper / Scout) with distinct voxel
  bodies, helmets, colors, stats and AI (patrol, line-of-sight target acquisition,
  strafing burst fire, auto-jump navigation, free-for-all — they fight each other too).
- **Hero assets**: rifle + scattergun viewmodels and the crashed tank centerpiece were
  generated with the Meshy API, then remeshed and compressed (meshopt + WebP) from
  66 MB raw to **1.9 MB total**.
- **Audio**: 24 sounds generated with ElevenLabs (weapons, hits, footsteps, pickups,
  explosion, UI, looping battlefield ambience, announcer voice lines), played through a
  grouped Web Audio manager with distance attenuation.
- **Economy mock**: Trench Points per kill/streak/headshot, persistent local wallet,
  creator-room card with owner cut — clearly labelled as a devnet-style mock.

## Verification hooks

- `?test=1` — auto-deploys without pointer lock and exposes deterministic QA hooks
  (`__TEST_AIM_AT_BOT__`, `__TEST_TELEPORT_TO_BOT__`, `__TEST_SET_TIME__`).
- `window.__THREE_GAME_DIAGNOSTICS__` — frame, state, renderer counts, player, bots,
  audio and imported-asset diagnostics.
- `node scripts/capture.mjs` — desktop/mobile screenshot evidence.
- `node scripts/playtest.mjs` — automated combat playtest.
- `node scripts/inspect-threejs-canvas.mjs --url …` — canvas pixel verification.

## Deploy

`npm run build` produces a fully static `dist/` (6.4 MB, ~190 KB gzipped JS before
lazy-loaded models/audio) that works on any static host (Netlify, Vercel, Cloudflare
Pages). No server required.
