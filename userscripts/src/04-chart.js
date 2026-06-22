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

  // Hide the site's own position markers (SRSRCNG.dataMarker, parked at the start line).
  // Redundant now that we own the moving dots. Handles single/array/nested values and both
  // CircleMarker (setStyle) and icon markers (setOpacity), and removes them outright.
  function hideSiteRiderMarkers() {
    const map = window.SRSRCNG && window.SRSRCNG.map;
    const out = [];
    const collect = (x) => { if (!x) return; Array.isArray(x) ? x.forEach(collect) : out.push(x); };
    collect(window.SRSRCNG && window.SRSRCNG.dataMarker);
    out.forEach((m) => {
      try {
        if (m.setStyle) m.setStyle({ opacity: 0, fillOpacity: 0 });
        if (m.setOpacity) m.setOpacity(0);
        if (map && map.hasLayer && map.hasLayer(m)) map.removeLayer(m);
      } catch (e) {}
    });

    // Compare playback: a stray site dot can linger on the start line even after the above
    // (it can be created after our first pass). Sweep any CircleMarker still parked at the
    // start line that isn't one of our own dots, and hide it.
    if (map && window.L && isCompare()) {
      const r0 = validRiders()[0];
      if (!r0) return;
      const start = window.L.latLng(r0.data[0][0], r0.data[0][1]);
      map.eachLayer((l) => {
        if (l instanceof window.L.CircleMarker && mapDots.indexOf(l) === -1) {
          try {
            if (l.getLatLng && map.distance(l.getLatLng(), start) < 8) {
              l.setStyle({ opacity: 0, fillOpacity: 0 });
            }
          } catch (e) {}
        }
      });
    }
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
  let playDots = [];

  function draw() {
    const el = document.getElementById(PLOT_ID);
    if (!el || el.offsetWidth === 0) return false;
    const axisFont = { color: '#727b8a', size: 9.5, family: AXIS_FONT_FAMILY, weight: '500' };
    const tickColor = 'rgba(148,163,184,.07)';
    // Subtle vertical gradient inside the plot area for depth (instrument-panel feel).
    const plotBg = { colors: ['#171a20', '#0d0f13'] };

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
        grid: { show: true, borderWidth: 0, hoverable: true, clickable: true, mouseActiveRadius: 1000, backgroundColor: plotBg },
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
      grid: { show: true, borderWidth: 0, hoverable: true, clickable: true, mouseActiveRadius: 1000, backgroundColor: plotBg },
      legend: { show: false },
    });
    return true;
  }

  function ensureOverlays() {
    const el = document.getElementById(PLOT_ID);
    if (!el) return;
    if (!crosshair || crosshair.parentNode !== el) {
      crosshair = document.createElement('div');
      crosshair.className = 'sr-ov';
      crosshair.style.cssText =
        'position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.32);' +
        'box-shadow:0 0 6px rgba(255,255,255,.15);display:none;pointer-events:none;z-index:5;';
      el.appendChild(crosshair);
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
      dot.className = 'sr-ov';
      dot.style.cssText =
        'position:absolute;width:11px;height:11px;border-radius:50%;background:' + color +
        ';border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4),0 0 9px ' + color +
        'cc;transform:translate(-50%,-50%);display:none;pointer-events:none;z-index:6;';
      el.appendChild(dot);
      playDots.push(dot);
    }
  }

  function row(color, label, value) {
    return (
      '<div class="sr-tip-row"><span class="k"><i style="background:' + color + '"></i>' + label +
      '</span><span class="v">' + value + '</span></div>'
    );
  }

