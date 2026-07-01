/**
 * Live E2E acceptance test for the srEvents overlay LOOK adjustments in
 * userscripts/src/05-map.js:
 *
 *   (1) Braking-onset arrows are bigger: SVG width/height = 18 (was 14).
 *   (2) The corner chip has NO rider name (colour dot + speed + delta only),
 *       is smaller (max-width 128, max-height 80), and the delta is now
 *       "+N m" (a prior "-N m" sign bug is fixed) — see renderCornerMarker()
 *       and the `.sr-evt-chip-delta` CSS in ensureEventStyles().
 *   (3) The chip now appears at the corner APEX (slowest point), later than
 *       the braking arrows (which fire at the brake point), and persists
 *       until the slowest rider passes — see chipVisible()/CHIP_LEAD_M/
 *       CHIP_TAIL_M vs zoneVisible()/EVENT_LEAD_M/EVENT_TAIL_M in 05-map.js.
 *
 * Run against the REAL collision condition: the site's own (older) copy of
 * this same script is left running (plugins-serdiuk-analysis*.js is NOT
 * blocked) — see overlay-adjustments-live.spec.ts for why that matters.
 *
 * Driven by the userscript's OWN #sr-play button (the site's native
 * #track-map-controls is hidden by our script).
 *
 * Run:
 *   cd ui_test && npx playwright test overlay-look-live --project=chromium
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

// Reads every currently-present .sr-evt-tri svg's width attribute + screen
// centre (for zoom-target selection later).
async function readArrowState(page: Page) {
  return page.evaluate(() => {
    const out: { width: number | null; height: number | null; cx: number; cy: number; lat: number | null; lng: number | null }[] = [];
    const map = (window as any).SRSRCNG?.map;
    document.querySelectorAll('.sr-evt-tri').forEach((el) => {
      const svg = el as SVGElement & HTMLElement;
      const w = svg.getAttribute('width');
      const h = svg.getAttribute('height');
      const rect = svg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let lat: number | null = null;
      let lng: number | null = null;
      if (map) {
        try {
          const mapRect = map.getContainer().getBoundingClientRect();
          const ll = map.containerPointToLatLng([cx - mapRect.left, cy - mapRect.top]);
          lat = ll.lat;
          lng = ll.lng;
        } catch (e) {}
      }
      out.push({ width: w ? parseFloat(w) : null, height: h ? parseFloat(h) : null, cx, cy, lat, lng });
    });
    return out;
  });
}

// Reads every currently-present .sr-evt-chip's textContent + screen centre
// (for zoom-target selection) + lat/lng (via its Leaflet marker position).
// Also reads the per-row .sr-evt-chip-speed / .sr-evt-chip-delta text
// directly (rather than only the flattened textContent, which concatenates
// adjacent rows with no whitespace — e.g. "+10 m" immediately followed by
// "107 km/h" reads as "...+10 m107 km/h" with no word boundary after "m",
// which breaks naive regexes) so delta-sign checks are robust to how many
// rider rows are present.
async function readChipState(page: Page) {
  return page.evaluate(() => {
    const out: {
      text: string;
      nameNodeCount: number;
      speeds: string[];
      deltas: string[];
      cx: number;
      cy: number;
      lat: number | null;
      lng: number | null;
    }[] = [];
    const map = (window as any).SRSRCNG?.map;
    document.querySelectorAll('.sr-evt-chip').forEach((el) => {
      const chip = el as HTMLElement;
      const rect = chip.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let lat: number | null = null;
      let lng: number | null = null;
      if (map) {
        try {
          const mapRect = map.getContainer().getBoundingClientRect();
          const ll = map.containerPointToLatLng([cx - mapRect.left, cy - mapRect.top]);
          lat = ll.lat;
          lng = ll.lng;
        } catch (e) {}
      }
      out.push({
        text: chip.textContent || '',
        nameNodeCount: chip.querySelectorAll('.sr-evt-chip-name').length,
        speeds: Array.from(chip.querySelectorAll('.sr-evt-chip-speed')).map((n) => n.textContent || ''),
        deltas: Array.from(chip.querySelectorAll('.sr-evt-chip-delta')).map((n) => n.textContent || ''),
        cx,
        cy,
        lat,
        lng,
      });
    });
    return out;
  });
}

// "Visible" per the task = present in the DOM AND not hidden.
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

// Rider name tokens that could leak into a chip's textContent if the "no
// name" adjustment regressed. Pulled from SRSRCNG rider metadata at runtime
// (first_name/last_name/username/nickname-shaped fields), rather than
// hardcoded, so the check works for whichever two riders IDs
// 122145,3,63254,5 actually resolve to.
async function readRiderNameTokens(page: Page) {
  return page.evaluate(() => {
    const riders = (window as any).SRSRCNG?.riders || [];
    const tokens: string[] = [];
    for (const r of riders) {
      for (const key of ['name', 'riderName', 'rider_name', 'firstName', 'first_name', 'lastName', 'last_name', 'username', 'nickname', 'displayName']) {
        const v = r && r[key];
        if (typeof v === 'string' && v.trim().length >= 3) tokens.push(v.trim());
      }
    }
    return Array.from(new Set(tokens));
  });
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

  const riderNameTokens = await readRiderNameTokens(page);
  console.log(`[run ${runIdx}] rider name tokens to check chips don't leak: ${JSON.stringify(riderNameTokens)}`);

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

  // === Sample arrow/chip state every ~400ms for ~20s: build the two
  // visibility timelines (Change 3: chip-at-apex timing) and collect
  // width/textContent samples (Changes 1 & 2) along the way.
  const timeline: { t: number; triVisible: number; chipVisible: number }[] = [];
  const arrowWidthSamples: number[] = [];
  const chipTextSamples: { t: number; text: string; nameNodeCount: number; speeds: string[]; deltas: string[] }[] = [];
  let bestArrowSnapshotForZoom: { lat: number; lng: number } | null = null;
  let bestChipSnapshotForZoom: { lat: number; lng: number } | null = null;
  // Playback is real-time (~0.1s/sample, paced off the longer lap — often
  // 2+ minutes), so a corner seen once during the ~20s sample window will
  // NOT come back around within any reasonable re-poll after zooming: a
  // "zoom then wait for the glyphs to reappear" strategy races (and loses
  // to) the live animation. Instead: the MOMENT we see a chip visible (the
  // richer of the two — it co-occurs with arrows per the apex-timing
  // design), pause playback via #sr-play immediately, freezing every dot/
  // glyph in place, so the subsequent zoom+screenshot has a static scene
  // to work with instead of a moving target.
  let pausedForScreenshot = false;

  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const counts = await readCounts(page);
    const t = Date.now() - start;
    timeline.push({ t, triVisible: counts.triVisible, chipVisible: counts.chipVisible });

    if (counts.triVisible > 0) {
      const arrows = await readArrowState(page);
      for (const a of arrows) {
        if (a.width !== null) arrowWidthSamples.push(a.width);
        if (a.lat !== null && a.lng !== null && !bestArrowSnapshotForZoom) {
          bestArrowSnapshotForZoom = { lat: a.lat, lng: a.lng };
        }
      }
    }
    if (counts.chipVisible > 0) {
      const chips = await readChipState(page);
      for (const c of chips) {
        chipTextSamples.push({ t, text: c.text, nameNodeCount: c.nameNodeCount, speeds: c.speeds, deltas: c.deltas });
        if (c.lat !== null && c.lng !== null && !bestChipSnapshotForZoom) {
          bestChipSnapshotForZoom = { lat: c.lat, lng: c.lng };
        }
      }
    }

    // Pause the instant BOTH a chip and at least one arrow are simultaneously
    // visible, so the frozen frame gives the screenshot the best chance of
    // showing both glyphs together.
    if (!pausedForScreenshot && counts.chipVisible > 0 && counts.triVisible > 0) {
      await playBtn.click(); // toggles playing -> paused; dots/glyphs freeze at this instant
      pausedForScreenshot = true;
      // Still keep sampling the timeline below (loop continues), but skip
      // the auto-resume-on-stopped logic for the rest of this window so we
      // don't accidentally un-pause ourselves.
      await page.waitForTimeout(400);
      continue;
    }

    await page.waitForTimeout(400);
    if (pausedForScreenshot) continue; // leave paused
    const stillPlaying = await page.evaluate(() =>
      document.getElementById('sr-play')?.classList.contains('is-playing'),
    );
    if (!stillPlaying) await playBtn.click();
  }

  console.log(`[run ${runIdx}] === visibility timeline (arrows vs chip) ===`);
  for (const row of timeline) {
    console.log(`t=${row.t}ms triVisible=${row.triVisible} chipVisible=${row.chipVisible}`);
  }

  // --- Screenshot(s): zoom into a corner where arrows/chip were seen, so the
  // bigger arrows + smaller chip are clearly legible (they can merge at
  // full-track zoom). Prefer a chip location (shows both glyphs together);
  // fall back to an arrow location.
  //
  // The lap is 2+ minutes and playback is real-time, so a corner seen once
  // during the sampling loop will not come back around within any
  // reasonable re-poll window after zooming — "zoom then wait for glyphs to
  // reappear" races (and loses to) the live animation, and reliably
  // captures an empty corner (confirmed empirically with an earlier version
  // of this test: 0/2 screenshots ever showed a glyph). Instead the
  // sampling loop above PAUSES playback (#sr-play) the instant a chip and
  // an arrow are simultaneously visible, freezing every dot/glyph in place,
  // so we can zoom into that exact frozen scene and shoot without racing
  // anything.
  const zoomTarget = bestChipSnapshotForZoom || bestArrowSnapshotForZoom;
  const screenshotPaths: string[] = [];

  if (zoomTarget) {
    // Confirm we're actually paused (best-effort: if the pause-on-sighting
    // branch above never fired for some reason, this at least avoids
    // shooting mid-animation immediately after a fresh click).
    const isPlayingNow = await page.evaluate(() =>
      document.getElementById('sr-play')?.classList.contains('is-playing'),
    );
    console.log(`[run ${runIdx}] paused for screenshot: ${pausedForScreenshot}, currently playing: ${isPlayingNow}`);

    await page.evaluate(({ lat, lng }) => {
      (window as any).SRSRCNG.map.setView([lat, lng], 17);
    }, zoomTarget);
    await expect
      .poll(() => page.evaluate(() => (window as any).SRSRCNG.map.getZoom()), {
        timeout: 10_000,
        intervals: [300],
      })
      .toBe(17);
    // Let the LOD recompute (zoomend handler) settle.
    await page.waitForTimeout(600);

    const counts1 = await readCounts(page);
    console.log(`[run ${runIdx}] zoom1 glyph counts: triVisible=${counts1.triVisible} chipVisible=${counts1.chipVisible}`);
    const p1 = `test-results/overlay-look-live-run${runIdx}-zoom1.png`;
    await page.screenshot({ path: p1, fullPage: false });
    screenshotPaths.push(p1);

    // Second shot: pan slightly (still paused, so the scene doesn't change
    // otherwise) to get a marginally different framing of the same frozen
    // corner, useful for judging the look from two angles.
    await page.evaluate(({ lat, lng }) => {
      (window as any).SRSRCNG.map.panTo([lat, lng]);
    }, zoomTarget);
    await page.waitForTimeout(400);
    const p2 = `test-results/overlay-look-live-run${runIdx}-zoom2.png`;
    await page.screenshot({ path: p2, fullPage: false });
    screenshotPaths.push(p2);
  } else {
    const p1 = `test-results/overlay-look-live-run${runIdx}-fallback.png`;
    await page.screenshot({ path: p1, fullPage: false });
    screenshotPaths.push(p1);
  }

  // Resume playback (if we paused) so the run cleanly ends in a known state
  // and subsequent regression reads aren't confused by a stuck pause.
  if (pausedForScreenshot) {
    const stillPaused = await page.evaluate(() =>
      !document.getElementById('sr-play')?.classList.contains('is-playing'),
    );
    if (stillPaused) await playBtn.click();
  }

  // --- Regressions.
  const paneNodeCount = await page.evaluate(
    () => document.querySelectorAll('.leaflet-pane.leaflet-srEvents-pane').length,
  );
  const finalCounts = await readCounts(page);
  const maxTriTotalSeen = finalCounts.triTotal;

  return {
    riderCount,
    timeline,
    arrowWidthSamples,
    chipTextSamples,
    riderNameTokens,
    paneNodeCount,
    finalCounts,
    maxTriTotalSeen,
    pageErrors,
    screenshotPaths,
  };
}

test.describe('srEvents overlay look adjustments: bigger arrows, name-free smaller chip with +N m delta, apex timing', () => {
  test('Look adjustments 1-3, 2 runs', async ({ page }, testInfo) => {
    test.setTimeout(300_000);

    const runReports: Awaited<ReturnType<typeof runOnce>>[] = [];

    for (let run = 1; run <= 2; run++) {
      console.log(`\n========== RUN ${run} ==========`);
      const report = await runOnce(page, run);
      runReports.push(report);

      // --- Regression assertions, every run.
      expect(report.paneNodeCount, `[run ${run}] expected exactly one srEvents Leaflet pane`).toBe(1);
      expect(
        report.pageErrors.map((e) => e.message),
        `[run ${run}] Uncaught page errors:\n${report.pageErrors.map((e) => e.stack || e.message).join('\n---\n')}`,
      ).toEqual([]);
      expect(
        report.maxTriTotalSeen,
        `[run ${run}] total .sr-evt-tri elements in DOM should stay small/bounded, not accumulate`,
      ).toBeLessThanOrEqual((report.riderCount + 2) * 2);

      // --- Change 1: arrow size == 18.
      expect(
        report.arrowWidthSamples.length,
        `[run ${run}] expected at least one visible .sr-evt-tri arrow with a readable width during playback`,
      ).toBeGreaterThan(0);
      const badWidths = report.arrowWidthSamples.filter((w) => w !== EXPECTED_ARROW_SIZE);
      console.log(
        `[run ${run}] Change 1: arrow width samples (n=${report.arrowWidthSamples.length}): ` +
          `${JSON.stringify(Array.from(new Set(report.arrowWidthSamples)))}`,
      );
      expect(
        badWidths,
        `[run ${run}] expected ALL sampled .sr-evt-tri svg widths to be ${EXPECTED_ARROW_SIZE}, found: ${JSON.stringify(badWidths)}`,
      ).toEqual([]);

      // --- Change 2: chip has no rider name, shows speed (km/h) + "+N m" delta.
      expect(
        report.chipTextSamples.length,
        `[run ${run}] expected at least one visible .sr-evt-chip during playback`,
      ).toBeGreaterThan(0);

      const sampleChipText = report.chipTextSamples[0].text;
      console.log(`[run ${run}] Change 2: sample chip textContent: ${JSON.stringify(sampleChipText)}`);
      console.log(`[run ${run}] Change 2: all distinct chip texts seen: ${JSON.stringify(Array.from(new Set(report.chipTextSamples.map((c) => c.text))))}`);

      const nameNodeTotal = report.chipTextSamples.reduce((sum, c) => sum + c.nameNodeCount, 0);
      expect(nameNodeTotal, `[run ${run}] expected 0 .sr-evt-chip-name nodes across all sampled chips`).toBe(0);

      // No chip's textContent should contain a full rider-name token.
      const leakedNameChips = report.chipTextSamples.filter((c) =>
        report.riderNameTokens.some((name) => c.text.includes(name)),
      );
      expect(
        leakedNameChips.map((c) => c.text),
        `[run ${run}] chip textContent should not contain any rider name token ${JSON.stringify(report.riderNameTokens)}`,
      ).toEqual([]);

      const hasSpeedUnit = report.chipTextSamples.some((c) => /km\/h/.test(c.text));
      expect(hasSpeedUnit, `[run ${run}] expected at least one chip to show a "km/h" speed`).toBe(true);

      const allDeltaTexts = report.chipTextSamples.flatMap((c) => c.deltas);
      const hasDelta = allDeltaTexts.some((d) => /\+\s*\d+\s*m/.test(d));
      // Not every visible chip is guaranteed to carry a >=3m delta row (see
      // renderCornerMarker: delta only rendered when metresLater >= 3), so
      // log rather than hard-fail if none were observed, but expect it in
      // the common case across 20s of playback with 2 riders.
      console.log(`[run ${run}] Change 2: any chip showed a "+N m" delta = ${hasDelta}`);

      // --- Change 3 (delta sign): every delta actually rendered (read from
      // the dedicated .sr-evt-chip-delta node, not the flattened
      // textContent — adjacent rows concatenate with no whitespace, e.g.
      // "+10 m" immediately followed by "107 km/h", which breaks
      // textContent-wide regexes) must be "+N m", never a leading minus.
      const deltaMatches = Array.from(new Set(allDeltaTexts.filter((d) => d.trim().length > 0)));
      const badDeltaMatches = deltaMatches.filter((d) => !/^\+\d+\s*m$/.test(d.trim()));
      console.log(`[run ${run}] Change 3 (sign): delta tokens seen: ${JSON.stringify(deltaMatches)}`);
      expect(
        badDeltaMatches,
        `[run ${run}] expected every delta token to match "+N m", found unexpected: ${JSON.stringify(badDeltaMatches)}`,
      ).toEqual([]);

      // --- Change 3 (apex timing): the chip's visibility must be OFFSET from
      // the arrows' visibility, not simultaneous start/stop. We check this by
      // finding ticks where chip turns on/off and comparing against when
      // arrows are on/off; a pure "always simultaneous" pattern (chip on
      // exactly iff arrow on, every tick, with identical transition ticks)
      // would indicate no apex offset.
      const arrowOnTicks = new Set(report.timeline.filter((r) => r.triVisible > 0).map((r) => r.t));
      const chipOnTicks = new Set(report.timeline.filter((r) => r.chipVisible > 0).map((r) => r.t));
      const allTicks = report.timeline.map((r) => r.t);
      let simultaneousTicks = 0;
      let differingTicks = 0;
      for (const t of allTicks) {
        const arrowOn = arrowOnTicks.has(t);
        const chipOn = chipOnTicks.has(t);
        if (arrowOn === chipOn) simultaneousTicks++;
        else differingTicks++;
      }
      console.log(
        `[run ${run}] Change 3 (apex timing): ticks where arrow-on === chip-on: ${simultaneousTicks}, ` +
          `differing: ${differingTicks}, total: ${allTicks.length}`,
      );
      // Also look for ticks where the chip is visible but NO arrow is
      // (chip lingering past the brake-point window, at/after the apex) —
      // direct evidence the chip's window is not identical to the arrows'.
      const chipOnlyTicks = report.timeline.filter((r) => r.chipVisible > 0 && r.triVisible === 0).length;
      const arrowOnlyTicks = report.timeline.filter((r) => r.triVisible > 0 && r.chipVisible === 0).length;
      console.log(
        `[run ${run}] Change 3 (apex timing): chip-only ticks (chip on, arrows off) = ${chipOnlyTicks}, ` +
          `arrow-only ticks (arrows on, chip off) = ${arrowOnlyTicks}`,
      );
      expect(
        differingTicks,
        `[run ${run}] expected chip visibility to be offset from arrow visibility at least some of the time ` +
          `(chip fires at apex, arrows fire at brake point — they should not track each other tick-for-tick), ` +
          `but arrow-on/chip-on state matched on every one of ${allTicks.length} ticks`,
      ).toBeGreaterThan(0);
    }

    await testInfo.attach('overlay-look-runs.json', {
      body: JSON.stringify(
        runReports.map((r) => ({
          riderCount: r.riderCount,
          timeline: r.timeline,
          arrowWidthSamples: Array.from(new Set(r.arrowWidthSamples)),
          chipTextSamples: r.chipTextSamples.slice(0, 20),
          paneNodeCount: r.paneNodeCount,
          finalCounts: r.finalCounts,
          screenshotPaths: r.screenshotPaths,
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });

    console.log('\n=== overlay-look-live: summary across runs ===');
    runReports.forEach((r, idx) => {
      console.log(
        `run ${idx + 1}: arrowWidths=${JSON.stringify(Array.from(new Set(r.arrowWidthSamples)))}, ` +
          `screenshots=${JSON.stringify(r.screenshotPaths)}`,
      );
    });
  });
});
