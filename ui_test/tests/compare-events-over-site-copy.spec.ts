/**
 * T14: acceptance test for the collision-tolerance fix in
 * userscripts/src/07-bootstrap.js (v2.14.0) — the compare-mode srEvents
 * overlay (braking triangles + corner coaching chips) must render even when
 * the site is ALSO serving its OWN older copy of this exact userscript as a
 * real <script> tag:
 *
 *   https://serious-racing.com/static/js/srsrcng/plugins-serdiuk-analysis.min.js?v=2.13.0
 *
 * That older site copy predates the srEvents overlay (T7-T10) and builds
 * #sr-tele-panel + the Flot plot before ours ever gets a chance to run,
 * which previously caused the main render()/poll loop's `chartUp` gate to be
 * satisfied on tick 1 — clearing the poll before render() (and therefore
 * renderCompareEvents()) ever executed. The fix adds an INDEPENDENT
 * `eventsPoll` + `eventsObs` bootstrap (see userscripts/src/07-bootstrap.js)
 * that calls renderCompareEvents() directly, decoupled from the chart-panel
 * gate, so the overlay renders regardless of who built the chart.
 *
 * CRITICAL DIFFERENCE from compare-events-overlay.spec.ts: that spec
 * deliberately ABORTS the site's own plugins-serdiuk-analysis*.js request so
 * only the build-under-test runs. This spec does the OPPOSITE on purpose —
 * it leaves the site's own script completely unblocked, so both copies are
 * genuinely running in the page at once. This is the real Tampermonkey
 * collision the user hit in production.
 *
 *   cd ui_test && npx playwright test compare-events-over-site-copy --project=chromium
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

// NOTE: unlike compare-events-overlay.spec.ts, we deliberately do NOT
// page.route(...).abort() the site's plugins-serdiuk-analysis*.js request
// here. Leaving it running is the entire point of this test — it reproduces
// the real collision between the site's bundled older copy and our injected
// build.
async function login(page: Page) {
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
  await expect
    .poll(() => page.evaluate(() => (window as any).SRSRCNG?.riders?.[1]?.data?.length ?? 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => !!(window as any).SRSRCNG?.map))
    .toBeTruthy();
}

function injectUserscript(page: Page) {
  const src = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
  return page.addScriptTag({ content: src });
}

function rectsIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: typeof a,
) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

test.describe('compare-mode srEvents overlay survives the site serving its own older copy', () => {
  test('overlay renders on top of the site copy, without duplication or page errors', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    // Track the site's own bundled analysis script so we can confirm it
    // actually loaded (i.e. we really are reproducing the collision, not
    // accidentally testing an empty page).
    let siteScriptRequested = false;
    let siteScriptStatus: number | null = null;
    page.on('response', (res) => {
      if (/static\/js\/srsrcng\/plugins-serdiuk-analysis.*\.js/.test(res.url())) {
        siteScriptRequested = true;
        siteScriptStatus = res.status();
      }
    });

    await login(page);
    await page.goto(LAP_URL);
    await waitForCompareReady(page);

    const riderCount = await page.evaluate(() => (window as any).SRSRCNG.riders.length);
    expect(riderCount).toBeGreaterThanOrEqual(2);

    expect(
      siteScriptRequested,
      'expected the site to actually request its own plugins-serdiuk-analysis*.js — ' +
        'otherwise this test is not reproducing the real collision',
    ).toBe(true);
    console.log(`site copy request status: ${siteScriptStatus}`);

    // Give the SITE's own (older) copy time to run its bootstrap and build
    // its #sr-tele-panel + chart first — this is what starves our main
    // render()/poll `chartUp` gate in the pre-fix behaviour.
    await page.waitForTimeout(3000);

    const sitePanelPresent = await page.evaluate(
      () => !!document.getElementById('sr-tele-panel'),
    );
    console.log(`#sr-tele-panel present from site copy alone: ${sitePanelPresent}`);

    // --- BEFORE: sanity that the overlay does NOT exist yet from the site's
    // own (older, pre-srEvents) copy alone. Optional/informational per the
    // task, but worth asserting since it demonstrates the site copy really
    // is older and lacks the feature.
    const beforeState = await page.evaluate(() => ({
      pane: !!(window as any).SRSRCNG?.map?.getPane?.('srEvents'),
      triCount: document.querySelectorAll('.sr-evt-tri').length,
      chipCount: document.querySelectorAll('.sr-evt-chip').length,
    }));
    console.log(`BEFORE injection: ${JSON.stringify(beforeState)}`);
    expect(beforeState.pane).toBe(false);
    expect(beforeState.triCount).toBe(0);

    // --- Inject OUR freshly built (v2.14.0) userscript on top of the
    // already-running site copy. Do NOT remove/neutralize the site copy.
    await injectUserscript(page);

    // --- AFTER: poll (up to ~15s) for the overlay to appear despite the
    // site copy already owning the chart panel.
    await expect
      .poll(
        () => page.evaluate(() => !!(window as any).SRSRCNG?.map?.getPane?.('srEvents')),
        { timeout: 15_000, intervals: [500] },
      )
      .toBeTruthy();

    await expect
      .poll(
        () => page.evaluate(() => document.querySelectorAll('.sr-evt-tri').length),
        { timeout: 15_000, intervals: [500] },
      )
      .toBeGreaterThan(0);

    const paneExists = await page.evaluate(
      () => !!document.querySelector('.leaflet-pane.leaflet-srEvents-pane'),
    );
    expect(paneExists).toBe(true);

    const triColors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.sr-evt-tri polygon')).map((el) =>
        el.getAttribute('fill'),
      ),
    );
    const distinctTriColors = new Set(triColors.filter(Boolean));
    expect(triColors.length).toBeGreaterThan(0);

    const afterState = await page.evaluate(() => ({
      paneNodeCount: document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length,
      triCount: document.querySelectorAll('.sr-evt-tri').length,
      chipCount: document.querySelectorAll('.sr-evt-chip').length,
      zoom: (window as any).SRSRCNG.map.getZoom(),
    }));
    console.log(`AFTER injection: ${JSON.stringify(afterState)}`);
    console.log(`triangle distinct colours: ${JSON.stringify([...distinctTriColors])}`);

    // --- No duplication: exactly ONE srEvents pane, idempotent vs the site
    // copy also running its own (harmless, feature-less) bootstrap loops.
    expect(
      afterState.paneNodeCount,
      'expected exactly one srEvents Leaflet pane even with the site copy running',
    ).toBe(1);

    // --- Stability: triangle count should not keep growing (would indicate
    // the two copies are fighting / re-adding markers on every poll tick).
    const triCountSamples: number[] = [afterState.triCount];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(500);
      const n = await page.evaluate(() => document.querySelectorAll('.sr-evt-tri').length);
      triCountSamples.push(n);
    }
    console.log(`triangle count samples over ~2s settle window: ${JSON.stringify(triCountSamples)}`);
    const uniqueCounts = new Set(triCountSamples);
    expect(
      [...uniqueCounts],
      `triangle count must stabilize, not grow, over repeated poll ticks: ${JSON.stringify(triCountSamples)}`,
    ).toEqual([afterState.triCount]);

    // --- Chips: LOD-gated, may legitimately be 0 at the default auto-fit
    // zoom. If present, they must not overlap. If absent, pan+zoom to a real
    // corner (using a rendered triangle/chip anchor) and re-check.
    let chipCountForScreenshot = afterState.chipCount;
    if (afterState.chipCount === 0) {
      console.log('no chips at default zoom (LOD) — attempting zoom-in on a real corner');

      // Prefer an actual chip anchor if one exists at any intermediate
      // moment; otherwise fall back to a triangle (onset) position and zoom
      // in hard, which should reveal nearby corner chips once in view.
      const anchor = await page.evaluate(() => {
        const map = (window as any).SRSRCNG.map;
        const el =
          document.querySelector('.sr-evt-chip-host') ||
          document.querySelector('.sr-evt-chip') ||
          document.querySelector('.sr-evt-tri');
        if (!el) return null;
        const host =
          (el as HTMLElement).closest('.leaflet-marker-icon') as HTMLElement || (el as HTMLElement);
        const r = host.getBoundingClientRect();
        const mapRect = map.getContainer().getBoundingClientRect();
        const cx = r.left - mapRect.left;
        const cy = r.top - mapRect.top;
        const latlng = map.containerPointToLatLng([cx, cy]);
        return { lat: latlng.lat, lng: latlng.lng };
      });

      if (anchor) {
        await page.evaluate(({ lat, lng }) => {
          (window as any).SRSRCNG.map.setView([lat, lng], 18);
        }, anchor as { lat: number; lng: number });

        await expect
          .poll(() => page.evaluate(() => (window as any).SRSRCNG.map.getZoom()), {
            timeout: 10_000,
            intervals: [300],
          })
          .toBe(18);

        // Let LOD recompute settle.
        let stableChipCount = -1;
        let lastChipCount = -2;
        await expect
          .poll(
            () =>
              page.evaluate(() => document.querySelectorAll('.sr-evt-chip').length).then((n) => {
                const stabilized = n === lastChipCount;
                lastChipCount = n;
                if (stabilized) stableChipCount = n;
                return stabilized;
              }),
            { timeout: 10_000, intervals: [300] },
          )
          .toBeTruthy();

        chipCountForScreenshot = stableChipCount;
        console.log(`chip count after zoom-to-corner: ${chipCountForScreenshot}`);
      } else {
        console.log('no chip/triangle anchor available to zoom in on — leaving chip count at 0');
      }
    }

    if (chipCountForScreenshot > 0) {
      const chipRects = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.sr-evt-chip')).map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        }),
      );
      const overlappingPairs: string[] = [];
      for (let i = 0; i < chipRects.length; i++) {
        for (let j = i + 1; j < chipRects.length; j++) {
          if (rectsIntersect(chipRects[i], chipRects[j])) {
            overlappingPairs.push(`chip[${i}] x chip[${j}]`);
          }
        }
      }
      expect(
        overlappingPairs,
        `chips must not overlap: ${overlappingPairs.join(', ')}`,
      ).toEqual([]);
    }

    // --- Screenshot: visual proof of triangles/chips rendered over the live
    // map, with the site's own older copy present and running.
    await page.screenshot({
      path: 'test-results/compare-events-over-site-copy.png',
      fullPage: false,
    });

    // --- No uncaught page errors from either copy running concurrently.
    expect(
      pageErrors.map((e) => e.message),
      `Uncaught page errors:\n${pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
    ).toEqual([]);

    console.log('=== compare-events-over-site-copy: results ===');
    console.log(`riderCount                    : ${riderCount}`);
    console.log(`site copy requested/status     : ${siteScriptRequested} / ${siteScriptStatus}`);
    console.log(`site #sr-tele-panel pre-inject  : ${sitePanelPresent}`);
    console.log(`BEFORE injection state          : ${JSON.stringify(beforeState)}`);
    console.log(`AFTER injection state           : ${JSON.stringify(afterState)}`);
    console.log(`triangle distinct colours       : ${JSON.stringify([...distinctTriColors])}`);
    console.log(`triangle count stability samples: ${JSON.stringify(triCountSamples)}`);
    console.log(`final chip count                : ${chipCountForScreenshot}`);
  });
});
