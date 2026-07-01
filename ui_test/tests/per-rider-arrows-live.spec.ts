/**
 * Live E2E acceptance test for PER-RIDER braking-onset arrows in
 * userscripts/src/05-map.js:
 *
 *   Each rider's braking-onset arrow (.sr-evt-tri) now appears when THAT
 *   rider reaches its OWN braking onset — visibility is keyed purely off
 *   `onsetVisible(riderDist, onsetDist, hi)` per rider/per-onset (see
 *   onsetEffectivelyVisible / rebuildEventsLayer in 05-map.js). There is
 *   deliberately no zone/grouping concept for arrows: a shared corner must
 *   NOT make both riders' arrows pop in on the same tick just because one of
 *   them arrived there first. (Corner CHIPS are still zone-grouped — out of
 *   scope for this spec.)
 *
 * Run against the REAL site (site's own older copy of this script present,
 * NOT blocked) — same pattern as latch-live.spec.ts / overlay-adjustments-live.spec.ts.
 *
 * Driven by the userscript's OWN #sr-play button (the site's native
 * #track-map-controls is hidden by our script).
 *
 * Run:
 *   cd ui_test && npx playwright test per-rider-arrows-live --project=chromium
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

const RIDER0_COLOR = '#fa554f'; // red
const RIDER1_COLOR = '#71c3ff'; // blue
const EXPECTED_ARROW_SIZE = 18;
const EXPECTED_ARROW_POLYGON = '8,1.2 13.6,12.6 8,9.8 2.4,12.6';

const SAMPLE_INTERVAL_MS = 350;
const SAMPLE_WINDOW_MS = 25_000;
const POS_EPS_DEG = 1e-4; // ~11m at these latitudes; "nearly same position" threshold

const SCREENSHOT_PATH = path.resolve(
  '/private/tmp/claude-501/-Users-serdiuk-git-pet-projects-serious-racing/ff161f6a-c284-429c-a719-6db20882492c/scratchpad',
  'per-rider-arrows-live.png',
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

// One entry per currently-visible arrow marker, scoped to OUR srEvents pane
// (the site's own older copy of this script renders same-classed nodes into
// a different pane — see latch-live.spec.ts's header comment for why the
// scoping matters). Reads: fill colour (which rider), the marker's lat/lng
// (from the Leaflet divIcon's positioned host, via the map's own coordinate
// conversion), width + polygon (regression checks).
async function readArrowSnapshot(page: Page) {
  return page.evaluate(
    ({ isVisibleFn, expectedPolygon }) => {
      // eslint-disable-next-line no-eval
      const visible = eval(`(${isVisibleFn})`) as (el: Element) => boolean;
      const map = (window as any).SRSRCNG?.map;
      const eventsPane = document.querySelector('.leaflet-srEvents-pane');
      const allTris = Array.from(document.querySelectorAll('svg.sr-evt-tri'));
      const ourTris = allTris.filter((el) => visible(el) && (!eventsPane || eventsPane.contains(el)));

      const arrows = ourTris.map((svg) => {
        const polygon = svg.querySelector('polygon');
        const fill = polygon ? polygon.getAttribute('fill') : null;
        const width = parseFloat((svg as SVGElement).getAttribute('width') || '0');
        const points = polygon ? polygon.getAttribute('points') : null;

        // Resolve the marker's lat/lng from the divIcon host's CSS transform
        // (Leaflet positions markers via a translate3d on
        // .leaflet-marker-icon), converted back through the map's own
        // containerPointToLatLng so this works regardless of current
        // pan/zoom.
        const host = (svg.closest('.leaflet-marker-icon') as HTMLElement) || null;
        let lat: number | null = null;
        let lng: number | null = null;
        if (host && map) {
          const rect = host.getBoundingClientRect();
          const mapRect = map.getContainer().getBoundingClientRect();
          const cx = rect.left + rect.width / 2 - mapRect.left;
          const cy = rect.top + rect.height / 2 - mapRect.top;
          const ll = map.containerPointToLatLng([cx, cy]);
          lat = ll.lat;
          lng = ll.lng;
        }

        return { fill, width, points, lat, lng };
      });

      const badWidths = Array.from(new Set(arrows.map((a) => a.width))).filter((w) => w !== 18);
      const badPolygons = Array.from(new Set(arrows.map((a) => a.points))).filter(
        (p) => p !== expectedPolygon && p !== null,
      );

      return { arrows, badWidths, badPolygons, totalOnPage: allTris.length };
    },
    { isVisibleFn: isVisible.toString(), expectedPolygon: EXPECTED_ARROW_POLYGON },
  );
}

async function readRegressionSnapshot(page: Page) {
  return page.evaluate(
    ({ isVisibleFn }) => {
      // eslint-disable-next-line no-eval
      const visible = eval(`(${isVisibleFn})`) as (el: Element) => boolean;
      const eventsPane = document.querySelector('.leaflet-srEvents-pane');
      const paneNodeCount = document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length;

      const allChips = Array.from(document.querySelectorAll('.sr-evt-chip'));
      const ourChips = allChips.filter((el) => visible(el) && (!eventsPane || eventsPane.contains(el)));
      const chipNameNodeCount = ourChips.reduce(
        (sum, c) => sum + c.querySelectorAll('.sr-evt-chip-name').length,
        0,
      );
      const chipDeltas = ourChips.flatMap((c) =>
        Array.from(c.querySelectorAll('.sr-evt-chip-delta')).map((n) => n.textContent || ''),
      );

      return { paneNodeCount, chipNameNodeCount, chipDeltas };
    },
    { isVisibleFn: isVisible.toString() },
  );
}

interface ArrowSample {
  fill: string | null;
  width: number;
  points: string | null;
  lat: number | null;
  lng: number | null;
}

interface TimelineRow {
  t: number;
  triCount: number;
  chipCount: number;
  redCount: number;
  blueCount: number;
  arrows: ArrowSample[];
}

interface RunReport {
  riderCount: number;
  riderColors: (string | null)[];
  timeline: TimelineRow[];
  firstRedT: number | null;
  firstBlueT: number | null;
  perTickSameTime: { t: number; redCount: number; blueCount: number }[];
  regressions: Awaited<ReturnType<typeof readRegressionSnapshot>>;
  pageErrors: Error[];
  badWidthsSeen: number[];
  badPolygonsSeen: (string | null)[];
  strayColorsSeen: string[];
  duplicatePositionEvents: string[];
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

  const riderInfo = await page.evaluate(() => {
    const s = (window as any).SRSRCNG;
    return {
      count: s.riders.length,
      colors: s.riders.map((r: any) => r.color ?? null),
    };
  });
  expect(riderInfo.count).toBe(2);
  console.log(`[run ${runIdx}] rider count=${riderInfo.count} colors=${JSON.stringify(riderInfo.colors)}`);

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

  // === Sample every ~350ms for ~25s. Track per-tick red/blue arrow counts
  // and every arrow's fill + resolved lat/lng.
  const timeline: TimelineRow[] = [];
  const start = Date.now();
  while (Date.now() - start < SAMPLE_WINDOW_MS) {
    const snap = await readArrowSnapshot(page);
    const regressionsNow = await readRegressionSnapshot(page); // cheap poll, chip count only needed for logging
    const t = Date.now() - start;
    const redCount = snap.arrows.filter((a) => a.fill?.toLowerCase() === RIDER0_COLOR).length;
    const blueCount = snap.arrows.filter((a) => a.fill?.toLowerCase() === RIDER1_COLOR).length;
    timeline.push({
      t,
      triCount: snap.arrows.length,
      chipCount: 0, // filled below from regressionsNow if needed; kept 0 to avoid extra eval per tick
      redCount,
      blueCount,
      arrows: snap.arrows,
    });
    void regressionsNow;
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  console.log(`[run ${runIdx}] === per-rider arrow timeline ===`);
  for (const row of timeline) {
    console.log(
      `t=${row.t}ms triCount=${row.triCount} red=${row.redCount} blue=${row.blueCount} fills=${JSON.stringify(
        row.arrows.map((a) => a.fill),
      )}`,
    );
  }

  // First tick where red > 0 / blue > 0.
  const firstRedRow = timeline.find((r) => r.redCount > 0);
  const firstBlueRow = timeline.find((r) => r.blueCount > 0);
  const firstRedT = firstRedRow ? firstRedRow.t : null;
  const firstBlueT = firstBlueRow ? firstBlueRow.t : null;

  // Per-tick "did red and blue appear in the SAME tick" — recorded for every
  // tick where at least one of them is present, so the report shows the full
  // timeline of co-occurrence, not just the first appearance.
  const perTickSameTime = timeline
    .filter((r) => r.redCount > 0 || r.blueCount > 0)
    .map((r) => ({ t: r.t, redCount: r.redCount, blueCount: r.blueCount }));

  // Bad widths / polygons across the whole run (union).
  const badWidthsSeen = new Set<number>();
  const badPolygonsSeen = new Set<string | null>();
  const strayColorsSeen = new Set<string>();
  const duplicatePositionEvents: string[] = [];

  for (const row of timeline) {
    for (const w of row.arrows.map((a) => a.width)) {
      if (w !== EXPECTED_ARROW_SIZE) badWidthsSeen.add(w);
    }
    for (const p of row.arrows.map((a) => a.points)) {
      if (p !== EXPECTED_ARROW_POLYGON) badPolygonsSeen.add(p);
    }
    for (const a of row.arrows) {
      const c = (a.fill || '').toLowerCase();
      if (c && c !== RIDER0_COLOR && c !== RIDER1_COLOR) strayColorsSeen.add(c);
    }
    // Duplicate-position check: any two VISIBLE arrows in the same tick
    // sitting within POS_EPS_DEG of each other (a phantom double-render of
    // the same onset).
    for (let i = 0; i < row.arrows.length; i++) {
      for (let j = i + 1; j < row.arrows.length; j++) {
        const a = row.arrows[i];
        const b = row.arrows[j];
        if (a.lat == null || b.lat == null || a.lng == null || b.lng == null) continue;
        const dLat = Math.abs(a.lat - b.lat);
        const dLng = Math.abs(a.lng - b.lng);
        if (dLat < POS_EPS_DEG && dLng < POS_EPS_DEG) {
          duplicatePositionEvents.push(
            `t=${row.t}ms: arrow[${i}] fill=${a.fill} @ (${a.lat},${a.lng}) ~= arrow[${j}] fill=${b.fill} @ (${b.lat},${b.lng})`,
          );
        }
      }
    }
  }

  const regressions = await readRegressionSnapshot(page);

  return {
    riderCount: riderInfo.count,
    riderColors: riderInfo.colors,
    timeline,
    firstRedT,
    firstBlueT,
    perTickSameTime,
    regressions,
    pageErrors,
    badWidthsSeen: Array.from(badWidthsSeen),
    badPolygonsSeen: Array.from(badPolygonsSeen),
    strayColorsSeen: Array.from(strayColorsSeen),
    duplicatePositionEvents,
  };
}

test.describe('srEvents per-rider braking-onset arrows: red pops with red, blue with blue', () => {
  test('Per-rider arrow appearance, 2 runs', async ({ page }, testInfo) => {
    test.setTimeout(600_000);

    const runReports: RunReport[] = [];

    for (let run = 1; run <= 2; run++) {
      console.log(`\n========== RUN ${run} ==========`);
      const report = await runOnce(page, run);
      runReports.push(report);

      // --- Rider count / colour sanity.
      expect(report.riderCount, `[run ${run}] expected exactly 2 riders`).toBe(2);
      const normalizedColors = report.riderColors.map((c) => (c || '').toLowerCase());
      expect(
        normalizedColors,
        `[run ${run}] expected rider colours [red, blue], got ${JSON.stringify(report.riderColors)}`,
      ).toEqual([RIDER0_COLOR, RIDER1_COLOR]);

      // --- Regressions.
      expect(report.regressions.paneNodeCount, `[run ${run}] expected exactly one srEvents Leaflet pane`).toBe(1);
      expect(
        report.pageErrors.map((e) => e.message),
        `[run ${run}] Uncaught page errors:\n${report.pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
      ).toEqual([]);
      expect(
        report.badWidthsSeen,
        `[run ${run}] expected every .sr-evt-tri svg width to be ${EXPECTED_ARROW_SIZE}`,
      ).toEqual([]);
      expect(
        report.badPolygonsSeen,
        `[run ${run}] expected every arrow polygon to be "${EXPECTED_ARROW_POLYGON}"`,
      ).toEqual([]);
      expect(report.regressions.chipNameNodeCount, `[run ${run}] chip must not render a rider name`).toBe(0);
      const badDeltas = report.regressions.chipDeltas.filter(
        (d) => d.trim().length > 0 && !/^\+\d+\s*m$/.test(d.trim()),
      );
      expect(badDeltas, `[run ${run}] every delta must be "+N m"`).toEqual([]);

      // --- Colour validity: no stray/third colour ever.
      expect(
        report.strayColorsSeen,
        `[run ${run}] DEFECT: arrow(s) rendered with a colour that is neither rider colour: ${JSON.stringify(
          report.strayColorsSeen,
        )}`,
      ).toEqual([]);

      // --- No same-position duplicates (phantom double-render of one onset).
      expect(
        report.duplicatePositionEvents,
        `[run ${run}] DEFECT: two visible arrows shared (nearly) the same position:\n` +
          report.duplicatePositionEvents.join('\n'),
      ).toEqual([]);

      // --- Sanity: we actually observed both colours during the run.
      console.log(`[run ${run}] firstRedT=${report.firstRedT}ms firstBlueT=${report.firstBlueT}ms`);
      expect(report.firstRedT, `[run ${run}] expected at least one RED arrow to appear during the sample window`).not.toBeNull();
      expect(report.firstBlueT, `[run ${run}] expected at least one BLUE arrow to appear during the sample window`).not.toBeNull();

      // --- KEY assertion: per-rider, not grouped. At least one tick must
      // show red and blue NOT co-occurring for the first time simultaneously
      // — i.e. the first-red tick and first-blue tick differ, OR (more
      // generally, in case both happen to start together at t=0 due to a
      // shared very-early corner) there exists some tick where exactly one
      // colour is present and not the other, proving independent timing.
      console.log(`[run ${run}] per-tick red/blue co-occurrence: ${JSON.stringify(report.perTickSameTime)}`);
      const differentFirstAppearance = report.firstRedT !== report.firstBlueT;
      const someTickOnlyOneColour = report.perTickSameTime.some(
        (r) => (r.redCount > 0) !== (r.blueCount > 0),
      );
      expect(
        differentFirstAppearance || someTickOnlyOneColour,
        `[run ${run}] DEFECT: red and blue arrows appear to be GROUPED (always co-occurring on the same tick), ` +
          `not per-rider. firstRedT=${report.firstRedT} firstBlueT=${report.firstBlueT}. ` +
          `Co-occurrence timeline:\n${JSON.stringify(report.perTickSameTime, null, 2)}`,
      ).toBe(true);
    }

    await testInfo.attach('per-rider-arrows-live-runs.json', {
      body: JSON.stringify(
        runReports.map((r) => ({
          riderCount: r.riderCount,
          riderColors: r.riderColors,
          firstRedT: r.firstRedT,
          firstBlueT: r.firstBlueT,
          perTickSameTime: r.perTickSameTime,
          badWidthsSeen: r.badWidthsSeen,
          badPolygonsSeen: r.badPolygonsSeen,
          strayColorsSeen: r.strayColorsSeen,
          duplicatePositionEvents: r.duplicatePositionEvents,
          regressions: r.regressions,
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });

    // --- Screenshot: try to catch a moment with both a red and blue arrow
    // visible, zooming toward the last-seen blue arrow (or red, if no blue)
    // for a clear shot.
    const lastRun = runReports[runReports.length - 1];
    const bothVisibleRow = [...lastRun.timeline]
      .reverse()
      .find((r) => r.redCount > 0 && r.blueCount > 0);
    const anyArrowRow = bothVisibleRow || [...lastRun.timeline].reverse().find((r) => r.triCount > 0);

    if (anyArrowRow) {
      const target = anyArrowRow.arrows.find((a) => a.lat != null && a.lng != null);
      if (target && target.lat != null && target.lng != null) {
        await page.evaluate(
          ({ lat, lng }) => {
            (window as any).SRSRCNG.map.setView([lat, lng], 17);
          },
          { lat: target.lat, lng: target.lng },
        );
        await page.waitForTimeout(600);
      }
    }
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH });
    console.log(`\nScreenshot saved to ${SCREENSHOT_PATH} (bothVisible=${!!bothVisibleRow})`);

    console.log('\n=== per-rider-arrows-live: summary across runs ===');
    runReports.forEach((r, idx) => {
      console.log(
        `run ${idx + 1}: firstRedT=${r.firstRedT} firstBlueT=${r.firstBlueT} ` +
          `strayColors=${JSON.stringify(r.strayColorsSeen)} duplicatePositions=${r.duplicatePositionEvents.length}`,
      );
    });
  });
});
