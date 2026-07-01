'use strict';

/**
 * fixture-helpers.js — shared fixture loading + column-extraction helpers.
 *
 * Reused across sr-track.events.test.js (T2) and later detector tests
 * (T3/T4/T6) so every test that consumes the captured compare fixture goes
 * through the same loading/shape logic instead of re-deriving it.
 *
 * Column layout for riders[i].data rows (per CLAUDE.md):
 *   [0] lat, [1] lng, [2] speed (mph BASE unit), [3] cumulativeDistance (m),
 *   [4] longAccel (m/s²), [5] leanAngle (°, clamped to ±40)
 */

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

/**
 * Load a fixture JSON file from userscripts/test/fixtures/ by filename.
 * Throws a clear, actionable error if the file is missing.
 * @param {string} filename e.g. 'compare-122145-3-63254-5.json'
 * @returns {object} parsed fixture object
 */
function loadFixture(filename) {
  const filePath = path.join(FIXTURE_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Fixture not found: ${filePath}\n` +
      `Expected a repo-local fixture at userscripts/test/fixtures/${filename}. ` +
      `Fixtures must be committed to the repo (not loaded from a scratchpad/temp path) ` +
      `so tests stay reproducible.`
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/** @param {Array<Array<number>>} data rider.data rows -> array of lat (col 0) */
function lat(data) { return data.map((row) => row[0]); }

/** @param {Array<Array<number>>} data rider.data rows -> array of lng (col 1) */
function lng(data) { return data.map((row) => row[1]); }

/** @param {Array<Array<number>>} data rider.data rows -> array of speed in mph BASE unit (col 2) */
function speedMph(data) { return data.map((row) => row[2]); }

/** @param {Array<Array<number>>} data rider.data rows -> array of cumulative distance in metres (col 3) */
function dist(data) { return data.map((row) => row[3]); }

/** @param {Array<Array<number>>} data rider.data rows -> array of longitudinal accel in m/s² (col 4) */
function longAccel(data) { return data.map((row) => row[4]); }

/** @param {Array<Array<number>>} data rider.data rows -> array of lean angle in degrees (col 5) */
function lean(data) { return data.map((row) => row[5]); }

module.exports = {
  FIXTURE_DIR,
  loadFixture,
  lat,
  lng,
  speedMph,
  dist,
  longAccel,
  lean,
};
