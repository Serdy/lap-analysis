// ==UserScript==
// @name         Serious-Racing — Telemetry Chart (Speed + Acc/Brk G + Lean) + Track Colouring
// @namespace    https://serious-racing.com/
// @version      2.10.3
// @description  Adds a combined telemetry chart (Speed, Acc/Brk G-force, Lean angle) on a time axis with crosshair + multi-value tooltip, a map dot, accel/brake-coloured lap trace, and a play button that animates a dot along the chart + track. When two riders are compared, switches to a speed-only chart (one line + dot per rider) on a time axis so the faster rider pulls ahead on the map. Hides the site's play/scrubber bar and its static rider markers. JS-only, reads window.SRSRCNG — no server access needed.
// @match        https://serious-racing.com/laptimes/*
// @run-at       document-idle
// @grant        none
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

  const PANEL_ID = 'sr-tele-panel';
  const PLOT_ID = 'sr-tele-plot';
  const DT = 0.1; // seconds per sample (10 Hz)
  const G = 9.81;

  const COLORS = { speed: '#e23b3b', g: '#6cae3e', lean: '#3d7fd6' };

  // Crisp, optically-centred SVG icons (unicode glyphs render off-centre).
  const ICON_PLAY =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style="margin-left:1.5px"><path d="M4 2.6 L13 8 L4 13.4 Z"/></svg>';
  const ICON_PAUSE =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';

  function ensureStyles() {
    if (document.getElementById('sr-tele-styles')) return;
    const css =
      '.sr-play-btn{position:absolute;left:12px;top:50%;transform:translateY(-50%);' +
      'width:34px;height:34px;padding:0;border:none;border-radius:50%;-webkit-appearance:none;appearance:none;' +
      'cursor:pointer;color:#fff;display:inline-flex;align-items:center;justify-content:center;' +
      'background:radial-gradient(circle at 50% 32%, #f0514c 0%, #e23b3b 55%, #c22f2b 100%);' +
      'box-shadow:0 2px 7px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.22), inset 0 -2px 4px rgba(0,0,0,.25);' +
      'transition:transform .13s cubic-bezier(.34,1.56,.64,1), box-shadow .15s ease, filter .15s ease;}' +
      '.sr-play-btn, .sr-play-btn:focus, .sr-play-btn:active{outline:none !important;}' +
      '.sr-play-btn:hover{filter:brightness(1.08);transform:translateY(-50%) scale(1.09);' +
      'box-shadow:0 4px 12px rgba(226,59,59,.5), inset 0 1px 0 rgba(255,255,255,.25);}' +
      '.sr-play-btn:active{transform:translateY(-50%) scale(.93);transition-duration:.05s;}' +
      '.sr-play-btn:focus-visible{box-shadow:0 0 0 3px rgba(226,59,59,.45), 0 2px 7px rgba(0,0,0,.5) !important;}' +
      '.sr-play-btn.is-playing{filter:brightness(.96);}' +
      '.sr-play-btn svg{display:block;}' +
      // Stop axis tick labels (e.g. negative lean values "-20","-40","-50") wrapping onto
      // two lines. The label class name varies by Flot build, so target every div in the
      // plot and let it lay out on one line with room to grow.
      '#' + PLOT_ID + ' div{white-space:nowrap !important;width:auto !important;}';
    const el = document.createElement('style');
    el.id = 'sr-tele-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // Track-trace colouring by longitudinal accel (m/s^2): accelerate / steady / brake.
  const TRACK = { accel: '#39c463', steady: '#f2c200', brake: '#e23b3b' };
  const ACCEL_T = 0.5; // dead-band (~0.05 G) -> steady (yellow)

  const $ = window.jQuery;

  function ready() {
    return (
      $ &&
      typeof $.plot === 'function' &&
      window.SRSRCNG &&
      Array.isArray(window.SRSRCNG.riders) &&
      window.SRSRCNG.riders.some((r) => r.data && r.data[0] && r.data[0].length >= 6)
    );
  }

  function primaryRider() {
    return window.SRSRCNG.riders.find((r) => r.data && r.data[0] && r.data[0].length >= 6);
  }

  // riders[].data col 2 is the BASE unit (mph); the displayed speed is col2 * speedMultiplier
  // (1.609344 -> km/h). speedUnit gives the label. (graphData is already in this unit.)
  function speedMult() {
    return (window.SRSRCNG && window.SRSRCNG.speedMultiplier) || 1;
  }
  function speedUnit() {
    return (window.SRSRCNG && window.SRSRCNG.speedUnit) || 'km/h';
  }

  // --- Comparison-mode helpers ---
  // A rider is usable if it has at least [lat, lng, speed, distance] per point.
  function validRiders() {
    return ((window.SRSRCNG && window.SRSRCNG.riders) || []).filter(
      (r) => r.data && r.data[0] && r.data[0].length >= 4 && r.data.length >= 2
    );
  }
  function isCompare() {
    return validRiders().length >= 2;
  }
  function riderColor(i) {
    const colors = (window.SRSRCNG && window.SRSRCNG.seriesColors) || [];
    const r = validRiders()[i];
    return (r && r.color) || colors[i] || (i === 0 ? COLORS.speed : '#3d7fd6');
  }
  function riderLabel(i) {
    const r = validRiders()[i];
    return (r && r.username) || 'Rider ' + (i + 1);
  }
  // Comparison uses a TIME axis: at a given elapsed time the faster rider is further round
  // the track, so the two map dots diverge (you see who's ahead). The x-axis spans the
  // LONGEST lap so the whole "race" plays; a shorter lap's dot clamps at its finish.
  function maxLapTime() {
    return Math.max.apply(null, validRiders().map((r) => (r.data.length - 1) * DT));
  }

  // mm:ss.cc  (e.g. 0:13.04, 2:34.40)
  function fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  function buildSeries(rider) {
    const pts = rider.data;
    const mult = speedMult();
    const speed = [];
    const gforce = [];
    const lean = [];
    for (let i = 0; i < pts.length; i++) {
      const t = i * DT;
      speed.push([t, pts[i][2] * mult]);
      gforce.push([t, pts[i][4] / G]);
      lean.push([t, pts[i][5]]);
    }
    return [
      { label: 'Speed', data: speed, color: COLORS.speed, yaxis: 1, lines: { lineWidth: 1.4 }, shadowSize: 0 },
      { label: 'Acc/Brk G', data: gforce, color: COLORS.g, yaxis: 2, lines: { lineWidth: 1.4 }, shadowSize: 0 },
      { label: 'Lean Angle', data: lean, color: COLORS.lean, yaxis: 3, lines: { lineWidth: 1.4 }, shadowSize: 0 },
    ];
  }

  // Comparison: one speed line per rider, x = elapsed time (s) from the lap start.
  function buildCompareSeries() {
    const mult = speedMult();
    return validRiders().map((rider, i) => {
      const pts = rider.data;
      const data = [];
      for (let j = 0; j < pts.length; j++) data.push([j * DT, pts[j][2] * mult]);
      return {
        label: riderLabel(i),
        data: data,
        color: riderColor(i),
        lines: { lineWidth: 1.5 },
        shadowSize: 0,
      };
    });
  }

  function timeTicks(maxT) {
    const step = 20; // 20 s like the reference
    const ticks = [];
    for (let t = 0; t <= maxT + 0.001; t += step) ticks.push(t);
    return ticks;
  }


  function speedChartRow() {
    const ph = document.getElementById('sidebar-graph-container');
    return ph ? ph.closest('.row') : null;
  }

  // The map pane is loaded once the map container exists.
  function mapPaneReady() {
    return !!document.getElementById('map-container');
  }

  // Remove the now-redundant site speed-only chart (our chart already shows speed).
  function hideSiteSpeedChart() {
    const ph = document.getElementById('sidebar-graph-container');
    if (!ph) return;
    const block = ph.closest('.loadgraph') || ph.closest('.row');
    if (block) block.style.display = 'none';
  }

  function legendChip(color, label, valueId, minW) {
    return (
      '<span style="display:inline-flex;align-items:center;margin:0 10px;">' +
      '<span style="display:inline-block;width:22px;height:3px;background:' + color + ';margin-right:5px;"></span>' +
      label +
      '<span id="' + valueId + '" style="display:inline-block;margin-left:6px;width:' + minW +
      'px;text-align:left;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;' +
      'overflow:hidden;color:' + color + ';">–</span>' +
      '</span>'
    );
  }

  function fmtLean(deg) {
    return (deg < 0 ? 'L ' : 'R ') + Math.abs(deg).toFixed(0) + '°';
  }

  // Legend chips depend on mode: single -> Speed/Acc-Brk/Lean; compare -> one per rider.
  function legendHtml() {
    if (isCompare()) {
      return validRiders()
        .map((r, i) => legendChip(riderColor(i), riderLabel(i), 'sr-leg-r' + i, 76))
        .join('');
    }
    return (
      legendChip(COLORS.speed, 'Speed', 'sr-leg-speed', 76) +
      legendChip(COLORS.g, 'Acc/Brk G', 'sr-leg-g', 64) +
      legendChip(COLORS.lean, 'Lean Angle', 'sr-leg-lean', 54)
    );
  }

  function setLegendValues(spd, accel, lean) {
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('sr-leg-speed', (spd * speedMult()).toFixed(0) + ' ' + speedUnit());
    set('sr-leg-g', (accel / G).toFixed(2) + ' G');
    set('sr-leg-lean', fmtLean(lean));
  }

  // Compare legend: raw per-rider speeds (col2 units), converted for display.
  function setCompareLegend(speeds) {
    speeds.forEach((spd, i) => {
      const el = document.getElementById('sr-leg-r' + i);
      if (el) el.textContent = (spd * speedMult()).toFixed(0) + ' ' + speedUnit();
    });
  }

  function updateLegend(idx) {
    const rider = primaryRider();
    if (!rider || !rider.data[idx]) return;
    const p = rider.data[idx];
    setLegendValues(p[2], p[4], p[5]);
  }

  function seedCompareLegend() {
    setCompareLegend(validRiders().map((r) => r.data[0][2]));
  }

  const PLOT_H = 200; // px, chart plot area

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
    // Dock as the last child inside the map column so map + scrubber + chart all share
    // the column height (a split view: map on top, chart at the bottom).
    const mapEl = document.getElementById('map-container');
    if (!mapEl) return null;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'bg-darker legend';
    panel.style.cssText = 'width:100%;flex:0 0 auto;';
    ensureStyles();
    panel.innerHTML =
      '<div style="position:relative;display:flex;justify-content:center;align-items:center;min-height:44px;' +
      'font-size:11px;color:#fff;padding:4px 8px 2px;">' +
      '<button id="sr-play" class="sr-play-btn" title="Play" aria-label="Play">' + ICON_PLAY + '</button>' +
      legendHtml() +
      '</div>' +
      '<div id="' + PLOT_ID + '" style="position:relative;width:100%;height:' + PLOT_H + 'px;"></div>';

    mapEl.appendChild(panel);
    const playBtn = panel.querySelector('#sr-play');
    if (playBtn) playBtn.addEventListener('click', togglePlayback);
    return panel;
  }

  // Hide the site's own play/scrubber bar — we provide our own play button + chart dot.
  function hidePlaybackControls() {
    const c = document.getElementById('track-map-controls');
    if (c) c.style.display = 'none';
  }

  // Hide the site's own static rider position markers (SRSRCNG.dataMarker, one CircleMarker
  // per rider, parked at the start line). Redundant now that we own the moving dots.
  function hideSiteRiderMarkers() {
    const dm = window.SRSRCNG && window.SRSRCNG.dataMarker;
    const list = Array.isArray(dm) ? dm : dm ? [dm] : [];
    list.forEach((m) => {
      try { if (m && m.setStyle) m.setStyle({ opacity: 0, fillOpacity: 0 }); } catch (e) {}
    });
  }

  // Turn the map column into a flex split so the docked chart stays visible: the map
  // canvas shrinks to fill remaining space, the scrubber + chart keep their heights.
  function applyLayout() {
    const mc = document.getElementById('map-container');
    const canvas = document.getElementById('track-map-canvas');
    if (!mc || !canvas) return;
    mc.style.display = 'flex';
    mc.style.flexDirection = 'column';
    mc.style.height = '100%';
    canvas.style.setProperty('flex', '1 1 0', 'important');
    canvas.style.setProperty('min-height', '0', 'important');
    canvas.style.setProperty('height', 'auto', 'important');
    const map = window.SRSRCNG && window.SRSRCNG.map;
    if (map && map.invalidateSize) setTimeout(() => map.invalidateSize(), 0);
  }

  let plot = null;
  let crosshair = null;
  let tooltip = null;
  let playDots = [];

  function draw() {
    const el = document.getElementById(PLOT_ID);
    if (!el || el.offsetWidth === 0) return false;
    const axisFont = { color: '#9aa0a6', size: 10 };
    const tickColor = 'rgba(255,255,255,.08)';

    if (isCompare()) {
      const maxT = maxLapTime();
      plot = $.plot($(el), buildCompareSeries(), {
        xaxis: {
          min: 0,
          max: maxT,
          ticks: timeTicks(maxT),
          tickFormatter: fmtTime,
          tickColor: tickColor,
          font: axisFont,
        },
        yaxes: [{ position: 'left', min: 0, tickColor: tickColor, font: axisFont }],
        grid: { show: true, borderWidth: 0, hoverable: true, mouseActiveRadius: 1000 },
        legend: { show: false },
      });
      return true;
    }

    const rider = primaryRider();
    if (!rider) return false;

    const maxT = (rider.data.length - 1) * DT;

    plot = $.plot($(el), buildSeries(rider), {
      xaxis: {
        min: 0,
        max: maxT,
        ticks: timeTicks(maxT),
        tickFormatter: fmtTime,
        tickColor: tickColor,
        font: axisFont,
      },
      yaxes: [
        { position: 'left', min: 0, tickColor: tickColor, font: axisFont },
        { position: 'right', min: -1, max: 1, tickColor: tickColor, font: axisFont },
        { position: 'right', min: -50, max: 50, ticks: [-50, -40, -20, 0, 20, 40, 50], labelWidth: 26, tickColor: tickColor, font: axisFont },
      ],
      grid: { show: true, borderWidth: 0, hoverable: true, mouseActiveRadius: 1000 },
      legend: { show: false },
    });
    return true;
  }

  function ensureOverlays() {
    const el = document.getElementById(PLOT_ID);
    if (!el) return;
    if (!crosshair || crosshair.parentNode !== el) {
      crosshair = document.createElement('div');
      crosshair.style.cssText =
        'position:absolute;top:0;bottom:0;width:1px;background:#7a1f1f;display:none;pointer-events:none;z-index:5;';
      el.appendChild(crosshair);
    }
    if (!tooltip || !tooltip.isConnected) {
      // Host the tooltip in a fixed, viewport-sized, overflow-hidden layer. Because the
      // layer is position:fixed and clips its overflow, the tooltip can never enlarge the
      // document — so toggling it none<->block (or measuring it mid-reflow at a stale
      // position) can no longer spawn a transient scrollbar / page jitter.
      let layer = document.getElementById('sr-tip-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'sr-tip-layer';
        layer.style.cssText =
          'position:fixed;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:9999;';
        document.body.appendChild(layer);
      }
      tooltip = document.createElement('div');
      tooltip.style.cssText =
        'position:absolute;display:none;pointer-events:none;background:rgba(20,20,20,.92);' +
        'color:#fff;font-size:11px;line-height:1.5;padding:5px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;';
      layer.appendChild(tooltip);
    }
    // One chart dot per rider (compare) or one (single). Rebuild if detached.
    if (playDots.length && playDots[0].parentNode !== el) {
      playDots.forEach((d) => { try { d.remove(); } catch (e) {} });
      playDots = [];
    }
    const nDots = isCompare() ? validRiders().length : 1;
    while (playDots.length < nDots) {
      const i = playDots.length;
      const color = isCompare() ? riderColor(i) : COLORS.speed;
      const dot = document.createElement('div');
      dot.style.cssText =
        'position:absolute;width:12px;height:12px;border-radius:50%;background:' + color +
        ';border:2px solid #fff;transform:translate(-50%,-50%);display:none;pointer-events:none;z-index:6;';
      el.appendChild(dot);
      playDots.push(dot);
    }
  }

  function row(color, label, value) {
    return (
      '<div><span style="display:inline-block;width:9px;height:9px;background:' + color +
      ';margin-right:6px;border-radius:1px;"></span>' + label + ': ' + value + '</div>'
    );
  }

  // Place the tooltip near the cursor but clamped to the visible viewport, so it can never
  // poke past the document edge and add a transient document-level scrollbar (which would
  // show as a second scrollbar next to the sidebar's own). clientWidth/Height exclude any
  // existing scrollbars, so clamping against them can't itself create new overflow.
  function positionTooltip(pageX, pageY) {
    if (!tooltip) return;
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const vh = doc.clientHeight;
    const sx = window.pageXOffset || doc.scrollLeft || 0;
    const sy = window.pageYOffset || doc.scrollTop || 0;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const pad = 4;
    // The tooltip lives in a position:fixed layer, so it's placed in viewport coordinates.
    const cx = pageX - sx;
    const cy = pageY - sy;

    let left = cx + 14;
    let top = cy - 10;
    // Flip to the left of the cursor if it would overflow the right edge.
    if (left + tw > vw - pad) left = cx - tw - 14;
    // Clamp vertically (the chart sits low, so the tooltip tends to overflow the bottom).
    if (top + th > vh - pad) top = vh - th - pad;
    if (left < pad) left = pad;
    if (top < pad) top = pad;

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  // --- Map sync: one dot per rider on the Leaflet map that follows the hovered point ---
  let mapDots = [];
  let mapDotMap = null;

  function setMapDotAt(i, lat, lng, color) {
    const map = window.SRSRCNG && window.SRSRCNG.map;
    if (!map || !window.L) return;
    if (mapDotMap !== map) {
      // map instance changed (pane swap) -> drop the old markers
      mapDots.forEach((d) => { try { mapDotMap && mapDotMap.removeLayer(d); } catch (e) {} });
      mapDots = [];
      mapDotMap = map;
    }
    let d = mapDots[i];
    if (!d) {
      d = window.L.circleMarker([lat, lng], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: color || '#fa554f',
        fillOpacity: 1,
        opacity: 1,
        interactive: false,
      });
      mapDots[i] = d;
      d.addTo(map);
    } else {
      d.setLatLng([lat, lng]);
      if (!map.hasLayer(d)) d.addTo(map);
    }
    if (d.bringToFront) d.bringToFront();
  }

  // Single-rider convenience.
  function setMapDot(lat, lng, color) {
    setMapDotAt(0, lat, lng, color);
  }

  function hideMapDots() {
    mapDots.forEach((d) => { try { mapDotMap && mapDotMap.removeLayer(d); } catch (e) {} });
  }

  // --- Track colouring: overlay the lap trace coloured by accel/brake ---
  let trackLayer = null;
  let trackLayerMap = null;

  function trackColor(accel) {
    if (accel > ACCEL_T) return TRACK.accel;
    if (accel < -ACCEL_T) return TRACK.brake;
    return TRACK.steady;
  }

  // Render our colour trace in a pane *below* overlayPane so the site's moving playback
  // dot (a CircleMarker in overlayPane) and the numbered sector markers stay on top.
  const TRACE_PANE = 'srTrace';

  function ensureTracePane(map) {
    if (map.getPane(TRACE_PANE)) return;
    map.createPane(TRACE_PANE);
    const p = map.getPane(TRACE_PANE);
    p.style.zIndex = 350; // between tilePane(200) and overlayPane(400)
    p.style.pointerEvents = 'none';
  }

  // Hide the site's flat lap polyline — our colour trace replaces it (same path, coloured).
  function hideSiteLapLine(map) {
    map.eachLayer((l) => {
      if (l instanceof window.L.Polyline && !(l instanceof window.L.Polygon)) {
        try {
          const ll = l.getLatLngs();
          const n = Array.isArray(ll) ? ll.flat(3).length : 0;
          if (n > 50) l.setStyle({ opacity: 0 });
        } catch (e) {}
      }
    });
  }

  function renderTrackColour() {
    const map = window.SRSRCNG && window.SRSRCNG.map;
    if (!map || !window.L) return;
    if (trackLayer && trackLayerMap === map) return; // already drawn for this map instance
    if (trackLayer && trackLayerMap) {
      try { trackLayerMap.removeLayer(trackLayer); } catch (e) {}
    }
    const rider = primaryRider();
    if (!rider) return;
    ensureTracePane(map);
    hideSiteLapLine(map);
    const pts = rider.data;
    const group = window.L.layerGroup();

    // Merge consecutive same-colour points into runs to keep the layer count low.
    let runColor = trackColor(pts[0][4]);
    let coords = [[pts[0][0], pts[0][1]]];
    const flush = (color) => {
      if (coords.length > 1) {
        window.L.polyline(coords, {
          pane: TRACE_PANE,
          color: color,
          weight: 5,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        }).addTo(group);
      }
    };
    for (let i = 1; i < pts.length; i++) {
      const c = trackColor(pts[i][4]);
      coords.push([pts[i][0], pts[i][1]]);
      if (c !== runColor) {
        flush(runColor);
        coords = [[pts[i][0], pts[i][1]]]; // overlap by the boundary point so runs connect
        runColor = c;
      }
    }
    flush(runColor);

    group.addTo(map);
    trackLayer = group;
    trackLayerMap = map;
  }

  function bindHover() {
    const el = document.getElementById(PLOT_ID);
    if (!el) return;
    const compare = isCompare();
    const maxX = compare ? maxLapTime() : (primaryRider().data.length - 1) * DT;

    $(el)
      .off('plothover.srtele')
      .on('plothover.srtele', function (event, pos) {
        if (!pos || pos.x == null || pos.x < 0 || pos.x > maxX) {
          tooltip.style.display = 'none';
          if (playing) renderPlaybackPos();
          else hideTransient();
          return;
        }
        // x is elapsed time in both modes now; the seek fns place dots + map markers +
        // legend and return the tooltip HTML.
        tooltip.innerHTML = compare ? seekToTime(pos.x) : seekTo(pos.x / DT);
        tooltip.style.display = 'block';
        positionTooltip(event.pageX, event.pageY);
      })
      .off('mouseleave.srtele')
      .on('mouseleave.srtele', function () {
        tooltip.style.display = 'none';
        if (playing) {
          renderPlaybackPos(); // hand the crosshair/dots back to playback
          return;
        }
        hideTransient();
      });
  }

  // --- Playback: animate a dot along the chart (and the map) over the lap time ---
  let playing = false;
  let playIdx = 0;
  let rafId = null;
  let lastTs = null;

  function setPlayIcon() {
    const b = document.getElementById('sr-play');
    if (!b) return;
    b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    b.title = playing ? 'Pause' : 'Play';
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    b.classList.toggle('is-playing', playing);
  }

  function hideTransient() {
    if (crosshair) crosshair.style.display = 'none';
    playDots.forEach((d) => { d.style.display = 'none'; });
    hideMapDots();
  }

  // SINGLE mode: position crosshair + chart dot + map dot + legend at a FRACTIONAL sample
  // index, interpolating between bracketing samples for smooth playback. Returns tooltip HTML.
  function seekTo(idxFloat) {
    if (!plot || !crosshair || !playDots[0]) return '';
    const rider = primaryRider();
    if (!rider) return '';
    const pts = rider.data;
    const maxIdx = pts.length - 1;
    if (idxFloat < 0) idxFloat = 0;
    if (idxFloat > maxIdx) idxFloat = maxIdx;
    const i0 = Math.floor(idxFloat);
    const i1 = Math.min(i0 + 1, maxIdx);
    const f = idxFloat - i0;
    const a = pts[i0], b = pts[i1];
    const lat = a[0] + (b[0] - a[0]) * f;
    const lng = a[1] + (b[1] - a[1]) * f;
    const spd = a[2] + (b[2] - a[2]) * f;
    const acc = a[4] + (b[4] - a[4]) * f;
    const lean = a[5] + (b[5] - a[5]) * f;
    const t = idxFloat * DT;

    const base = plot.pointOffset({ x: t, y: 0, yaxis: 1 });
    crosshair.style.left = base.left + 'px';
    crosshair.style.display = 'block';

    const sp = plot.pointOffset({ x: t, y: spd * speedMult(), yaxis: 1 });
    playDots[0].style.left = sp.left + 'px';
    playDots[0].style.top = sp.top + 'px';
    playDots[0].style.display = 'block';

    setMapDot(lat, lng, rider.color || '#fa554f');
    setLegendValues(spd, acc, lean);

    return (
      '<div style="font-weight:600;margin-bottom:2px;">' + fmtTime(t) + '</div>' +
      row(COLORS.speed, 'Speed', (spd * speedMult()).toFixed(2) + ' ' + speedUnit()) +
      row(COLORS.g, 'Acc/Brk G', (acc / G).toFixed(2)) +
      row(COLORS.lean, 'Lean Angle', lean.toFixed(1))
    );
  }

  // COMPARE mode: place every rider's chart dot + map dot + legend speed at an elapsed TIME.
  // Each rider is sampled at the same time, clamped to its own lap length — so a faster lap's
  // dot pulls ahead on the track and clamps at its finish once that lap ends. Returns tooltip.
  function seekToTime(t) {
    if (!plot || !crosshair) return '';
    const riders = validRiders();
    if (!riders.length) return '';
    const maxT = maxLapTime();
    if (t < 0) t = 0;
    if (t > maxT) t = maxT;

    const base = plot.pointOffset({ x: t, y: 0, yaxis: 1 });
    crosshair.style.left = base.left + 'px';
    crosshair.style.display = 'block';

    const speeds = [];
    let tip = '<div style="font-weight:600;margin-bottom:2px;">' + fmtTime(t) + '</div>';
    riders.forEach((rider, i) => {
      const pts = rider.data;
      const last = pts.length - 1;
      let fi = t / DT;
      if (fi > last) fi = last; // shorter lap: clamp at its finish
      const i0 = Math.floor(fi), i1 = Math.min(i0 + 1, last), f = fi - i0;
      const a = pts[i0], b = pts[i1];
      const lat = a[0] + (b[0] - a[0]) * f;
      const lng = a[1] + (b[1] - a[1]) * f;
      const spd = a[2] + (b[2] - a[2]) * f;
      speeds.push(spd);
      const dot = playDots[i];
      if (dot) {
        // chart dot rides this rider's own line, so anchor it at the rider's clamped time.
        const sp = plot.pointOffset({ x: fi * DT, y: spd * speedMult(), yaxis: 1 });
        dot.style.left = sp.left + 'px';
        dot.style.top = sp.top + 'px';
        dot.style.display = 'block';
      }
      setMapDotAt(i, lat, lng, riderColor(i));
      tip += row(riderColor(i), riderLabel(i), (spd * speedMult()).toFixed(0) + ' ' + speedUnit());
    });
    setCompareLegend(speeds);
    return tip;
  }

  function renderPlaybackPos() {
    if (isCompare()) seekToTime(playIdx * DT);
    else seekTo(playIdx);
  }

  // Playback is paced in real time. In compare mode it runs against the LONGEST lap so the
  // whole race plays out (the faster rider finishes first and its dot waits at the line).
  function paceRider() {
    if (!isCompare()) return primaryRider();
    return validRiders().reduce((a, b) => (b.data.length > a.data.length ? b : a));
  }

  function frame(ts) {
    if (!playing) return;
    if (!document.getElementById(PLOT_ID)) { stopPlayback(); return; }
    if (lastTs == null) lastTs = ts;
    const dtSec = (ts - lastTs) / 1000;
    lastTs = ts;
    const n = paceRider().data.length;
    playIdx += dtSec / DT; // real-time: advance one sample per 0.1 s elapsed
    if (playIdx >= n - 1) {
      playIdx = n - 1;
      renderPlaybackPos();
      stopPlayback();
      return;
    }
    renderPlaybackPos();
    rafId = window.requestAnimationFrame(frame);
  }

  function startPlayback() {
    if (playing) return;
    const n = paceRider().data.length;
    if (playIdx >= n - 1) playIdx = 0; // restart from the beginning
    playing = true;
    lastTs = null;
    setPlayIcon();
    rafId = window.requestAnimationFrame(frame);
  }

  function stopPlayback() {
    playing = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = null;
    setPlayIcon();
  }

  function togglePlayback() {
    if (playing) stopPlayback();
    else startPlayback();
  }

  function render() {
    if (!ready()) return;
    if (window.SRSRCNG.currentlyViewing && window.SRSRCNG.currentlyViewing !== 'map') return;
    // In compare mode keep the site's two per-rider traces; only colour the trace solo.
    if (!isCompare()) renderTrackColour();
    hideSiteSpeedChart();
    hidePlaybackControls();
    hideSiteRiderMarkers();
    if (!ensurePanel()) return;
    applyLayout();
    if (draw()) {
      ensureOverlays();
      bindHover();
      if (isCompare()) seedCompareLegend(); // seed each rider's readout
      else updateLegend(0);
    }
  }

  // Flot doesn't auto-resize our chart; redraw + re-bind on resize.
  let resizeId = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeId);
    resizeId = setTimeout(() => {
      if (!document.getElementById(PLOT_ID)) return;
      applyLayout();
      if (draw()) {
        ensureOverlays();
        bindHover();
      }
    }, 150);
  });

  // The map pane is swapped in via jQuery .html(); re-inject when our panel is gone
  // but the speed chart is present.
  const obs = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID) && mapPaneReady()) render();
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Poll until BOTH the chart and the track overlay are up. The map (window.SRSRCNG.map)
  // can initialise after our chart, so we keep retrying the track colour until it exists
  // instead of assuming a load order.
  let tries = 0;
  const poll = setInterval(() => {
    tries += 1;
    // single mode also waits for the accel trace; compare mode has no overlay.
    const chartUp = document.getElementById(PLOT_ID) && (isCompare() || trackLayer);
    if (chartUp || tries > 60) {
      clearInterval(poll);
      return;
    }
    render();
  }, 250);
})();
