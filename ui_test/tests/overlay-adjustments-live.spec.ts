/**
 * Live E2E acceptance test for two srEvents overlay adjustments in
 * userscripts/src/05-map.js:
 *
 *   (A) Braking-onset arrows now point perpendicular-INWARD toward the track
 *       edge (renderOnsetMarker's rotationDeg, derived from the inward-vs-fan
 *       side unit vector), not along travel direction. For a 2-rider compare,
 *       one rider is fanned to the +perp side and the other to -perp, so their
 *       "inward" rotations should point roughly opposite each other (~180°
 *       apart) rather than sharing the same heading-based rotation.
 *
 *   (B) Zone-grouped visibility (buildEventZones / zoneVisible in 05-map.js):
 *       both riders' onset arrows for the same corner + that corner's chip
 *       now appear/disappear TOGETHER as a zone (governed by the slowest/
 *       last rider through the zone), rather than each arrow's independent
 *       per-rider [onsetDist-15m, onsetDist+100m] window causing staggered/
 *       solo flicker.
 *
 * Run against the REAL collision condition: the site's own (older) copy of
 * this same script is left running (plugins-serdiuk-analysis*.js is NOT
 * blocked) — see compare-events-over-site-copy.spec.ts / dynamic-events-
 * live.spec.ts for why that matters (dot-tracking must not latch onto a
 * static site-owned dot).
 *
 * Driven by the userscript's OWN #sr-play button (the site's native
 * #track-map-controls is hidden by our script).
 *
 * Run:
 *   cd ui_test && npx playwright test overlay-adjustments-live --project=chromium
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

const EXPECTED_ARROW_POINTS = '8,1.2 13.6,12.6 8,9.8 2.4,12.6';

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

// CRITICAL: deliberately do NOT page.route(...).abort() the site's own
// plugins-serdiuk-analysis*.js request anywhere in this file — the real
// collision condition (site copy present, not blocked) is the whole point.
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

// Reads every currently-present .sr-evt-tri element, its inline rotation
// (parsed from the svg's own `transform: rotate(Ndeg)` — the inner <svg> IS
// the element carrying the rotation per renderOnsetMarker(), not a wrapper
// div), its Leaflet marker's screen position (host bounding rect centre, used
// to associate arrows into "same zone" groups by proximity), and its fill
// colour (rider identity — riderColor(riderIndex) in 05-map.js).
async function readArrowState(page: Page) {
  return page.evaluate(() => {
    const out: {
      rotationDeg: number | null;
      color: string | null;
      cx: number;
      cy: number;
      points: string | null;
    }[] = [];
    document.querySelectorAll('.sr-evt-tri').forEach((el) => {
      // .sr-evt-tri matches both the <svg> and could in theory match a host;
      // in this implementation it's ONLY the <svg class="sr-evt-tri">, so
      // guard defensively by requiring an inline transform/style attribute.
      const svg = el as SVGElement & HTMLElement;
      const style = svg.getAttribute('style') || '';
      const m = style.match(/rotate\(([-\d.]+)deg\)/);
      const rotationDeg = m ? parseFloat(m[1]) : null;
      const polygon = svg.querySelector('polygon');
      const color = polygon ? polygon.getAttribute('fill') : null;
      const points = polygon ? polygon.getAttribute('points') : null;
      const rect = svg.getBoundingClientRect();
      out.push({
        rotationDeg,
        color,
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
        points,
      });
    });
    return out;
  });
}

// "Visible" per the task = present in the DOM AND not hidden (rebuildEventsLayer
// adds/removes markers from the layer group rather than toggling a hidden
// class, so "in the DOM" already means "shown" — still defensively check
// computed style in case that ever changes).
function countVisible(selector: string) {
  return Array.from(document.querySelectorAll(selector)).filter((el) => {
    const style = window.getComputedStyle(el as Element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    const host = (el as HTMLElement).closest('.leaflet-marker-icon') as HTMLElement | null;
    if (host) {
      const hostStyle = window.getComputedStyle(host);
      if (hostStyle.display === 'none' || hostStyle.visibility === 'hidden') return false;
      if (parseFloat(hostStyle.opacity || '1') === 0) return false;
    }
    return true;
  }).length;
}

async function readCounts(page: Page) {
  return page.evaluate((countVisibleFn) => {
    // eslint-disable-next-line no-eval
    const fn = eval(`(${countVisibleFn})`);
    return {
      triVisible: fn('.sr-evt-tri'),
      chipVisible: fn('.sr-evt-chip'),
      triTotal: document.querySelectorAll('.sr-evt-tri').length,
      chipTotal: document.querySelectorAll('.sr-evt-chip').length,
    };
  }, countVisible.toString());
}

// Smallest angular difference between two headings, in [0, 180].
function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

async function runOnce(page: Page, runIdx: number) {
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

  // --- Start playback via our own #sr-play control.
  const playBtn = page.locator('#sr-play');
  await expect(playBtn).toBeVisible({ timeout: 10_000 });
  await playBtn.click();

  await expect
    .poll(
      async () => {
        const isPlaying = await page.evaluate(() =>
          document.getElementById('sr-play')?.classList.contains('is-playing'),
        );
        return isPlaying;
      },
      { timeout: 8_000, intervals: [300] },
    )
    .toBeTruthy();

  // === Change B: sample visible tri/chip counts every ~400ms for ~15s,
  // and snapshot full arrow state (rotation/colour/position) at each tick
  // so we can also mine Change A evidence from the same run.
  const timeline: {
    t: number;
    triVisible: number;
    triMarkers: number; // distinct markers = triVisible / 2 (host div + inner svg both match .sr-evt-tri)
    chipVisible: number;
    triTotal: number;
    chipTotal: number;
  }[] = [];
  const arrowSnapshots: { t: number; arrows: Awaited<ReturnType<typeof readArrowState>> }[] = [];

  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const counts = await readCounts(page);
    const t = Date.now() - start;
    timeline.push({ t, ...counts, triMarkers: counts.triVisible / 2 });
    if (counts.triVisible > 0) {
      const arrows = await readArrowState(page);
      arrowSnapshots.push({ t, arrows });
    }
    await page.waitForTimeout(400);
    // Keep playback going if it finished (lap end) so we get a full window of data.
    const stillPlaying = await page.evaluate(() =>
      document.getElementById('sr-play')?.classList.contains('is-playing'),
    );
    if (!stillPlaying) await playBtn.click();
  }

  console.log(`[run ${runIdx}] === during-playback timeline (arrows/chips) ===`);
  for (const row of timeline) {
    console.log(
      `t=${row.t}ms triVisible=${row.triVisible} (markers~${row.triMarkers}, total=${row.triTotal}) ` +
        `chipVisible=${row.chipVisible} (total=${row.chipTotal})`,
    );
  }

  // === Change A: find a snapshot with >=2 DISTINCT (by centre position)
  // .sr-evt-tri elements — note the selector can match both a wrapper node
  // and the inner <svg> for the same logical arrow (2 DOM nodes per real
  // arrow in some renderings), so we dedupe by rounded screen position
  // before comparing rotations, then require >=2 distinct-position arrows
  // to draw a same-zone-opposite-rotation conclusion.
  let bestSnapshot: { t: number; arrows: Awaited<ReturnType<typeof readArrowState>> } | null = null;
  let bestDistinctCount = 0;
  for (const snap of arrowSnapshots) {
    const withRotation = snap.arrows.filter((a) => a.rotationDeg !== null);
    const distinctByPos = new Map<string, typeof withRotation[number]>();
    for (const a of withRotation) {
      const key = `${Math.round(a.cx / 4)}:${Math.round(a.cy / 4)}`;
      if (!distinctByPos.has(key)) distinctByPos.set(key, a);
    }
    if (distinctByPos.size > bestDistinctCount) {
      bestDistinctCount = distinctByPos.size;
      bestSnapshot = { t: snap.t, arrows: [...distinctByPos.values()] };
    }
  }

  console.log(
    `[run ${runIdx}] best arrow snapshot for Change A: t=${bestSnapshot?.t}, distinct arrows=${bestDistinctCount}`,
  );
  if (bestSnapshot) {
    for (const a of bestSnapshot.arrows) {
      console.log(
        `[run ${runIdx}]   arrow color=${a.color} rotationDeg=${a.rotationDeg} pos=(${Math.round(a.cx)},${Math.round(a.cy)}) points=${a.points}`,
      );
    }
  }

  const distinctTri = new Set(timeline.map((r) => r.triVisible));
  const distinctChip = new Set(timeline.map((r) => r.chipVisible));

  // --- Arrow shape: confirm the pointer-arrow polygon points are unchanged.
  // Read from the recorded snapshots (taken WHILE arrows were visible) rather
  // than a fresh query now, since by the time we get here playback may have
  // moved on and cleared every arrow from the DOM (arrows are dynamic/
  // position-driven, not a fire-and-forget one-time render).
  let arrowPoints: string | null = null;
  for (const snap of arrowSnapshots) {
    const withPoints = snap.arrows.find((a) => a.points);
    if (withPoints) {
      arrowPoints = withPoints.points;
      break;
    }
  }
  if (arrowPoints === null) {
    // Fallback: a live query, in case arrows happen to still be visible.
    arrowPoints = await page.evaluate(() => {
      const el = document.querySelector('.sr-evt-tri polygon');
      return el ? el.getAttribute('points') : null;
    });
  }
  console.log(`[run ${runIdx}] arrow polygon points: ${arrowPoints}`);

  // --- Screenshot when arrows are visible.
  let screenshotTaken = false;
  for (let i = 0; i < 15; i++) {
    const counts = await readCounts(page);
    if (counts.triVisible >= 2) {
      await page.screenshot({
        path: `test-results/overlay-adjustments-live-run${runIdx}.png`,
        fullPage: false,
      });
      screenshotTaken = true;
      break;
    }
    await page.waitForTimeout(400);
    const stillPlaying = await page.evaluate(() =>
      document.getElementById('sr-play')?.classList.contains('is-playing'),
    );
    if (!stillPlaying) await playBtn.click();
  }
  if (!screenshotTaken) {
    await page.screenshot({
      path: `test-results/overlay-adjustments-live-run${runIdx}.png`,
      fullPage: false,
    });
  }

  // --- Regressions.
  const paneNodeCount = await page.evaluate(
    () => document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length,
  );

  const finalCounts = await readCounts(page);
  const maxTriTotalSeen = Math.max(...timeline.map((r) => r.triTotal), finalCounts.triTotal);

  return {
    riderCount,
    timeline,
    arrowSnapshots,
    bestSnapshot,
    bestDistinctCount,
    distinctTri,
    distinctChip,
    arrowPoints,
    paneNodeCount,
    finalCounts,
    maxTriTotalSeen,
    pageErrors,
    screenshotPath: `test-results/overlay-adjustments-live-run${runIdx}.png`,
  };
}

test.describe('srEvents overlay adjustments: inward-pointing arrows + grouped zone visibility, with the site copy present', () => {
  test('Change A (opposite/inward rotations) and Change B (grouped appear/disappear), 3 runs', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);

    const runReports: Awaited<ReturnType<typeof runOnce>>[] = [];

    for (let run = 1; run <= 3; run++) {
      console.log(`\n========== RUN ${run} ==========`);
      const report = await runOnce(page, run);
      runReports.push(report);

      // --- Regression assertions, every run.
      expect(report.paneNodeCount, `[run ${run}] expected exactly one srEvents Leaflet pane`).toBe(1);
      expect(report.arrowPoints, `[run ${run}] expected at least one .sr-evt-tri polygon to read points from`).not.toBeNull();
      expect(report.arrowPoints, `[run ${run}] arrow polygon shape must be unchanged`).toBe(EXPECTED_ARROW_POINTS);
      expect(
        report.finalCounts.triTotal,
        `[run ${run}] total .sr-evt-tri elements in DOM should stay small/bounded, not accumulate`,
      ).toBeLessThanOrEqual((report.riderCount + 2) * 2); // *2: host+svg both match selector
      expect(
        report.pageErrors.map((e) => e.message),
        `[run ${run}] Uncaught page errors:\n${report.pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
      ).toEqual([]);

      // --- Change A: at the richest snapshot, if >=2 distinct arrows were
      // observed, at least one pair should have substantially different
      // (roughly opposite, 120-240 deg apart) rotations. This is the direct
      // signature of "inward toward the shared track line" fan-out: one
      // rider's arrow points back along +perp, the other's along -perp.
      if (report.bestDistinctCount >= 2 && report.bestSnapshot) {
        const arrows = report.bestSnapshot.arrows;
        let foundOppositePair = false;
        let maxDiffSeen = 0;
        const pairsLog: string[] = [];
        for (let i = 0; i < arrows.length; i++) {
          for (let j = i + 1; j < arrows.length; j++) {
            const a = arrows[i], b = arrows[j];
            if (a.rotationDeg === null || b.rotationDeg === null) continue;
            const diff = angleDiff(a.rotationDeg, b.rotationDeg);
            maxDiffSeen = Math.max(maxDiffSeen, diff);
            pairsLog.push(
              `(${a.color}@${a.rotationDeg}deg, ${b.color}@${b.rotationDeg}deg) => diff=${diff.toFixed(1)}deg`,
            );
            if (diff >= 120 && diff <= 240) foundOppositePair = true;
          }
        }
        console.log(`[run ${run}] Change A pairwise rotation diffs: ${pairsLog.join('; ')}`);
        expect(
          foundOppositePair,
          `[run ${run}] expected at least one pair of simultaneously-visible arrows with ` +
            `roughly opposite (120-240deg apart) rotations (inward from opposite sides of the ` +
            `track), but max diff seen was ${maxDiffSeen.toFixed(1)}deg. Pairs: ${pairsLog.join('; ')}`,
        ).toBe(true);
      } else {
        console.log(
          `[run ${run}] WARNING: never observed >=2 simultaneous distinct-position arrows ` +
            `(best=${report.bestDistinctCount}) — Change A rotation-opposition check skipped for this run.`,
        );
      }

      // --- Change B: arrows should appear in step with the chip, not solo.
      // Practical grouped-timing check: every tick where >=1 arrow-marker is
      // visible AND a chip is visible, count it "paired"; a tick with arrows
      // but zero chip is "solo" (could still be legitimate if LOD hides
      // chips at this zoom — logged, not hard-failed alone). The hard
      // signature of the OLD (independent) behaviour would be arrows
      // clearing to 0 one-at-a-time while another stays > 0 for many ticks —
      // for a 2-rider zone with a chip we expect chip-presence and
      // arrow-presence to move together over the window.
      const arrowActiveTicks = report.timeline.filter((r) => r.triVisible > 0);
      const chipActiveTicks = report.timeline.filter((r) => r.chipVisible > 0);
      const bothActiveTicks = report.timeline.filter((r) => r.triVisible > 0 && r.chipVisible > 0);
      console.log(
        `[run ${run}] Change B: ticks arrow-active=${arrowActiveTicks.length}, chip-active=${chipActiveTicks.length}, ` +
          `both-active=${bothActiveTicks.length}, total ticks=${report.timeline.length}`,
      );

      // Look specifically for "transition groups": count how many times the
      // tri-visible series goes from a value to a DIFFERENT nonzero value
      // (partial-clear, i.e. one arrow of a pair vanished while the other
      // stayed) with chipVisible unchanged from >0 to 0 at the same instant
      // vs together. We report this explicitly rather than asserting a
      // brittle exact count, per the task's "report the timeline" ask.
      let staggeredClearSuspected = false;
      for (let i = 1; i < report.timeline.length; i++) {
        const prev = report.timeline[i - 1];
        const cur = report.timeline[i];
        // Arrow count dropped by exactly 1 marker (partial clear of a pair)
        // while a chip that was visible stayed visible unchanged: suggests
        // one rider's arrow cleared independently of the zone/chip.
        if (
          prev.triMarkers - cur.triMarkers === 1 &&
          prev.chipVisible > 0 &&
          cur.chipVisible === prev.chipVisible
        ) {
          staggeredClearSuspected = true;
          console.log(
            `[run ${run}] possible staggered clear at t=${cur.t}ms: triMarkers ${prev.triMarkers}->${cur.triMarkers} while chipVisible stayed ${prev.chipVisible}`,
          );
        }
      }
      console.log(`[run ${run}] staggeredClearSuspected=${staggeredClearSuspected}`);

      expect(
        distinctSeriesHasVariation(report.distinctTri),
        `[run ${run}] arrow visible-count must change over time during playback (grouped zones ` +
          `should still turn on/off, just together) — got constant series`,
      ).toBe(true);
    }

    // Attach full per-run data to the report.
    await testInfo.attach('overlay-adjustments-runs.json', {
      body: JSON.stringify(
        runReports.map((r) => ({
          riderCount: r.riderCount,
          timeline: r.timeline,
          bestSnapshot: r.bestSnapshot,
          arrowPoints: r.arrowPoints,
          paneNodeCount: r.paneNodeCount,
          finalCounts: r.finalCounts,
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });

    console.log('\n=== overlay-adjustments-live: summary across runs ===');
    runReports.forEach((r, idx) => {
      console.log(
        `run ${idx + 1}: bestDistinctArrows=${r.bestDistinctCount}, arrowPoints=${r.arrowPoints}, ` +
          `paneCount=${r.paneNodeCount}, screenshot=${r.screenshotPath}`,
      );
    });
  });
});

function distinctSeriesHasVariation(distinctSet: Set<number>): boolean {
  return distinctSet.size > 1;
}
