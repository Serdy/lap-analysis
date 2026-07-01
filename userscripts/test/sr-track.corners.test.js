'use strict';

/**
 * Unit tests for SR_TRACK.detectCorners (T4).
 *
 * detectCorners() finds per-rider corner spans (primary: RELATIVE lean
 * threshold, since lean's GPS-derived scale differs rider-to-rider; fallback:
 * speed-minima for a rider whose lean channel is dead) and then clusters
 * those spans across riders into track-level corners by normalized distance,
 * order-independently, dropping single-rider "phantom" spans when more than
 * one rider is present.
 *
 * Run: npm test (or: node --test) from userscripts/ or userscripts/test/.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SR_TRACK = require('../src/sr-track.js');
const { loadFixture } = require('./fixture-helpers.js');

const FIXTURE_FILE = 'compare-122145-3-63254-5.json';

// ---------------------------------------------------------------------------
// Synthetic lap builders
// ---------------------------------------------------------------------------
/**
 * Build one synthetic rider's data rows with corners at given sample-index
 * ranges (inclusive). Each corner ramps lean up to `leanPeak` at midspan and
 * dips speed down to `speedDip` mph at midspan, both via a smooth triangular
 * profile, so corner detection has an unambiguous apex.
 *
 * @param {number} n total samples
 * @param {Array<[number,number]>} cornerRanges  [[startIdx,endIdxInclusive], ...]
 * @param {object} [opts]
 * @returns {Array<Array<number>>}
 */
function buildSyntheticLap(n, cornerRanges, opts) {
  opts = opts || {};
  const latStep = opts.latStep != null ? opts.latStep : 0.0001;
  const lngStep = opts.lngStep != null ? opts.lngStep : 0.0001;
  const startLat = opts.startLat != null ? opts.startLat : 45;
  const startLng = opts.startLng != null ? opts.startLng : 10;
  const straightSpeed = opts.straightSpeed != null ? opts.straightSpeed : 90; // mph
  const speedDip = opts.speedDip != null ? opts.speedDip : 40; // mph at apex
  const leanPeak = opts.leanPeak != null ? opts.leanPeak : 40; // deg at apex
  const leanFlat = opts.leanFlat != null ? opts.leanFlat : 3; // deg on straights
  const col4 = opts.col4 != null ? opts.col4 : 0.2;

  function activeRange(i) {
    for (const [lo, hi] of cornerRanges) {
      if (i >= lo && i <= hi) return [lo, hi];
    }
    return null;
  }

  const rows = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const range = activeRange(i);
    let speed = straightSpeed;
    let lean = leanFlat;
    if (range) {
      const [lo, hi] = range;
      const mid = (lo + hi) / 2;
      const half = Math.max(1, (hi - lo) / 2);
      const t = 1 - Math.min(1, Math.abs(i - mid) / half); // 0 at edges, 1 at apex
      speed = straightSpeed - t * (straightSpeed - speedDip);
      lean = leanFlat + t * (leanPeak - leanFlat);
    }
    const lat = startLat + i * latStep;
    const lng = startLng + i * lngStep;
    rows.push([lat, lng, speed, d, col4, lean]);
    d += speed * SR_TRACK.DEFAULT_CFG.MPH_TO_MS * SR_TRACK.DEFAULT_CFG.DT;
  }
  return rows;
}

/** Build a rider whose lean channel trips validity()'s lean-dead flag (saturated). */
function buildLeanDeadLap(n, cornerRanges, opts) {
  opts = opts || {};
  const rows = buildSyntheticLap(n, cornerRanges, opts);
  // Saturate lean at the configured cap for the vast majority of samples so
  // validity() reports useL:false (per leanSatFrac/leanSatDeg in DEFAULT_CFG).
  const satDeg = SR_TRACK.DEFAULT_CFG.leanSatDeg;
  for (let i = 0; i < rows.length; i++) {
    rows[i][5] = (i % 2 === 0) ? satDeg : -satDeg;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Seam / export / cfg checks
// ---------------------------------------------------------------------------
describe('SR_TRACK.detectCorners seam', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof SR_TRACK.detectCorners, 'function');
  });

  it('DEFAULT_CFG carries the new corner-detector thresholds, overridable', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    assert.strictEqual(typeof cfg.CORNER_LEAN_FRAC, 'number');
    assert.strictEqual(typeof cfg.CORNER_MATCH_WINDOW, 'number');
    assert.strictEqual(typeof cfg.CORNER_LEAN_SMOOTH_WIN, 'number');
    assert.strictEqual(typeof cfg.CORNER_SPEED_PROM_FRAC, 'number');
    assert.strictEqual(typeof cfg.CORNER_SPEED_MIN_SEP, 'number');
    assert.ok(cfg.CORNER_LEAN_FRAC > 0 && cfg.CORNER_LEAN_FRAC < 1,
      'CORNER_LEAN_FRAC should be a fraction in (0,1)');
  });
});

// ---------------------------------------------------------------------------
// Relative threshold works cross-scale (the core T4 requirement)
// ---------------------------------------------------------------------------
describe('detectCorners: relative lean threshold works cross-scale', () => {
  it('both a high-lean-scale rider (~45deg) and a low-lean-scale rider (~27deg) produce corners', () => {
    const cornerRanges = [[20, 40], [80, 100], [140, 160]];
    const riderHigh = buildSyntheticLap(200, cornerRanges, { leanPeak: 45.8 });
    const riderLow = buildSyntheticLap(200, cornerRanges, { leanPeak: 27.8 });

    const spansHigh = SR_TRACK._riderCornerSpans(riderHigh, SR_TRACK.DEFAULT_CFG);
    const spansLow = SR_TRACK._riderCornerSpans(riderLow, SR_TRACK.DEFAULT_CFG);

    assert.ok(spansHigh.length >= 3, `high-lean rider should find >=3 corners, got ${spansHigh.length}`);
    assert.ok(spansLow.length >= 3, `low-lean rider should find >=3 corners, got ${spansLow.length}`);
  });

  it('contrast: an ABSOLUTE 35deg threshold would find zero corners for the low-scale rider', () => {
    // This encodes *why* a relative threshold is required: demonstrate the
    // failure mode a naive absolute-degree approach would hit.
    const cornerRanges = [[20, 40], [80, 100], [140, 160]];
    const riderLow = buildSyntheticLap(200, cornerRanges, { leanPeak: 27.8 });
    const leanArr = riderLow.map((row) => row[5]);

    const ABS_THRESHOLD = 35;
    const countAboveAbsolute = leanArr.filter((v) => Math.abs(v) > ABS_THRESHOLD).length;
    assert.strictEqual(countAboveAbsolute, 0,
      'sanity: no sample in the low-lean-scale rider ever exceeds an absolute 35deg threshold');

    // Yet our relative detector still finds corners for this same rider.
    const spansLow = SR_TRACK._riderCornerSpans(riderLow, SR_TRACK.DEFAULT_CFG);
    assert.ok(spansLow.length >= 3,
      `relative detector should still find corners where absolute-35deg finds none, got ${spansLow.length}`);
  });
});

// ---------------------------------------------------------------------------
// Order independence
// ---------------------------------------------------------------------------
describe('detectCorners: cross-rider clustering is order-independent', () => {
  it('swapping rider order yields identical clustered corners (synthetic)', () => {
    const cornerRanges = [[20, 40], [80, 100], [140, 160]];
    const riderA = buildSyntheticLap(200, cornerRanges, { leanPeak: 45 });
    const riderB = buildSyntheticLap(200, cornerRanges, { leanPeak: 30 });

    const forward = SR_TRACK.detectCorners([riderA, riderB]);
    const swapped = SR_TRACK.detectCorners([riderB, riderA]);

    assert.strictEqual(forward.length, swapped.length);
    for (let i = 0; i < forward.length; i++) {
      assert.ok(Math.abs(forward[i].dist - swapped[i].dist) < 1e-6,
        `cluster ${i} dist should match regardless of rider order`);
      // riderIndex 0 in `forward` is riderA; riderIndex 0 in `swapped` is riderB.
      // So forward[i].perRider[0] (riderA) should equal swapped[i].perRider[1] (riderA).
      const a1 = forward[i].perRider[0];
      const a2 = swapped[i].perRider[1];
      assert.strictEqual(a1 === null, a2 === null);
      if (a1) assert.ok(Math.abs(a1.minSpeed - a2.minSpeed) < 1e-9);
    }
  });

  it('swapping rider order yields identical clustered corners (real fixture)', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);

    const forward = SR_TRACK.detectCorners(riders);
    const swapped = SR_TRACK.detectCorners([riders[1], riders[0]]);

    assert.strictEqual(forward.length, swapped.length);
    const forwardDists = forward.map((c) => c.dist.toFixed(2));
    const swappedDists = swapped.map((c) => c.dist.toFixed(2));
    assert.deepStrictEqual(forwardDists, swappedDists);
  });
});

// ---------------------------------------------------------------------------
// Phantom rejection
// ---------------------------------------------------------------------------
describe('detectCorners: phantom span rejection', () => {
  it('a corner span seen by only one rider is dropped when >=2 riders are present', () => {
    const sharedRanges = [[20, 40], [140, 160]];
    const phantomRange = [[80, 100]]; // only riderA corners here

    const riderA = buildSyntheticLap(200, sharedRanges.concat(phantomRange), { leanPeak: 45 });
    const riderB = buildSyntheticLap(200, sharedRanges, { leanPeak: 30 });

    const clustered = SR_TRACK.detectCorners([riderA, riderB]);

    // Expect exactly the 2 shared corners; the phantom (single-rider) corner is dropped.
    assert.strictEqual(clustered.length, 2,
      `expected 2 corroborated corners, got ${clustered.length}`);
    for (const c of clustered) {
      const present = c.perRider.filter((p) => p !== null).length;
      assert.ok(present >= 2, 'every kept cluster must have both riders present');
    }
  });

  it('with a single rider supplied, all spans are kept (nothing to corroborate against)', () => {
    const riderA = buildSyntheticLap(200, [[20, 40], [80, 100], [140, 160]], { leanPeak: 45 });
    const clustered = SR_TRACK.detectCorners([riderA]);
    assert.strictEqual(clustered.length, 3,
      `single-rider input should keep all 3 corners, got ${clustered.length}`);
    for (const c of clustered) {
      assert.strictEqual(c.perRider.length, 1);
      assert.ok(c.perRider[0] !== null);
    }
  });
});

// ---------------------------------------------------------------------------
// Lean-dead fallback
// ---------------------------------------------------------------------------
describe('detectCorners: lean-dead fallback to speed minima', () => {
  it('a rider whose lean channel is saturated/dead still gets corners via speed minima', () => {
    const cornerRanges = [[20, 40], [80, 100], [140, 160]];
    const riderDeadLean = buildLeanDeadLap(200, cornerRanges);

    // Sanity: validity() must actually report lean unusable for this synthetic rider.
    const arrays = SR_TRACK._extractRiderArrays(riderDeadLean);
    const valid = SR_TRACK.validity(arrays.col4, arrays.speedMph, arrays.lean);
    assert.strictEqual(valid.useL, false, 'sanity: synthetic rider should trip the lean-dead flag');

    const spans = SR_TRACK._riderCornerSpans(riderDeadLean, SR_TRACK.DEFAULT_CFG);
    assert.ok(spans.length >= 3, `expected >=3 corners via speed-minima fallback, got ${spans.length}`);
  });

  it('speed-minima fallback spans land near the true speed-dip apex', () => {
    const cornerRanges = [[50, 90]];
    const riderDeadLean = buildLeanDeadLap(150, cornerRanges, { speedDip: 30, straightSpeed: 100 });
    const spans = SR_TRACK._riderCornerSpans(riderDeadLean, SR_TRACK.DEFAULT_CFG);
    assert.strictEqual(spans.length, 1);
    assert.ok(Math.abs(spans[0].apexIdx - 70) <= 5,
      `apex idx ${spans[0].apexIdx} should be close to the true dip midpoint (70)`);
  });
});

// ---------------------------------------------------------------------------
// Min speed correctness
// ---------------------------------------------------------------------------
describe('detectCorners: minSpeed correctness on synthetic spans', () => {
  it('reports the true minimum speed within a corner span (lean-based path)', () => {
    const riderA = buildSyntheticLap(120, [[40, 80]], { speedDip: 35, straightSpeed: 95, leanPeak: 42 });
    const spans = SR_TRACK._riderCornerSpans(riderA, SR_TRACK.DEFAULT_CFG);
    assert.strictEqual(spans.length, 1);
    // True minimum over the whole lap is the corner apex (dip to 35 mph).
    const trueMin = Math.min(...riderA.map((r) => r[2]));
    assert.ok(Math.abs(spans[0].minSpeed - trueMin) < 1e-6);
  });

  it('clustered corner minSpeed matches the per-rider span minSpeed', () => {
    const cornerRanges = [[40, 80]];
    const riderA = buildSyntheticLap(120, cornerRanges, { speedDip: 35, leanPeak: 42 });
    const riderB = buildSyntheticLap(120, cornerRanges, { speedDip: 50, leanPeak: 30 });
    const clustered = SR_TRACK.detectCorners([riderA, riderB]);
    assert.strictEqual(clustered.length, 1);
    assert.ok(Math.abs(clustered[0].perRider[0].minSpeed - 35) < 2);
    assert.ok(Math.abs(clustered[0].perRider[1].minSpeed - 50) < 2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('detectCorners: edge cases do not throw', () => {
  it('empty riders array -> []', () => {
    assert.deepStrictEqual(SR_TRACK.detectCorners([]), []);
  });

  it('undefined/null riders -> []', () => {
    assert.deepStrictEqual(SR_TRACK.detectCorners(undefined), []);
    assert.deepStrictEqual(SR_TRACK.detectCorners(null), []);
  });

  it('one rider with too-short data -> [] without throwing', () => {
    const riderA = [[45, 10, 60, 0, 0, 0], [45.0001, 10.0001, 58, 5, -6, 1]];
    assert.doesNotThrow(() => {
      const out = SR_TRACK.detectCorners([riderA]);
      assert.ok(Array.isArray(out));
    });
  });

  it('a rider entry that is an empty array does not throw', () => {
    assert.doesNotThrow(() => {
      const out = SR_TRACK.detectCorners([[], []]);
      assert.deepStrictEqual(out, []);
    });
  });

  it('NaN-laden rows do not throw and produce finite fields only', () => {
    const riderA = buildSyntheticLap(150, [[20, 40], [80, 100]], { leanPeak: 45 });
    const riderB = buildSyntheticLap(150, [[20, 40], [80, 100]], { leanPeak: 28 });
    riderA[10] = [NaN, 10.001, NaN, 100, NaN, NaN];
    riderB[30][5] = NaN; // lean
    riderB[31][2] = NaN; // speed
    riderA[32][0] = NaN; // lat
    riderA[32][1] = NaN; // lng

    assert.doesNotThrow(() => {
      const out = SR_TRACK.detectCorners([riderA, riderB]);
      for (const c of out) {
        assert.ok(Number.isFinite(c.dist));
        for (const p of c.perRider) {
          if (!p) continue;
          assert.ok(Number.isFinite(p.minSpeed));
          assert.ok(Number.isFinite(p.apexIdx));
          assert.ok(Number.isFinite(p.apexLat));
          assert.ok(Number.isFinite(p.apexLng));
          assert.ok(Number.isFinite(p.entryDist));
        }
      }
    });
  });

  it('all-NaN rider rows do not throw', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push([NaN, NaN, NaN, NaN, NaN, NaN]);
    assert.doesNotThrow(() => {
      const out = SR_TRACK.detectCorners([rows]);
      assert.ok(Array.isArray(out));
    });
  });
});

// ---------------------------------------------------------------------------
// Smoke test on the real captured fixture
// ---------------------------------------------------------------------------
describe('detectCorners: smoke test on real fixture', () => {
  it('returns a plausible clustered-corner count for Brno GP (~14 turns; loose range)', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);

    const clustered = SR_TRACK.detectCorners(riders);

    assert.ok(Array.isArray(clustered));
    assert.ok(clustered.length > 6 && clustered.length < 22,
      `expected a plausible corner count (>6 and <22), got ${clustered.length}`);

    for (const c of clustered) {
      assert.ok(Number.isFinite(c.dist) && c.dist >= 0);
      const present = c.perRider.filter((p) => p !== null);
      assert.ok(present.length >= 1, 'every clustered corner must have >=1 rider present');
      for (const p of present) {
        assert.ok(Number.isFinite(p.minSpeed) && p.minSpeed > 0);
        assert.ok(Number.isFinite(p.apexLat) && Number.isFinite(p.apexLng));
      }
    }

    // Clusters must be sorted by distance.
    for (let i = 1; i < clustered.length; i++) {
      assert.ok(clustered[i].dist >= clustered[i - 1].dist);
    }
  });
});
