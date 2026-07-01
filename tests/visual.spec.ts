import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

type CanvasSample = {
  ok: boolean;
  reason: string;
  variance?: number;
  colorBuckets?: number;
};

async function sampleCanvas(page: import('@playwright/test').Page): Promise<CanvasSample> {
  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  if (!box || box.width < 32 || box.height < 32) {
    return { ok: false, reason: 'canvas-too-small' };
  }

  const buffer = await canvas.screenshot();
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alphaPixels = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));

  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alphaPixels += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }

  const variance = max - min;
  return {
    ok: alphaPixels > 256 && (variance > 8 || buckets.size > 3),
    reason: 'sampled',
    variance,
    colorBuckets: buckets.size,
  };
}

function collectErrors(page: import('@playwright/test').Page): {
  consoleErrors: string[];
  pageErrors: string[];
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

test('landing page renders with live diorama', async ({ page }, testInfo) => {
  const { consoleErrors, pageErrors } = collectErrors(page);

  await page.goto('/');
  await expect(page.locator('#screen-landing')).toBeVisible();
  await expect(page.locator('.hero-title')).toContainText('TRENCH');
  await expect(page.locator('#btn-deploy')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);

  const sample = await sampleCanvas(page);
  expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${testInfo.project.name}-landing`, {
    body: screenshot,
    contentType: 'image/png',
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('gameplay: movement, shooting and HUD respond', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'FPS controls are desktop-first');
  const { consoleErrors, pageErrors } = collectErrors(page);

  await page.goto('/?test=1');
  // test mode auto-deploys after 300ms
  await page.waitForFunction(
    () => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing',
    undefined,
    { timeout: 10_000 },
  );
  await expect(page.locator('#hud')).toBeVisible();

  const before = await page.evaluate(() => {
    const p = window.__THREE_GAME_DIAGNOSTICS__!.player.position;
    return { x: p.x, z: p.z };
  });

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyW');

  await expect
    .poll(async () =>
      page.evaluate((b) => {
        const p = window.__THREE_GAME_DIAGNOSTICS__!.player.position;
        return Math.hypot(p.x - b.x, p.z - b.z);
      }, before),
    )
    .toBeGreaterThan(0.8);

  // fire the rifle: ammo counter should drop below 30
  // (bots are lethal — if we got killed while moving, wait out the auto-redeploy)
  await page.waitForFunction(
    () => window.__THREE_GAME_DIAGNOSTICS__?.state === 'playing',
    undefined,
    { timeout: 15_000 },
  );
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.locator('#ammo-mag').textContent()), {
      timeout: 10_000,
    })
    .toBeLessThan(30);

  // scoreboard toggles
  await page.keyboard.down('Tab');
  await expect(page.locator('#scoreboard')).toBeVisible();
  await page.keyboard.up('Tab');

  const sample = await sampleCanvas(page);
  expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${testInfo.project.name}-gameplay`, {
    body: screenshot,
    contentType: 'image/png',
  });

  const realErrors = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource'), // audio/model 404s degrade gracefully
  );
  expect(realErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
