// Automated playtest: fight bots for ~45s, report combat + renderer evidence.
import { chromium } from '@playwright/test';

const BASE = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5188';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`PAGE: ${e.message}`));

await page.goto(`${BASE}/?test=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing', undefined, {
  timeout: 45000,
});

const start = await page.evaluate(() => ({
  time: window.__THREE_GAME_DIAGNOSTICS__.match.timeLeft,
  hp: window.__THREE_GAME_DIAGNOSTICS__.player.health,
}));

let kills = 0;
let deaths = 0;
let sawScoreboardRows = 0;

for (let i = 0; i < 22; i++) {
  await page.evaluate(() => window.__TEST_AIM_AT_BOT__?.());
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__TEST_AIM_AT_BOT__?.());
  await page.waitForTimeout(900);
  await page.mouse.up();
  // reload occasionally
  if (i % 4 === 3) {
    await page.keyboard.press('KeyR');
    await page.waitForTimeout(1900);
  }
  const snap = await page.evaluate(() => {
    const kf = document.getElementById('killfeed');
    const tp = document.getElementById('tp-session')?.textContent;
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return {
      state: d.state,
      hp: d.player.health,
      alive: d.player.alive,
      botsAlive: d.bots.alive,
      kf: kf?.children.length ?? 0,
      tp,
      timeLeft: d.match.timeLeft,
    };
  });
  if (snap.state === 'dead') deaths++;
  sawScoreboardRows = Math.max(sawScoreboardRows, snap.kf);
  if (i % 5 === 0) console.log(`t=${i * 2}s`, JSON.stringify(snap));
}

// throw a grenade
await page.evaluate(() => window.__TEST_AIM_AT_BOT__?.());
await page.keyboard.press('KeyG');
await page.waitForTimeout(3000);

// weapon switch
await page.keyboard.press('Digit2');
await page.waitForTimeout(700);
const weaponName = await page.locator('#weapon-name').textContent();

const end = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  const standings = document.querySelectorAll('#scoreboard-body tr').length;
  return {
    timeLeft: d.match.timeLeft,
    renderer: d.renderer,
    botsAlive: d.bots.alive,
    playerAlive: d.player.alive,
    state: d.state,
    audio: d.audio,
    imports: d.imports,
    standings,
  };
});

// session TP from HUD
const tpSession = await page.locator('#tp-session').textContent();
const killRows = await page.evaluate(() => {
  return [...document.querySelectorAll('#killfeed .kf-row')].map((r) => r.textContent);
});

console.log('--- RESULT ---');
console.log('simulated time:', (start.time - end.timeLeft).toFixed(1), 's');
console.log('weapon after switch:', weaponName);
console.log('TP session:', tpSession);
console.log('recent killfeed:', JSON.stringify(killRows));
console.log('max killfeed rows seen:', sawScoreboardRows, ' player deaths observed:', deaths, kills);
console.log('end:', JSON.stringify(end, null, 1));
console.log('console errors:', JSON.stringify(errors.slice(0, 8)));

await page.screenshot({ path: 'artifacts/playtest-final.png' });
await browser.close();
