# TrenchField — Documentación Maestra del Proyecto

> Documento de referencia completo. Si se pierde el contexto de la sesión, TODO lo
> necesario para continuar el trabajo está aquí. Actualizado: 2026-07-02.

---

## 1. Qué es

**TrenchField**: shooter voxel de navegador (estilo Blockfield premium). Arena compacta
de trincheras WW1, partidas de 5 minutos. Dos modos:

- **Single Player**: FFA contra 6 bots con IA. Trench Points locales.
- **Multiplayer**: lobbies en tiempo real (2-8 jugadores), friendly o **wager con SOL
  real** (mainnet). Cada kill transfiere 10% del stake de la víctima al asesino; cash
  out del pot al terminar.

## 2. URLs y despliegues

| Qué | Dónde | Notas |
| --- | --- | --- |
| **Juego (cliente)** | https://minecraftshooter.vercel.app | Vercel, auto-deploy en push a `main` |
| **Server realtime** | https://trenchfield-server.fly.dev | Fly.io app `trenchfield-server`, región `iad`, 1 máquina always-on `shared-cpu-2x/1024mb` |
| **Repo** | https://github.com/Alexey9911/trenchfield | rama `main` |
| **Health check** | `GET /health` en el server | `{"ok":true,"wagers":true,"cluster":"mainnet-beta","db":true}` |

⚠️ **DNS local**: el router del usuario NO resuelve `*.fly.dev`. Para probar desde esta
máquina usar Chromium con `--host-resolver-rules=MAP trenchfield-server.fly.dev 66.241.124.10`
o curl con `--resolve trenchfield-server.fly.dev:443:66.241.124.10`. Los usuarios reales
resuelven bien (IPv6 dedicado + IPv4 compartido 66.241.124.10).

## 3. Stack técnico

**Cliente** (raíz del repo): Vite + TypeScript + Three.js 0.184. Vercel.
**Server** (`server/`, JavaScript ESM): Node 22 + Express + socket.io + pg + @solana/web3.js.
**DB**: Neon Postgres (instancia compartida de wow-recreate, host
`ep-silent-forest-adt59w44.c-2.us-east-1.aws.neon.tech/neondb`, tablas con prefijo `tf_`).
**Arquitectura copiada de**: `D:\Alexey\threeJS journey\DEV-CRYPTO\football-Game-Copy-V2`
(SOLBALL: lobbies, escrow, chat, moderación) + `D:\Alexey\threeJS journey\DEV-CRYPTO\wow-claude`
(recreate: heurísticas de chat, deploy en Fly, Neon).

## 4. Secretos y claves (NUNCA en git)

Los valores viven en `server/.env` (gitignored) y en `fly secrets` del app
`trenchfield-server`:

| Var | Origen | Notas |
| --- | --- | --- |
| `DATABASE_URL` | copiado de `wow-claude/recreate-wow/.env` | Neon us-east-1 |
| `HELIUS_API_KEY` | copiado de `football-Game-Copy-V2/.env` | RPC Solana |
| `HOUSE_WALLET_SECRET` | **NUEVA wallet generada** (base58 en `server/.env.wallet`) | Escrow. Pubkey: `FfgnAfyowTivLr8WaifwCZrysNY2JLvwJ37NkLuaKcum`. ⚠️ Hay que fondearla con ~0.02 SOL para fees de payout |
| `SOLANA_CLUSTER` | `mainnet-beta` | igual que football |
| `CEREBRAS_API_KEYS` | 2 keys dadas por el usuario (`csk-k26y…`, `csk-9y83…`) | moderación LLM del chat, en fly secrets |

Cliente (Vercel env): `VITE_SOCKET_URL=https://trenchfield-server.fly.dev`.
`VITE_SOLANA_RPC` (opcional, mainnet Helius con la misma key). En localhost el cliente
usa `http://127.0.0.1:8123` como fallback.

## 5. Estructura del código

### Cliente `src/`
- `core/Engine.ts` — renderer/loop. rAF + fallback setTimeout con **sub-stepping** (si un
  frame tarda >50ms, corre N sub-pasos de sim para que el tiempo simulado siga al real;
  también mantiene vivo el juego en pestañas ocultas/headless).
- `core/Input.ts` — intents teclado/ratón + **estado táctil** merged. `isLocked` es true
  con pointer lock, testMode o touchMode.
- `core/TouchControls.ts` — joystick virtual izq., drag derecho para mirar, botones
  FIRE/ADS/JUMP/RELOAD, slots 1/2/3 y granada. Activa `body.touch` en móvil.
- `core/AudioManager.ts` — Web Audio con grupos (sfx/ui/ambience/voice), unlock por
  gesto, atenuación por distancia. Manifest apunta a `/assets/audio/...`.
- `game/constants.ts` — TODOS los tunables: armas (`WEAPONS`: rifle/scattergun/sniper),
  granadas (`GRENADES`: frag/smoke/flash), bots (`BOT_ARCHETYPES`), mapas (`MAPS`:
  day/night con tema completo de cielo/luces/fog), skins (`SKINS`/`SKIN_ORDER`:
  olive/scout/ironclad → mapean a arquetipos de bot).
- `game/Identity.ts` — nickname + `deviceId` guest persistente + wallet. **Leaderboard
  keyed por wallet o guestId** (nick solo display, como football). Tag corto `#XXXX`.
- `game/Game.ts` — orquestador (~1400 líneas). Estados: menu/playing/dead/ended.
  Cámara de menú = **showcase 3ª persona**: orbita al bot que lleva la skin elegida
  (bots 0/1/2 llevan las 3 skins), con lerp suave al cambiar (`setSkinPreview`).
  `buildWorld(mapId)` reconstruye mundo/sky/props al cambiar mapa. MP integrado
  (ver §7).
- `game/Match.ts` — roster, timer, Trench Points, wallet local (localStorage).
- `world/` — `VoxelWorld` (chunks 12x12, AO por vértice, raycast DDA, colisión AABB,
  cráteres destructibles), `MapBuilder` (arena 72×72: trincheras zigzag por `variant`,
  búnkeres, torres, spawns/waypoints), `BlockAtlas` (atlas pixel-art procedural 4x
  upscaled + mipmaps), `Sky` (dome shader con tema, sol/luna, estrellas de noche,
  colinas, nubes, key/hemi/rim lights), `PropsKit` (crates/barriles/alambre instanciados).
- `entities/` — `PlayerController` (FPS, colisión voxel, regen), `WeaponSystem`
  (viewmodels con bob/sway/recoil/ADS, scope sniper oculta el arma y muestra overlay,
  cooldowns de granadas por tipo, fallbacks procedurales hasta que cargan los GLB),
  `Bot` (FSM patrol/engage, LOS, ráfagas, auto-jump, ceguera por flash), `BotBodyFactory`
  (soldados voxel con joints nombrados — usado también para skins/remotos), `Grenade`,
  `Pickups` (medkit/ammo).
- `fx/` — `VfxSystem` (pools: tracers, muzzle flash+cono+chispas, debris voxel,
  explosiones, **nubes de humo tácticas** con `segmentBlockedBySmoke` para LOS de bots,
  flashbang), `CameraFx` (shake/recoil/landing).
- `net/NetClient.ts` — wrapper socket.io con todos los eventos tipados.
- `net/RemotePlayers.ts` — avatares remotos (cuerpos de BotBodyFactory) con buffer de
  interpolación 110ms, raycast de hits, anim de caminar/apuntar/muerte.
- `solana/wallet.ts` — Phantom/Solflare/Backpack inyectados, connect, signMessage
  (auth por nonce), `payStake` (SystemProgram.transfer al escrow).
- `ui/Screens.ts` — landing (mode toggle solo/mp, nickname, selector skin, mapas),
  pause/death/end. `ui/Hud.ts` — HUD zonificado + **live leaderboard** (`setLiveLeaderboard`),
  `setLockHint`, `setMode` (labels solo vs mp), scope/flash overlays. `ui/MultiplayerUI.ts` —
  wallet panel, lobby browser/create/room, chat global+lobby, leaderboards kills/SOL.

### Server `server/`
- `index.js` — todo el realtime: lobbies (create/join/ready/countdown, códigos 4-char,
  reconnect grace 45s, cleanup 5min), snapshots @20Hz volatile, **validación de combate**
  (fire-rate por rpm, rango por arma, speed check con rubber-band, heurística aimbot:
  >90% accuracy + >70% headshots sobre 40 tiros → kick), kills → `applyKill` (pots wager),
  escrow (`escrowDeposit` verifica on-chain con anti-replay, `unstake`, settle al final
  con **ledger antes de pagar**), chat (rate-limit token bucket, ban IP, scopes), meta
  broadcast (lobbies + leaderboards), `soloResult` (kills de SP al leaderboard por
  wallet/guestId).
- `db.js` — pg Pool + fallback en memoria. Tablas: `tf_players` (wallet PK = wallet o
  guestId, nick, kills, deaths, sol_won), `tf_matches`, `tf_bets` (ledger de stakes),
  `tf_chat`, `tf_chat_ip_bans`. `ensureSchema()` al boot.
- `solana.js` — house wallet, `verifyDeposit` (getParsedTransaction, 8 retries),
  `payout`, rotación de RPCs Helius.
- `moderation.js` — 3 capas: rate-limit → heurísticas (gibberish, repeat-spam,
  impersonación de nick, exención crypto para addresses/hashes) → **LLM batch cada 4s**
  (Cerebras `gpt-oss-120b` con el prompt VERBATIM de SOLBALL, fallback Groq, fail-open).
- `weapons.js` — specs server-side (el daño NUNCA se confía del cliente).
- `fly.toml` + `Dockerfile` viven EN `server/` — **desplegar siempre con
  `cd server && fly deploy --remote-only --ha=false`** (desde la raíz sube 160MB de
  contexto y se cuelga). ⚠️ NUNCA escalar a >1 máquina (escrow/lobbies en RAM).

## 6. Protocolo de red (socket.io)

Cliente→Server: `hello {nick, wallet, token, guestId}` · `wallet-nonce`/`wallet-auth`
(firma ed25519 → token HMAC) · `createLobby {title, mode: free|wager, stake, map,
maxPlayers}` · `joinLobby {code}` · `leaveLobby` · `setReady` · `escrowDeposit {sig}` ·
`unstake` · `state {x,y,z,yaw,pitch,w,f,rn}` @20Hz volatile · `shot {w,o,d}` ·
`hit {victim, w, head}` · `grenade {kind,o,d}` · `fragDamage {victim,dmg,at}` ·
`chat {msg, scope}` · `chatHistory` · `soloResult {kills,deaths}`.

Server→Cliente: `meta` (lobbies+leaderboards+online) · `lobbyUpdate` · `matchStart`
(players+spawns+endsAt+killGain) · `snapshot {players:[{id,x,y,z,yaw,pitch,w,f,hp,alive,k,d}]}`
· `shot`/`grenade` (relay) · `killfeed {killer,victim,ids,solDelta}` · `damaged` ·
`hitConfirm` · `respawn {spawn}` · `rubberband {pos}` · `matchEnd {standings,payouts}` ·
`chat`/`chatRemoved`/`lobbyChatHistory` · `kicked`.

Stakes permitidos: `[0.01, 0.05]` SOL. Kill = stake×0.1. Match: 5 min.

## 7. Multiplayer en el cliente (Game.ts)

`mpActive=true` desde `matchStart`: bots ocultos, `RemotePlayers` activo, estado enviado
@20Hz, **HP autoritativo del server** (snapshot pisa el local), disparos → raycast contra
remotos → `sendHit` (server valida y aplica daño), granadas visuales relayed + frag envía
`fragDamage` por distancia, muerte → `onMpDeath` (libera pointer lock, server manda
`respawn`), fin → end screen con standings/pots SOL. `quitToMenu` limpia todo.

## 8. UI/UX actual (rediseño 2026-07-02)

- **Landing 2 columnas**: izquierda = título + toggle SINGLE PLAYER/MULTIPLAYER +
  CALLSIGN (con tag de identidad) + selector de skin con flechas; derecha = panel
  contextual (solo: mapas+DEPLOY; mp: TP+lobbies+CREATE+leaderboard). Centro
  transparente para ver el **showcase del bot con tu skin en 3ª persona**.
- **HUD zonificado sin overlaps**: standings live (top-5) arriba-izq SIEMPRE visible,
  timer centro, puntos/pot arriba-der con killfeed debajo, vitals abajo-izq, munición +
  pips de granadas abajo-der. TAB = scoreboard completo. `setMode` cambia labels
  (TRENCH POINTS/SKIRMISH vs SOL POT/WAGER DEATHMATCH).
- **Chat**: dock centro-abajo en menú (expandido en desktop), tabs GLOBAL/LOBBY. Oculto
  durante juego activo. En móvil: FAB 💬 → hoja fullscreen.
- **Lobby room**: panel compacto abajo-izquierda (no cubre la pantalla).
- **Pointer lock**: se libera al morir (Redeploy clickeable); si se pierde jugando,
  aparece "CLICK TO LOOK" y un click en el canvas lo recupera. En MP no hay pausa
  (partida sigue), solo el hint.
- **Móvil**: layout apilado, touch controls (joystick + FIRE/ADS/JUMP/RELOAD + slots),
  safe-areas, HUD compactado en las esquinas superiores.

## 9. Assets

- **3D (Meshy, key `msy_xnlu…RpW`, balance ~585)**: rifle, shotgun, sniper, tanque.
  Crudos en `meshy_output/` (gitignored). Pipeline: Meshy text-to-3D → (remesh si >20MB)
  → `npx @gltf-transform/cli optimize X.glb public/models/X.glb --compress meshopt
  --texture-compress webp --texture-size 1024`. Total shipped ~2.3MB. Loader necesita
  `MeshoptDecoder` (ya configurado en `ImportedAssets.ts`, que también corrige la
  orientación: eje largo → -Z + flip 180°).
- **Audio**: disparos = Kenney CC0 arcade (laser4/spaceTrash1/phaserDown1, del mirror
  github `iwenzhou/kenney`, convertidos con ffmpeg); resto = ElevenLabs (24 archivos,
  key `sk_339c…ad51`). Todo en `public/assets/audio/`.

## 10. Testing y QA

- `?test=1` — auto-deploy solo sin pointer lock. Hooks: `__TEST_AIM_AT_BOT__` (con LOS),
  `__TEST_AIM_AT_REMOTE__`, `__TEST_TELEPORT_TO_BOT__(dist)`, `__TEST_GOD__(bool)`,
  `__TEST_SET_TIME__(s)`, `__TEST_SCENE_INFO__()`, `__TEST_TRACE_SHOT__()`.
  `?test=1&mp=1` — NO auto-deploya (para flujo MP por UI).
- `window.__THREE_GAME_DIAGNOSTICS__` — frame/state/renderer/player/bots/audio/imports.
- `window.__PAGE_ERRORS__` — errores capturados desde index.html.
- Scripts: `scripts/capture.mjs` (screenshots desktop/mobile), `scripts/playtest.mjs`
  (combate solo), `scripts/mptest.mjs` (**E2E 2 clientes**: crear lobby por UI → join por
  código exacto → chat → ready → match → kill/daño → respawn), `npm test` (Playwright).
- Dev: `npm run dev` (:5188, preview panel `trenchfield-dev`), server local
  `cd server && node index.js` (:8123). Preview build `:4188`.
- ⚠️ El panel de preview mantiene la página `hidden` (no rAF) — screenshots vía
  Playwright, no `preview_screenshot`.

## 11. Cuentas/CLIs autenticados en esta máquina

`gh` (Alexey9911) · `vercel` (alexey9911) · `fly` (alexeysebas@gmail.com) · Neon vía
DATABASE_URL (neonctl cuelga pidiendo auth browser — no usar).

## 12. Pendientes / roadmap

1. **Skins customizadas** (explícitamente dejado para el final por el usuario) — p.ej.
   generar variantes con Meshy o texturas nuevas en BotBodyFactory.
2. Fondear la hot wallet (`Ffgn…KcuM`) con ~0.02 SOL para fees de payout de wagers.
3. Geckos.io UDP opcional (patrón football/wow: `GECKOS_ENABLED=1` + IPv4 dedicada
   ~$2/mes + `GECKOS_BIND=fly-global-services`) si se quiere menos latencia.
4. Kill no siempre registra en el mptest (ventana de tiempo del test corta; el daño sí
   fluye — p2 quedó a 15hp). Afinar si se quiere asserts estrictos.
5. Code-splitting del bundle (~1MB warn por @solana/web3.js) — dynamic import.
6. `viewport maximum-scale=1` puede molestar accesibilidad zoom (elegido para evitar
   double-tap zoom en juego).

## 13. Preferencias del usuario (Alexey)

Español casual, delega todo y quiere autonomía total sin preguntas. Skills obligatorias:
color-expert, frontend-design, superpowers, threejs-game-skills (director), + mobile/UI
para interfaz. Prefiere Meshy sobre Tripo. Prioridad: jugabilidad + visuales > infra.
Estética actual (dusk trench + stencil militar + acentos Solana verde) LE GUSTA — no
cambiarla, solo refinarla. Prototipo pulido, sin prácticas "agresivas" innecesarias.
