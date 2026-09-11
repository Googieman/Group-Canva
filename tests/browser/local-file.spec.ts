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
