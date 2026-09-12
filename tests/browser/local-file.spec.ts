import { test, expect, type Page } from '@playwright/test';

async function createLocalFile(page: Page): Promise<{ baseUrl: string; fileId: string }> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page).toHaveURL(/\?file=/);
  const url = new URL(page.url());
  return { baseUrl: url.origin, fileId: url.searchParams.get('file')! };
}

test('local-file startup is editable and saved on this device', async ({ page }) => {
  const { baseUrl, fileId } = await createLocalFile(page);
  await page.goto(`${baseUrl}/?file=${encodeURIComponent(fileId)}`);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(page.getByText('Connecting…', { exact: true })).not.toBeVisible();
  await expect(page.locator('canvas')).toHaveAttribute('aria-disabled', 'false');
});

test('drawing after a shape keeps visual order valid and uses wheel sizing', async ({ page }) => {
  const { baseUrl, fileId } = await createLocalFile(page);
  await page.goto(`${baseUrl}/?file=${encodeURIComponent(fileId)}`);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(page.locator('.width-button')).toHaveCount(0);

  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounds were unavailable.');
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.move(box.x + 120, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 190);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Brush (B)', exact: true }).click();
  await page.mouse.move(box.x + 360, box.y + 220);
  await page.mouse.wheel(0, -100);
  await page.mouse.down();
  await page.mouse.move(box.x + 430, box.y + 250);
  await page.mouse.up();

  await expect(page.locator('.toast')).toBeHidden();
  await expect(page.locator('.save-state')).not.toHaveText(/Document objects must retain visual order/);
});

test('a second local-file tab is read-only without disconnecting the writer', async ({ browser }) => {
  const context = await browser.newContext();
  const writer = await context.newPage();
  const { baseUrl, fileId } = await createLocalFile(writer);
  await writer.goto(`${baseUrl}/?file=${encodeURIComponent(fileId)}`);
  await expect(writer.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(writer.locator('canvas')).toHaveAttribute('aria-disabled', 'false');

  const reader = await context.newPage();
  await reader.goto(`${baseUrl}/?file=${encodeURIComponent(fileId)}`);
  await expect(reader.getByText('Read-only · another tab is editing', { exact: true })).toBeVisible();
  await expect(reader.getByText('Connecting…', { exact: true })).not.toBeVisible();
  await expect(reader.locator('canvas')).toHaveAttribute('aria-disabled', 'true');
  await expect(reader.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await expect(reader.getByRole('button', { name: 'Brush (B)', exact: true })).toBeHidden();
  await expect(writer.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(writer.getByText('Connecting…', { exact: true })).not.toBeVisible();

  await context.close();
});

test('home file actions preserve renamed content and duplicate/delete durable files', async ({ page }) => {
  const { fileId } = await createLocalFile(page);
  page.once('dialog', dialog => dialog.accept('Renamed idea'));
  await page.getByRole('button', { name: 'Untitled canvas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Renamed idea', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'My canvases', exact: true }).click();
  const original = page.locator('.file-card').filter({ hasText: 'Renamed idea' }).first();
  await original.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(2);
  page.once('dialog', dialog => dialog.accept());
  await original.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(1);
  expect(fileId).toMatch(/^file-/);
});
