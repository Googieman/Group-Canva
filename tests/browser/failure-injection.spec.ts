import { test, expect } from '@playwright/test';

test('deleting the IndexedDB database leaves a visible save recovery error', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('group-canvas');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB deletion was blocked by an open editor connection.'));
  }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.save-state')).toHaveText(/error|unable|failed/i);
});
