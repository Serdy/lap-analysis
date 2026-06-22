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

  // Restore the site's flat polyline to visible (used on bail path so the map isn't blank).
  function showSiteLapLine(map) {
    map.eachLayer((l) => {
      if (l instanceof window.L.Polyline && !(l instanceof window.L.Polygon)) {
        try {
          const ll = l.getLatLngs();
          const n = Array.isArray(ll) ? ll.flat(3).length : 0;
          if (n > 50) l.setStyle({ opacity: 1 });
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
      trackLayer = null;
      trackLayerMap = null;
    }
    const rider = primaryRider();
    if (!rider) return;

    // --- SR_TRACK pipeline ---
    const pts = rider.data;
    const col4     = pts.map((p) => p[4]);
    const speedMph = pts.map((p) => p[2]); // col2 is mph base unit per CLAUDE.md
    const lean     = pts.map((p) => p[5]);

    const valid = SR_TRACK.validity(col4, speedMph, lean);
    if (valid.bail) {
      // Both sensors unusable — leave the site's default flat line visible and draw nothing.
      showSiteLapLine(map);
      return;
    }

    const score = SR_TRACK.computeScore(col4, speedMph, lean, valid);
    const rawBand = SR_TRACK.quantize(score);

    // MIN_RUN absorption: merge runs shorter than cfg.MIN_RUN samples into the previous run.
    const MIN_RUN = SR_TRACK.DEFAULT_CFG.MIN_RUN; // 4 samples = 0.4 s
    const band = rawBand.slice(); // work on a copy
    let i = 0;
    while (i < band.length) {
      // Find end of current run
      let j = i + 1;
      while (j < band.length && band[j] === band[i]) j++;
      const runLen = j - i;
      if (runLen < MIN_RUN && i > 0) {
        // Absorb into previous run's band value
        const prev = band[i - 1];
        for (let k = i; k < j; k++) band[k] = prev;
        // Don't advance i — the absorbed samples now belong to the previous run;
        // merge backward by re-scanning from the previous run boundary.
        // To avoid O(n²) on adversarial input, just continue forward — the next
        // iteration will naturally extend the previous band's run.
      }
      i = j;
    }

    ensureTracePane(map);
    hideSiteLapLine(map);

    const group = window.L.layerGroup();

    // Merge consecutive equal-band points into polyline runs (boundary-overlap so runs connect).
    let runBand = band[0];
    let coords = [[pts[0][0], pts[0][1]]];
    const flush = (b) => {
      if (coords.length > 1) {
        window.L.polyline(coords, {
          pane:        TRACE_PANE,
          color:       SR_TRACK.bandToColor(b),
          weight:      5,
          opacity:     0.92,
          lineCap:     'round',
          lineJoin:    'round',
          interactive: false,
        }).addTo(group);
      }
    };
    for (i = 1; i < pts.length; i++) {
      coords.push([pts[i][0], pts[i][1]]);
      if (band[i] !== runBand) {
        flush(runBand);
        coords = [[pts[i][0], pts[i][1]]]; // overlap by boundary point so runs connect
        runBand = band[i];
      }
    }
    flush(runBand);

    group.addTo(map);
    trackLayer = group;
    trackLayerMap = map;
  }

