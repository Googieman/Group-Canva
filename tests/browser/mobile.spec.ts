import { test, expect, devices } from '@playwright/test';

test('phone touch drawing produces a usable continuous brush mark', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Real touch dispatch uses Chromium CDP.');
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await expect(page.locator('canvas')).toHaveAttribute('aria-disabled', 'false');
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounds were unavailable.');
  const cdp = await context.newCDPSession(page);
  const start = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.5 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start], modifiers: 0 });
  for (let index = 1; index <= 20; index++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: start.x + box.width * 0.6 * index / 20, y: start.y + box.height * 0.2 * index / 20 }],
      modifiers: 0,
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers: 0 });
  await page.waitForTimeout(250);
  const metrics = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d')!;
    const canvas = element as HTMLCanvasElement;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let alpha = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) alpha++;
    let maxColumnAlpha = 0;
    for (let x = 0; x < canvas.width; x++) {
      let run = 0;
      for (let y = 0; y < canvas.height; y++) {
        if (data[(y * canvas.width + x) * 4 + 3]! > 32) run++;
        else run = 0;
        maxColumnAlpha = Math.max(maxColumnAlpha, run);
      }
    }
    return { alpha, maxColumnAlpha, cssMaxColumn: maxColumnAlpha * canvas.clientWidth / canvas.width };
  });
  expect(metrics.alpha).toBeGreaterThan(100);
  expect(metrics.cssMaxColumn).toBeGreaterThanOrEqual(2.5);
  await context.close();
});
