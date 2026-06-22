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
      // Speed is the hero: a slightly thicker line (no fill — kept as a clean trace).
      { label: 'Speed', data: speed, color: COLORS.speed, yaxis: 1, lines: { lineWidth: 1.8 }, shadowSize: 0 },
      { label: 'Acc/Brk G', data: gforce, color: COLORS.g, yaxis: 2, lines: { lineWidth: 1.3 }, shadowSize: 0 },
      { label: 'Lean Angle', data: lean, color: COLORS.lean, yaxis: 3, lines: { lineWidth: 1.3 }, shadowSize: 0 },
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
      '<span class="sr-leg-chip">' +
      '<span class="sr-leg-swatch" style="background:' + color + ';box-shadow:0 0 7px ' + color + '88;"></span>' +
      '<span class="sr-leg-label">' + label + '</span>' +
      '<span id="' + valueId + '" class="sr-leg-val" style="width:' + minW + 'px;color:' + color + ';">–</span>' +
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

