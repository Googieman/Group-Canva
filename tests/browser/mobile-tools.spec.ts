import { test, expect, devices, type BrowserContext, type Page } from '@playwright/test';

type TouchPoint = { x: number; y: number };

async function touchStroke(context: BrowserContext, page: Page, points: TouchPoint[], delayMs = 0): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const first = points[0]!;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first], modifiers: 0 });
  for (const point of points.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point], modifiers: 0 });
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers: 0 });
}

async function touchLine(context: BrowserContext, page: Page, box: { x: number; y: number; width: number; height: number }, start: readonly [number, number], end: readonly [number, number], steps = 16): Promise<void> {
  const points = Array.from({ length: steps + 1 }, (_, index) => ({
    x: box.x + box.width * (start[0] + (end[0] - start[0]) * index / steps),
    y: box.y + box.height * (start[1] + (end[1] - start[1]) * index / steps),
  }));
  await touchStroke(context, page, points);
}

async function alpha(page: Page): Promise<number> {
  return page.locator('canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) count++;
    return count;
  });
}

async function alphaInRegion(page: Page, region: { x: number; y: number; width: number; height: number }): Promise<number> {
  return page.locator('canvas').evaluate((element, bounds) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const x = Math.max(0, Math.floor(canvas.width * bounds.x));
    const y = Math.max(0, Math.floor(canvas.height * bounds.y));
    const width = Math.min(canvas.width - x, Math.ceil(canvas.width * bounds.width));
    const height = Math.min(canvas.height - y, Math.ceil(canvas.height * bounds.height));
    const data = context.getImageData(
      x,
      y,
      width,
      height,
    ).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) count++;
    return count;
  }, region);
}

test('phone touch brush follows a curved path', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Real touch dispatch uses Chromium CDP.');
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounds were unavailable.');

  const points = Array.from({ length: 41 }, (_, index) => {
    const progress = index / 40;
    return {
      x: box.x + box.width * (0.15 + 0.7 * progress),
      y: box.y + box.height * (0.5 - 0.22 * Math.sin(Math.PI * progress)),
    };
  });
  await touchStroke(context, page, points, 8);

  const bulge = await alphaInRegion(page, {
    x: 0.43,
    y: 0.23,
    width: 0.14,
    height: 0.16,
  });
  expect(bulge).toBeGreaterThan(0);
  await context.close();
});

test('phone touch gestures drive the drawing tools', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Real touch dispatch uses Chromium CDP.');
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await expect(page.locator('canvas')).toHaveAttribute('aria-disabled', 'false');
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounds were unavailable.');

  await touchLine(context, page, box, [.15, .25], [.4, .25]);
  const brushPixels = await alpha(page);
  expect(brushPixels).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'Eraser (E)', exact: true }).click();
  await touchLine(context, page, box, [.1, .25], [.45, .25]);
  await expect.poll(() => alpha(page)).toBeLessThan(brushPixels);

  for (const [tool, start, end] of [
    ['Rectangle', [.5, .15], [.8, .35]],
    ['Ellipse', [.5, .4], [.8, .6]],
    ['Line', [.15, .7], [.4, .85]],
    ['Arrow', [.55, .7], [.85, .85]],
  ] as const) {
    await page.getByRole('button', { name: tool, exact: true }).click();
    const before = await alpha(page);
    await touchLine(context, page, box, start, end);
    await expect.poll(() => alpha(page)).toBeGreaterThan(before);
  }

  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await touchLine(context, page, box, [.2, .65], [.2, .65], 1);
  await expect(page.locator('textarea.canvas-text-editor')).toBeVisible();
  await page.locator('textarea.canvas-text-editor').fill('mobile text');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('textarea.canvas-text-editor')).toBeHidden();

  await page.getByRole('button', { name: 'Hand (H)', exact: true }).click();
  const beforeZoom = await page.locator('.zoom-label').textContent();
  const first = { x: box.x + box.width * .35, y: box.y + box.height * .45 };
  const second = { x: box.x + box.width * .65, y: box.y + box.height * .45 };
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second], modifiers: 0 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: first.x - 25, y: first.y }, { x: second.x + 25, y: second.y }], modifiers: 0 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers: 0 });
  await expect.poll(() => page.locator('.zoom-label').textContent()).not.toBe(beforeZoom);

  await context.close();
});
