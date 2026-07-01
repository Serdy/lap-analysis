/**
 * Telemetry extraction for the COMPARE lap 122145,3,63254,5.
 *
 * Confirms the SRSRCNG.riders[] shape in comparison mode, checks whether col4
 * (longitudinal accel) is populated for EACH rider, and reports braking/speed
 * stats used to calibrate the braking-onset + corner detectors.
 *
 *   npx playwright test extract-compare-122145-3-63254-5 --project=chromium
 */

import fs from 'fs';
import { test, expect } from '@playwright/test';

const USER     = process.env.user;
const PASSWORD = process.env.password;

const LAP_URL     = '/laptimes/122145,3,63254,5/?pane=map';
const OUTPUT_FILE =
  '/private/tmp/claude-501/-Users-serdiuk-git-pet-projects-serious-racing/ff161f6a-c284-429c-a719-6db20882492c/scratchpad/compare-122145-3-63254-5.json';

test.beforeAll(() => {
  if (!USER || !PASSWORD) {
    throw new Error('Missing `user` / `password` in ui_test/.env');
  }
});

test('extract compare riders + report col4/braking stats', async ({ page }) => {
  await page.goto('/accounts/login/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(USER!);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/home\//);

  await page.goto(LAP_URL);

  await expect
    .poll(
      () => page.evaluate(() => (window as any).SRSRCNG?.riders?.[0]?.data?.length ?? 0),
      { timeout: 60_000, intervals: [500] },
    )
    .toBeGreaterThan(0);

  const payload = await page.evaluate(() => {
    const s = (window as any).SRSRCNG;
    return {
      speedMultiplier: s.speedMultiplier,
      speedUnit:       s.speedUnit,
      seriesColors:    s.seriesColors,
      riders: (s.riders || []).map((r: any) => ({
        name:      r.name,
        color:     r.color,
        laptime:   r.laptime,
        numPoints: r.data?.length ?? 0,
        data:      r.data,
      })),
    };
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf8');

  const mult = payload.speedMultiplier;
  console.log('=== Compare extraction complete ===');
  console.log(`Output file     : ${OUTPUT_FILE}`);
  console.log(`speedMultiplier : ${mult}  speedUnit: ${payload.speedUnit}`);
  console.log(`seriesColors    : ${JSON.stringify(payload.seriesColors)}`);
  console.log(`rider count     : ${payload.riders.length}`);

  payload.riders.forEach((r: any, i: number) => {
    const data: number[][] = r.data || [];
    if (!data.length) { console.log(`\n[rider ${i}] ${r.name}: NO DATA`); return; }
    const col4 = data.map(p => p[4]);
    const speedsKmh = data.map(p => p[2] * mult);
    const nonZeroCol4 = col4.filter(v => Math.abs(v) > 1e-6).length;
    const brakingPts  = col4.filter(v => v < -0.5).length;   // dead-band per CLAUDE.md
    const minCol4 = Math.min(...col4), maxCol4 = Math.max(...col4);
    const minKmh  = Math.min(...speedsKmh), maxKmh = Math.max(...speedsKmh);
    console.log(`\n[rider ${i}] ${r.name}  color=${r.color}  laptime=${r.laptime}  points=${data.length}`);
    console.log(`  col4 (m/s2): min=${minCol4.toFixed(3)} max=${maxCol4.toFixed(3)}  nonZero=${nonZeroCol4}/${data.length}  braking(<-0.5)=${brakingPts}`);
    console.log(`  speed km/h : min=${minKmh.toFixed(1)} max=${maxKmh.toFixed(1)}`);
    console.log(`  col4 dead? : ${nonZeroCol4 === 0 ? 'YES (g-sensor dead -> speed-derivative fallback)' : 'no'}`);
  });
});
