import { test, expect } from '@playwright/test';

const USER = process.env.user;
const PASSWORD = process.env.password;

test.beforeAll(() => {
  if (!USER || !PASSWORD) {
    throw new Error('Missing `user` / `password` in ui_test/.env');
  }
});

test('login, open Brno track, open first lap time', async ({ page }) => {
  // Log in
  await page.goto('/accounts/login/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(USER!);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/home\//);

  // Open the TRACKS menu (Bootstrap dropdown — the click can race the
  // document toggle handler, so retry opening until the menu is shown).
  const tracksBtn = page.getByRole('button', { name: 'TRACKS' });
  const brnoLink = page.locator('.dropdown-menu.show a[href="/laptimes/tracks/22/"]');
  await expect(async () => {
    await tracksBtn.click();
    await expect(brnoLink).toBeVisible({ timeout: 2000 });
  }).toPass();
  await brnoLink.click();
  await expect(page).toHaveURL(/\/laptimes\/tracks\/22\//);
  await expect(page.getByRole('heading', { name: 'Brno', level: 1 })).toBeVisible();

  // Open the first lap time in the table
  await page.getByRole('table').getByRole('link').first().click();

  // Lands on the lap analysis page (e.g. /laptimes/122097,5/?pane=map)
  await expect(page).toHaveURL(/\/laptimes\/\d+,\d+\//);
});
