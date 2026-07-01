// Capture desktop/mobile screenshots of landing + active gameplay.
// Usage: node scripts/capture.mjs [outDir]
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5188';
const OUT = process.argv[2] ?? 'artifacts';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function capture(name, opts, path, actions) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`PAGE: ${e.message}`));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 20, undefined, {
    timeout: 45000,
  });
  if (actions) await actions(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const diag = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  console.log(
    `${name}: state=${diag?.state} calls=${diag?.renderer?.calls} tris=${diag?.renderer?.triangles} errors=${errors.length}`,
  );
  if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join(' | ')}`);
  await ctx.close();
}

await capture('desktop-landing', { viewport: { width: 1440, height: 810 } }, '/', async (page) => {
  await page.waitForTimeout(1200);
});

await capture(
  'desktop-gameplay',
  { viewport: { width: 1440, height: 810 } },
  '/?test=1',
  async (page) => {
    await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing', undefined, { timeout: 10000 });
    // move forward, then fire toward the arena
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(900);
    await page.keyboard.up('KeyW');
    await page.evaluate(() => window.__TEST_AIM_AT_BOT__?.() || window.__TEST_LOOK__?.(Math.PI, 0));
    await page.mouse.down();
    await page.waitForTimeout(260);
    await page.mouse.up();
    await page.waitForTimeout(100);
  },
);

await capture(
  'desktop-combat',
  { viewport: { width: 1440, height: 810 } },
  '/?test=1',
  async (page) => {
    await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing', undefined, { timeout: 10000 });
    // let bots wander, then aim at the nearest one and fire
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__TEST_AIM_AT_BOT__?.());
    await page.mouse.down();
    await page.waitForTimeout(180);
    await page.evaluate(() => window.__TEST_AIM_AT_BOT__?.());
    await page.waitForTimeout(60);
  },
);

await capture('mobile-landing', { ...devices['iPhone 13'] }, '/', async (page) => {
  await page.waitForTimeout(1000);
});

await browser.close();
console.log('done');
