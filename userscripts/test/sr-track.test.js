'use strict';

/**
 * Unit tests for SR_TRACK (userscripts/src/sr-track.js).
 *
 * Run:  node --test  (from this directory)
 *   or: npm test
 *
 * Uses only Node built-ins: node:test + node:assert.  No npm install required.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SR_TRACK = require('../src/sr-track.js');

// ---------------------------------------------------------------------------
// Seam smoke test: the import itself must work and expose all four methods.
// ---------------------------------------------------------------------------
describe('SR_TRACK module seam', () => {
  it('exports an object with the four expected methods', () => {
    assert.ok(SR_TRACK !== null && typeof SR_TRACK === 'object', 'SR_TRACK is an object');
    for (const name of ['validity', 'computeScore', 'quantize', 'scoreToColor']) {
      assert.strictEqual(typeof SR_TRACK[name], 'function', `SR_TRACK.${name} is a function`);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreToColor — every return value must be a non-empty string
// ---------------------------------------------------------------------------
describe('SR_TRACK.scoreToColor', () => {
  it('returns a string for accel', () => {
    const c = SR_TRACK.scoreToColor('accel');
    assert.strictEqual(typeof c, 'string');
    assert.ok(c.length > 0);
  });

  it('returns a string for brake', () => {
    const c = SR_TRACK.scoreToColor('brake');
    assert.strictEqual(typeof c, 'string');
    assert.ok(c.length > 0);
  });

  it('returns a string for steady', () => {
    const c = SR_TRACK.scoreToColor('steady');
    assert.strictEqual(typeof c, 'string');
    assert.ok(c.length > 0);
  });

  it('returns the steady colour for an unrecognised state', () => {
    const steady = SR_TRACK.scoreToColor('steady');
    assert.strictEqual(SR_TRACK.scoreToColor('unknown'), steady);
  });

  it('all three zone colours are distinct', () => {
    const a = SR_TRACK.scoreToColor('accel');
    const b = SR_TRACK.scoreToColor('brake');
    const s = SR_TRACK.scoreToColor('steady');
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a, s);
    assert.notStrictEqual(b, s);
  });
});

// ---------------------------------------------------------------------------
// validity — classifies accel values against the dead-band
// ---------------------------------------------------------------------------
describe('SR_TRACK.validity', () => {
  it('returns "accel" for values above the dead-band', () => {
    assert.strictEqual(SR_TRACK.validity(1.0), 'accel');
    assert.strictEqual(SR_TRACK.validity(10), 'accel');
  });

  it('returns "brake" for values below the negative dead-band', () => {
    assert.strictEqual(SR_TRACK.validity(-1.0), 'brake');
    assert.strictEqual(SR_TRACK.validity(-10), 'brake');
  });

  it('returns "steady" for values inside the dead-band', () => {
    assert.strictEqual(SR_TRACK.validity(0), 'steady');
    assert.strictEqual(SR_TRACK.validity(0.4), 'steady');
    assert.strictEqual(SR_TRACK.validity(-0.4), 'steady');
  });

  it('treats the dead-band boundary as steady (closed interval)', () => {
    // Exactly ±0.5 should NOT be classified as accel/brake (boundary is inside dead-band)
    assert.strictEqual(SR_TRACK.validity(0.5), 'steady');
    assert.strictEqual(SR_TRACK.validity(-0.5), 'steady');
  });

  it('respects a custom dead-band argument', () => {
    assert.strictEqual(SR_TRACK.validity(1.0, 2.0), 'steady');
    assert.strictEqual(SR_TRACK.validity(3.0, 2.0), 'accel');
    assert.strictEqual(SR_TRACK.validity(-3.0, 2.0), 'brake');
  });
});

// ---------------------------------------------------------------------------
// computeScore — score in [0, 1]
// ---------------------------------------------------------------------------
describe('SR_TRACK.computeScore', () => {
  it('returns 0 when the value is inside the dead-band', () => {
    assert.strictEqual(SR_TRACK.computeScore(0), 0);
    assert.strictEqual(SR_TRACK.computeScore(0.3), 0);
    assert.strictEqual(SR_TRACK.computeScore(-0.3), 0);
  });

  it('returns a positive score for accel/brake values beyond the dead-band', () => {
    const s = SR_TRACK.computeScore(5.0);
    assert.ok(s > 0 && s <= 1, `score ${s} should be in (0, 1]`);
  });

  it('clamps to 1 for extreme values', () => {
    assert.strictEqual(SR_TRACK.computeScore(100), 1);
    assert.strictEqual(SR_TRACK.computeScore(-100), 1);
  });

  it('is symmetric around zero', () => {
    const pos = SR_TRACK.computeScore(5.0);
    const neg = SR_TRACK.computeScore(-5.0);
    assert.strictEqual(pos, neg);
  });
});

// ---------------------------------------------------------------------------
// quantize — collapses to one of three sentinel values
// ---------------------------------------------------------------------------
describe('SR_TRACK.quantize', () => {
  it('returns 0 for steady values', () => {
    assert.strictEqual(SR_TRACK.quantize(0), 0);
    assert.strictEqual(SR_TRACK.quantize(0.3), 0);
  });

  it('returns +deadband for accel values', () => {
    assert.strictEqual(SR_TRACK.quantize(2.0), 0.5);   // default dead-band
  });

  it('returns -deadband for brake values', () => {
    assert.strictEqual(SR_TRACK.quantize(-2.0), -0.5);
  });

  it('respects a custom dead-band', () => {
    assert.strictEqual(SR_TRACK.quantize(5.0, 2.0), 2.0);
    assert.strictEqual(SR_TRACK.quantize(-5.0, 2.0), -2.0);
    assert.strictEqual(SR_TRACK.quantize(1.0, 2.0), 0);
  });
});
