'use strict';

/**
 * T6 — calibration regression test.
 *
 * T3 (detectBrakingOnsets), T4 (detectCorners), and T5 (buildCompareEvents)
 * shipped with placeholder DEFAULT_CFG thresholds and only loose smoke tests
 * ("some plausible range") on the real captured fixture. T6's job was to
 * calibrate those thresholds against the real fixture so the headline
 * coaching feature — "who braked later into the corner" — actually produces
 * a delta for most corners instead of 2 out of 13.
 *
 * This file PINS the calibrated behaviour so a future change to DEFAULT_CFG
 * (or an accidental logic regression) is caught immediately, instead of
 * silently degrading brake-delta coverage again. Tolerances are kept loose
 * enough to survive trivial refactors (e.g. reordering internal loops) but
 * tight enough to catch a real threshold regression.
 *
 * Baseline (pre-calibration, T3/T4/T5 placeholder defaults):
 *   - detectBrakingOnsets: rider0 -> 9 onsets, rider1 -> 14 onsets
 *   - detectCorners: 13 clustered corners
 *   - buildCompareEvents: only 2/13 corners had a non-null brakeDelta
 *
 * Calibrated (this file pins the new numbers):
 *   - detectBrakingOnsets: rider0 -> 13 onsets, rider1 -> 14 onsets
 *   - detectCorners: 13 clustered corners (unchanged — corner detection was
 *     already healthy; only the onset/match thresholds needed calibration)
 *   - buildCompareEvents: 13/13 corners now have a non-null brakeDelta
 *
 * What changed and why (see DEFAULT_CFG comments in sr-track.js for detail):
 *   - BRAKE_ONSET_ENTER: -0.35 -> -0.12. The old threshold missed genuine
 *     GENTLE braking (real col4 dips of -2..-2.6 m/s2, e.g. a light dab into
 *     a fast corner) because the fused score never crossed -0.35 for those.
 *   - BRAKE_ONSET_EXIT: -0.15 -> -0.10. Must stay numerically > ENTER
 *     (shallower) for Schmitt-trigger hysteresis; re-tightened to a 0.02 gap
 *     now that ENTER itself sits close to zero.
 *   - DELTA_MATCH_WINDOW: 120 -> 370. On the real fixture, a single braking
 *     onset commonly covers a long continuous braking zone feeding one apex
 *     of a multi-corner combo (observed onset-to-apex spans up to ~310m).
 *     120m was too short to reach the onset that actually explains a given
 *     corner. 370 was chosen via brute-force search as comfortably inside a
 *     [340, 420+] plateau that matches every corner with ZERO onsets reused
 *     across two different corners (reuse would fabricate a bogus delta for
 *     whichever corner didn't really own that onset — verified by hand this
 *     does NOT happen at 370 on this fixture).
 *
 * Per-corner co-braking breakdown at the calibrated defaults (both riders
 * present at all 13 clustered corners on this fixture):
 *   - 13 corners: BOTH riders have a matched brake point -> non-null delta.
 *   - 0 corners: exactly one rider brakes, the other coasts/lifts only
 *     (none observed on this particular fixture at the calibrated
 *     thresholds; earlier, stricter thresholds had several such corners,
 *     but manual inspection of the raw col4/speed traces showed the
 *     "missing" rider WAS genuinely braking, just gently -- see report).
 *   - 0 corners: neither rider brakes (this fixture's clustered corners all
 *     require at least a lift/brake from both riders, per detectCorners'
 *     phantom-rejection already excluding corners only one rider takes).
 *
 * Run: npm test (or: node --test) from userscripts/ or userscripts/test/.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SR_TRACK = require('../src/sr-track.js');
const { loadFixture } = require('./fixture-helpers.js');

const FIXTURE_FILE = 'compare-122145-3-63254-5.json';
const MPH_TO_KMH = 1.609344;

describe('T6 calibration: DEFAULT_CFG pins the tuned thresholds', () => {
  it('BRAKE_ONSET_ENTER/EXIT are calibrated, not the T3 placeholder values', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    assert.ok(Math.abs(cfg.BRAKE_ONSET_ENTER - (-0.12)) < 1e-9,
      `BRAKE_ONSET_ENTER should be calibrated to -0.12, got ${cfg.BRAKE_ONSET_ENTER}`);
    assert.ok(Math.abs(cfg.BRAKE_ONSET_EXIT - (-0.10)) < 1e-9,
      `BRAKE_ONSET_EXIT should be calibrated to -0.10, got ${cfg.BRAKE_ONSET_EXIT}`);
    assert.ok(cfg.BRAKE_ONSET_ENTER < cfg.BRAKE_ONSET_EXIT,
      'hysteresis invariant must still hold after calibration');
  });

  it('DELTA_MATCH_WINDOW is calibrated, not the T5 placeholder value', () => {
    const cfg = SR_TRACK.DEFAULT_CFG;
    assert.ok(Math.abs(cfg.DELTA_MATCH_WINDOW - 370) < 1e-9,
      `DELTA_MATCH_WINDOW should be calibrated to 370, got ${cfg.DELTA_MATCH_WINDOW}`);
  });
});

describe('T6 calibration: onset counts on the real fixture (pinned, tight band)', () => {
  it('rider0 (SERDIUK, 156.12s) produces 13 onsets, +-1', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const onsets = SR_TRACK.detectBrakingOnsets(fixture.riders[0].data);
    assert.ok(Math.abs(onsets.length - 13) <= 1,
      `expected 13 +-1 onsets for rider0, got ${onsets.length}`);
  });

  it('rider1 (LEEK74, 130.33s) produces 14 onsets, +-1', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const onsets = SR_TRACK.detectBrakingOnsets(fixture.riders[1].data);
    assert.ok(Math.abs(onsets.length - 14) <= 1,
      `expected 14 +-1 onsets for rider1, got ${onsets.length}`);
  });
});

describe('T6 calibration: clustered corner count stays plausible for Brno GP', () => {
  it('detectCorners still finds 13 corners, +-2 (calibration targeted onsets/matching, not corner detection)', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const clustered = SR_TRACK.detectCorners(riders);
    assert.ok(Math.abs(clustered.length - 13) <= 2,
      `expected 13 +-2 clustered corners, got ${clustered.length}`);
  });
});

describe('T6 calibration: brake-delta coverage is measurably improved over the 2/13 baseline', () => {
  it('at least 10 of the clustered corners now have a non-null brakeDelta', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const result = SR_TRACK.buildCompareEvents(riders);

    let withDelta = 0;
    for (const corner of result.corners) {
      if (corner.brakeDelta) withDelta++;
    }

    assert.ok(withDelta >= 10,
      `expected >=10/${result.corners.length} corners with a non-null brakeDelta ` +
      `(pre-calibration baseline was 2/13), got ${withDelta}`);
  });

  it('no two different corners share the same matched onset for the same rider (no cross-corner reuse)', () => {
    // A wide DELTA_MATCH_WINDOW risks the SAME onset being "closest" to two
    // different corners, which would silently fabricate a brakeDelta for
    // whichever corner doesn't really own that onset. This is the specific
    // failure mode T6 checked for when calibrating DELTA_MATCH_WINDOW.
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const result = SR_TRACK.buildCompareEvents(riders);

    const seen = new Map(); // "riderIndex:brakePointDist" -> count of corners using it
    for (const corner of result.corners) {
      for (const p of corner.perRider) {
        if (!p || p.brakePointDist === null) continue;
        const key = p.riderIndex + ':' + p.brakePointDist.toFixed(1);
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    const reused = [...seen.entries()].filter(([, count]) => count > 1);
    assert.deepStrictEqual(reused, [],
      `expected zero onsets reused across corners, found: ${JSON.stringify(reused)}`);
  });
});

describe('T6 calibration: spot-checked corner against raw telemetry', () => {
  it('corner 12 (last corner, ~4983m): both riders present, minSpeed and brakeDelta match hand-verified values', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const result = SR_TRACK.buildCompareEvents(riders);

    // Corner index is stable because detectCorners output is sorted by dist
    // and corner detection itself was not recalibrated (13 corners, unchanged
    // order) -- but assert the corner exists near the expected distance first
    // so a shift in corner count/order fails loudly instead of silently
    // checking the wrong corner.
    const corner = result.corners.find((c) => Math.abs(c.dist - 4982.7) < 20);
    assert.ok(corner, 'expected a clustered corner near dist=4983m');

    const r0 = corner.perRider[0];
    const r1 = corner.perRider[1];
    assert.ok(r0 && r1, 'both riders should be present at this corner');

    const r0Kmh = r0.minSpeed * MPH_TO_KMH;
    const r1Kmh = r1.minSpeed * MPH_TO_KMH;
    assert.ok(Math.abs(r0Kmh - 95.6) < 1.5,
      `rider0 minSpeed should be ~95.6 km/h, got ${r0Kmh.toFixed(1)}`);
    assert.ok(Math.abs(r1Kmh - 106.4) < 1.5,
      `rider1 minSpeed should be ~106.4 km/h, got ${r1Kmh.toFixed(1)}`);

    assert.ok(corner.brakeDelta, 'expected a non-null brakeDelta for this corner');
    assert.strictEqual(corner.brakeDelta.referenceRider, 0,
      'rider0 should be the reference (earliest) braker at this corner');
    assert.strictEqual(corner.brakeDelta.entries.length, 1);
    assert.strictEqual(corner.brakeDelta.entries[0].riderIndex, 1);
    assert.ok(Math.abs(corner.brakeDelta.entries[0].metresLater - 8.82) < 3,
      `rider1 should brake ~8.8m later than rider0, got ${corner.brakeDelta.entries[0].metresLater.toFixed(2)}`);

    // Cross-check the delta directly against the raw matched brake-point
    // distances so this test fails if the delta math itself ever drifts,
    // not just if the calibrated thresholds move the matched onsets.
    const expectedDelta = r1.brakePointDist - r0.brakePointDist;
    assert.ok(Math.abs(corner.brakeDelta.entries[0].metresLater - expectedDelta) < 1e-6);
  });

  it('corner 2 (~1646m): both riders present with a small, plausible brakeDelta', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const result = SR_TRACK.buildCompareEvents(riders);

    const corner = result.corners.find((c) => Math.abs(c.dist - 1645.8) < 20);
    assert.ok(corner, 'expected a clustered corner near dist=1646m');

    const r0 = corner.perRider[0];
    const r1 = corner.perRider[1];
    assert.ok(r0 && r1, 'both riders should be present at this corner');

    const r0Kmh = r0.minSpeed * MPH_TO_KMH;
    const r1Kmh = r1.minSpeed * MPH_TO_KMH;
    assert.ok(Math.abs(r0Kmh - 91.6) < 1.5, `rider0 minSpeed should be ~91.6 km/h, got ${r0Kmh.toFixed(1)}`);
    assert.ok(Math.abs(r1Kmh - 101.7) < 1.5, `rider1 minSpeed should be ~101.7 km/h, got ${r1Kmh.toFixed(1)}`);

    assert.ok(corner.brakeDelta, 'expected a non-null brakeDelta for this corner');
    assert.strictEqual(corner.brakeDelta.referenceRider, 0);
    assert.ok(Math.abs(corner.brakeDelta.entries[0].metresLater - 1.3) < 3,
      `rider1 should brake ~1.3m later than rider0, got ${corner.brakeDelta.entries[0].metresLater.toFixed(2)}`);
  });
});

describe('T6 calibration: pre-existing invariants still hold at the new thresholds', () => {
  it('onsets stay ordered by increasing distance for both riders', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    for (const rider of fixture.riders) {
      const onsets = SR_TRACK.detectBrakingOnsets(rider.data);
      for (let i = 1; i < onsets.length; i++) {
        assert.ok(onsets[i].dist >= onsets[i - 1].dist);
      }
    }
  });

  it('detectCorners cross-rider clustering is still order-independent at the new thresholds', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const forward = SR_TRACK.detectCorners(riders);
    const swapped = SR_TRACK.detectCorners([riders[1], riders[0]]);
    assert.strictEqual(forward.length, swapped.length);
    const forwardDists = forward.map((c) => c.dist.toFixed(2));
    const swappedDists = swapped.map((c) => c.dist.toFixed(2));
    assert.deepStrictEqual(forwardDists, swappedDists);
  });

  it('every brakeDelta entry still has metresLater >= 0 (reference is always the earliest braker)', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const riders = fixture.riders.map((r) => r.data);
    const result = SR_TRACK.buildCompareEvents(riders);
    for (const corner of result.corners) {
      if (!corner.brakeDelta) continue;
      for (const entry of corner.brakeDelta.entries) {
        assert.ok(entry.metresLater >= -1e-6);
      }
    }
  });
});
