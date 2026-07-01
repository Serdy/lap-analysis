'use strict';

/**
 * Unit tests for SR_TRACK.detectBrakingOnsets (T3).
 *
 * detectBrakingOnsets() is a Schmitt-trigger + debounce layer on top of the
 * existing computeScore() fused g+speed score — it must NOT implement a second
 * braking classifier. These tests build synthetic riderData rows
 * ([lat,lng,speedMph,cumDist,longAccel,lean]) to exercise the trigger/debounce
 * logic deterministically, then smoke-test against the real captured fixture.
 *
 * Run: npm test (or: node --test) from userscripts/ or userscripts/test/.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SR_TRACK = require('../src/sr-track.js');
const { loadFixture, longAccel, speedMph, lean } = require('./fixture-helpers.js');

const FIXTURE_FILE = 'compare-122145-3-63254-5.json';

// ---------------------------------------------------------------------------
// Synthetic lap builder
// ---------------------------------------------------------------------------
/**
 * Build synthetic riderData rows with braking zones at the given sample-index
 * ranges (inclusive), and gentle acceleration everywhere else. GPS moves in a
 * straight line by default (constant heading) so bearing math is predictable.
 *
 * @param {number} n total samples
 * @param {Array<[number,number]>} brakeRanges  [[startIdx,endIdxInclusive], ...]
 * @param {object} [opts]
 * @returns {Array<Array<number>>}
 */
function buildSyntheticLap(n, brakeRanges, opts) {
  opts = opts || {};
  const latStep = opts.latStep != null ? opts.latStep : 0.0001;
  const lngStep = opts.lngStep != null ? opts.lngStep : 0.0001;
  const startLat = opts.startLat != null ? opts.startLat : 45;
  const startLng = opts.startLng != null ? opts.startLng : 10;
  const startDist = opts.startDist != null ? opts.startDist : 0;
  const leanDeg = opts.lean != null ? opts.lean : 5;

  function inBrakeRange(i) {
    return brakeRanges.some(([lo, hi]) => i >= lo && i <= hi);
  }

  const rows = [];
  let v = opts.startSpeed != null ? opts.startSpeed : 60; // mph
  let d = startDist;
  for (let i = 0; i < n; i++) {
    const braking = inBrakeRange(i);
    const col4 = braking ? -6 : 0.5;
    v = braking ? Math.max(25, v - 2) : Math.min(90, v + 0.3);
    const lat = startLat + i * latStep;
    const lng = startLng + i * lngStep;
    rows.push([lat, lng, v, d, col4, leanDeg]);
    d += v * SR_TRACK.DEFAULT_CFG.MPH_TO_MS * SR_TRACK.DEFAULT_CFG.DT;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Seam / export check
// ---------------------------------------------------------------------------
describe('SR_TRACK.detectBrakingOnsets seam', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof SR_TRACK.detectBrakingOnsets, 'function');
  });

  it('DEFAULT_CFG carries the new onset thresholds, overridable', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    assert.strictEqual(typeof cfg.BRAKE_ONSET_ENTER, 'number');
    assert.strictEqual(typeof cfg.BRAKE_ONSET_EXIT, 'number');
    assert.strictEqual(typeof cfg.ONSET_MIN_SAMPLES, 'number');
    assert.strictEqual(typeof cfg.ONSET_MIN_DIST, 'number');
    assert.ok(cfg.BRAKE_ONSET_ENTER < cfg.BRAKE_ONSET_EXIT,
      'enter threshold must be more negative than exit (hysteresis)');
  });
});

// ---------------------------------------------------------------------------
// Single braking zone -> exactly one onset
// ---------------------------------------------------------------------------
describe('detectBrakingOnsets: single braking zone', () => {
  it('produces exactly one onset at the expected entering index', () => {
    const rows = buildSyntheticLap(80, [[30, 45]]);
    const onsets = SR_TRACK.detectBrakingOnsets(rows);

    assert.strictEqual(onsets.length, 1, `expected exactly 1 onset, got ${onsets.length}`);
    // Onset should fire at or shortly after the true brake-input index (30),
    // once computeScore's slew/smoothing lets the fused score cross ENTER.
    assert.ok(onsets[0].idx >= 30 && onsets[0].idx <= 36,
      `onset idx ${onsets[0].idx} should be close to the true brake start (30)`);
  });

  it('emits idx/lat/lng/dist/heading/minSpeed/severity with sane values', () => {
    const rows = buildSyntheticLap(80, [[30, 45]]);
    const onsets = SR_TRACK.detectBrakingOnsets(rows);
    assert.strictEqual(onsets.length, 1);

    const o = onsets[0];
    assert.strictEqual(typeof o.idx, 'number');
    assert.strictEqual(o.lat, rows[o.idx][0]);
    assert.strictEqual(o.lng, rows[o.idx][1]);
    assert.ok(Number.isFinite(o.dist));
    assert.ok(Number.isFinite(o.heading) && o.heading >= 0 && o.heading < 360);
    assert.ok(Number.isFinite(o.minSpeed) && o.minSpeed > 0);
    // minSpeed must be <= the speed at onset (braking reduces speed).
    assert.ok(o.minSpeed <= rows[o.idx][2] + 1e-9);
    assert.ok(Number.isFinite(o.severity) && o.severity > 0);
  });
});

// ---------------------------------------------------------------------------
// Two separated zones -> two onsets; two close zones -> collapsed to one
// ---------------------------------------------------------------------------
describe('detectBrakingOnsets: onset debounce by distance', () => {
  it('two braking zones separated by > ONSET_MIN_DIST produce two onsets', () => {
    // At ~60mph (~26.8 m/s) coasting/accelerating, 100 samples * 0.1s ~ a few
    // hundred metres — comfortably more than ONSET_MIN_DIST (40m) apart.
    const rows = buildSyntheticLap(220, [[30, 45], [140, 155]]);
    const onsets = SR_TRACK.detectBrakingOnsets(rows);

    assert.strictEqual(onsets.length, 2, `expected 2 onsets, got ${onsets.length}`);
    const gap = onsets[1].dist - onsets[0].dist;
    assert.ok(gap >= SR_TRACK.DEFAULT_CFG.ONSET_MIN_DIST,
      `gap between onsets (${gap}m) should exceed ONSET_MIN_DIST`);
  });

  it('two braking zones closer than ONSET_MIN_DIST collapse to one onset', () => {
    // Re-enter braking almost immediately after exiting (small gap of steady
    // driving) so the two "zones" are within ONSET_MIN_DIST of each other.
    const rows = buildSyntheticLap(80, [[20, 30], [33, 43]], { startSpeed: 40 });
    const onsets = SR_TRACK.detectBrakingOnsets(rows);

    assert.strictEqual(onsets.length, 1,
      `zones closer than ONSET_MIN_DIST should collapse to 1 onset, got ${onsets.length}`);
  });

  it('ONSET_MIN_DIST is overridable via cfg', () => {
    const rows = buildSyntheticLap(220, [[30, 45], [140, 155]]);
    // With a huge min-distance requirement, the second zone's onset should be
    // suppressed (too close to the first, in this synthetic geometry).
    const onsets = SR_TRACK.detectBrakingOnsets(rows, { ONSET_MIN_DIST: 100000 });
    assert.strictEqual(onsets.length, 1,
      'an enormous ONSET_MIN_DIST should collapse both zones to one onset');
  });
});

// ---------------------------------------------------------------------------
// Debounce by minimum sample duration
// ---------------------------------------------------------------------------
describe('detectBrakingOnsets: onset debounce by minimum duration', () => {
  it('a very brief dip below ENTER that recovers quickly is not counted', () => {
    // Single-sample blip: not sustained long enough to reach ONSET_MIN_SAMPLES
    // once computeScore's smoothing/slew is applied.
    const rows = buildSyntheticLap(60, [[30, 30]]);
    const onsets = SR_TRACK.detectBrakingOnsets(rows);
    assert.strictEqual(onsets.length, 0, 'a one-sample blip should not register as an onset');
  });

  it('ONSET_MIN_SAMPLES is overridable via cfg', () => {
    const rows = buildSyntheticLap(60, [[30, 30]]);
    // With min-samples relaxed to 1, even a short blip should be able to count
    // (as long as computeScore's own smoothing still lets the score dip enough).
    const onsetsRelaxed = SR_TRACK.detectBrakingOnsets(rows, { ONSET_MIN_SAMPLES: 1 });
    const onsetsDefault = SR_TRACK.detectBrakingOnsets(rows);
    assert.ok(onsetsRelaxed.length >= onsetsDefault.length,
      'relaxing ONSET_MIN_SAMPLES should never produce fewer onsets than default');
  });
});

// ---------------------------------------------------------------------------
// Bearing correctness + no-throw at array edges
// ---------------------------------------------------------------------------
describe('detectBrakingOnsets: bearing on a synthetic straight', () => {
  it('heading is ~0deg (due north) for a straight increasing-latitude line', () => {
    // lngStep=0 means pure north travel -> bearing should be ~0 (or ~360).
    const rows = buildSyntheticLap(80, [[30, 45]], { latStep: 0.0001, lngStep: 0 });
    const onsets = SR_TRACK.detectBrakingOnsets(rows);
    assert.strictEqual(onsets.length, 1);
    const h = onsets[0].heading;
    const distFrom0 = Math.min(h, 360 - h);
    assert.ok(distFrom0 < 2, `heading ${h} should be close to 0 (due north), within tolerance`);
  });

  it('heading is ~90deg (due east) for a straight increasing-longitude line', () => {
    const rows = buildSyntheticLap(80, [[30, 45]], { latStep: 0, lngStep: 0.0001 });
    const onsets = SR_TRACK.detectBrakingOnsets(rows);
    assert.strictEqual(onsets.length, 1);
    assert.ok(Math.abs(onsets[0].heading - 90) < 2,
      `heading ${onsets[0].heading} should be close to 90 (due east)`);
  });

  it('does not throw when the onset sits at index 0', () => {
    // Force braking from the very first sample so the onset's prevIdx would be -1
    // (clamped to 0 inside the bearing calc).
    const rows = buildSyntheticLap(60, [[0, 20]]);
    assert.doesNotThrow(() => {
      const onsets = SR_TRACK.detectBrakingOnsets(rows);
      // Not asserting count here (edge behaviour is implementation-defined for
      // "already braking at t=0"); only that it never throws and stays sane.
      for (const o of onsets) {
        assert.ok(Number.isFinite(o.heading));
      }
    });
  });

  it('does not throw when a braking run continues through the last index', () => {
    const n = 60;
    const rows = buildSyntheticLap(n, [[n - 15, n - 1]]);
    assert.doesNotThrow(() => {
      const onsets = SR_TRACK.detectBrakingOnsets(rows);
      for (const o of onsets) {
        assert.ok(Number.isFinite(o.heading));
        assert.ok(o.idx >= 0 && o.idx < n);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty / too-short / NaN-laden input
// ---------------------------------------------------------------------------
describe('detectBrakingOnsets: edge cases do not throw', () => {
  it('empty array -> []', () => {
    assert.deepStrictEqual(SR_TRACK.detectBrakingOnsets([]), []);
  });

  it('undefined/null input -> []', () => {
    assert.deepStrictEqual(SR_TRACK.detectBrakingOnsets(undefined), []);
    assert.deepStrictEqual(SR_TRACK.detectBrakingOnsets(null), []);
  });

  it('single-row input -> []', () => {
    assert.deepStrictEqual(SR_TRACK.detectBrakingOnsets([[45, 10, 60, 0, 0, 0]]), []);
  });

  it('too-short input (a few rows) does not throw and returns an array', () => {
    const rows = [
      [45, 10, 60, 0, 0, 0],
      [45.0001, 10.0001, 58, 5, -6, 0],
      [45.0002, 10.0002, 55, 10, -6, 0],
    ];
    assert.doesNotThrow(() => {
      const onsets = SR_TRACK.detectBrakingOnsets(rows);
      assert.ok(Array.isArray(onsets));
    });
  });

  it('NaN-laden rows do not throw and produce finite fields only', () => {
    const rows = buildSyntheticLap(60, [[20, 35]]);
    // Corrupt a few rows with NaN across different columns.
    rows[10] = [NaN, 10.001, NaN, 100, NaN, NaN];
    rows[25][4] = NaN; // longAccel
    rows[26][2] = NaN; // speed
    rows[27][0] = NaN; // lat
    rows[27][1] = NaN; // lng

    assert.doesNotThrow(() => {
      const onsets = SR_TRACK.detectBrakingOnsets(rows);
      for (const o of onsets) {
        assert.ok(Number.isFinite(o.idx));
        assert.ok(Number.isFinite(o.lat));
        assert.ok(Number.isFinite(o.lng));
        assert.ok(Number.isFinite(o.dist));
        assert.ok(Number.isFinite(o.heading));
        assert.ok(Number.isFinite(o.minSpeed));
        assert.ok(Number.isFinite(o.severity));
      }
    });
  });

  it('all-NaN rows -> [] (both channels dead, validity bails)', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push([NaN, NaN, NaN, NaN, NaN, NaN]);
    assert.deepStrictEqual(SR_TRACK.detectBrakingOnsets(rows), []);
  });
});

// ---------------------------------------------------------------------------
// Smoke test on the real captured fixture (both riders)
// ---------------------------------------------------------------------------
describe('detectBrakingOnsets: smoke test on real fixture', () => {
  it('returns a plausible number of onsets per rider (loose range; precise calibration is T6)', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    for (const rider of fixture.riders) {
      const onsets = SR_TRACK.detectBrakingOnsets(rider.data);
      assert.ok(Array.isArray(onsets), `rider ${rider.name}: onsets should be an array`);
      assert.ok(onsets.length > 5 && onsets.length < 60,
        `rider ${rider.name}: expected a plausible number of onsets (>5 and <60), got ${onsets.length}`);

      // Basic field sanity across every emitted onset.
      for (const o of onsets) {
        assert.ok(o.idx >= 0 && o.idx < rider.data.length);
        assert.ok(Number.isFinite(o.lat) && Number.isFinite(o.lng));
        assert.ok(Number.isFinite(o.dist) && o.dist >= 0);
        assert.ok(o.heading >= 0 && o.heading < 360);
        assert.ok(Number.isFinite(o.minSpeed) && o.minSpeed > 0);
        assert.ok(Number.isFinite(o.severity) && o.severity >= 0);
      }

      // Onsets must be in non-decreasing distance order (single pass over the lap).
      for (let i = 1; i < onsets.length; i++) {
        assert.ok(onsets[i].dist >= onsets[i - 1].dist,
          `rider ${rider.name}: onsets should be ordered by increasing distance`);
      }
    }
  });

  it('reuses computeScore/validity rather than re-deriving from col4 directly', () => {
    // Indirect check: if validity() bails (both g and speed dead), onsets must
    // be [] too — proving the function funnels through the shared validity/score
    // pipeline instead of an independent classifier.
    const fixture = loadFixture(FIXTURE_FILE);
    const rider = fixture.riders[0];
    const col4 = longAccel(rider.data);
    const speed = speedMph(rider.data);
    const leanArr = lean(rider.data);
    const valid = SR_TRACK.validity(col4, speed, leanArr);
    assert.ok(!valid.bail, 'sanity: fixture rider should not bail');

    // Deliberately construct data where both channels are dead -> bail -> [].
    const deadRows = rider.data.map((row) => [row[0], row[1], 60, row[3], 0, 0]);
    assert.deepStrictEqual(SR_TRACK.detectBrakingOnsets(deadRows), []);
  });
});
