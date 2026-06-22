/**
 * sr-track.js — SR_TRACK module (canonical source)
 *
 * Pure logic: no DOM, no jQuery, no window.SRSRCNG.
 *
 * DUAL-EXPORT SEAM
 * ----------------
 * Bottom of this file uses:
 *   if (typeof module !== 'undefined' && module.exports) { module.exports = SR_TRACK; }
 *   else { window.SR_TRACK = SR_TRACK; }
 *
 * In Node (unit tests):  require('./sr-track.js') returns the SR_TRACK object.
 * In the browser (page): `module` is undefined, so window.SR_TRACK is assigned instead.
 * No ReferenceError in either environment — the guard is safe everywhere.
 *
 * KEEPING IN SYNC WITH THE USERSCRIPT
 * ------------------------------------
 * The body of this file (everything between the "BEGIN sr-track inline" and
 * "END sr-track inline" markers below) is copied verbatim into
 * serious-racing-lean-angle.user.js inside its IIFE, replacing any prior inline
 * copy.  When you change logic here, update that inlined block too.
 * Search for "BEGIN sr-track inline" to find it.
 *
 * Why a separate file instead of extracting from the IIFE?
 *   The userscript must be a single self-contained .user.js for Tampermonkey —
 *   no build step, no external require.  A separate module file lets Node tests
 *   import the logic directly while the userscript inlines the same code.
 *
 * SPEED UNIT DECISION
 * -------------------
 * riders[i].data col2 is the mph BASE unit per CLAUDE.md (authoritative).
 * Conversion: v_ms = col2 * 0.44704  (mph → m/s; exact NIST factor).
 * col4 is already in m/s². Both channels are thus in SI throughout the pipeline.
 * Peak sanity: 125 mph * 0.44704 ≈ 55.9 m/s peak speed; speed-derivative accel
 * at hard corner exit ~3–8 m/s² — within the expected 3–12 m/s² band.
 */

// === BEGIN sr-track inline ===

var SR_TRACK = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Default configuration (all live-tunable by passing a cfg override object).
  // ---------------------------------------------------------------------------
  var DEFAULT_CFG = {
    // Fusion weights
    BRAKE_FLOOR: 0.3,   // m/s²; g <= -BRAKE_FLOOR => pure brake half
    wS:          1.0,   // speed-supplement weight (accel half)
    wL:          0.15,  // lean-trend weight (accel half)

    // Fixed normalisation scales (NOT per-lap percentile — cross-lap consistent)
    B_SCALE: 8.0,       // m/s²; maps -B_SCALE -> score -1 (brake; sharper)

    // Accel normalisation is LEAN-GATED: the m/s² that maps to full green depends
    // on lean angle, because high-speed straight-line accel is gentle (~1.4 m/s²
    // near top speed) yet genuinely "on the gas", while a slight speed gain mid-
    // corner should stay yellow. Low lean (straight) -> small scale (sensitive,
    // gentle accel reads green); high lean (corner) -> large scale (creep stays
    // yellow). Calibrated against lap 122060,5 real telemetry.
    A_SCALE_STRAIGHT: 1.5, // m/s² -> +1 when upright (lean ~0)
    A_SCALE_CORNER:   4.0, // m/s² -> +1 when fully leaned (>= LEAN_GATE)
    LEAN_GATE:        25,  // deg; lean at which the scale reaches A_SCALE_CORNER
    A_SCALE: 4.0,       // legacy: fallback scale (e.g. col4-dead path normalisation)

    // Signal smoothing (centered MA window widths, in samples)
    speedSmoothWin: 5,
    col4SmoothWin:  3,
    leanSmoothWin:  5,
    diffSpan:       3,  // central-difference half-span (samples) for aSpd & leanTrend
    aSpdClamp:      25, // m/s²; outlier clamp on speed-derivative

    // Output
    scoreSmoothWin: 3,
    // Asymmetric slew (max |Δscore| per sample). Braking onset is sharp and must
    // show red fast, so downward steps are large; acceleration builds gradually,
    // so upward steps stay gentle (keeps the gradient smooth, no green bleeding
    // past the speed peak into the brake zone).
    slewUp:         0.15, // toward accel/green (gentle)
    slewDown:       0.6,  // toward brake/red (snappy)
    slew:           0.15, // legacy alias (unused; kept for back-compat references)
    LEVELS:         11,   // quantisation bands
    MIN_RUN:        4,    // absorb colour runs < 4 samples (0.4 s)

    // Validity thresholds
    col4DeadFrac:  0.70, // fraction of |col4|<0.05 => col4 considered dead
    leanSatFrac:   0.85, // fraction at saturation => lean considered dead
    leanSatDeg:    40,   // degrees; GPS lean saturates at ±40

    // Speed unit conversion (mph base → m/s)
    MPH_TO_MS: 0.44704,

    // Fixed timestep (seconds per sample)
    DT: 0.1,

    // Lean-trend reference scale (°/s); values above this count as full unwinding
    LEAN_DREF: 60,
  };

  // Merge caller overrides onto a copy of the defaults.
  function makeCfg(override) {
    var cfg = {};
    var k;
    for (k in DEFAULT_CFG) { if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) cfg[k] = DEFAULT_CFG[k]; }
    if (override) {
      for (k in override) { if (Object.prototype.hasOwnProperty.call(override, k)) cfg[k] = override[k]; }
    }
    return cfg;
  }

  // ---------------------------------------------------------------------------
  // Internal numeric helpers
  // ---------------------------------------------------------------------------
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function isFiniteNum(x) { return typeof x === 'number' && isFinite(x); }

  /** Variance of a numeric array (population). Returns 0 on empty/single-element. */
  function variance(arr) {
    var n = arr.length;
    if (n < 2) return 0;
    var sum = 0, i;
    for (i = 0; i < n; i++) sum += arr[i];
    var mean = sum / n;
    var sq = 0;
    for (i = 0; i < n; i++) sq += (arr[i] - mean) * (arr[i] - mean);
    return sq / n;
  }

  /**
   * Centered moving average. Edge samples use the largest available symmetric window.
   * Falls back gracefully for n<2 (returns a copy).
   * @param {number[]} arr
   * @param {number}   win  half-width on each side (total window = 2*win+1)
   * @returns {number[]}
   */
  function centeredMA(arr, win) {
    var n = arr.length;
    var out = new Array(n);
    var i, j, lo, hi, sum, cnt;
    for (i = 0; i < n; i++) {
      lo = Math.max(0, i - win);
      hi = Math.min(n - 1, i + win);
      sum = 0; cnt = 0;
      for (j = lo; j <= hi; j++) {
        if (isFiniteNum(arr[j])) { sum += arr[j]; cnt++; }
      }
      out[i] = cnt > 0 ? sum / cnt : 0;
    }
    return out;
  }

  /**
   * Central finite difference with variable half-span.
   * At index i uses span = min(diffSpan, i, n-1-i) so edges never access out-of-bounds.
   * Returns derivative in units of arr_units / s.
   * @param {number[]} arr   smoothed signal
   * @param {number}   span  desired half-span (samples)
   * @param {number}   dt    seconds per sample
   * @returns {number[]}
   */
  function centralDiff(arr, span, dt) {
    var n = arr.length;
    var out = new Array(n);
    var i, s;
    for (i = 0; i < n; i++) {
      s = Math.min(span, i, n - 1 - i);
      if (s === 0) {
        // single-sided where possible
        if (i === 0 && n > 1)      out[i] = (arr[1] - arr[0]) / dt;
        else if (i === n - 1 && n > 1) out[i] = (arr[n - 1] - arr[n - 2]) / dt;
        else                        out[i] = 0;
      } else {
        out[i] = (arr[i + s] - arr[i - s]) / (2 * s * dt);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // T2 — validity(col4Arr, speedMphArr, leanArr, cfg) -> {useG,useS,useL}|{bail:true}
  // ---------------------------------------------------------------------------
  /**
   * Assess per-channel usability for a full lap's worth of arrays.
   *
   * @param {number[]} col4Arr      longitudinal accel (m/s²), from riders[i].data col 4
   * @param {number[]} speedMphArr  speed in mph BASE unit (col 2), per CLAUDE.md
   * @param {number[]} leanArr      lean angle (°), col 5; saturates at ±40
   * @param {object}  [cfgOverride] optional cfg overrides
   * @returns {{useG:boolean,useS:boolean,useL:boolean}|{bail:boolean}}
   *   bail:true only when BOTH col4 and speed are unusable.
   */
  function validity(col4Arr, speedMphArr, leanArr, cfgOverride) {
    // Backward-compat scalar path (old stub used validity(scalar[, deadband])).
    // If first arg is a plain number the caller is using the old scalar API.
    if (typeof col4Arr === 'number') {
      return _validityScalar(col4Arr, speedMphArr /* deadband */);
    }

    var cfg = makeCfg(cfgOverride);
    var n = Array.isArray(col4Arr) ? col4Arr.length : 0;

    // Assess col4 (g-sensor)
    var useG = true;
    if (n < 2) {
      useG = false;
    } else {
      var deadCount = 0, i;
      for (i = 0; i < n; i++) {
        if (!isFiniteNum(col4Arr[i]) || Math.abs(col4Arr[i]) < 0.05) deadCount++;
      }
      if (deadCount / n > cfg.col4DeadFrac) useG = false;
      if (useG && variance(col4Arr) < 1e-6) useG = false;
    }

    // Assess speed
    var useS = true;
    var sn = Array.isArray(speedMphArr) ? speedMphArr.length : 0;
    if (sn < 2) {
      useS = false;
    } else {
      var allNaN = true, j;
      for (j = 0; j < sn; j++) { if (isFiniteNum(speedMphArr[j])) { allNaN = false; break; } }
      if (allNaN) useS = false;
      if (useS && variance(speedMphArr) < 1e-9) useS = false;
    }

    // Bail if BOTH sensors are dead
    if (!useG && !useS) return { bail: true };

    // Assess lean
    var useL = true;
    var ln = Array.isArray(leanArr) ? leanArr.length : 0;
    if (ln < 2) {
      useL = false;
    } else {
      var satCount = 0, k;
      var satThresh = cfg.leanSatDeg * 0.99;
      for (k = 0; k < ln; k++) {
        if (!isFiniteNum(leanArr[k]) || Math.abs(leanArr[k]) >= satThresh) satCount++;
      }
      if (satCount / ln > cfg.leanSatFrac) useL = false;
      if (useL && variance(leanArr) < 1e-6) useL = false;
    }

    return { useG: useG, useS: useS, useL: useL };
  }

  /** Old scalar-based classification (kept for backward compat with T0 tests). */
  function _validityScalar(accel, deadband) {
    if (deadband === undefined || typeof deadband !== 'number') deadband = 0.5;
    if (accel > deadband) return 'accel';
    if (accel < -deadband) return 'brake';
    return 'steady';
  }

  // ---------------------------------------------------------------------------
  // T3 — internal signal pipeline
  // ---------------------------------------------------------------------------
  /**
   * Build all smoothed signals needed by computeScore.
   * @returns {{ g, vs, aSpd, leanSmooth, dLean }}
   */
  function _buildSignals(col4Arr, speedMphArr, leanArr, cfg) {
    var n = col4Arr.length;
    var i;

    // col4 smoothed (m/s²; already SI)
    var g = centeredMA(col4Arr, Math.floor(cfg.col4SmoothWin / 2));

    // Speed: mph → m/s, then smooth
    var v_ms = new Array(n);
    for (i = 0; i < n; i++) {
      v_ms[i] = isFiniteNum(speedMphArr[i]) ? speedMphArr[i] * cfg.MPH_TO_MS : 0;
    }
    var vs = centeredMA(v_ms, Math.floor(cfg.speedSmoothWin / 2));

    // Speed-derivative accel (m/s²), clamped
    var aSpd = centralDiff(vs, cfg.diffSpan, cfg.DT);
    for (i = 0; i < n; i++) {
      aSpd[i] = clamp(aSpd[i], -cfg.aSpdClamp, cfg.aSpdClamp);
    }

    // Lean: smooth |lean| then differentiate for trend
    var leanAbs = new Array(n);
    for (i = 0; i < n; i++) {
      leanAbs[i] = isFiniteNum(leanArr[i]) ? Math.abs(leanArr[i]) : 0;
    }
    var leanSmooth = centeredMA(leanAbs, Math.floor(cfg.leanSmoothWin / 2));
    var dLean = centralDiff(leanSmooth, cfg.diffSpan, cfg.DT); // °/s; negative = unwinding

    return { g: g, vs: vs, aSpd: aSpd, leanSmooth: leanSmooth, dLean: dLean };
  }

  // ---------------------------------------------------------------------------
  // T4 — computeScore(col4Arr, speedMphArr, leanArr, valid, cfg) -> score[]
  // ---------------------------------------------------------------------------
  /**
   * Compute a fused longitudinal score in [-1..+1] for each sample.
   *
   * Positive = accelerating, negative = braking, zero = coasting/neutral.
   *
   * Backward compat: if first arg is a number, falls back to old scalar path.
   *
   * @param {number[]} col4Arr     longitudinal accel m/s²
   * @param {number[]} speedMphArr speed in mph base unit (col2 per CLAUDE.md)
   * @param {number[]} leanArr     lean angle °
   * @param {{useG,useS,useL}|null} valid  from validity(); null = use all channels
   * @param {object}  [cfgOverride]
   * @returns {number[]}  score[] in [-1..+1], same length as col4Arr
   */
  function computeScore(col4Arr, speedMphArr, leanArr, valid, cfgOverride) {
    // Backward-compat scalar path
    if (typeof col4Arr === 'number') {
      return _computeScoreScalar(col4Arr, speedMphArr /* deadband */);
    }

    var cfg = makeCfg(cfgOverride);
    var n = Array.isArray(col4Arr) ? col4Arr.length : 0;
    if (n === 0) return [];

    // Default valid: trust all channels
    var useG = true, useS = true, useL = true;
    if (valid && !valid.bail) {
      useG = valid.useG !== false;
      useS = valid.useS !== false;
      useL = valid.useL !== false;
    }

    var sig = _buildSignals(col4Arr, speedMphArr, leanArr, cfg);
    var g    = sig.g;
    var aSpd = sig.aSpd;
    var dLean = sig.dLean;

    var leanSmooth = sig.leanSmooth;

    // Normalisation helpers
    function normB(x) { return clamp(x / cfg.B_SCALE, -1, 0); } // x expected negative
    // Lean-gated accel scale: sensitive upright, insensitive when leaned over.
    function aScaleFor(leanMag) {
      var t = clamp(leanMag / cfg.LEAN_GATE, 0, 1);
      return cfg.A_SCALE_STRAIGHT + (cfg.A_SCALE_CORNER - cfg.A_SCALE_STRAIGHT) * t;
    }

    var raw = new Array(n);
    var i, base, supp, leanContrib;

    for (i = 0; i < n; i++) {
      var gi = useG ? g[i] : 0;
      var aSi = useS ? aSpd[i] : 0;
      // -dLean: negative dLean (lean decreasing = unwinding corner = accel evidence)
      leanContrib = useL ? clamp(-dLean[i] / cfg.LEAN_DREF, 0, 1) : 0;
      // Lean magnitude gates accel sensitivity. No lean channel -> treat as upright.
      var aEff = aScaleFor(useL ? leanSmooth[i] : 0);

      if (!useG) {
        // col4 dead: speed-derived channel carries full range (including braking via neg aSpd)
        var rawS = cfg.wS * clamp(aSi / aEff, -1, 1) + cfg.wL * leanContrib;
        raw[i] = clamp(rawS, -1, 1);
      } else if (gi <= -cfg.BRAKE_FLOOR) {
        // Pure brake half: normB(gi) in [-1, 0]. Speed/lean do NOT pull toward accel.
        raw[i] = normB(gi);
      } else {
        // Accel/coast half — lean-gated so gentle straight-line accel reads green
        // while a slight speed gain mid-corner stays yellow.
        base = clamp(Math.max(gi, 0) / aEff, 0, 1);
        supp = cfg.wS * clamp(aSi / aEff, 0, 1) + cfg.wL * leanContrib;
        // Supplement can only RAISE, not lower; score = max(base, supp)
        raw[i] = Math.max(base, supp);
      }
    }

    // Output smoothing
    var smoothed = centeredMA(raw, Math.floor(cfg.scoreSmoothWin / 2));

    // Asymmetric slew-rate limiting: snappy toward brake, gentle toward accel.
    var slewUp = cfg.slewUp != null ? cfg.slewUp : cfg.slew;
    var slewDown = cfg.slewDown != null ? cfg.slewDown : cfg.slew;
    var out = new Array(n);
    out[0] = smoothed[0];
    for (i = 1; i < n; i++) {
      var delta = smoothed[i] - out[i - 1];
      if (delta > slewUp) delta = slewUp;
      else if (delta < -slewDown) delta = -slewDown;
      out[i] = out[i - 1] + delta;
    }

    return out;
  }

  /** Old scalar path preserved for T0 backward-compat tests. */
  function _computeScoreScalar(accel, deadband) {
    if (deadband === undefined || typeof deadband !== 'number') deadband = 0.5;
    var abs = accel < 0 ? -accel : accel;
    var beyond = abs - deadband;
    if (beyond <= 0) return 0;
    var maxBeyond = 14.7 - deadband;
    var score = beyond / maxBeyond;
    return score > 1 ? 1 : score;
  }

  // ---------------------------------------------------------------------------
  // T5 — quantize(scoreArr, cfg) -> band[]
  // ---------------------------------------------------------------------------
  /**
   * Quantise score[] into LEVELS integer bands.
   *
   * LEVELS=11 produces bands 0..10 with edges at -1, -0.8, -0.6, …, +0.8, +1.
   * Band index:  0 = hardest braking, 5 = neutral, 10 = hardest accel.
   *
   * Backward compat: if first arg is a plain number, uses old sentinel-value path.
   *
   * @param {number[]|number} scoreArr  score array in [-1..+1], or scalar (old API)
   * @param {object|number}  [cfg]      cfg override object, or deadband scalar (old API)
   * @returns {number[]|number}
   */
  function quantize(scoreArr, cfg) {
    // Backward-compat scalar path (old tests pass a scalar accel + optional deadband)
    if (typeof scoreArr === 'number') {
      return _quantizeScalar(scoreArr, cfg /* deadband */);
    }

    var c = makeCfg(typeof cfg === 'object' ? cfg : undefined);
    var n = Array.isArray(scoreArr) ? scoreArr.length : 0;
    if (n === 0) return [];

    var levels = c.LEVELS; // 11
    // Edges: levels+1 = 12 values from -1 to +1 inclusive
    var step = 2 / levels; // 2/11 ≈ 0.1818…
    var out = new Array(n);
    var i, band;
    for (i = 0; i < n; i++) {
      var s = clamp(scoreArr[i], -1, 1);
      // Map [-1, +1] to [0, LEVELS]; clamp top edge to LEVELS-1
      band = Math.floor((s + 1) / step);
      if (band >= levels) band = levels - 1;
      out[i] = band;
    }
    return out;
  }

  /** Returns the midpoint score for a band index (useful for colorising). */
  function bandMidpoint(band, levels) {
    if (levels === undefined) levels = DEFAULT_CFG.LEVELS;
    var step = 2 / levels;
    return -1 + (band + 0.5) * step;
  }

  /** Old scalar sentinel-value path from T0 stub (preserved for backward compat). */
  function _quantizeScalar(accel, deadband) {
    if (deadband === undefined || typeof deadband !== 'number') deadband = 0.5;
    var zone = _validityScalar(accel, deadband);
    if (zone === 'accel') return deadband;
    if (zone === 'brake') return -deadband;
    return 0;
  }

  // ---------------------------------------------------------------------------
  // T5 — scoreToColor(score, cfg) -> '#rrggbb'
  // ---------------------------------------------------------------------------
  /**
   * Map a numeric score in [-1..+1] to a colour via HSL interpolation.
   *
   * Designer spec anchors (HSL):
   *   brake:   #ff3b2f  hsl(4,   100%, 59%)
   *   neutral: #f5b800  hsl(46,  100%, 48%)
   *   accel:   #22d66e  hsl(147, 67%,  49%)
   *
   * Gamma bias 0.75 bends the gradient toward neutral so mid-scores don't
   * look fully saturated.
   *
   * Backward compat: if first arg is a string ('accel'|'steady'|'brake'), returns
   * the legacy flat colour so existing T0 tests continue to pass.
   *
   * @param {number|string} score   numeric in [-1..+1], or legacy string state
   * @param {object}       [cfg]   ignored (reserved for future override)
   * @returns {string}  '#rrggbb'
   */
  function scoreToColor(score, cfg) {
    // Legacy string path — keeps T0 tests green
    if (typeof score === 'string') {
      if (score === 'accel')  return '#37d67a';
      if (score === 'brake')  return '#ff5c52';
      return '#f0b429'; // steady / unknown
    }

    // Numeric HSL path
    // Anchors
    var BRAKE   = { h: 4,   s: 100, l: 59 };
    var NEUTRAL = { h: 46,  s: 100, l: 48 };
    var ACCEL   = { h: 147, s: 67,  l: 49 };

    var s = typeof score === 'number' && isFinite(score) ? clamp(score, -1, 1) : 0;
    var t = (s + 1) / 2; // [0, 1]; 0 = full brake, 0.5 = neutral, 1 = full accel

    // Gamma bias: pull mid-values toward neutral (0.5)
    var half = t - 0.5;
    var absHalf = half < 0 ? -half : half;
    var sign = half < 0 ? -1 : (half > 0 ? 1 : 0);
    var tb = sign * Math.pow(absHalf * 2, 0.75) / 2 + 0.5;

    var h, sl, ll, from, to, frac;
    if (tb <= 0.5) {
      // Brake → Neutral
      frac = tb / 0.5;          // [0, 1]; 0 = brake, 1 = neutral
      from = BRAKE; to = NEUTRAL;
    } else {
      // Neutral → Accel
      frac = (tb - 0.5) / 0.5;  // [0, 1]; 0 = neutral, 1 = accel
      from = NEUTRAL; to = ACCEL;
    }

    h  = from.h + (to.h  - from.h)  * frac;
    sl = from.s + (to.s  - from.s)  * frac;
    ll = from.l + (to.l  - from.l)  * frac;

    return _hslToHex(h, sl / 100, ll / 100);
  }

  /**
   * Return the display colour for a band index (maps band midpoint through scoreToColor).
   * @param {number} band   integer in [0, LEVELS-1]
   * @param {object} [cfg]
   * @returns {string} '#rrggbb'
   */
  function bandToColor(band, cfg) {
    var c = makeCfg(typeof cfg === 'object' ? cfg : undefined);
    return scoreToColor(bandMidpoint(band, c.LEVELS));
  }

  // ---------------------------------------------------------------------------
  // Internal: HSL → #rrggbb
  // Standard algorithm; h in [0,360), s and l in [0,1].
  // ---------------------------------------------------------------------------
  function _hslToHex(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r, g, b;
    h = ((h % 360) + 360) % 360; // normalise
    if      (h <  60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    function toHex(v) {
      var n = Math.round((v + m) * 255);
      n = n < 0 ? 0 : n > 255 ? 255 : n;
      return (n < 16 ? '0' : '') + n.toString(16);
    }
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    // Array-based pipeline (new)
    validity:      validity,
    computeScore:  computeScore,
    quantize:      quantize,
    scoreToColor:  scoreToColor,
    bandMidpoint:  bandMidpoint,
    bandToColor:   bandToColor,

    // Expose default config so callers can inspect or derive overrides
    DEFAULT_CFG:   DEFAULT_CFG,

    // Internal helpers exposed for unit testing
    _centeredMA:   centeredMA,
    _centralDiff:  centralDiff,
    _buildSignals: _buildSignals,
    _hslToHex:     _hslToHex,
  };
}());

// === END sr-track inline ===

// Dual-export seam: works in Node (require) and in the browser (window) without error.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SR_TRACK;
} else {
  window.SR_TRACK = SR_TRACK;
}
