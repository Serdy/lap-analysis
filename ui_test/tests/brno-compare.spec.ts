import { test, expect } from '@playwright/test';

const USER = process.env.user;
const PASSWORD = process.env.password;

test.beforeAll(() => {
  if (!USER || !PASSWORD) {
    throw new Error('Missing `user` / `password` in ui_test/.env');
  }
});

test('compare the fastest Brno motorbike lap with my own lap', async ({ page }) => {
  // Log in
  await page.goto('/accounts/login/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(USER!);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/home\//);

  // TRACKS menu -> Brno (Bootstrap dropdown; the click can race the toggle, so retry).
  const tracksBtn = page.getByRole('button', { name: 'TRACKS' });
  const brnoLink = page.locator('.dropdown-menu.show a[href="/laptimes/tracks/22/"]');
  await expect(async () => {
    await tracksBtn.click();
    await expect(brnoLink).toBeVisible({ timeout: 2000 });
  }).toPass();
  await brnoLink.click();
  await expect(page).toHaveURL(/\/laptimes\/tracks\/22\//);

  // Open the full Track info page.
  await page.getByRole('link', { name: 'Track info' }).click();
  await expect(page).toHaveURL(/\/tracks\/Brno\//);

  // "Fastest people" -> Motorbikes tab (two tabs share this name; the first is here).
  await page.getByRole('tab', { name: 'Motorbikes' }).first().click();

  // Open the fastest motorbike lap (first leaderboard entry in the visible panel).
  await page.locator('a[href*="/laptimes/cwpl/"]:visible').first().click();

  // Viewing someone else's lap shows a "Choose a lap" page listing my own laps.
  await expect(page.getByRole('heading', { name: 'Choose a lap' })).toBeVisible();

  // Pick my first (top) lap -> opens the comparison view.
  await page.getByRole('table').getByRole('link').first().click();

  // Comparison view: the URL carries two laps and SRSRCNG holds two riders.
  await expect(page).toHaveURL(/\/laptimes\/\d+,\d+,\d+,\d+\//);
  await expect
    .poll(async () => page.evaluate(() => (window as any).SRSRCNG?.riders?.length ?? 0))
    .toBe(2);
});
