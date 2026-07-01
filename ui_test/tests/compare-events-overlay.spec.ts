/**
 * T13: end-to-end verification of the compare-mode braking-triangle +
 * corner-coaching-label overlay (srEvents pane), injected via the BUILT
 * userscript (serious-racing-lean-angle.user.js), on the live compare lap
 *   /laptimes/122145,3,63254,5/?pane=map   (2 riders: SERDIUK red, LEEK74 blue)
 *
 * Playwright can't run Tampermonkey, so we inject the built IIFE into page
 * scope (page.addScriptTag) after SRSRCNG + the Leaflet map are ready. The
 * script self-drives via its own MutationObserver + poll loop (see
 * userscripts/src/07-bootstrap.js), so once injected we just wait for it to
 * render.
 *
 * Also covers the chip-declutter fix (userscripts/src/05-map.js
 * CHIP_COLLAPSE_RADIUS_PX): at default zoom, corner chips must collapse to a
 * small, non-overlapping set (screen-rect intersection check). We also verify
 * that guarantee still holds after zooming in ON A REAL CORNER (panned there via
 * setView using a corner apex from SR_TRACK.buildCompareEvents, not an in-place
 * setZoom which can land the viewport on an empty patch of map and trivially
 * "pass" with zero chips).
 *
 *   cd ui_test && npx playwright test compare-events-overlay --project=chromium
 */

import fs from 'fs';
import path from 'path';
import { test, expect, Page } from '@playwright/test';

const USER     = process.env.user;
const PASSWORD = process.env.password;

const LAP_URL = '/laptimes/122145,3,63254,5/?pane=map';
const USERSCRIPT_PATH = path.resolve(
  __dirname,
  '../../userscripts/serious-racing-lean-angle.user.js',
);

test.beforeAll(() => {
  if (!USER || !PASSWORD) {
    throw new Error('Missing `user` / `password` in ui_test/.env');
  }
  if (!fs.existsSync(USERSCRIPT_PATH)) {
    throw new Error(
      `Built userscript not found at ${USERSCRIPT_PATH}. Run \`node userscripts/build.mjs\` first.`,
    );
  }
});

// The live site itself already serves an OLDER build of this exact userscript as a
// real <script> tag (static/js/srsrcng/plugins-serdiuk-analysis.min.js) — apparently a
// prior deployment for real-world testing, independent of Tampermonkey. That older
// build predates the srEvents overlay (T7-T10), so it satisfies the bootstrap poll
// loop's "chartUp" gate before our freshly `addScriptTag`-injected copy ever gets to
// run its own render(). Block that request so only the build under test executes.
const LIVE_PLUGIN_GLOB = '**/static/js/srsrcng/plugins-serdiuk-analysis*.js*';

async function login(page: Page) {
  await page.route(LIVE_PLUGIN_GLOB, (route) => route.abort());
  await page.goto('/accounts/login/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(USER!);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/home\//);
}

async function waitForCompareReady(page: Page) {
  await expect
    .poll(
      () => page.evaluate(() => (window as any).SRSRCNG?.riders?.[0]?.data?.length ?? 0),
      { timeout: 60_000, intervals: [500] },
    )
    .toBeGreaterThan(0);
  // Second rider must also be present for compare mode's isCompare() >= 2 gate.
  await expect
    .poll(() => page.evaluate(() => (window as any).SRSRCNG?.riders?.[1]?.data?.length ?? 0))
    .toBeGreaterThan(0);
  // The Leaflet map instance must exist before the userscript's map code can run.
  await expect
    .poll(() => page.evaluate(() => !!(window as any).SRSRCNG?.map))
    .toBeTruthy();
}

function injectUserscript(page: Page) {
  const src = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
  return page.addScriptTag({ content: src });
}

test.describe('compare-mode srEvents overlay (braking triangles + coaching chips)', () => {
  test('renders triangles + chips without breaking the existing trace/chart', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await login(page);
    await page.goto(LAP_URL);
    await waitForCompareReady(page);

    // Sanity: confirm we are actually in 2-rider compare mode before judging
    // the overlay (isCompare() in the userscript requires >= 2 valid riders).
    const riderCount = await page.evaluate(() => (window as any).SRSRCNG.riders.length);
    expect(riderCount).toBeGreaterThanOrEqual(2);

    // --- Baseline: capture pre-injection state of things the overlay must not break ---
    const chartExistedBefore = await page.evaluate(
      () => !!document.getElementById('sidebar-graph-container'),
    );
    expect(chartExistedBefore).toBe(true);

    await injectUserscript(page);

    // The userscript's own poll loop (07-bootstrap.js) calls render() every
    // 250ms for up to 60 tries (~15s) and renderCompareEvents() runs inside
    // render() once isCompare() is true. Give it generous time to settle.
    await expect
      .poll(
        () => page.evaluate(() => !!(window as any).SRSRCNG?.map?.getPane?.('srEvents')),
        { timeout: 20_000, intervals: [500] },
      )
      .toBeTruthy();

    // --- Pane exists (both by Leaflet API and by the DOM class it creates) ---
    const paneExists = await page.evaluate(
      () => !!document.querySelector('.leaflet-pane.leaflet-srEvents-pane'),
    );
    expect(paneExists).toBe(true);

    // --- Triangle (braking-onset) markers render, at least at default zoom (LOD top-K) ---
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('.sr-evt-tri').length))
      .toBeGreaterThan(0);

    const triColors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.sr-evt-tri polygon')).map((el) =>
        el.getAttribute('fill'),
      ),
    );
    const distinctTriColors = new Set(triColors.filter(Boolean));
    // Two riders -> fanned triangles in (ideally) two distinct colours. At minimum
    // we must have triangles at all; report the actual distinct-colour count either way.
    expect(triColors.length).toBeGreaterThan(0);

    // --- LOD / chip-declutter: corner chips only render at zoom >= LOD_ZOOM_FULL (15,
    // per userscripts/src/05-map.js), and at low-ish zoom they are additionally
    // collapsed by SCREEN DISTANCE using a dedicated CHIP_COLLAPSE_RADIUS_PX (90px,
    // separate from the 24px triangle-collapse radius) so overlapping corner chips
    // no longer pile into an unreadable stack. Highest-severity (deepest/slowest)
    // corner survives each collapse. This lap's default auto-fit zoom (~15.6) is
    // expected to yield only a FEW non-overlapping chips (~2 of the 13 detected
    // corners). The non-overlap guarantee is re-checked below after zooming in on
    // a real corner (see the "Zoom-in-on-a-corner" block).
    const chipsAtDefaultZoom = await page.evaluate(
      () => document.querySelectorAll('.sr-evt-chip').length,
    );
    const defaultZoom = await page.evaluate(() => (window as any).SRSRCNG.map.getZoom());

    expect(
      chipsAtDefaultZoom,
      `expected a reduced, decluttered chip count (~2) at default zoom ${defaultZoom}, got ${chipsAtDefaultZoom}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      chipsAtDefaultZoom,
      `chip count at default zoom should be clearly less than the full 13-corner set (declutter fix regressed), got ${chipsAtDefaultZoom}`,
    ).toBeLessThan(13);

    // Core regression guard for the reported defect: no two VISIBLE chips may
    // overlap on screen at default zoom. Read each chip's actual rendered
    // bounding box and assert pairwise non-intersection (a stronger, more direct
    // check than trusting the collapse radius math alone).
    const chipRectsAtDefaultZoom = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.sr-evt-chip')).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }),
    );

    function rectsIntersect(a: { left: number; top: number; right: number; bottom: number }, b: typeof a) {
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    }

    const overlappingPairs: string[] = [];
    for (let i = 0; i < chipRectsAtDefaultZoom.length; i++) {
      for (let j = i + 1; j < chipRectsAtDefaultZoom.length; j++) {
        if (rectsIntersect(chipRectsAtDefaultZoom[i], chipRectsAtDefaultZoom[j])) {
          overlappingPairs.push(`chip[${i}] x chip[${j}]: ${JSON.stringify(chipRectsAtDefaultZoom[i])} vs ${JSON.stringify(chipRectsAtDefaultZoom[j])}`);
        }
      }
    }
    expect(
      overlappingPairs,
      `chips overlap at default zoom (declutter fix failed):\n${overlappingPairs.join('\n')}`,
    ).toEqual([]);

    // Visual confirmation of the declutter fix: chips at default zoom, non-overlapping.
    await page.screenshot({
      path: 'test-results/compare-events-overlay-chips-default-zoom.png',
      fullPage: false,
    });

    // --- Zoom-in-on-a-corner: setZoom(18) IN PLACE (around the whole-track
    // centroid) is not a real user interaction — it can land the viewport on an
    // empty patch of map with no track segment in view, at which point
    // lodFilterCorners()'s viewport culling (inViewport(), 05-map.js) is CORRECTLY
    // showing ~0 chips for an empty view. That's a bug in this test's zoom step,
    // not the product. A real user zooms in ON something (a corner).
    //
    // SR_TRACK (the detection model that produces corner apexes) is a `var` closed
    // over inside the injected userscript's own IIFE (userscripts/build.mjs) — it is
    // NOT exposed on `window`, so it can't be called from here directly. Instead we
    // read a REAL rendered corner-chip marker (`.sr-evt-chip-host`, already confirmed
    // to exist above via chipsAtDefaultZoom >= 1) and convert its Leaflet-anchored
    // screen position back to a lat/lng via the live map. This is the corner's actual
    // apex position (renderCornerMarker anchors the marker at [anchorLat, anchorLng] =
    // the apex, 05-map.js) rather than a braking-onset position, which matters: onsets
    // sit upstream of the apex and can be far enough away that zooming in on an onset
    // still excludes the apex from the viewport (verified empirically — using a
    // `.sr-evt-tri` onset marker here reliably produced 0 chips at zoom 18, because
    // lodFilterCorners() culls by apex position, not onset position).
    const corner = await page.evaluate(() => {
      const map = (window as any).SRSRCNG.map;
      const el = document.querySelector('.sr-evt-chip-host') || document.querySelector('.sr-evt-chip');
      if (!el) return null;
      const host = (el as HTMLElement).closest('.leaflet-marker-icon') as HTMLElement || (el as HTMLElement);
      const r = host.getBoundingClientRect();
      const mapRect = map.getContainer().getBoundingClientRect();
      const cx = r.left - mapRect.left;
      const cy = r.top - mapRect.top;
      const latlng = map.containerPointToLatLng([cx, cy]);
      return { lat: latlng.lat, lng: latlng.lng };
    });
    expect(corner, 'expected to be able to resolve a rendered .sr-evt-chip-host marker back to a lat/lng').not.toBeNull();

    await page.evaluate(({ lat, lng }) => {
      const map = (window as any).SRSRCNG.map;
      map.setView([lat, lng], 18);
    }, corner as { lat: number; lng: number });
    // zoomend triggers the userscript's LOD recompute (rebuildEventsLayer) synchronously
    // off the 'zoomend' Leaflet event; poll in case of a tick of async catch-up, and
    // additionally wait for the chip count to stabilize (stop changing) before reading it.
    await expect
      .poll(() => page.evaluate(() => (window as any).SRSRCNG.map.getZoom()), {
        timeout: 10_000,
        intervals: [300],
      })
      .toBe(18);

    let stableChipCount = -1;
    let lastChipCount = -2;
    await expect
      .poll(
        () => {
          return page.evaluate(() => document.querySelectorAll('.sr-evt-chip').length).then((n) => {
            const stabilized = n === lastChipCount;
            lastChipCount = n;
            if (stabilized) stableChipCount = n;
            return stabilized;
          });
        },
        { timeout: 10_000, intervals: [300] },
      )
      .toBeTruthy();

    const chipCountAtCornerZoom = stableChipCount;

    // Honest assertion: zooming out in place vs. zooming in on a real corner are not
    // guaranteed to change the TOTAL chip count in the same direction — zooming in on
    // one corner narrows the viewport to that corner's neighbourhood, so it may show
    // FEWER total chips than the wide default view (only nearby corners are in frame),
    // not more. Asserting "strictly greater than chipsAtDefaultZoom" does not reflect
    // reality and was the source of the false failure. The property that DOES hold,
    // and is the one the LOD/declutter design actually promises, is:
    //   (a) the corner-zoomed viewport is non-empty (culling+reveal works — we did NOT
    //       land in a void), and
    //   (b) chips at this zoom are STILL pairwise non-overlapping (the declutter fix
    //       holds at every zoom level, not just the default one).
    expect(
      chipCountAtCornerZoom,
      `expected at least one chip once zoomed onto a real corner (got ${chipCountAtCornerZoom}); ` +
        'an empty result here would mean the viewport landed off-track',
    ).toBeGreaterThan(0);

    const chipRectsAtCornerZoom = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.sr-evt-chip')).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }),
    );
    const overlappingPairsAtCornerZoom: string[] = [];
    for (let i = 0; i < chipRectsAtCornerZoom.length; i++) {
      for (let j = i + 1; j < chipRectsAtCornerZoom.length; j++) {
        if (rectsIntersect(chipRectsAtCornerZoom[i], chipRectsAtCornerZoom[j])) {
          overlappingPairsAtCornerZoom.push(
            `chip[${i}] x chip[${j}]: ${JSON.stringify(chipRectsAtCornerZoom[i])} vs ${JSON.stringify(chipRectsAtCornerZoom[j])}`,
          );
        }
      }
    }
    expect(
      overlappingPairsAtCornerZoom,
      `chips overlap at corner zoom (declutter fix should hold at every zoom):\n${overlappingPairsAtCornerZoom.join('\n')}`,
    ).toEqual([]);

    // Visual confirmation of the declutter fix holding at a real zoomed-in corner view.
    await page.screenshot({
      path: 'test-results/compare-events-overlay-chips-corner-zoom.png',
      fullPage: false,
    });

    const chipCountAtHighZoom = chipCountAtCornerZoom;

    // --- Existing behaviour intact: site speed chart placeholder + our own telemetry panel ---
    const chartStillPresent = await page.evaluate(
      () => !!document.getElementById('sidebar-graph-container'),
    );
    expect(chartStillPresent).toBe(true);

    const ourPanelPresent = await page.evaluate(
      () => !!document.getElementById('sr-tele-panel'),
    );
    expect(ourPanelPresent).toBe(true);

    // Map must still be interactive (Leaflet instance alive, container attached).
    const mapAlive = await page.evaluate(() => {
      const map = (window as any).SRSRCNG.map;
      return !!(map && map.getContainer && document.body.contains(map.getContainer()));
    });
    expect(mapAlive).toBe(true);

    // --- No uncaught page errors from our script (or anything else) ---
    expect(
      pageErrors.map((e) => e.message),
      `Uncaught page errors:\n${pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
    ).toEqual([]);

    console.log('=== compare-events-overlay: single-render results ===');
    console.log(`riderCount               : ${riderCount}`);
    console.log(`triangle count (default) : ${triColors.length}`);
    console.log(`triangle distinct colors : ${JSON.stringify([...distinctTriColors])}`);
    console.log(`default zoom             : ${defaultZoom}`);
    console.log(`chip count (default zoom): ${chipsAtDefaultZoom} (decluttered, non-overlapping)`);
    console.log(`corner apex used for zoom: ${JSON.stringify(corner)}`);
    console.log(`chip count (corner, z=18): ${chipCountAtHighZoom} (non-empty, non-overlapping)`);
  });

  test('pane-swap round trip (Analyse tab away and browser-back) does not duplicate overlay markers', async ({ page }) => {
    // Investigation notes (see task report): on this desktop viewport the only
    // RELIABLY CLICKABLE pane control is the "Analyse" button (`a.loadinfo.d-md-block`,
    // visible; the mobile subnav's `.loadmap`/`.loadgraph`/`.loadinfo` triplet is
    // `display:none` on desktop and Playwright correctly refuses to click a
    // genuinely non-visible element). Clicking "Analyse" flips
    // window.SRSRCNG.currentlyViewing to 'info' and sets #map-container to
    // `display:none` — a real pane switch away from the map, driven by the app's
    // own code, not simulated. There is no visible "back to map" control once on
    // the Analyse pane on this viewport (browser back only restores the URL, not
    // app state, on this app), so we return to a clean map pane via re-navigation,
    // which the app treats identically to a fresh visit/tab-restore and which the
    // userscript's own MutationObserver + poll loop (07-bootstrap.js) are
    // specifically designed to recover from.
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await login(page);
    await page.goto(LAP_URL);
    await waitForCompareReady(page);

    await injectUserscript(page);

    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('.sr-evt-tri').length), {
        timeout: 20_000,
        intervals: [500],
      })
      .toBeGreaterThan(0);

    const triCountBefore = await page.evaluate(
      () => document.querySelectorAll('.sr-evt-tri').length,
    );
    expect(triCountBefore).toBeGreaterThan(0);

    // Real pane switch away from map, via the app's own visible "Analyse" control.
    await page.locator('a.loadinfo.d-md-block').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).SRSRCNG?.currentlyViewing))
      .toBe('info');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.getElementById('map-container')!).display))
      .toBe('none');

    // renderCompareEvents() / render() must be inert while off the map pane (the
    // early `currentlyViewing !== 'map'` guard in render()) — confirm no growth.
    await page.waitForTimeout(1000);
    const triCountWhileAway = await page.evaluate(
      () => document.querySelectorAll('.sr-evt-tri').length,
    );
    expect(triCountWhileAway).toBe(triCountBefore);

    // Return to the map pane and let the userscript's own re-render machinery
    // (poll loop / MutationObserver) pick back up.
    await page.goto(LAP_URL);
    await waitForCompareReady(page);
    await injectUserscript(page); // mirrors the real userscript being persistently active across the round trip

    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('.sr-evt-tri').length), {
        timeout: 20_000,
        intervals: [500],
      })
      .toBeGreaterThan(0);
    await page.waitForTimeout(500);

    const triCountAfter = await page.evaluate(
      () => document.querySelectorAll('.sr-evt-tri').length,
    );

    // Core assertion: no duplication. The count after the pane-switch round trip
    // must match the pre-switch count exactly (same zoom/viewport => same LOD
    // result), not some multiple of it.
    expect(triCountAfter).toBe(triCountBefore);

    // Exactly one srEvents Leaflet pane must exist — never duplicated.
    const paneNodeCount = await page.evaluate(
      () => document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length,
    );
    expect(paneNodeCount).toBe(1);

    expect(
      pageErrors.map((e) => e.message),
      `Uncaught page errors:\n${pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
    ).toEqual([]);

    console.log('=== compare-events-overlay: pane-swap round trip (Analyse tab) ===');
    console.log(`triangle count before swap : ${triCountBefore}`);
    console.log(`triangle count while away  : ${triCountWhileAway}`);
    console.log(`triangle count after swap  : ${triCountAfter}`);
    console.log(`srEvents pane DOM nodes    : ${paneNodeCount}`);
  });

  test('reload (full app + Leaflet re-init) does not duplicate overlay markers', async ({ page }) => {
    // A stronger variant of the pane-swap scenario: force the WHOLE app, including
    // Leaflet, to reinitialize from scratch (new window.SRSRCNG.map instance, same
    // DOM ids) — a superset of any in-app pane-swap mechanism, and reliably
    // driveable without depending on which swap strategy a given viewport uses.
    // This exercises renderCompareEvents()'s map-instance-identity guard
    // (userscripts/src/05-map.js) directly.
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await login(page);
    await page.goto(LAP_URL);
    await waitForCompareReady(page);
    await injectUserscript(page);

    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('.sr-evt-tri').length), {
        timeout: 20_000,
        intervals: [500],
      })
      .toBeGreaterThan(0);

    const triCountBefore = await page.evaluate(
      () => document.querySelectorAll('.sr-evt-tri').length,
    );

    const mapTagged = await page.evaluate(() => {
      (window as any).__srTestTag = (window as any).SRSRCNG.map;
      return true;
    });
    expect(mapTagged).toBe(true);

    await page.reload();
    await waitForCompareReady(page);

    const gotFreshMapInstance = await page.evaluate(
      () => (window as any).SRSRCNG.map !== (window as any).__srTestTag,
    );
    expect(gotFreshMapInstance).toBe(true);

    // Re-inject: mirrors the userscript's own MutationObserver re-render path,
    // which fires when its panel is gone and the map pane is ready again.
    await injectUserscript(page);

    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('.sr-evt-tri').length), {
        timeout: 20_000,
        intervals: [500],
      })
      .toBeGreaterThan(0);

    await page.waitForTimeout(500);
    const triCountAfter = await page.evaluate(
      () => document.querySelectorAll('.sr-evt-tri').length,
    );

    expect(triCountAfter).toBe(triCountBefore);

    const paneNodeCount = await page.evaluate(
      () => document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length,
    );
    expect(paneNodeCount).toBe(1);

    expect(
      pageErrors.map((e) => e.message),
      `Uncaught page errors:\n${pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
    ).toEqual([]);

    console.log('=== compare-events-overlay: full reload round trip ===');
    console.log(`triangle count before reload: ${triCountBefore}`);
    console.log(`triangle count after reload : ${triCountAfter}`);
    console.log(`srEvents pane DOM nodes     : ${paneNodeCount}`);
  });
});
