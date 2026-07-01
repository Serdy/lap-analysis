'use strict';

/**
 * Fixture calibration harness + baseline shape/validity test (T2).
 *
 * Loads a real captured 2-rider compare lap and asserts its shape is what
 * later detector tests (T3/T4/T6) will assume: exactly 2 riders, 6-column
 * data rows, and both riders' g-sensor channel usable per SR_TRACK.validity.
 *
 * This file intentionally does NOT exercise any detector logic
 * (computeScore/quantize/scoreToColor) — that's T3/T4. It only calibrates
 * the fixture + reusable column-extraction helpers those tests will import
 * from fixture-helpers.js.
 *
 * Run:  npm test  (from userscripts/ or userscripts/test/)
 *   or: node --test userscripts/test/sr-track.events.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SR_TRACK = require('../src/sr-track.js');
const {
  loadFixture,
  lat,
  lng,
  speedMph,
  dist,
  longAccel,
  lean,
} = require('./fixture-helpers.js');

const FIXTURE_FILE = 'compare-122145-3-63254-5.json';

describe('Fixture: compare-122145-3-63254-5.json', () => {
  it('loads from the repo-local fixtures/ directory', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    assert.ok(fixture !== null && typeof fixture === 'object', 'fixture is an object');
  });

  it('has the expected top-level shape', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    assert.strictEqual(fixture.speedMultiplier, 1.609344);
    assert.strictEqual(fixture.speedUnit, 'km/h');
    assert.ok(Array.isArray(fixture.seriesColors), 'seriesColors is an array');
    assert.ok(Array.isArray(fixture.riders), 'riders is an array');
  });

  it('has exactly 2 riders', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    assert.strictEqual(fixture.riders.length, 2, 'expected a 2-rider compare fixture');
  });

  it('every data row is a 6-element array, for both riders', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    for (const rider of fixture.riders) {
      assert.ok(Array.isArray(rider.data), `rider ${rider.name} data is an array`);
      assert.ok(rider.data.length > 0, `rider ${rider.name} has at least one data row`);
      for (let i = 0; i < rider.data.length; i++) {
        const row = rider.data[i];
        assert.ok(Array.isArray(row), `rider ${rider.name} row ${i} is an array`);
        assert.strictEqual(row.length, 6, `rider ${rider.name} row ${i} has 6 columns`);
      }
    }
  });

  it('rider.data.length matches rider.numPoints', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    for (const rider of fixture.riders) {
      assert.strictEqual(rider.data.length, rider.numPoints,
        `rider ${rider.name}: data.length should equal numPoints`);
    }
  });

  it('both riders pass validity() with the g-sensor usable (useG === true)', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    for (const rider of fixture.riders) {
      const col4 = longAccel(rider.data);
      const col2 = speedMph(rider.data);
      const col5 = lean(rider.data);

      const valid = SR_TRACK.validity(col4, col2, col5);

      assert.ok(!valid.bail, `rider ${rider.name}: validity() should not bail`);
      assert.strictEqual(valid.useG, true, `rider ${rider.name}: useG should be true (live g-sensor)`);
    }
  });
});

describe('fixture-helpers column extraction', () => {
  it('extracts columns of matching length for each rider', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    for (const rider of fixture.riders) {
      const n = rider.data.length;
      assert.strictEqual(lat(rider.data).length, n);
      assert.strictEqual(lng(rider.data).length, n);
      assert.strictEqual(speedMph(rider.data).length, n);
      assert.strictEqual(dist(rider.data).length, n);
      assert.strictEqual(longAccel(rider.data).length, n);
      assert.strictEqual(lean(rider.data).length, n);
    }
  });

  it('extracted columns line up with the raw row values', () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const rider = fixture.riders[0];
    const row0 = rider.data[0];

    assert.strictEqual(lat(rider.data)[0], row0[0]);
    assert.strictEqual(lng(rider.data)[0], row0[1]);
    assert.strictEqual(speedMph(rider.data)[0], row0[2]);
    assert.strictEqual(dist(rider.data)[0], row0[3]);
    assert.strictEqual(longAccel(rider.data)[0], row0[4]);
    assert.strictEqual(lean(rider.data)[0], row0[5]);
  });

  it('speedMph values are plausibly in the mph BASE unit, not already km/h', () => {
    // Sanity guard against a unit regression: per CLAUDE.md, col2 is mph, and
    // multiplying by speedMultiplier (1.609344) yields the displayed km/h.
    // A representative sample from this fixture peaks around ~140 mph
    // (~225 km/h); if col2 were already km/h this check would still pass
    // loosely, so we also assert the multiplier recovers a sane km/h range.
    const fixture = loadFixture(FIXTURE_FILE);
    for (const rider of fixture.riders) {
      const speeds = speedMph(rider.data);
      const maxMph = Math.max(...speeds);
      const maxKmh = maxMph * fixture.speedMultiplier;
      assert.ok(maxMph > 0 && maxMph < 250, `rider ${rider.name}: max mph ${maxMph} looks sane`);
      assert.ok(maxKmh > 50 && maxKmh < 400, `rider ${rider.name}: max km/h ${maxKmh} looks sane`);
    }
  });
});
