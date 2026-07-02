// Two-client multiplayer end-to-end test against the local server.
import { chromium } from '@playwright/test';

const BASE = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5188';
const browser = await chromium.launch();

async function makeClient(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] PAGE ERROR:`, e.message));
  await page.goto(`${BASE}/?test=1&mp=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, undefined, {
    timeout: 45000,
  });
  return page;
}

const p1 = await makeClient('p1');
const p2 = await makeClient('p2');

// wait for socket connection (status label)
await p1.waitForFunction(
  () => document.getElementById('mp-status-label')?.textContent?.includes('ONLINE'),
  undefined,
  { timeout: 15000 },
);
console.log('p1 connected to frontline');

// p1 creates a free lobby via the real UI
await p1.click('#btn-create-lobby');
await p1.fill('#create-title', 'E2E TEST');
await p1.click('#create-confirm');
await p1.waitForSelector('#screen-lobby.active', { timeout: 10000 });
const code = await p1.locator('#lobby-room-code').textContent();
console.log('lobby created:', code);

// p2 joins p1's specific lobby by code (list may contain stale lobbies)
await p2.waitForFunction(
  (c) => document.querySelector(`#lobby-list .lobby-row[data-code="${c}"]`) !== null,
  code,
  { timeout: 10000 },
);
await p2.click(`#lobby-list .lobby-row[data-code="${code}"]`);
await p2.waitForSelector('#screen-lobby.active', { timeout: 10000 });
console.log('p2 joined lobby', await p2.locator('#lobby-room-code').textContent());

// global chat check (expand the collapsed dock first)
await p1.evaluate(() => document.getElementById('chat-dock')?.classList.remove('collapsed'));
await p2.evaluate(() => document.getElementById('chat-dock')?.classList.remove('collapsed'));
await p1.fill('#chat-input', 'hola frontline');
await p1.press('#chat-input', 'Enter');
await p2.waitForFunction(
  () => document.getElementById('chat-messages')?.textContent?.includes('hola frontline'),
  undefined,
  { timeout: 8000 },
).then(() => console.log('global chat delivered ✔')).catch(() => console.log('global chat FAILED ✘'));

// both ready (small settle between joins/clicks)
await p2.waitForTimeout(400);
await p1.click('#lobby-ready');
await p1.waitForTimeout(300);
await p2.click('#lobby-ready');
await p2.waitForTimeout(500);
const readyStates = await Promise.all([
  p1.locator('#lobby-ready').textContent(),
  p2.locator('#lobby-ready').textContent(),
]);
console.log('ready button states:', JSON.stringify(readyStates));
console.log('both ready — waiting for countdown…');

await p1.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing', undefined, {
  timeout: 20000,
});
await p2.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing', undefined, {
  timeout: 20000,
});
console.log('MATCH STARTED on both clients ✔');
await p1.waitForTimeout(1500);

// p1 hunts p2: aim at remote + fire until killfeed
let killed = false;
for (let i = 0; i < 30 && !killed; i++) {
  await p1.evaluate(() => window.__TEST_AIM_AT_REMOTE__?.());
  await p1.mouse.down();
  await p1.waitForTimeout(260);
  await p1.mouse.up();
  await p1.waitForTimeout(120);
  if (i % 5 === 4) {
    await p1.keyboard.press('KeyR');
    await p1.waitForTimeout(2000);
  }
  killed = await p1.evaluate(
    () => document.querySelectorAll('#killfeed .kf-row').length > 0,
  );
}
console.log('kill registered:', killed);

const p2state = await p2.evaluate(() => ({
  state: window.__THREE_GAME_DIAGNOSTICS__?.state,
  hp: window.__THREE_GAME_DIAGNOSTICS__?.player?.health,
}));
console.log('p2 after fight:', JSON.stringify(p2state));

await p1.screenshot({ path: 'artifacts/mp-p1.png' });
await p2.screenshot({ path: 'artifacts/mp-p2.png' });

// wait for p2 respawn if dead
if (p2state.state === 'dead') {
  await p2
    .waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing', undefined, { timeout: 8000 })
    .then(() => console.log('p2 respawned ✔'))
    .catch(() => console.log('p2 respawn FAILED ✘'));
}

await browser.close();
console.log('MP E2E DONE');
