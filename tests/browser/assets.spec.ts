import { test, expect } from '@playwright/test';

async function browserPng(page: import('@playwright/test').Page, size = 2): Promise<Buffer> {
  const base64 = await page.evaluate((imageSize) => {
    const canvas = document.createElement('canvas'); canvas.width = imageSize; canvas.height = imageSize;
    const context = canvas.getContext('2d')!; context.fillStyle = '#e66b3b'; context.fillRect(0, 0, imageSize, imageSize);
    return canvas.toDataURL('image/png').split(',', 2)[1]!;
  }, size);
  return Buffer.from(base64, 'base64');
}

async function orangePixels(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index]! > 180 && data[index + 1]! > 60 && data[index + 1]! < 160 && data[index + 2]! < 120 && data[index + 3]! > 0) count++;
    }
    return count;
  });
}

async function hostCanvas(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await page.getByRole('button', { name: 'My canvases', exact: true }).click();
  await page.locator('.file-card').first().getByRole('button', { name: 'Host', exact: true }).click();
  await expect(page.getByText('Live together', { exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toHaveAttribute('aria-disabled', 'false');
  return { context, page, roomId: new URL(page.url()).searchParams.get('room')! };
}

test('local image assets survive save and reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.locator('input.image-picker').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: await browserPng(page) });
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: /undo/i })).toBeEnabled();
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const project = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { assets: unknown[] };
  expect(project.assets).toHaveLength(1);
});

test('host image assets are uploaded before commit and survive host recovery', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'New canvas', exact: true }).click();
    await page.getByRole('button', { name: 'My canvases', exact: true }).click();
    await page.locator('.file-card').first().getByRole('button', { name: 'Host', exact: true }).click();
    await expect(page.getByText('Live together', { exact: true })).toBeVisible();
    await page.locator('input.image-picker').setInputFiles({ name: 'host-pixel.png', mimeType: 'image/png', buffer: await browserPng(page) });
    await expect(page.getByRole('button', { name: /undo/i })).toBeEnabled();
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByText('Live together', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('guest image remains visible to the host after the guest disconnects', async ({ browser }) => {
  const host = await hostCanvas(browser);
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    await guest.goto(`/?room=${encodeURIComponent(host.roomId)}`);
    await expect(guest.getByText('Live together', { exact: true })).toBeVisible();
    await expect(guest.locator('canvas')).toHaveAttribute('aria-disabled', 'false');
    await guest.locator('input.image-picker').setInputFiles({ name: 'guest-pixel.png', mimeType: 'image/png', buffer: await browserPng(guest, 80) });
    await expect.poll(() => orangePixels(host.page)).toBeGreaterThan(100);
    await guestContext.close();
    await expect.poll(() => host.page.getByText(/Just you|1 here/).first().textContent()).toMatch(/Just you|1 here/);
    await expect.poll(() => orangePixels(host.page)).toBeGreaterThan(100);
    await host.page.reload();
    await expect(host.page.getByText('Live together', { exact: true })).toBeVisible();
    await expect(host.page.locator('canvas')).toHaveAttribute('aria-disabled', 'false');
    await expect.poll(() => orangePixels(host.page)).toBeGreaterThan(100);
  } finally {
    await guestContext.close().catch(() => {});
    await host.context.close();
  }
});

test('host refresh regains edit access without creating a new session', async ({ browser }) => {
  const host = await hostCanvas(browser);
  try {
    const roomId = host.roomId;
    await host.page.reload();
    await expect(host.page.getByText('Live together', { exact: true })).toBeVisible();
    await expect(host.page.locator('canvas')).toHaveAttribute('aria-disabled', 'false');
    const box = (await host.page.locator('canvas').boundingBox())!;
    await host.page.mouse.move(box.x + box.width * .2, box.y + box.height * .4);
    await host.page.mouse.down();
    await host.page.mouse.move(box.x + box.width * .55, box.y + box.height * .5, { steps: 8 });
    await host.page.mouse.up();
    await expect(host.page.getByRole('button', { name: /undo/i })).toBeEnabled();
    expect(new URL(host.page.url()).searchParams.get('room')).toBe(roomId);
  } finally {
    await host.context.close();
  }
});
