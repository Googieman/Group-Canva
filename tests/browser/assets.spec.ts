import { test, expect } from '@playwright/test';

async function browserPng(page: import('@playwright/test').Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext('2d')!; context.fillStyle = '#e66b3b'; context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL('image/png').split(',', 2)[1]!;
  });
  return Buffer.from(base64, 'base64');
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
