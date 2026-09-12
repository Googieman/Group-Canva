import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('Downloaded file is not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

test('PNG export is content-sized instead of capturing the editor viewport', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /undo/i })).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = new Uint8Array(await readFile(path!));
  const size = pngSize(bytes);
  expect(size.width).toBeGreaterThan(100);
  expect(size.height).toBeGreaterThan(100);
  expect(size.width).toBeLessThan(1600);
  expect(size.height).toBeLessThan(900);
  const coloredPixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const surface = document.createElement('canvas');
    surface.width = image.naturalWidth;
    surface.height = image.naturalHeight;
    const context = surface.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index]! < 240 || pixels[index + 1]! < 240 || pixels[index + 2]! < 240) count++;
    }
    return count;
  }, Buffer.from(bytes).toString('base64'));
  expect(coloredPixels).toBeGreaterThan(100);
});
