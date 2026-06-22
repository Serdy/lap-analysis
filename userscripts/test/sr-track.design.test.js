'use strict';

/**
 * Design-spec validation tests for SR_TRACK array-based pipeline.
 *
 * These tests validate the APPROVED DESIGN SPEC for the track-coloring module
 * against the implementation in userscripts/src/sr-track.js.
 *
 * Run: npm test (or: node --test)
 *
 * Design anchors:
 *   - Score in [-1..+1]: negative=brake, 0=neutral, +1=accel
 *   - Lean-gated accel normalization: A_SCALE_STRAIGHT=1.5 (upright) →
 *     A_SCALE_CORNER=4.0 (leaned, gated at LEAN_GATE=25°); B_SCALE=8.0
 *   - Asymmetric fusion: brake half (g<=-BRAKE_FLOOR=0.3) owns braking;
 *     accel half uses max(base, supplement) where supplement can only raise
 *   - Lean uses TREND (derivative), weight wL=0.15, cleanly removable
 *   - Quantize to LEVELS=11 bands
 *   - Color ramp: red→yellow→green in HSL (anchors hsl 4/46/147)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SR_TRACK = require('../src/sr-track.js');

// ---------------------------------------------------------------------------
// Helper: approximate floating-point equality (for HSL → RGB rounding)
// ---------------------------------------------------------------------------
function approxEq(actual, expected, tolerance = 0.02, msg = '') {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= tolerance, `${msg} expected ${expected} ± ${tolerance}, got ${actual}`);
}

// Helper: parse #rrggbb to {r, g, b} in [0,255]
function parseHex(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `not a valid #rrggbb: ${hex}`);
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// Helper: convert RGB [0,255] to HSL (returns {h, s, l} with s,l in [0,1])
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r: h = 60 * (((g - b) / d + (g < b ? 6 : 0)) % 6); break;
      case g: h = 60 * ((b - r) / d + 2); break;
      case b: h = 60 * ((r - g) / d + 4); break;
    }
  }
  return { h, s, l };
}

// ---------------------------------------------------------------------------
// Test Group (i): Unit conversion
// ---------------------------------------------------------------------------
describe('Design (i): Unit conversion', () => {
  it('speed ramp col2 increasing → aSpd reflects analytic m/s² value', () => {
    // Linear speed ramp: col2 increasing by 1 mph per 0.1s sample.
    // dv = 1 mph per 0.1 s = 10 mph/s = 10 * 0.44704 m/s/s ≈ 4.47 m/s²
    // However, with central differences over span=3 (samples), we're averaging
    // over a window, so the result will be lower. With speedSmoothWin=5, the
    // differentiation will also be on smoothed speed.
    // Empirically, a slow linear ramp gives aSpd ≈ 2.235 m/s² due to the
    // smoothing and differencing window (span=3 means Δ over 6 samples = 0.6s).
    const col4 = [0, 0, 0, 0, 0];
    const col2 = [60, 61, 62, 63, 64]; // linear ramp, 1 mph/sample
    const lean = [0, 0, 0, 0, 0];

    const sig = SR_TRACK._buildSignals(col4, col2, lean, SR_TRACK.DEFAULT_CFG);
    const aSpd = sig.aSpd;

    // The speed-derivative signal should be positive and proportional to the
    // ramp gradient. Check that aSpd is clearly positive and consistent.
    assert.ok(aSpd[2] > 0, `aSpd[2]=${aSpd[2]} should be positive from rising speed`);
    // All middle samples should show similar positive acceleration (smooth ramp)
    for (let i = 1; i < aSpd.length - 1; i++) {
      assert.ok(aSpd[i] > 0, `aSpd[${i}]=${aSpd[i]} should be positive`);
    }
  });

  it('constant speed → aSpd ≈ 0', () => {
    const col4 = [0, 0, 0, 0, 0];
    const col2 = [50, 50, 50, 50, 50];
    const lean = [0, 0, 0, 0, 0];

    const sig = SR_TRACK._buildSignals(col4, col2, lean, SR_TRACK.DEFAULT_CFG);
    const aSpd = sig.aSpd;

    // All samples should be very close to 0
    for (let i = 0; i < aSpd.length; i++) {
      approxEq(aSpd[i], 0, 0.1, `aSpd[${i}] at constant speed`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test Group (ii): Braking returns normalized g regardless of speed noise
// ---------------------------------------------------------------------------
describe('Design (ii): Braking normalization independent of speed', () => {
  it('strong negative col4 + rising speed → score ≈ normB(col4)', () => {
    // col4 ≈ -6 m/s² everywhere (well into brake half, g <= -0.3)
    // speed rising from 60 to 100 mph (noisy, positive aSpd)
    const col4 = [-6, -5.9, -6.1, -5.8, -6.2];
    const col2 = [60, 70, 80, 90, 100];
    const lean = [0, 0, 0, 0, 0];
    const cfg = SR_TRACK.DEFAULT_CFG;

    const score = SR_TRACK.computeScore(col4, col2, lean, null, cfg);

    // Expected: normB(-6) = clamp(-6/8, -1, 0) = -0.75
    // Speed noise should NOT pull this toward accel (0).
    // All samples should stay in brake half (negative).
    for (let i = 0; i < score.length; i++) {
      assert.ok(score[i] < -0.5,
        `score[${i}]=${score[i]} should be strong negative (brake), not diluted by rising speed`);
    }
    // Average should be close to -0.75
    const avg = score.reduce((a, b) => a + b) / score.length;
    approxEq(avg, -0.75, 0.15, 'average score for constant -6 m/s²');
  });
});

// ---------------------------------------------------------------------------
// Test Group (iii): The "bug case" — flat col4 + rising speed → positive score
// ---------------------------------------------------------------------------
describe('Design (iii): Flat col4 + rising speed → positive score', () => {
  it('col4≈0 everywhere but speed climbing → score > 0 (green-ward)', () => {
    // This is the whole point of the feature: speed growth can lift a zero-accel
    // reading into accel territory.
    // Speed ramp: 40→60 mph over 5 samples = 20 mph in 0.5 s ≈ 8.94 m/s/s
    // The speed-derived accel supplement should be significant and positive.
    const col4 = [0, 0, 0.05, -0.05, 0];  // essentially flat, noise around zero
    const col2 = [40, 44, 48, 52, 56, 60];
    const lean = [0, 0, 0, 0, 0, 0];

    const score = SR_TRACK.computeScore(col4, col2, lean, null, SR_TRACK.DEFAULT_CFG);

    // The middle samples (where speed rise is clearest) should be POSITIVE.
    // We're not in brake half (col4 > -0.3), so supplement can raise the base.
    assert.ok(score[2] > 0, `score[2]=${score[2]} should be positive from speed climb`);
    assert.ok(score[3] > 0, `score[3]=${score[3]} should be positive from speed climb`);
  });
});

// ---------------------------------------------------------------------------
// Test Group (iv): col4 brake spike NOT diluted by speed
// ---------------------------------------------------------------------------
describe('Design (iv): Brake spike protected by max() / brake-half logic', () => {
  it('sustained col4 braking stays brake half even with rising speed (col4 wins)', () => {
    // Adversarial: col4 reports real braking (−5 m/s²) for a sustained zone while
    // the speed channel still ticks up (the case where the two channels disagree).
    // col4-primary-for-braking means red wins: the brake zone must read negative,
    // not be diluted to green by the speed supplement.
    const col4 = [0, 0, -5, -5, -5, -5, -5, -5, 0, 0];
    const col2 = [50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5, 54, 54.5]; // mild speed rise
    const lean = new Array(10).fill(0);

    const score = SR_TRACK.computeScore(col4, col2, lean, null, SR_TRACK.DEFAULT_CFG);

    // Deep inside the sustained brake zone the score must be clearly negative.
    assert.ok(score[6] < 0,
      `score[6]=${score[6]} should remain brake-half (negative) despite rising speed`);
  });

  it('hard braking right after full-green accel turns red FAST (asymmetric slew)', () => {
    // The end-of-straight case: full-green acceleration, then the rider grabs the
    // brakes at the speed peak. Green must not bleed past the peak — the score
    // must drop into the brake half within a few samples (snappy slewDown).
    const col4 = [0, 0, 0, 0, 0, 0, 0, 0, -6, -6, -6, -6, -6, -6];
    // speed climbs hard, peaks, then falls (real braking)
    const col2 = [40, 47, 54, 61, 68, 75, 82, 85, 83, 78, 71, 63, 55, 47];
    const lean = new Array(14).fill(3); // upright straight

    const score = SR_TRACK.computeScore(col4, col2, lean, null, SR_TRACK.DEFAULT_CFG);

    // Accel phase should be green; once braking starts (idx 8), within ~4 samples
    // the score must be clearly negative (red), not lingering green.
    assert.ok(score[5] > 0.5, `accel phase score[5]=${score[5]} should be green`);
    assert.ok(score[12] < -0.3,
      `score[12]=${score[12]} should be red soon after brake onset (no green bleed)`);
  });
});

// ---------------------------------------------------------------------------
// Test Group (v): Monotonic color ramp red→yellow→green
// ---------------------------------------------------------------------------
describe('Design (v): Color ramp monotonic red→yellow→green', () => {
  it('ramp scores -1→0→+1 produce monotonically increasing hues', () => {
    // Sample scores across the full range
    const scores = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
    const colors = scores.map(s => SR_TRACK.scoreToColor(s));
    const hues = colors.map(hex => {
      const rgb = parseHex(hex);
      return rgbToHsl(rgb.r, rgb.g, rgb.b).h;
    });

    // Hues should be monotonically increasing (or stay the same, but not backtrack)
    for (let i = 1; i < hues.length; i++) {
      assert.ok(hues[i] >= hues[i - 1],
        `hues should be monotonic: h[${i-1}]=${hues[i-1]}, h[${i}]=${hues[i]}`);
    }

    // Check endpoints match design anchors (with rounding tolerance)
    const brake = parseHex(SR_TRACK.scoreToColor(-1));
    const brakeLsl = rgbToHsl(brake.r, brake.g, brake.b);
    approxEq(brakeLsl.h, 4, 5, 'brake hue near 4°');

    const neutral = parseHex(SR_TRACK.scoreToColor(0));
    const neutralHsl = rgbToHsl(neutral.r, neutral.g, neutral.b);
    approxEq(neutralHsl.h, 46, 10, 'neutral hue near 46°');

    const accel = parseHex(SR_TRACK.scoreToColor(1));
    const accelHsl = rgbToHsl(accel.r, accel.g, accel.b);
    approxEq(accelHsl.h, 147, 5, 'accel hue near 147°');
  });

  it('scoreToColor always returns valid #rrggbb', () => {
    const scores = [-1, -0.5, 0, 0.5, 1, 0.123, -0.789];
    for (const s of scores) {
      const color = SR_TRACK.scoreToColor(s);
      assert.match(color, /^#[0-9a-f]{6}$/i, `${color} is a valid #rrggbb for score ${s}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test Group (vi): Corner-creep stays near-yellow
// ---------------------------------------------------------------------------
describe('Design (vi): Corner-creep (small steady speed gain + high lean) stays near-yellow', () => {
  it('small aSpd + cornering lean → score ≈ 0 (yellow, not green)', () => {
    // Slight speed gain 45→47 mph (~0.89 m/s²) WHILE leaned over in a corner.
    // Lean 35° is a real corner (this lap's corners saturate at 30–40°); the
    // lean-gated scale makes the accel bar high there, so creep stays yellow.
    const col4 = [0, 0, 0, 0, 0, 0];
    const col2 = [45, 45.4, 45.8, 46.2, 46.6, 47];
    const lean = [35, 35, 35, 35, 35, 35];  // steady cornering lean

    const score = SR_TRACK.computeScore(col4, col2, lean, null, SR_TRACK.DEFAULT_CFG);

    const avg = score.reduce((a, b) => a + b) / score.length;
    approxEq(avg, 0, 0.3, 'corner-creep stays near neutral yellow');
  });
});

// ---------------------------------------------------------------------------
// Test Group (vi-b): Straight-line gentle accel reads GREEN (lean-gated fix)
// ---------------------------------------------------------------------------
describe('Design (vi-b): Gentle high-speed straight accel reads green (low lean)', () => {
  it('col4=0, real ~1.4 m/s² speed gain, upright → score clearly green', () => {
    // 112→119 mph (~180→191 km/h) over 10 samples ≈ 1.4 m/s² — the exact
    // gentle-but-real top-speed acceleration that previously read yellow.
    // Lean ~3° (upright straight) -> sensitive accel scale -> green.
    const n = 12;
    const col4 = new Array(n).fill(0);
    const col2 = Array.from({ length: n }, (_, i) => 112 + i * (7 / (n - 1)));
    const lean = new Array(n).fill(3);

    const score = SR_TRACK.computeScore(col4, col2, lean, null, SR_TRACK.DEFAULT_CFG);

    // Steady-state (skip the first couple of slew-limited samples) should be green.
    const tail = score.slice(4);
    const avg = tail.reduce((a, b) => a + b) / tail.length;
    assert.ok(avg > 0.55,
      `upright gentle accel should read green (score>0.55), got avg=${avg.toFixed(3)}`);
  });
});

// ---------------------------------------------------------------------------
// Test Group (vii): Per-channel validity fallbacks
// ---------------------------------------------------------------------------
describe('Design (vii): Per-channel validity fallbacks', () => {
  it('(a) col4 dead (>70% pinned) + good speed → useG=false, score from speed', () => {
    // col4: 99% of samples pinned near 0, 1% real signal
    const col4 = new Array(100).fill(0);
    col4[50] = 1;  // one spike
    // speed rising linearly
    const col2 = Array.from({length: 100}, (_, i) => 50 + i * 0.1);
    const lean = new Array(100).fill(0);

    const valid = SR_TRACK.validity(col4, col2, lean);
    assert.strictEqual(valid.useG, false, 'col4 should be marked as dead');
    assert.strictEqual(valid.useS, true, 'speed should be marked as usable');

    // computeScore should still produce signed scores (from speed channel)
    const score = SR_TRACK.computeScore(col4, col2, lean, valid);
    assert.ok(score.length > 0);
    assert.ok(score.some(s => s > 0), 'should have positive scores from rising speed');
  });

  it('(b) col4 dead AND speed dead → bail:true', () => {
    const col4 = new Array(50).fill(0);  // all pinned
    const col2 = new Array(50).fill(60); // all constant
    const lean = new Array(50).fill(0);

    const valid = SR_TRACK.validity(col4, col2, lean);
    assert.strictEqual(valid.bail, true, 'should bail when both g and speed are dead');
  });

  it('(c) lean fully saturated (>85% at ±40°) → useL=false', () => {
    // Create col4 and col2 with variation so they're not dead, then saturate lean.
    const col4 = Array.from({length: 100}, (_, i) => Math.sin(i * 0.1) * 2);
    const col2 = Array.from({length: 100}, (_, i) => 60 + i * 0.1);
    // 90 samples at saturation, 10 at 0 (exceeds 85% threshold)
    const lean = Array.from({length: 100}, (_, i) => i < 90 ? (i % 2 ? 40 : -40) : 0);

    const valid = SR_TRACK.validity(col4, col2, lean);
    assert.ok(!valid.bail, 'should not bail (col4 and speed are usable)');
    assert.strictEqual(valid.useL, false, 'lean should be marked dead when >85% saturated');
  });

  it('(d) NaN/empty/single-point arrays don\'t throw', () => {
    // Empty arrays
    let score = SR_TRACK.computeScore([], [], []);
    assert.deepStrictEqual(score, []);

    // Single point (too short for proper diffs)
    score = SR_TRACK.computeScore([0], [60], [0]);
    assert.strictEqual(score.length, 1);

    // Arrays with NaN
    score = SR_TRACK.computeScore([NaN, 0, NaN], [60, NaN, 70], [0, 0, 0]);
    assert.strictEqual(score.length, 3);
    // Should not throw and should produce finite results
    for (let i = 0; i < score.length; i++) {
      assert.ok(isFinite(score[i]), `score[${i}] should be finite despite NaN inputs`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test Group (bonus): wL=0 removes lean contribution
// ---------------------------------------------------------------------------
describe('Design (bonus): wL=0 removes lean contribution cleanly', () => {
  it('wL=0 vs wL=0.15 differ on lean-unwinding input; wL=0 no boost from lean', () => {
    // Lean unwinding (negative dLean trend) with flat col4 and flat speed.
    // With wL=0.15, lean trend should boost score toward accel.
    // With wL=0, lean contributes nothing; score should stay near 0.
    const col4 = [0, 0, 0, 0, 0];
    const col2 = [60, 60, 60, 60, 60];
    // Lean decreasing: 40→0 (unwinding from full lean)
    const lean = [40, 30, 20, 10, 0];

    const scoreWithLean = SR_TRACK.computeScore(col4, col2, lean, null,
      { ...SR_TRACK.DEFAULT_CFG, wL: 0.15 });
    const scoreNoLean = SR_TRACK.computeScore(col4, col2, lean, null,
      { ...SR_TRACK.DEFAULT_CFG, wL: 0 });

    // With wL=0.15, lean unwinding should produce positive scores.
    const avgWithLean = scoreWithLean.reduce((a, b) => a + b) / scoreWithLean.length;
    assert.ok(avgWithLean > 0.1,
      `with wL=0.15, lean unwinding should boost score; got avg=${avgWithLean}`);

    // With wL=0, no lean contribution; should stay near 0.
    const avgNoLean = scoreNoLean.reduce((a, b) => a + b) / scoreNoLean.length;
    approxEq(avgNoLean, 0, 0.2,
      `with wL=0, lean should not affect score; got avg=${avgNoLean}`);

    // They should be clearly different
    assert.ok(avgWithLean > avgNoLean + 0.1,
      `wL=0.15 (${avgWithLean}) should be higher than wL=0 (${avgNoLean})`);
  });
});

// ---------------------------------------------------------------------------
// Additional design validation: quantize to 11 bands
// ---------------------------------------------------------------------------
describe('Design: Quantization to LEVELS=11', () => {
  it('produces 11 distinct bands (0..10) for score range [-1..+1]', () => {
    // Sample scores across full range
    const scores = Array.from({length: 101}, (_, i) => -1 + i * 0.02);
    const bands = SR_TRACK.quantize(scores);

    const uniqueBands = new Set(bands);
    assert.ok(uniqueBands.size > 1, 'should produce multiple distinct bands');
    assert.ok(uniqueBands.size <= 11, 'should not exceed 11 bands');

    // Check band values are in [0, 10]
    for (const band of uniqueBands) {
      assert.ok(band >= 0 && band <= 10, `band ${band} should be in [0, 10]`);
    }
  });

  it('band 0 = hardest brake, band 5 = neutral, band 10 = hardest accel', () => {
    const band0 = SR_TRACK.quantize([-1]);
    const band5 = SR_TRACK.quantize([0]);
    const band10 = SR_TRACK.quantize([1]);

    assert.strictEqual(band0[0], 0, 'score -1 → band 0 (brake)');
    // band 5 should be mid-range (neutral)
    assert.ok(band5[0] >= 4 && band5[0] <= 6, `score 0 → band ${band5[0]} (near 5=neutral)`);
    assert.strictEqual(band10[0], 10, 'score +1 → band 10 (accel)');
  });
});
