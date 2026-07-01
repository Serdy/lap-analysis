/**
 * Live E2E acceptance test for the srEvents "latch/accumulate" behavior in
 * userscripts/src/05-map.js:
 *
 *   Once a braking-onset arrow (.sr-evt-tri) or corner chip (.sr-evt-chip)
 *   appears during playback, it LATCHES — it stays visible/accumulates rather
 *   than disappearing once the moving rider(s) pass out of its normal
 *   "in-window" range. The trail only clears on a big backward seek/replay
 *   (> LATCH_REWIND_M = 200m) or a fresh map/lap load. LOD/declutter still
 *   applies on top of the latched set.
 *
 * Run against the REAL site (site's own older copy of this script present,
 * NOT blocked) — see overlay-adjustments-live.spec.ts / overlay-look-live.spec.ts
 * for why that matters and the general pattern this file is modeled on.
 *
 * Driven by the userscript's OWN #sr-play button (the site's native
 * #track-map-controls is hidden by our script).
 *
 * Run:
 *   cd ui_test && npx playwright test latch-live --project=chromium
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

const EXPECTED_ARROW_SIZE = 18;
const EXPECTED_ARROW_POLYGON = '8,1.2 13.6,12.6 8,9.8 2.4,12.6';
// Each rendered arrow marker is a Leaflet divIcon host (.sr-evt-tri-host)
// wrapping an inline <svg class="sr-evt-tri">. querySelectorAll('.sr-evt-tri')
// therefore returns one node PER marker (the svg itself carries the class,
// not the host) -- but some renders additionally wrap host+svg such that a
// naive count could double-count. We defensively de-duplicate by the host
// element (closest .leaflet-marker-icon) so "distinct marker count" is
// robust regardless of how many DOM nodes per marker carry the class.
const SAMPLE_INTERVAL_MS = 500;
const SAMPLE_WINDOW_MS = 25_000;

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

// Distinct-marker counter: a marker is (host element carrying either the svg
// or the chip div). We count by de-duplicating on the nearest
// .leaflet-marker-icon ancestor (falling back to the element itself if no
// such ancestor exists) so host+svg pairs (2 DOM nodes per arrow marker)
// collapse to 1. Only counts markers that are actually visible (not
// display:none/visibility:hidden/opacity:0, and not hidden via a hidden
// host).
function countDistinctMarkers(selector: string) {
  const seen = new Set<Element>();
  Array.from(document.querySelectorAll(selector)).forEach((el) => {
    const style = window.getComputedStyle(el as Element);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (parseFloat(style.opacity || '1') === 0) return;
    const host = (el as HTMLElement).closest('.leaflet-marker-icon') as HTMLElement | null;
    if (host) {
      const hostStyle = window.getComputedStyle(host);
      if (hostStyle.display === 'none' || hostStyle.visibility === 'hidden') return;
      if (parseFloat(hostStyle.opacity || '1') === 0) return;
      seen.add(host);
    } else {
      seen.add(el);
    }
  });
  return seen.size;
}

async function readMarkerCounts(page: Page) {
  return page.evaluate((countFn) => {
    // eslint-disable-next-line no-eval
    const fn = eval(`(${countFn})`);
    return {
      triCount: fn('.sr-evt-tri'),
      chipCount: fn('.sr-evt-chip'),
    };
  }, countDistinctMarkers.toString());
}

// NOTE: the site's own (older) copy of this same script coexists on the page
// (deliberately not blocked — see file header) and renders its OWN
// `.sr-evt-tri` / `.sr-evt-chip` elements from an older code path, which can
// have different (e.g. stale/older-size) attributes. Only markers that are
// currently VISIBLE and belong to OUR overlay should be asserted against —
// same visibility filter as countDistinctMarkers. We additionally scope to
// elements inside the `srEvents` Leaflet pane (our overlay's own pane; see
// EVENTS_PANE in 05-map.js) so a same-classed node injected by the site's
// older copy into a different pane can't leak into the regression checks.
function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity || '1') === 0) return false;
  const host = (el as HTMLElement).closest('.leaflet-marker-icon') as HTMLElement | null;
  if (host) {
    const hostStyle = window.getComputedStyle(host);
    if (hostStyle.display === 'none' || hostStyle.visibility === 'hidden') return false;
    if (parseFloat(hostStyle.opacity || '1') === 0) return false;
  }
  return true;
}

async function readRegressionSnapshot(page: Page) {
  return page.evaluate(
    ({ expectedPolygon, isVisibleFn }) => {
      // eslint-disable-next-line no-eval
      const visible = eval(`(${isVisibleFn})`) as (el: Element) => boolean;
      const eventsPane = document.querySelector('.leaflet-srEvents-pane');
      const paneNodeCount = document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length;

      // The `.sr-evt-tri` class is applied to TWO nodes per marker: the
      // outer Leaflet div.leaflet-marker-icon host (no `width` attribute —
      // sizing is via inline CSS px on the host div) and the inner
      // `<svg class="sr-evt-tri" width="18">` (the actual sized element).
      // Only the <svg> carries a meaningful `width` attribute/polygon, so
      // scope the size/shape checks to svg nodes specifically.
      const allTris = Array.from(document.querySelectorAll('svg.sr-evt-tri'));
      const ourTris = allTris.filter((el) => visible(el) && (!eventsPane || eventsPane.contains(el)));
      const widths = ourTris.map((el) => parseFloat((el as SVGElement).getAttribute('width') || '0'));
      const polygons = ourTris.map((el) => {
        const p = el.querySelector('polygon');
        return p ? p.getAttribute('points') : null;
      });

      const allChips = Array.from(document.querySelectorAll('.sr-evt-chip'));
      const ourChips = allChips.filter((el) => visible(el) && (!eventsPane || eventsPane.contains(el)));
      const chipNameNodeCount = ourChips.reduce(
        (sum, c) => sum + c.querySelectorAll('.sr-evt-chip-name').length,
        0,
      );
      const chipDeltas = ourChips.flatMap((c) =>
        Array.from(c.querySelectorAll('.sr-evt-chip-delta')).map((n) => n.textContent || ''),
      );

      const badWidths = Array.from(new Set(widths)).filter((w) => w !== 18);
      const badPolygons = Array.from(new Set(polygons)).filter((p) => p !== expectedPolygon && p !== null);
      return {
        paneNodeCount,
        badWidths,
        badPolygons,
        chipNameNodeCount,
        chipDeltas,
        triCountTotal: allTris.length,
        ourTriCountTotal: ourTris.length,
      };
    },
    { expectedPolygon: EXPECTED_ARROW_POLYGON, isVisibleFn: isVisible.toString() },
  );
}

interface RunReport {
  riderCount: number;
  timeline: { t: number; triCount: number; chipCount: number; phase: string }[];
  pauseHoldOk: boolean;
  pauseHoldTimeline: { t: number; triCount: number; chipCount: number }[];
  replayTested: boolean;
  replayResetOk: boolean | null;
  replayTimeline: { t: number; triCount: number; chipCount: number }[];
  regressions: Awaited<ReturnType<typeof readRegressionSnapshot>>;
  pageErrors: Error[];
  arrowsEverSeen: boolean;
  chipsEverSeen: boolean;
}

async function runOnce(page: Page, runIdx: number): Promise<RunReport> {
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));

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
      'otherwise this run is not reproducing the real collision condition',
  ).toBe(true);
  console.log(`[run ${runIdx}] site copy request status: ${siteScriptStatus}`);

  // Give the site's own (older) copy time to build its chart/dots first.
  await page.waitForTimeout(3000);

  await injectUserscript(page);

  await expect
    .poll(
      () => page.evaluate(() => !!(window as any).SRSRCNG?.map?.getPane?.('srEvents')),
      { timeout: 15_000, intervals: [500] },
    )
    .toBeTruthy();

  // --- Fix zoom BEFORE playback starts, and never change it mid-sample:
  // LOD/declutter is zoom-dependent, so changing zoom mid-run would
  // legitimately change the visible-marker count independent of latching.
  const fixedZoom = await page.evaluate(() => (window as any).SRSRCNG.map.getZoom());
  console.log(`[run ${runIdx}] sampling at fixed zoom=${fixedZoom}`);

  // --- Start playback via our own #sr-play control.
  const playBtn = page.locator('#sr-play');
  await expect(playBtn).toBeVisible({ timeout: 10_000 });
  await playBtn.click();

  await expect
    .poll(
      async () =>
        page.evaluate(() => document.getElementById('sr-play')?.classList.contains('is-playing')),
      { timeout: 8_000, intervals: [300] },
    )
    .toBeTruthy();

  // === Step 2: Accumulation. Sample distinct arrow/chip counts every
  // ~500ms for ~25s at the fixed zoom above. Assert monotonic non-decrease.
  const timeline: { t: number; triCount: number; chipCount: number; phase: string }[] = [];
  const start = Date.now();
  while (Date.now() - start < SAMPLE_WINDOW_MS) {
    const counts = await readMarkerCounts(page);
    const t = Date.now() - start;
    timeline.push({ t, triCount: counts.triCount, chipCount: counts.chipCount, phase: 'accumulate' });

    // Zoom must not have drifted (defensive check against any inadvertent
    // site/user interaction changing it mid-run).
    const zoomNow = await page.evaluate(() => (window as any).SRSRCNG.map.getZoom());
    expect(zoomNow, `[run ${runIdx}] zoom drifted mid-sample (was fixed at ${fixedZoom})`).toBe(fixedZoom);

    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  console.log(`[run ${runIdx}] === accumulation timeline (arrows vs chips, fixed zoom=${fixedZoom}) ===`);
  for (const row of timeline) {
    console.log(`t=${row.t}ms triCount=${row.triCount} chipCount=${row.chipCount}`);
  }

  const arrowsEverSeen = timeline.some((r) => r.triCount > 0);
  const chipsEverSeen = timeline.some((r) => r.chipCount > 0);

  // --- Step 3: Pause holds. Pause mid-run, sample a few more times, assert
  // counts do not decrease after pausing.
  const wasPlayingBeforePause = await page.evaluate(() =>
    document.getElementById('sr-play')?.classList.contains('is-playing'),
  );
  if (wasPlayingBeforePause) {
    await playBtn.click(); // pause
  }
  await expect
    .poll(
      async () =>
        page.evaluate(() => document.getElementById('sr-play')?.classList.contains('is-playing')),
      { timeout: 5_000, intervals: [200] },
    )
    .toBeFalsy();

  const countsAtPause = await readMarkerCounts(page);
  const pauseHoldTimeline: { t: number; triCount: number; chipCount: number }[] = [
    { t: 0, triCount: countsAtPause.triCount, chipCount: countsAtPause.chipCount },
  ];
  const pauseStart = Date.now();
  while (Date.now() - pauseStart < 4_000) {
    await page.waitForTimeout(500);
    const c = await readMarkerCounts(page);
    pauseHoldTimeline.push({ t: Date.now() - pauseStart, triCount: c.triCount, chipCount: c.chipCount });
  }
  console.log(`[run ${runIdx}] === pause-hold timeline ===`);
  for (const row of pauseHoldTimeline) {
    console.log(`t=${row.t}ms triCount=${row.triCount} chipCount=${row.chipCount}`);
  }
  const pauseHoldOk = pauseHoldTimeline.every(
    (row, i) => i === 0 || (row.triCount >= pauseHoldTimeline[i - 1].triCount && row.chipCount >= pauseHoldTimeline[i - 1].chipCount),
  );

  // --- Step 4 (optional): replay-reset. Drive a rewind by seeking the
  // scrubber-equivalent back near the start (via the userscript's internal
  // seek, if reachable) and confirm the accumulated markers clear then
  // re-accumulate. We attempt this by calling the exposed seek function if
  // present; otherwise we fall back to reloading the page pane, which is
  // guaranteed to reset (fresh map/lap load).
  let replayTested = false;
  let replayResetOk: boolean | null = null;
  const replayTimeline: { t: number; triCount: number; chipCount: number }[] = [];

  const countsBeforeReplay = await readMarkerCounts(page);
  console.log(
    `[run ${runIdx}] counts before replay attempt: triCount=${countsBeforeReplay.triCount} chipCount=${countsBeforeReplay.chipCount}`,
  );

  // Try to find a scrubber/slider element we can drag back near t=0.
  const sliderHandle = page.locator('#mapsliderSlider, #mapslider input[type=range], #mapslider');
  const sliderCount = await sliderHandle.count().catch(() => 0);

  if (sliderCount > 0 && (countsBeforeReplay.triCount > 0 || countsBeforeReplay.chipCount > 0)) {
    try {
      // The site's own scrubber is hidden by the userscript
      // (#track-map-controls), so dragging it is unlikely to be visible/
      // interactable. Attempt anyway; if it fails, we fall back to reload.
      await sliderHandle.first().click({ position: { x: 2, y: 2 }, force: true, timeout: 3000 });
      replayTested = true;
    } catch (e) {
      console.log(`[run ${runIdx}] scrubber not interactable (expected — site controls are hidden): ${(e as Error).message}`);
    }
  }

  if (!replayTested) {
    // Fall back to a full pane reload (guaranteed rewind: fresh map/lap load
    // resets everything per the design). This exercises "map reload" from
    // the acceptance criteria, not literally the scrubber-drag rewind path,
    // so we label it accordingly in the report.
    console.log(`[run ${runIdx}] driving replay-reset via full page reload (fresh map/lap load) instead of scrubber drag`);
    await page.reload();
    await waitForCompareReady(page);
    await page.waitForTimeout(3000);
    await injectUserscript(page);
    await expect
      .poll(
        () => page.evaluate(() => !!(window as any).SRSRCNG?.map?.getPane?.('srEvents')),
        { timeout: 15_000, intervals: [500] },
      )
      .toBeTruthy();

    await page.evaluate((z) => (window as any).SRSRCNG.map.setZoom(z), fixedZoom);

    const countsAfterReload = await readMarkerCounts(page);
    replayTimeline.push({ t: 0, triCount: countsAfterReload.triCount, chipCount: countsAfterReload.chipCount });
    replayTested = true;
    // A reset means the fresh load starts at/near zero accumulated markers
    // (before any new playback), i.e. strictly less than or equal to what
    // had accumulated before, and typically 0 since playback hasn't started.
    replayResetOk = countsAfterReload.triCount <= countsBeforeReplay.triCount &&
      countsAfterReload.chipCount <= countsBeforeReplay.chipCount;

    // Re-accumulate: play again briefly and confirm markers can reappear.
    const playBtn2 = page.locator('#sr-play');
    await expect(playBtn2).toBeVisible({ timeout: 10_000 });
    await playBtn2.click();
    await expect
      .poll(
        async () =>
          page.evaluate(() => document.getElementById('sr-play')?.classList.contains('is-playing')),
        { timeout: 8_000, intervals: [300] },
      )
      .toBeTruthy();

    const reAccStart = Date.now();
    while (Date.now() - reAccStart < 10_000) {
      const c = await readMarkerCounts(page);
      replayTimeline.push({ t: Date.now() - reAccStart + 1, triCount: c.triCount, chipCount: c.chipCount });
      await page.waitForTimeout(500);
    }
    console.log(`[run ${runIdx}] === replay-reset timeline (reload -> re-accumulate) ===`);
    for (const row of replayTimeline) {
      console.log(`t=${row.t}ms triCount=${row.triCount} chipCount=${row.chipCount}`);
    }
    const reAccumulated = replayTimeline.some((r) => r.triCount > 0 || r.chipCount > 0);
    replayResetOk = (replayResetOk ?? true) && reAccumulated;
    console.log(`[run ${runIdx}] replay-reset re-accumulated after reload: ${reAccumulated}`);
  }

  // --- Step 5: Regressions.
  const regressions = await readRegressionSnapshot(page);

  return {
    riderCount,
    timeline,
    pauseHoldOk,
    pauseHoldTimeline,
    replayTested,
    replayResetOk,
    replayTimeline,
    regressions,
    pageErrors,
    arrowsEverSeen,
    chipsEverSeen,
  };
}

test.describe('srEvents overlay latch/accumulate: markers persist once seen, clear only on rewind/reload', () => {
  test('Latch accumulation, pause-hold, replay-reset, 2 runs', async ({ page }, testInfo) => {
    test.setTimeout(600_000);

    const runReports: RunReport[] = [];

    for (let run = 1; run <= 2; run++) {
      console.log(`\n========== RUN ${run} ==========`);
      const report = await runOnce(page, run);
      runReports.push(report);

      // --- Regressions, every run.
      expect(report.regressions.paneNodeCount, `[run ${run}] expected exactly one srEvents Leaflet pane`).toBe(1);
      expect(
        report.pageErrors.map((e) => e.message),
        `[run ${run}] Uncaught page errors:\n${report.pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
      ).toEqual([]);
      expect(
        report.regressions.badWidths,
        `[run ${run}] expected every .sr-evt-tri svg width to be ${EXPECTED_ARROW_SIZE}`,
      ).toEqual([]);
      expect(
        report.regressions.badPolygons,
        `[run ${run}] expected every arrow polygon to be "${EXPECTED_ARROW_POLYGON}"`,
      ).toEqual([]);
      expect(report.regressions.chipNameNodeCount, `[run ${run}] chip must not render a rider name`).toBe(0);
      const badDeltas = report.regressions.chipDeltas.filter((d) => d.trim().length > 0 && !/^\+\d+\s*m$/.test(d.trim()));
      expect(badDeltas, `[run ${run}] every delta must be "+N m"`).toEqual([]);

      // --- Sanity: we actually observed the phenomenon under test.
      expect(report.arrowsEverSeen, `[run ${run}] expected at least one .sr-evt-tri to appear during the sample window`).toBe(true);

      // --- Step 2: monotonic non-decreasing accumulation at fixed zoom.
      const triDrops: string[] = [];
      const chipDrops: string[] = [];
      for (let i = 1; i < report.timeline.length; i++) {
        const prev = report.timeline[i - 1];
        const cur = report.timeline[i];
        if (cur.triCount < prev.triCount) {
          triDrops.push(`t=${prev.t}->${cur.t}: triCount ${prev.triCount} -> ${cur.triCount}`);
        }
        if (cur.chipCount < prev.chipCount) {
          chipDrops.push(`t=${prev.t}->${cur.t}: chipCount ${prev.chipCount} -> ${cur.chipCount}`);
        }
      }
      console.log(`[run ${run}] arrow-count drops during forward playback: ${JSON.stringify(triDrops)}`);
      console.log(`[run ${run}] chip-count drops during forward playback: ${JSON.stringify(chipDrops)}`);
      expect(
        triDrops,
        `[run ${run}] DEFECT: arrow (.sr-evt-tri) distinct marker count dropped during forward playback ` +
          `(latch failed to hold) — timeline:\n${JSON.stringify(report.timeline, null, 2)}`,
      ).toEqual([]);
      expect(
        chipDrops,
        `[run ${run}] DEFECT: chip (.sr-evt-chip) distinct marker count dropped during forward playback ` +
          `(latch failed to hold) — timeline:\n${JSON.stringify(report.timeline, null, 2)}`,
      ).toEqual([]);

      // --- Step 3: pause holds (no decrease after pausing).
      console.log(`[run ${run}] pause-hold ok: ${report.pauseHoldOk}`);
      expect(
        report.pauseHoldOk,
        `[run ${run}] DEFECT: marker counts decreased after pausing playback — pause-hold timeline:\n` +
          JSON.stringify(report.pauseHoldTimeline, null, 2),
      ).toBe(true);

      // --- Step 4: replay-reset (best-effort; reported either way).
      console.log(`[run ${run}] replay-reset tested: ${report.replayTested}, result: ${report.replayResetOk}`);
      if (report.replayTested && report.replayResetOk !== null) {
        expect(
          report.replayResetOk,
          `[run ${run}] expected accumulated markers to clear on reload and re-accumulate on replay — ` +
            `timeline:\n${JSON.stringify(report.replayTimeline, null, 2)}`,
        ).toBe(true);
      }
    }

    await testInfo.attach('latch-live-runs.json', {
      body: JSON.stringify(
        runReports.map((r) => ({
          riderCount: r.riderCount,
          timeline: r.timeline,
          pauseHoldOk: r.pauseHoldOk,
          pauseHoldTimeline: r.pauseHoldTimeline,
          replayTested: r.replayTested,
          replayResetOk: r.replayResetOk,
          replayTimeline: r.replayTimeline,
          regressions: r.regressions,
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });

    console.log('\n=== latch-live: summary across runs ===');
    runReports.forEach((r, idx) => {
      const maxTri = Math.max(...r.timeline.map((t) => t.triCount), 0);
      const maxChip = Math.max(...r.timeline.map((t) => t.chipCount), 0);
      console.log(
        `run ${idx + 1}: maxTriCount=${maxTri}, maxChipCount=${maxChip}, pauseHoldOk=${r.pauseHoldOk}, ` +
          `replayTested=${r.replayTested}, replayResetOk=${r.replayResetOk}`,
      );
    });
  });
});
