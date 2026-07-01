// ==UserScript==
// @name         Serious-Racing — Telemetry Chart (Speed + Acc/Brk G + Lean) + Track Colouring
// @namespace    https://serious-racing.com/
// @version      2.19.0
// @description  Adds a combined telemetry chart (Speed, Acc/Brk G-force, Lean angle) on a time axis with crosshair + multi-value tooltip, a map dot, accel/brake-coloured lap trace, and a play button that animates a dot along the chart + track. When two riders are compared, switches to a speed-only chart (one line + dot per rider) on a time axis so the faster rider pulls ahead on the map. Hides the site's play/scrubber bar and its static rider markers. JS-only, reads window.SRSRCNG — no server access needed.
// @match        https://serious-racing.com/laptimes/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/Serdy/lap-analysis
// @supportURL   https://github.com/Serdy/lap-analysis/issues
// @downloadURL  https://github.com/Serdy/lap-analysis/releases/latest/download/serious-racing-lean-angle.user.js
// @updateURL    https://github.com/Serdy/lap-analysis/releases/latest/download/serious-racing-lean-angle.user.js
// ==/UserScript==

/*
 * Data source (verified live):
 *   window.SRSRCNG.riders[i].data -> array of points, each:
 *     [ lat, lng, speed(km/h), cumulativeDistance(m), longAccel(m/s^2), leanAngle(deg) ]
 *   - Points are sampled at a fixed 0.1 s (10 Hz): time[i] = i * 0.1 s, and the last
 *     sample equals rider.laptime — so we use a TIME x-axis (matches the site's own view).
 *   - Acc/Brk G = longAccel / 9.81 (col 4).  Lean (col 5) is a +/-40-deg GPS estimate.
 *
 * Features:
 *   1. Own Flot chart (Flot is already loaded) in an injected panel below the speed chart,
 *      with three y-axes: Speed (left), G-Force (right), Lean Angle (far right). Crosshair +
 *      tooltip are drawn manually (the crosshair/tooltip Flot plugins are not loaded).
 *   2. Hover -> a dot on the live Leaflet map (window.SRSRCNG.map) at the point's GPS pos.
 *   3. The lap trace is recoloured green (accelerating) / yellow (steady) / red (braking)
 *      from the longitudinal-accel channel, as an overlay polyline we own.
 *   4. COMPARISON mode (window.SRSRCNG.riders has >= 2 valid riders): the chart becomes
 *      speed-only with one line per rider on a TIME axis. Hover/playback sample every rider
 *      at the same elapsed time (clamped to its own lap length), so the faster rider's chart
 *      dot + map dot pull ahead and you see who's leading. The legend shows each rider's live
 *      speed. The accel-colour overlay is skipped so the site's per-rider traces stay visible.
 */
(function () {
  'use strict';
