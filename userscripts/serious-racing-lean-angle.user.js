// ==UserScript==
// @name         Serious-Racing — Telemetry Chart (Speed + Acc/Brk G + Lean) + Track Colouring
// @namespace    https://serious-racing.com/
// @version      2.5.1
// @description  Adds a combined telemetry chart (Speed, Acc/Brk G-force, Lean angle) on a time axis with crosshair + multi-value tooltip, a map dot that follows the hovered point, and recolours the lap trace green/yellow/red by accel/brake. JS-only, reads window.SRSRCNG — no server access needed.
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
 */
(function () {
  'use strict';

  const PANEL_ID = 'sr-tele-panel';
  const PLOT_ID = 'sr-tele-plot';
  const DT = 0.1; // seconds per sample (10 Hz)
  const G = 9.81;

  const COLORS = { speed: '#e23b3b', g: '#6cae3e', lean: '#3d7fd6' };

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
      '<span id="' + valueId + '" style="display:inline-block;margin-left:6px;min-width:' + minW +
      'px;text-align:left;font-weight:600;font-variant-numeric:tabular-nums;color:' + color + ';">–</span>' +
      '</span>'
    );
  }

  function fmtLean(deg) {
    return (deg < 0 ? 'L ' : 'R ') + Math.abs(deg).toFixed(0) + '°';
  }

  function updateLegend(idx) {
    const rider = primaryRider();
    if (!rider || !rider.data[idx]) return;
    const p = rider.data[idx];
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('sr-leg-speed', (p[2] * speedMult()).toFixed(0) + ' ' + speedUnit());
    set('sr-leg-g', (p[4] / G).toFixed(2) + ' G');
    set('sr-leg-lean', fmtLean(p[5]));
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
    panel.innerHTML =
      '<div style="display:flex;justify-content:center;align-items:center;font-size:11px;color:#fff;padding:6px 8px 2px;">' +
      legendChip(COLORS.speed, 'Speed', 'sr-leg-speed', 64) +
      legendChip(COLORS.g, 'Acc/Brk G', 'sr-leg-g', 56) +
      legendChip(COLORS.lean, 'Lean Angle', 'sr-leg-lean', 48) +
      '</div>' +
      '<div id="' + PLOT_ID + '" style="position:relative;width:100%;height:' + PLOT_H + 'px;"></div>';

    mapEl.appendChild(panel);
    return panel;
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

  function draw() {
    const el = document.getElementById(PLOT_ID);
    if (!el || el.offsetWidth === 0) return false;
    const rider = primaryRider();
    if (!rider) return false;

    const maxT = (rider.data.length - 1) * DT;
    const axisFont = { color: '#9aa0a6', size: 10 };
    const tickColor = 'rgba(255,255,255,.08)';

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
        { position: 'right', min: -50, max: 50, ticks: [-50, -40, -20, 0, 20, 40, 50], tickColor: tickColor, font: axisFont },
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
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.style.cssText =
        'position:absolute;display:none;z-index:9999;pointer-events:none;background:rgba(20,20,20,.92);' +
        'color:#fff;font-size:11px;line-height:1.5;padding:5px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;';
      document.body.appendChild(tooltip);
    }
  }

  function row(color, label, value) {
    return (
      '<div><span style="display:inline-block;width:9px;height:9px;background:' + color +
      ';margin-right:6px;border-radius:1px;"></span>' + label + ': ' + value + '</div>'
    );
  }

  // --- Map sync: a dot on the Leaflet map that follows the hovered chart point ---
  let mapDot = null;
  let mapDotMap = null;

  function setMapDot(lat, lng, color) {
    const map = window.SRSRCNG && window.SRSRCNG.map;
    if (!map || !window.L) return;
    if (!mapDot || mapDotMap !== map) {
      if (mapDot && mapDotMap) {
        try { mapDotMap.removeLayer(mapDot); } catch (e) {}
      }
      mapDot = window.L.circleMarker([lat, lng], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: color || '#fa554f',
        fillOpacity: 1,
        opacity: 1,
        interactive: false,
      });
      mapDotMap = map;
      mapDot.addTo(map);
    } else {
      mapDot.setLatLng([lat, lng]);
      if (!map.hasLayer(mapDot)) mapDot.addTo(map);
    }
    if (mapDot.bringToFront) mapDot.bringToFront();
  }

  function hideMapDot() {
    if (mapDot && mapDotMap) {
      try { mapDotMap.removeLayer(mapDot); } catch (e) {}
    }
  }

  // --- Track colouring: overlay the lap trace coloured by accel/brake ---
  let trackLayer = null;
  let trackLayerMap = null;

  function trackColor(accel) {
    if (accel > ACCEL_T) return TRACK.accel;
    if (accel < -ACCEL_T) return TRACK.brake;
    return TRACK.steady;
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
    const pts = rider.data;
    const group = window.L.layerGroup();

    // Merge consecutive same-colour points into runs to keep the layer count low.
    let runColor = trackColor(pts[0][4]);
    let coords = [[pts[0][0], pts[0][1]]];
    const flush = (color) => {
      if (coords.length > 1) {
        window.L.polyline(coords, {
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
    const rider = primaryRider();
    const pts = rider.data;
    const maxT = (pts.length - 1) * DT;
    const dotColor = rider.color || '#fa554f';

    $(el)
      .off('plothover.srtele')
      .on('plothover.srtele', function (event, pos) {
        if (!pos || pos.x == null || pos.x < 0 || pos.x > maxT) {
          crosshair.style.display = 'none';
          tooltip.style.display = 'none';
          return;
        }
        let idx = Math.round(pos.x / DT);
        if (idx < 0) idx = 0;
        if (idx >= pts.length) idx = pts.length - 1;
        const p = pts[idx];

        const off = plot.pointOffset({ x: idx * DT, y: 0, yaxis: 1 });
        crosshair.style.left = off.left + 'px';
        crosshair.style.display = 'block';

        setMapDot(p[0], p[1], dotColor);
        updateLegend(idx);

        tooltip.innerHTML =
          '<div style="font-weight:600;margin-bottom:2px;">' + fmtTime(idx * DT) + '</div>' +
          row(COLORS.speed, 'Speed', (p[2] * speedMult()).toFixed(2) + ' ' + speedUnit()) +
          row(COLORS.g, 'Acc/Brk G', (p[4] / G).toFixed(2)) +
          row(COLORS.lean, 'Lean Angle', p[5].toFixed(1));
        tooltip.style.left = event.pageX + 14 + 'px';
        tooltip.style.top = event.pageY - 10 + 'px';
        tooltip.style.display = 'block';
      })
      .off('mouseleave.srtele')
      .on('mouseleave.srtele', function () {
        crosshair.style.display = 'none';
        tooltip.style.display = 'none';
        hideMapDot();
      });
  }

  function render() {
    if (!ready()) return;
    if (window.SRSRCNG.currentlyViewing && window.SRSRCNG.currentlyViewing !== 'map') return;
    renderTrackColour();
    hideSiteSpeedChart();
    if (!ensurePanel()) return;
    applyLayout();
    if (draw()) {
      ensureOverlays();
      bindHover();
      updateLegend(0); // seed the readout before the first hover
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

  // Initial attempt (poll briefly until the chart pane is ready).
  let tries = 0;
  const poll = setInterval(() => {
    tries += 1;
    if (document.getElementById(PLOT_ID) || tries > 40) {
      clearInterval(poll);
      return;
    }
    render();
  }, 250);
})();
