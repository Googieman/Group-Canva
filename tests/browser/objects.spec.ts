import { test, expect } from '@playwright/test';

test('text editing keeps multiline drafts until explicit commit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * .25, box.y + box.height * .25);
  const editor = page.locator('textarea.canvas-text-editor');
  await expect(editor).toBeVisible();
  await editor.fill('first line\nsecond line');
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.keyboard.press('Control+Enter');
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('button', { name: /undo/i })).toBeEnabled();
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect.poll(() => page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(canvas.width * .2, canvas.height * .18, canvas.width * .45, canvas.height * .25).data;
    let pixels = 0; for (let index = 3; index < data.length; index += 4) if (data[index] > 0) pixels++;
    return pixels;
  })).toBeGreaterThan(10);
});
