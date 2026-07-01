'use strict';

/**
 * Unit tests for SR_TRACK.buildCompareEvents (T5).
 *
 * buildCompareEvents() is the single top-level entry point the map renderer
 * calls in compare mode. It is pure composition over detectBrakingOnsets()
 * (T3) and detectCorners() (T4) — it must NOT reimplement braking or corner
 * detection, only match onsets to clustered corners and compute a
 * reference-vs-each "braked N metres later" delta.
 *
 * Run: npm test (or: node --test) from userscripts/ or userscripts/test/.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SR_TRACK = require('../src/sr-track.js');
const { loadFixture } = require('./fixture-helpers.js');

const FIXTURE_FILE = 'compare-122145-3-63254-5.json';

// ---------------------------------------------------------------------------
// Synthetic lap builder: one corner (lean+speed dip) preceded by a braking
// zone (col4 dip) at a controllable offset upstream of the corner apex, so
// the resulting onset dist is deterministic-ish and comparable across riders.
// ---------------------------------------------------------------------------
/**
 * @param {number} n total samples
 * @param {object} opts
 *   brakeRange: [startIdx, endIdxInclusive] — braking zone (col4 dip)
 *   cornerRange: [startIdx, endIdxInclusive] — corner zone (lean+speed dip)
 * `opts.brakeCol4` controls the deceleration magnitude during the brake range
 * (default -6 m/s², a hard brake that reliably trips a T3 onset). Passing a
 * small magnitude (e.g. -0.2) keeps the distance profile close to a "real"
 * braking rider's while staying below the onset trigger, i.e. an onset-free
 * rider whose lap distance still lines up with one who actually brakes hard.
 *
 * @returns {Array<Array<number>>}
 */
function buildLapWithBrakeAndCorner(n, opts) {
  opts = opts || {};
  const latStep = 0.0001;
  const lngStep = 0.0001;
  const startLat = 45;
  const startLng = 10;
  const straightSpeed = opts.straightSpeed != null ? opts.straightSpeed : 90; // mph
  const speedDip = opts.speedDip != null ? opts.speedDip : 40; // mph at apex
  const leanPeak = opts.leanPeak != null ? opts.leanPeak : 40; // deg at apex
  const leanFlat = 3;
  const brakeRange = opts.brakeRange;
  const cornerRange = opts.cornerRange;
  const brakeCol4 = opts.brakeCol4 != null ? opts.brakeCol4 : -6; // m/s² during brakeRange
  const brakeDecel = opts.brakeCol4 != null && opts.brakeCol4 > -1 ? 0.1 : 2.2; // mph/sample

  function inRange(i, range) { return range && i >= range[0] && i <= range[1]; }

  const rows = [];
  let d = 0;
  let v = straightSpeed;
  for (let i = 0; i < n; i++) {
    const braking = inRange(i, brakeRange);
    let lean = leanFlat;

    if (inRange(i, cornerRange)) {
      const [lo, hi] = cornerRange;
      const mid = (lo + hi) / 2;
      const half = Math.max(1, (hi - lo) / 2);
      const t = 1 - Math.min(1, Math.abs(i - mid) / half);
      lean = leanFlat + t * (leanPeak - leanFlat);
    }

    const col4 = braking ? brakeCol4 : 0.4;
    if (braking) {
      v = Math.max(speedDip, v - brakeDecel);
    } else if (v < straightSpeed) {
      v = Math.min(straightSpeed, v + 0.3);
    }

    const lat = startLat + i * latStep;
    const lng = startLng + i * lngStep;
    rows.push([lat, lng, v, d, col4, lean]);
    d += v * SR_TRACK.DEFAULT_CFG.MPH_TO_MS * SR_TRACK.DEFAULT_CFG.DT;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Seam / export checks
// ---------------------------------------------------------------------------
describe('SR_TRACK.buildCompareEvents seam', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof SR_TRACK.buildCompareEvents, 'function');
  });

  it('DEFAULT_CFG carries the new delta-match window keys, overridable', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    assert.strictEqual(typeof cfg.DELTA_MATCH_WINDOW, 'number');
    assert.strictEqual(typeof cfg.DELTA_MATCH_FORWARD, 'number');
    assert.ok(cfg.DELTA_MATCH_WINDOW > 0);
  });

  it('does not mutate DEFAULT_CFG when called with an override', () => {
    const before = JSON.stringify(SR_TRACK.DEFAULT_CFG);
    const riderA = buildLapWithBrakeAndCorner(200, { brakeRange: [60, 80], cornerRange: [90, 110] });
    SR_TRACK.buildCompareEvents([riderA], { DELTA_MATCH_WINDOW: 200 });
    assert.strictEqual(JSON.stringify(SR_TRACK.DEFAULT_CFG), before);
  });
});

// ---------------------------------------------------------------------------
// Synthetic: known braking-delta magnitude and sign
// ---------------------------------------------------------------------------
describe('buildCompareEvents: synthetic braking-point delta correctness', () => {
  it('rider B (brakes later / closer to the corner) is reported as braking N m later than rider A', () => {
    const cornerRange = [140, 160];
    // Rider A brakes early (starts at idx 108); rider B brakes later (idx 122).
    // Both brake zones end at the same idx (138, just before the corner) so
    // only the ONSET (start of braking) distance differs between riders.
    const riderA = buildLapWithBrakeAndCorner(220, { brakeRange: [108, 138], cornerRange });
    const riderB = buildLapWithBrakeAndCorner(220, { brakeRange: [122, 138], cornerRange });

    const result = SR_TRACK.buildCompareEvents([riderA, riderB]);

    assert.strictEqual(result.corners.length, 1, `expected exactly 1 clustered corner, got ${result.corners.length}`);
    const corner = result.corners[0];

    assert.ok(corner.brakeDelta, 'expected a non-null brakeDelta for this corner');
    assert.strictEqual(corner.brakeDelta.referenceRider, 0, 'rider A (earlier braker) should be the reference');
    assert.strictEqual(corner.brakeDelta.entries.length, 1);
    assert.strictEqual(corner.brakeDelta.entries[0].riderIndex, 1);
    assert.ok(corner.brakeDelta.entries[0].metresLater > 0,
      `rider B braked later so metresLater should be positive, got ${corner.brakeDelta.entries[0].metresLater}`);

    // Cross-check against the raw onset dists directly (ground truth).
    const onsetsA = result.onsets[0];
    const onsetsB = result.onsets[1];
    assert.ok(onsetsA.length >= 1 && onsetsB.length >= 1, 'both riders should have at least one onset');
    const expectedDelta = onsetsB[onsetsB.length - 1].dist - onsetsA[onsetsA.length - 1].dist;
    assert.ok(Math.abs(corner.brakeDelta.entries[0].metresLater - expectedDelta) < 1e-6);
  });

  it('perRider entries carry minSpeed for every present rider regardless of brake-match outcome', () => {
    const cornerRange = [140, 160];
    const riderA = buildLapWithBrakeAndCorner(220, { brakeRange: [122, 138], cornerRange, speedDip: 35 });
    const riderB = buildLapWithBrakeAndCorner(220, { brakeRange: [122, 138], cornerRange, speedDip: 50 });

    const result = SR_TRACK.buildCompareEvents([riderA, riderB]);
    const corner = result.corners[0];
    const present = corner.perRider.filter((p) => p !== null);
    assert.strictEqual(present.length, 2);
    for (const p of present) {
      assert.ok(Number.isFinite(p.minSpeed) && p.minSpeed > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Rider with no matched onset for a corner
// ---------------------------------------------------------------------------
describe('buildCompareEvents: rider with no matched onset is excluded gracefully', () => {
  it('a rider who never brakes near the corner gets brakePointDist:null, excluded from delta, no throw', () => {
    const cornerRange = [140, 160];
    // Rider A brakes hard (idx 122-138) into the corner -> one onset.
    const riderA = buildLapWithBrakeAndCorner(220, { brakeRange: [122, 138], cornerRange });
    // Rider B decelerates too gently to trip an onset (brakeCol4 well above
    // BRAKE_ONSET_ENTER), but the same speed/timing shape keeps its corner
    // span's distance close enough to riderA's to still cluster together.
    const riderB = buildLapWithBrakeAndCorner(220, { brakeRange: [122, 138], cornerRange, brakeCol4: -0.2 });

    assert.doesNotThrow(() => {
      const result = SR_TRACK.buildCompareEvents([riderA, riderB]);
      assert.strictEqual(result.corners.length, 1, `expected 1 clustered corner, got ${result.corners.length}`);
      assert.deepStrictEqual(result.onsets[1], [], 'rider B should have zero onsets');
      const corner = result.corners[0];

      const riderAEntry = corner.perRider[0];
      const riderBEntry = corner.perRider[1];
      assert.ok(riderAEntry, 'rider A should be present at this corner');
      assert.ok(Number.isFinite(riderAEntry.brakePointDist), 'rider A should have a matched brake point');

      // Rider B might still be phantom-rejected if their corner span is too
      // shallow to cluster; only assert brakePointDist:null when present.
      if (riderBEntry) {
        assert.strictEqual(riderBEntry.brakePointDist, null);
      }

      // With <2 matched riders, brakeDelta must be null; rider B must never
      // appear in any delta entries.
      assert.strictEqual(corner.brakeDelta, null);
    });
  });

  it('brakeDelta is null when fewer than 2 riders have a matched brake point', () => {
    const cornerRange = [140, 160];
    const riderA = buildLapWithBrakeAndCorner(220, { brakeRange: [122, 138], cornerRange });
    const riderB = buildLapWithBrakeAndCorner(220, { brakeRange: [122, 138], cornerRange, brakeCol4: -0.2 });

    const result = SR_TRACK.buildCompareEvents([riderA, riderB]);
    const corner = result.corners[0];
    const matchedCount = corner.perRider.filter((p) => p && p.brakePointDist !== null).length;
    assert.ok(matchedCount < 2, 'sanity: this synthetic setup should yield <2 matched brake points');
    assert.strictEqual(corner.brakeDelta, null);
  });
});

// ---------------------------------------------------------------------------
// Stable shape for 2, 3, 4 riders
// ---------------------------------------------------------------------------
describe('buildCompareEvents: stable output shape for 2-4 riders', () => {
  function makeRiders(count) {
    const cornerRange = [140, 160];
    const riders = [];
    for (let i = 0; i < count; i++) {
      riders.push(buildLapWithBrakeAndCorner(220, {
        brakeRange: [70 + i * 10, 130 + i * 5],
        cornerRange,
        leanPeak: 40 - i * 2,
        speedDip: 40 + i * 3,
      }));
    }
    return riders;
  }

  for (const count of [2, 3, 4]) {
    it(`produces a well-formed result for ${count} riders`, () => {
      const riders = makeRiders(count);
      const result = SR_TRACK.buildCompareEvents(riders);

      assert.ok(Array.isArray(result.onsets));
      assert.strictEqual(result.onsets.length, count);
      for (const riderOnsets of result.onsets) {
        assert.ok(Array.isArray(riderOnsets));
      }

      assert.ok(Array.isArray(result.corners));
      for (const corner of result.corners) {
        assert.ok(Number.isFinite(corner.dist));
        assert.ok(Array.isArray(corner.perRider));
        assert.strictEqual(corner.perRider.length, count);

        for (const p of corner.perRider) {
          if (p === null) continue;
          assert.ok(Number.isFinite(p.riderIndex));
          assert.ok(Number.isFinite(p.minSpeed));
          assert.ok(Number.isFinite(p.apexLat));
          assert.ok(Number.isFinite(p.apexLng));
          assert.ok(Number.isFinite(p.entryDist));
          assert.ok(p.brakePointDist === null || Number.isFinite(p.brakePointDist));
        }

        if (corner.brakeDelta) {
          assert.ok(Number.isFinite(corner.brakeDelta.referenceRider));
          assert.ok(Array.isArray(corner.brakeDelta.entries));
          for (const e of corner.brakeDelta.entries) {
            assert.ok(Number.isFinite(e.riderIndex));
            assert.ok(Number.isFinite(e.metresLater));
            assert.ok(e.metresLater >= -1e-6, 'reference should be the earliest braker (metresLater >= 0)');
            assert.notStrictEqual(e.riderIndex, corner.brakeDelta.referenceRider);
          }
        } else {
          assert.ok(corner.brakeDelta === null);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('buildCompareEvents: edge cases do not throw', () => {
  it('empty riders array -> onsets:[] corners:[]', () => {
    const result = SR_TRACK.buildCompareEvents([]);
    assert.deepStrictEqual(result, { onsets: [], corners: [] });
  });

  it('undefined/null riders -> onsets:[] corners:[]', () => {
    assert.deepStrictEqual(SR_TRACK.buildCompareEvents(undefined), { onsets: [], corners: [] });
    assert.deepStrictEqual(SR_TRACK.buildCompareEvents(null), { onsets: [], corners: [] });
  });

  it('single rider -> corners have no brakeDelta (nothing to compare against)', () => {
    const riderA = buildLapWithBrakeAndCorner(220, { brakeRange: [90, 130], cornerRange: [140, 160] });
    const result = SR_TRACK.buildCompareEvents([riderA]);

    assert.strictEqual(result.onsets.length, 1);
    for (const corner of result.corners) {
      assert.strictEqual(corner.perRider.length, 1);
      assert.strictEqual(corner.brakeDelta, null, 'a single rider can never produce a brake delta');
    }
  });

  it('short/too-short rider data does not throw', () => {
    const shortRider = [[45, 10, 60, 0, 0, 0], [45.0001, 10.0001, 58, 5, -6, 1]];
    assert.doesNotThrow(() => {
      const result = SR_TRACK.buildCompareEvents([shortRider, shortRider]);
      assert.ok(Array.isArray(result.onsets));
      assert.ok(Array.isArray(result.corners));
    });
  });

  it('a rider entry that is an empty array does not throw', () => {
    assert.doesNotThrow(() => {
      const result = SR_TRACK.buildCompareEvents([[], []]);
      assert.strictEqual(result.onsets.length, 2);
      assert.deepStrictEqual(result.onsets[0], []);
      assert.deepStrictEqual(result.corners, []);
    });
  });

  it('NaN-laden rows do not throw and produce finite fields only', () => {
    const cornerRange = [80, 100];
    const riderA = buildLapWithBrakeAndCorner(180, { brakeRange: [30, 60], cornerRange });
    const riderB = buildLapWithBrakeAndCorner(180, { brakeRange: [40, 70], cornerRange });
    riderA[10] = [NaN, 10.001, NaN, 100, NaN, NaN];
    riderB[20][4] = NaN; // longAccel
    riderB[21][2] = NaN; // speed
    riderA[22][0] = NaN; // lat
    riderA[22][1] = NaN; // lng

    assert.doesNotThrow(() => {
      const result = SR_TRACK.buildCompareEvents([riderA, riderB]);
      for (const corner of result.corners) {
        assert.ok(Number.isFinite(corner.dist));
        for (const p of corner.perRider) {
          if (!p) continue;
          assert.ok(Number.isFinite(p.minSpeed));
          assert.ok(Number.isFinite(p.apexLat));
          assert.ok(Number.isFinite(p.apexLng));
          assert.ok(Number.isFinite(p.entryDist));
          assert.ok(p.brakePointDist === null || Number.isFinite(p.brakePointDist));
        }
        if (corner.brakeDelta) {
          for (const e of corner.brakeDelta.entries) {
            assert.ok(Number.isFinite(e.metresLater));
          }
        }
      }
    });
  });

  it('all-NaN rider rows do not throw', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push([NaN, NaN, NaN, NaN, NaN, NaN]);
    assert.doesNotThrow(() => {
      const result = SR_TRACK.buildCompareEvents([rows, rows]);
      assert.ok(Array.isArray(result.onsets));
      assert.ok(Array.isArray(result.corners));
    });
  });
});

// ---------------------------------------------------------------------------
// _matchOnsetToCorner / _computeBrakeDelta unit-level checks
// ---------------------------------------------------------------------------
describe('buildCompareEvents: internal helpers', () => {
  it('_matchOnsetToCorner picks the nearest onset within the backward/forward window', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    const onsets = [{ dist: 50 }, { dist: 90 }, { dist: 300 }];
    const match = SR_TRACK._matchOnsetToCorner(onsets, 100, cfg);
    assert.strictEqual(match.dist, 90);
  });

  it('_matchOnsetToCorner returns null when nothing is in the window', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    const onsets = [{ dist: 10 }];
    const match = SR_TRACK._matchOnsetToCorner(onsets, 1000, cfg);
    assert.strictEqual(match, null);
  });

  it('_matchOnsetToCorner handles empty/null onsets without throwing', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    assert.strictEqual(SR_TRACK._matchOnsetToCorner([], 100, cfg), null);
    assert.strictEqual(SR_TRACK._matchOnsetToCorner(null, 100, cfg), null);
  });

  it('_computeBrakeDelta returns null for 0 or 1 matched riders', () => {
    assert.strictEqual(SR_TRACK._computeBrakeDelta([]), null);
    assert.strictEqual(SR_TRACK._computeBrakeDelta([{ riderIndex: 0, brakePointDist: 50 }]), null);
    assert.strictEqual(SR_TRACK._computeBrakeDelta([
      { riderIndex: 0, brakePointDist: 50 },
      { riderIndex: 1, brakePointDist: null },
    ]), null);
  });

  it('_computeBrakeDelta: reference-vs-each for 4 matched riders', () => {
    const riderBrakePoints = [
      { riderIndex: 0, brakePointDist: 100 }, // reference (earliest)
      { riderIndex: 1, brakePointDist: 110 },
      { riderIndex: 2, brakePointDist: 130 },
      { riderIndex: 3, brakePointDist: 105 },
    ];
    const delta = SR_TRACK._computeBrakeDelta(riderBrakePoints);
    assert.strictEqual(delta.referenceRider, 0);
    assert.strictEqual(delta.entries.length, 3);
    const byRider = Object.fromEntries(delta.entries.map((e) => [e.riderIndex, e.metresLater]));
    assert.ok(Math.abs(byRider[1] - 10) < 1e-9);
    assert.ok(Math.abs(byRider[2] - 30) < 1e-9);
    assert.ok(Math.abs(byRider[3] - 5) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Fixture smoke test
// ---------------------------------------------------------------------------
describe('buildCompareEvents: smoke test on real fixture', () => {
  it('returns corners with per-rider min speeds and at least some non-null brake deltas', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);

    const result = SR_TRACK.buildCompareEvents(riders);

    assert.strictEqual(result.onsets.length, riders.length);
    for (const riderOnsets of result.onsets) {
      assert.ok(Array.isArray(riderOnsets));
      assert.ok(riderOnsets.length > 5 && riderOnsets.length < 60,
        `expected a plausible onset count, got ${riderOnsets.length}`);
    }

    assert.ok(result.corners.length > 6 && result.corners.length < 22,
      `expected a plausible corner count, got ${result.corners.length}`);

    let nonNullDeltaCount = 0;
    for (const corner of result.corners) {
      assert.ok(Number.isFinite(corner.dist));
      const present = corner.perRider.filter((p) => p !== null);
      assert.ok(present.length >= 1);
      for (const p of present) {
        assert.ok(Number.isFinite(p.minSpeed) && p.minSpeed > 0);
      }
      if (corner.brakeDelta) {
        nonNullDeltaCount++;
        assert.ok(Number.isFinite(corner.brakeDelta.referenceRider));
        for (const e of corner.brakeDelta.entries) {
          assert.ok(Number.isFinite(e.metresLater));
          assert.ok(e.metresLater >= -1e-6);
        }
      }
    }

    assert.ok(nonNullDeltaCount > 0,
      'expected at least some corners with a non-null brake delta on the real fixture');
  });

  it('corners stay sorted by distance (inherited from detectCorners)', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const result = SR_TRACK.buildCompareEvents(riders);
    for (let i = 1; i < result.corners.length; i++) {
      assert.ok(result.corners[i].dist >= result.corners[i - 1].dist);
    }
  });
});
