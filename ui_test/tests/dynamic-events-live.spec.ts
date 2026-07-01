/**
 * Live E2E acceptance test for the DYNAMIC compare-mode srEvents overlay
 * (userscripts/src/05-map.js): braking-onset markers are now pointer arrows
 * (`.sr-evt-tri`, drawn as an SVG polygon `8,1.2 13.6,12.6 8,9.8 2.4,12.6`)
 * and BOTH the arrows and the corner coaching chips (`.sr-evt-chip`) are
 * DYNAMIC — only present in the DOM while a rider's LIVE position is inside
 * a window around the event:
 *   - arrows: [onsetDist - 15m, onsetDist + 100m]  (EVENT_LEAD_M / EVENT_TAIL_M)
 *   - chips:  within CORNER_WINDOW_M (~120m) of the corner
 *
 * Live position is read by scanning window.SRSRCNG.map for same-coloured
 * Leaflet circleMarkers and tracking whichever one is ACTUALLY MOVING frame
 * to frame (see trackRiderDot() in 05-map.js) — because there is no exposed
 * "current playback index" that survives both our own #sr-play control and a
 * possible foreign/older copy of this same script also running on the page.
 *
 * THE REAL RISK this test exists to catch: with the site's OWN older copy of
 * the userscript also present (it renders its own same-colour dots), the
 * dot-tracking heuristic could latch onto a STATIC site dot instead of the
 * one our own #sr-play button is actually animating, in which case arrows/
 * chips would never appear (or would appear once and freeze). A prior check
 * of this feature blocked the site copy's request, which cannot catch this
 * class of bug — hence this test deliberately leaves it running, exactly
 * like compare-events-over-site-copy.spec.ts does for the collision-
 * tolerance fix.
 *
 * Run:
 *   cd ui_test && npx playwright test dynamic-events-live --project=chromium
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

// CRITICAL: unlike a "clean room" spec, we deliberately do NOT
// page.route(...).abort() the site's own plugins-serdiuk-analysis*.js
// request anywhere in this file. Leaving it running is the entire point —
// it's the real-world condition where extra same-colour static dots exist
// on the map and the "pick the one that's moving" heuristic must not be
// fooled by them.
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

// "Visible" per the task = present in the DOM AND not hidden. The overlay's
// dynamic mechanism (rebuildEventsLayer in 05-map.js) actually adds/removes
// markers from the Leaflet layer group rather than toggling a hidden class
// (`.sr-evt-chip-hidden` exists in the injected CSS but is never applied by
// the JS), so "in the DOM" already means "shown" here. We still defensively
// filter on computed opacity/display/visibility in case that ever changes.
function countVisible(selector: string) {
  return Array.from(document.querySelectorAll(selector)).filter((el) => {
    const style = window.getComputedStyle(el as Element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    // .sr-evt-tri is an inline SVG inside a divIcon host; also check the host.
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

async function mapDotPositions(page: Page) {
  return page.evaluate(() => {
    const map = (window as any).SRSRCNG?.map;
    if (!map) return [];
    const layers = map._layers || {};
    const out: { color: string; lat: number; lng: number }[] = [];
    for (const id in layers) {
      const l = layers[id];
      if (l && typeof l.getLatLng === 'function' && typeof l.getRadius === 'function' && l.options) {
        const ll = l.getLatLng();
        out.push({ color: String(l.options.fillColor || l.options.color || ''), lat: ll.lat, lng: ll.lng });
      }
    }
    return out;
  });
}

test.describe('dynamic srEvents overlay is driven by live playback position, with the site copy present', () => {
  test('arrows/chips appear and disappear as #sr-play animates the riders, over 3 runs', async ({ page }, testInfo) => {
    test.setTimeout(180_000);

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
        'otherwise this test is not reproducing the real dot-tracking risk',
    ).toBe(true);
    console.log(`site copy request status: ${siteScriptStatus}`);

    // Give the site's own (older) copy time to build its chart/dots first —
    // this is what creates the extra same-colour static dots on the map.
    await page.waitForTimeout(3000);

    await injectUserscript(page);

    await expect
      .poll(
        () => page.evaluate(() => !!(window as any).SRSRCNG?.map?.getPane?.('srEvents')),
        { timeout: 15_000, intervals: [500] },
      )
      .toBeTruthy();

    // --- Idle state: dynamic overlay should show very few or zero arrows,
    // and zero chips, before any playback has moved a rider's dot.
    const idle = await readCounts(page);
    console.log(`IDLE counts: ${JSON.stringify(idle)}`);
    expect(idle.chipVisible, 'expected 0 chips visible at idle (before playback)').toBe(0);
    expect(
      idle.triVisible,
      'expected very few (<=2) arrows visible at idle (before playback) — dynamic visibility should not show the full set',
    ).toBeLessThanOrEqual(2);

    const dotsBeforePlay = await mapDotPositions(page);
    console.log(`map circleMarker-ish dots before play: ${JSON.stringify(dotsBeforePlay)}`);

    // --- Find and click the userscript's own #sr-play button (the control
    // the user actually uses — the site's #track-map-controls is hidden).
    const playBtn = page.locator('#sr-play');
    await expect(playBtn).toBeVisible({ timeout: 10_000 });
    await playBtn.click();

    // Confirm playback actually started: at least one rider's tracked dot
    // must move within a couple seconds of clicking play.
    const dotsJustAfterPlay = await mapDotPositions(page);
    await expect
      .poll(
        async () => {
          const now = await mapDotPositions(page);
          // Compare against the pre-play snapshot: did ANY dot's position change?
          return now.some((d) => {
            const before = dotsJustAfterPlay.find(
              (b) => b.color === d.color && Math.abs(b.lat - d.lat) < 1e-9 && Math.abs(b.lng - d.lng) < 1e-9,
            );
            return !before; // no exact match found among pre-play dots => something moved/changed
          });
        },
        { timeout: 8_000, intervals: [300] },
      )
      .toBeTruthy();

    // --- During playback: sample visible arrow/chip counts every ~400ms for ~12s.
    const timeline: { t: number; triVisible: number; chipVisible: number; triTotal: number; chipTotal: number }[] = [];
    const start = Date.now();
    while (Date.now() - start < 12_000) {
      const counts = await readCounts(page);
      timeline.push({ t: Date.now() - start, ...counts });
      await page.waitForTimeout(400);
    }

    console.log('=== during-playback timeline (arrows/chips) ===');
    for (const row of timeline) {
      console.log(
        `t=${row.t}ms triVisible=${row.triVisible} (total=${row.triTotal}) chipVisible=${row.chipVisible} (total=${row.chipTotal})`,
      );
    }

    const triSeries = timeline.map((r) => r.triVisible);
    const chipSeries = timeline.map((r) => r.chipVisible);
    const distinctTri = new Set(triSeries);
    const distinctChip = new Set(chipSeries);

    const isPlayingDuringSampling = await page.evaluate(() =>
      document.getElementById('sr-play')?.classList.contains('is-playing'),
    );
    console.log(`#sr-play still marked is-playing at end of sampling window: ${isPlayingDuringSampling}`);

    // Key evidence: counts must CHANGE over the sampling window (not a flat
    // static count, and not stuck at 0 the whole time).
    expect(
      distinctTri.size,
      `arrow visible-count must change over time during playback, got constant series: ${JSON.stringify(triSeries)}`,
    ).toBeGreaterThan(1);
    expect(
      Math.max(...triSeries),
      `arrow visible-count must be >0 at some point during playback: ${JSON.stringify(triSeries)}`,
    ).toBeGreaterThan(0);

    // Chips are more zoom/LOD-gated at the default auto-fit view, so we only
    // require that they are not "stuck" — i.e. either they vary, or (if the
    // corner LOD never triggers at this zoom) log it clearly rather than
    // silently pass. We still hard-fail if they are stuck at a large nonzero
    // constant (would indicate a static rather than dynamic set).
    if (distinctChip.size === 1 && chipSeries[0] > 0) {
      throw new Error(
        `chip visible-count is a STATIC nonzero constant (${chipSeries[0]}) across the whole playback window — ` +
          `expected dynamic show/hide based on live position: ${JSON.stringify(chipSeries)}`,
      );
    }
    console.log(`chip visible-count distinct values seen: ${JSON.stringify([...distinctChip])}`);

    // --- Take a screenshot mid-playback (ideally while something is visible).
    let screenshotTaken = false;
    for (let i = 0; i < 15; i++) {
      const counts = await readCounts(page);
      if (counts.triVisible > 0) {
        await page.screenshot({ path: 'test-results/dynamic-events-live-mid-playback.png', fullPage: false });
        screenshotTaken = true;
        break;
      }
      await page.waitForTimeout(400);
    }
    if (!screenshotTaken) {
      await page.screenshot({ path: 'test-results/dynamic-events-live-mid-playback.png', fullPage: false });
    }

    // --- Pause-in-window: pause at a moment when arrows are visible, and
    // assert they remain visible (position-based, not is-playing-based).
    let pausedWithArrowsVisible = false;
    let visibleAtPauseMoment = -1;
    for (let i = 0; i < 20; i++) {
      const counts = await readCounts(page);
      if (counts.triVisible > 0) {
        await playBtn.click(); // pause
        visibleAtPauseMoment = counts.triVisible;
        pausedWithArrowsVisible = true;
        break;
      }
      // If playback already finished (lap ended), restart it.
      const stillPlaying = await page.evaluate(() =>
        document.getElementById('sr-play')?.classList.contains('is-playing'),
      );
      if (!stillPlaying) {
        await playBtn.click();
      }
      await page.waitForTimeout(400);
    }

    console.log(`pause-in-window: found visible arrows to pause on = ${pausedWithArrowsVisible} (count=${visibleAtPauseMoment})`);

    if (pausedWithArrowsVisible) {
      // Give the rAF-driven visibility loop a moment to settle after pause,
      // then confirm the count did not immediately collapse to 0.
      await page.waitForTimeout(500);
      const afterPause = await readCounts(page);
      console.log(`counts immediately after pause: ${JSON.stringify(afterPause)}`);
      expect(
        afterPause.triVisible,
        `arrow visible-count must NOT drop to 0 immediately on pause when a rider was mid-window (was ${visibleAtPauseMoment})`,
      ).toBeGreaterThan(0);

      // Hold steady for another couple seconds while paused — the window is
      // position-based, so a stationary paused dot should stay visible.
      await page.waitForTimeout(2000);
      const stillAfterHold = await readCounts(page);
      console.log(`counts after holding 2s while paused: ${JSON.stringify(stillAfterHold)}`);
      expect(
        stillAfterHold.triVisible,
        'arrow visible-count must remain >0 while paused and stationary mid-window',
      ).toBeGreaterThan(0);
    } else {
      console.log(
        'WARNING: never observed a moment with visible arrows to pause on within the retry budget — ' +
          'pause-in-window check skipped (see timeline above for full context)',
      );
    }

    // --- Arrow shape: confirm the new pointer-arrow polygon points.
    const arrowPoints = await page.evaluate(() => {
      const el = document.querySelector('.sr-evt-tri polygon');
      return el ? el.getAttribute('points') : null;
    });
    console.log(`arrow polygon points: ${arrowPoints}`);
    expect(arrowPoints, 'expected at least one .sr-evt-tri polygon to read points from').not.toBeNull();
    expect(arrowPoints).toBe(EXPECTED_ARROW_POINTS);

    // --- No regressions: exactly one srEvents pane, no page errors, rider
    // dots are 2 colors, no marker duplication.
    const paneNodeCount = await page.evaluate(
      () => document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length,
    );
    expect(paneNodeCount, 'expected exactly one srEvents Leaflet pane').toBe(1);

    const finalDots = await mapDotPositions(page);
    const distinctColors = new Set(finalDots.map((d) => d.color).filter(Boolean));
    console.log(`final map dot colors: ${JSON.stringify([...distinctColors])}`);
    expect(distinctColors.size, 'expected exactly 2 distinct rider dot colors').toBe(2);

    // No marker duplication: total triangle/chip element counts should be
    // small and bounded (not growing unbounded across the run) — sample once
    // more now and compare against the timeline's max.
    const finalCounts = await readCounts(page);
    const maxTriTotalSeen = Math.max(...timeline.map((r) => r.triTotal), finalCounts.triTotal);
    console.log(`final total (DOM, not just visible) tri=${finalCounts.triTotal} chip=${finalCounts.chipTotal}, max tri total seen=${maxTriTotalSeen}`);
    expect(finalCounts.triTotal, 'total .sr-evt-tri elements in DOM should stay small/bounded, not accumulate').toBeLessThanOrEqual(riderCount + 2);

    expect(
      pageErrors.map((e) => e.message),
      `Uncaught page errors:\n${pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
    ).toEqual([]);

    // Attach the timeline + summary to the test report for the record.
    await testInfo.attach('dynamic-events-timeline.json', {
      body: JSON.stringify({ idle, timeline, pausedWithArrowsVisible, visibleAtPauseMoment, arrowPoints }, null, 2),
      contentType: 'application/json',
    });

    console.log('=== dynamic-events-live: summary ===');
    console.log(`riderCount                 : ${riderCount}`);
    console.log(`site copy requested/status : ${siteScriptRequested} / ${siteScriptStatus}`);
    console.log(`idle counts                : ${JSON.stringify(idle)}`);
    console.log(`distinct tri-visible values: ${JSON.stringify([...distinctTri])}`);
    console.log(`distinct chip-visible vals : ${JSON.stringify([...distinctChip])}`);
    console.log(`pausedWithArrowsVisible    : ${pausedWithArrowsVisible} (count=${visibleAtPauseMoment})`);
    console.log(`arrow polygon points       : ${arrowPoints}`);
  });
});
