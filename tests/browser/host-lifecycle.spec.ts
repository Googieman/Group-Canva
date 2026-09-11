import { test, expect } from '@playwright/test';

test('host recovery keeps the room stable and guests read-only', async ({ browser }) => {
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: 'New canvas', exact: true }).click();
    await host.getByRole('button', { name: 'My canvases', exact: true }).click();
    const file = host.locator('.file-card').first();
    await expect(file).toBeVisible();
    await file.getByRole('button', { name: 'Host', exact: true }).click();
    await expect(host.getByText('Live together', { exact: true })).toBeVisible();

    const hostUrl = new URL(host.url());
    const roomId = hostUrl.searchParams.get('room');
    expect(roomId).toBeTruthy();
    expect(hostUrl.searchParams.get('host')).toBeTruthy();
    await guest.goto(`${hostUrl.origin}/?room=${encodeURIComponent(roomId!)}`);
    await expect(guest.getByText('Live together', { exact: true })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
    await expect(guest.getByRole('button', { name: 'Download project', exact: true })).toBeHidden();
    await expect(guest.getByRole('button', { name: 'Export PNG', exact: true })).toBeHidden();
    await expect(guest.getByRole('button', { name: 'End session', exact: true })).toBeHidden();

    await host.reload();
    await expect(host.getByText('Live together', { exact: true })).toBeVisible();
    await expect(guest.getByText('Live together', { exact: true })).toBeVisible();

    host.once('dialog', dialog => dialog.accept());
    await host.getByRole('button', { name: 'End session', exact: true }).click();
    await expect(host.getByText(/ended/i)).toBeVisible();
    await expect(guest.getByText(/ended/i)).toBeVisible();
  } finally {
    await context.close();
  }
});
