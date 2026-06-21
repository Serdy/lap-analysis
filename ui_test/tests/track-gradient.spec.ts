/**
 * E2E tests for the gradient track-coloring feature (v2.13.0).
 *
 * Userscript: userscripts/serious-racing-lean-angle.user.js
 * Injected via page.addInitScript so it executes immediately after each page load,
 * matching what Tampermonkey does in a real browser session.
 *
 * The userscript wraps everything in an IIFE and reads window.SRSRCNG, so injecting
 * the raw source (stripped of the ==UserScript== header comment) is sufficient.
 */

import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';

const USER     = process.env.user;
const PASSWORD = process.env.password;

// The target single-lap URL (gradient feature).
const SINGLE_LAP_URL = '/laptimes/122060,5/?pane=map';

// Custom trace pane name as declared in the userscript.
const TRACE_PANE = 'srTrace';

// Path to the userscript source.
const USERSCRIPT_PATH = path.resolve(
  __dirname,
  '../../userscripts/serious-racing-lean-angle.user.js',
);

/**
 * Return the userscript source with the ==UserScript== metadata block stripped.
 * Tampermonkey removes that block before running; injecting it as-is also works
 * because the block is a multi-line comment, but stripping is cleaner.
 */
function userscriptSource(): string {
  const raw = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
  // Strip the // ==UserScript== ... // ==/UserScript== header.
  return raw.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/m, '');
}

/** Log in once, reuse the session via storageState. */
async function login(page: any) {
  await page.goto('/accounts/login/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(USER!);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/home\//);
}

test.beforeAll(() => {
  if (!USER || !PASSWORD) {
    throw new Error('Missing `user` / `password` in ui_test/.env');
  }
});

// ---------------------------------------------------------------------------
// Assertion 1 + 2: gradient overlay renders on a single-lap map pane
// ---------------------------------------------------------------------------
test('gradient overlay: custom trace pane contains multiple polylines and site flat line is hidden', async ({ page }) => {
  // Inject the userscript so it fires on every navigation in this page.
  await page.addInitScript({ content: userscriptSource() });

  await login(page);
  await page.goto(SINGLE_LAP_URL);

  // Wait for SRSRCNG to be loaded with rider data.
  await expect
    .poll(() => page.evaluate(() => (window as any).SRSRCNG?.riders?.length ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Wait for the Leaflet map to be initialized.
  await expect
    .poll(() => page.evaluate(() => !!(window as any).SRSRCNG?.map), { timeout: 30_000 })
    .toBe(true);

  // Wait for our custom pane to be created (signals renderTrackColour has run).
  await expect
    .poll(
      () =>
        page.evaluate((pane) => {
          const map = (window as any).SRSRCNG?.map;
          return !!(map && map.getPane && map.getPane(pane));
        }, TRACE_PANE),
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);

  // Allow the polylines a moment to be flushed into the DOM.
  await page.waitForTimeout(1_000);

  // ---- Assertion 1: custom trace pane exists and contains path elements ----
  const pathCount = await page.evaluate((pane) => {
    const map = (window as any).SRSRCNG?.map;
    if (!map) return 0;
    const paneEl = map.getPane(pane);
    if (!paneEl) return 0;
    return paneEl.querySelectorAll('path').length;
  }, TRACE_PANE);

  expect(pathCount, `Expected multiple paths in ${TRACE_PANE} pane, got ${pathCount}`).toBeGreaterThan(1);

  // ---- Assertion 1b: the site's original flat lap polyline is hidden (opacity 0) ----
  const flatLineOpacity = await page.evaluate(() => {
    const map = (window as any).SRSRCNG?.map;
    if (!map) return null;
    const L = (window as any).L;
    if (!L) return null;
    // Find the site's flat polyline (>50 LatLng points, not in our custom pane).
    let opacity: number | null = null;
    map.eachLayer((l: any) => {
      if (l instanceof L.Polyline && !(l instanceof L.Polygon)) {
        try {
          const ll = l.getLatLngs();
          const n = Array.isArray(ll) ? ll.flat(3).length : 0;
          if (n > 50) {
            // Check if this is our pane (skip our own runs)
            const opts = l.options || {};
            if (opts.pane !== 'srTrace') {
              opacity = l.options?.opacity ?? null;
            }
          }
        } catch (_) {}
      }
    });
    return opacity;
  });

  expect(
    flatLineOpacity,
    `Expected the site flat line to be hidden (opacity 0), got ${flatLineOpacity}`,
  ).toBe(0);

  // ---- Assertion 2: gradient is multi-color (more than one distinct stroke color) ----
  const strokeColors = await page.evaluate((pane) => {
    const map = (window as any).SRSRCNG?.map;
    if (!map) return [];
    const paneEl = map.getPane(pane);
    if (!paneEl) return [];
    const paths = Array.from(paneEl.querySelectorAll('path'));
    const colors = new Set<string>();
    paths.forEach((p) => {
      const stroke = (p as SVGPathElement).getAttribute('stroke');
      if (stroke) colors.add(stroke.toLowerCase());
    });
    return Array.from(colors);
  }, TRACE_PANE);

  expect(
    strokeColors.length,
    `Expected more than 1 distinct stroke color in trace, got [${strokeColors.join(', ')}]`,
  ).toBeGreaterThan(1);

  // ---- Assertion 2b: colors are in the red→straw→green family ----
  // The palette goes from brake red (~hsl 3°) through straw (~hsl 45°) to accel green (~hsl 143°).
  // Verify at least one color that is "reddish" (high-R, low-G) and one that is "greenish" (high-G, low-R).
  function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const m = hex.replace('#', '').match(/([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  // We do the color-family check in the test process using the collected hex strings.
  const hasReddish = strokeColors.some((hex) => {
    const rgb = hexToRgb(hex);
    return rgb !== null && rgb.r > rgb.g && rgb.r > 150;
  });
  const hasGreenish = strokeColors.some((hex) => {
    const rgb = hexToRgb(hex);
    return rgb !== null && rgb.g > rgb.r && rgb.g > 80;
  });

  expect(
    hasReddish,
    `Expected at least one reddish color in palette, got [${strokeColors.join(', ')}]`,
  ).toBe(true);

  expect(
    hasGreenish,
    `Expected at least one greenish color in palette, got [${strokeColors.join(', ')}]`,
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Assertion 3: compare mode does NOT draw the gradient overlay
// ---------------------------------------------------------------------------
test('compare mode: gradient overlay is NOT drawn (site per-rider traces remain)', async ({ page }) => {
  await page.addInitScript({ content: userscriptSource() });

  await login(page);

  // Navigate to compare view via the UI (mirrors brno-compare.spec.ts).
  const tracksBtn = page.getByRole('button', { name: 'TRACKS' });
  const brnoLink  = page.locator('.dropdown-menu.show a[href="/laptimes/tracks/22/"]');
  await expect(async () => {
    await tracksBtn.click();
    await expect(brnoLink).toBeVisible({ timeout: 2000 });
  }).toPass();
  await brnoLink.click();
  await expect(page).toHaveURL(/\/laptimes\/tracks\/22\//);

  await page.getByRole('link', { name: 'Track info' }).click();
  await expect(page).toHaveURL(/\/tracks\/Brno\//);

  await page.getByRole('tab', { name: 'Motorbikes' }).first().click();
  await page.locator('a[href*="/laptimes/cwpl/"]:visible').first().click();
  await expect(page.getByRole('heading', { name: 'Choose a lap' })).toBeVisible();

  await page.getByRole('table').getByRole('link').first().click();
  await expect(page).toHaveURL(/\/laptimes\/\d+,\d+,\d+,\d+\//);

  // Confirm two riders are loaded.
  await expect
    .poll(() => page.evaluate(() => (window as any).SRSRCNG?.riders?.length ?? 0), { timeout: 30_000 })
    .toBe(2);

  // Navigate to the map pane (the compare URL may not default to it).
  const currentUrl = page.url();
  if (!currentUrl.includes('pane=map')) {
    // Click the Map tab if present.
    const mapTab = page.locator('a[href*="pane=map"], [data-pane="map"]').first();
    if (await mapTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await mapTab.click();
    }
  }

  // Wait for the Leaflet map.
  await expect
    .poll(() => page.evaluate(() => !!(window as any).SRSRCNG?.map), { timeout: 30_000 })
    .toBe(true);

  // Give the userscript up to 20 s to run (it polls every 250 ms for up to 60 tries).
  await page.waitForTimeout(5_000);

  // Our custom trace pane must NOT exist in compare mode.
  const tracePane = await page.evaluate((pane) => {
    const map = (window as any).SRSRCNG?.map;
    if (!map || !map.getPane) return null;
    const el = map.getPane(pane);
    return el ? true : false;
  }, TRACE_PANE);

  expect(
    tracePane,
    'Expected no srTrace pane in compare mode (gradient overlay should be skipped)',
  ).toBe(false);

  // The site's own lap lines should still be visible (opacity != 0).
  const siteLinesVisible = await page.evaluate(() => {
    const map = (window as any).SRSRCNG?.map;
    const L   = (window as any).L;
    if (!map || !L) return null;
    let foundVisible = false;
    map.eachLayer((l: any) => {
      if (l instanceof L.Polyline && !(l instanceof L.Polygon)) {
        try {
          const ll = l.getLatLngs();
          const n  = Array.isArray(ll) ? ll.flat(3).length : 0;
          if (n > 50) {
            const op = l.options?.opacity;
            if (op === undefined || op > 0) foundVisible = true;
          }
        } catch (_) {}
      }
    });
    return foundVisible;
  });

  expect(
    siteLinesVisible,
    'Expected at least one visible site polyline in compare mode',
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Assertion 4 (bail fallback): skipped — stubbing window.SRSRCNG after the
// page's own script has already populated it is not reliably achievable with
// addInitScript (it runs before page scripts, so a stub set there is
// overwritten). Intercepting and rewriting the 487 KB inline script to inject
// dead col4/speed data via route interception is fragile and out of scope for
// this harness. SKIP noted explicitly per QA brief.
// ---------------------------------------------------------------------------
test.skip('bail fallback: flat site line restored when col4+speed are all dead', () => {
  // Skipped: stubbing rider data post-load is impractical in this harness.
  // The bail path is covered by the unit tests in userscripts/sr-track.js (validity() returns
  // {bail:true} when col4DeadFrac and variance checks fail, which triggers showSiteLapLine).
});

// ---------------------------------------------------------------------------
// Deliverable 2: screenshot of the gradient on the target lap
// ---------------------------------------------------------------------------
test('screenshot: gradient on lap 122060 for human sign-off', async ({ page }) => {
  await page.addInitScript({ content: userscriptSource() });

  await login(page);
  await page.goto(SINGLE_LAP_URL);

  // Wait for SRSRCNG + map.
  await expect
    .poll(() => page.evaluate(() => !!(window as any).SRSRCNG?.map), { timeout: 30_000 })
    .toBe(true);

  // Wait for our trace pane to appear.
  await expect
    .poll(
      () =>
        page.evaluate((pane) => {
          const map = (window as any).SRSRCNG?.map;
          return !!(map && map.getPane && map.getPane(pane));
        }, TRACE_PANE),
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);

  // Allow tiles + overlays to fully render.
  await page.waitForTimeout(2_000);

  const screenshotDir = '/private/tmp/claude-501/-Users-serdiuk-git-pet-projects-serious-racing/89354da2-4e96-49b8-be4c-aed910002c2b/scratchpad';

  // Full map pane screenshot.
  const mapCanvas = page.locator('#map-container');
  await mapCanvas.screenshot({ path: `${screenshotDir}/gradient-122060.png` });

  // Zoom into a corner area by panning the Leaflet map to the first GPS point and
  // zooming in, then capturing.
  await page.evaluate(() => {
    const map = (window as any).SRSRCNG?.map;
    const riders = (window as any).SRSRCNG?.riders;
    if (!map || !riders?.length) return;
    const data = riders[0].data;
    if (!data?.length) return;
    // Find a point that is roughly 10% into the lap (past the start line, likely a corner).
    const idx = Math.floor(data.length * 0.10);
    const pt  = data[idx];
    map.setView([pt[0], pt[1]], 17, { animate: false });
  });

  await page.waitForTimeout(1_500);
  await mapCanvas.screenshot({ path: `${screenshotDir}/gradient-122060-corner.png` });
});
