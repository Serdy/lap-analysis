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

  // --- Compare-mode events: braking-onset markers + corner coaching markers ---
  // See userscripts/DESIGN-srEvents.md. This task (T7) wires up the pane, the
  // map-instance lifecycle guard, and the guarded SR_TRACK.buildCompareEvents()
  // call, rendering simple PLACEHOLDER markers. T8 replaces onset markers with
  // the rotated fanned triangle glyph; T9 replaces corner markers with the
  // coaching label chip — both slot into renderOnsetMarker()/renderCornerMarker()
  // below without touching the surrounding lifecycle code.
  let eventsLayer = null;
  let eventsLayerMap = null;

  // T10: cached detection model (onsets/corners) for the current map instance, kept
  // separate from `eventsLayer` (the rendered group) so zoom/pan LOD recompute only
  // re-filters + re-draws — it never re-runs SR_TRACK.buildCompareEvents().
  let eventsModel = null;
  let eventsModelMap = null;

  // T10: the bound zoomend/moveend LOD handler for the CURRENT map instance, so the
  // map-instance-change teardown path can unbind it (map.off) before ever touching a
  // dead/replaced Leaflet map. Guards double-binding on repeated renderCompareEvents().
  let eventsLodHandler = null;
  let eventsLodHandlerMap = null;

  // --- T10: clutter / LOD config (see DESIGN-srEvents.md §7-8) ---
  // LOD_ZOOM_FULL: UNVALIDATED — a best-guess crossover zoom, not measured against a
  // real Leaflet session on serious-racing.com (tracks range from karting circuits to
  // full GP layouts, and zoom-to-metres-per-pixel varies by tile provider/latitude).
  // Tune this constant after visual QA against a real lap; nothing else here depends
  // on the exact value.
  const LOD_ZOOM_FULL = 15;       // Z >= this: render everything in viewport; Z < this: top-K only, no chips
  const LOD_TOP_K = 3;            // per-rider onsets kept at Z < LOD_ZOOM_FULL, ranked by severity
  const COLLAPSE_RADIUS_PX = 24;  // screen-space px; triangle candidates closer than this collapse to one

  // --- Corner chip declutter: collapse by ESTIMATED RENDERED-RECT INTERSECTION, ---
  // --- not anchor-point distance. ---
  //
  // An anchor-distance radius (like COLLAPSE_RADIUS_PX for triangles) is wrong for
  // chips: each corner chip is a large card offset from its anchor, so two anchors
  // within some "small" radius can still render two cards that overlap (confirmed
  // live: default zoom ~15.6 showed 9 chips with 3 overlapping pairs even after a
  // 90px anchor-radius pass). Instead we estimate each chip's actual on-screen box
  // (see chipRectAt() below) and suppress a candidate if its box intersects any
  // already-kept chip's box, guaranteeing the same non-overlap the E2E asserts via
  // getBoundingClientRect().
  //
  // These mirror the CSS in ensureEventStyles() below — if that CSS's
  // max-width/max-height on `.sr-evt-chip` ever changes, update these too.
  const CHIP_CARD_W = 168; // .sr-evt-chip max-width
  const CHIP_CARD_H = 104; // .sr-evt-chip max-height
  const CHIP_GAP_PX = 6;   // extra breathing room required between kept chips' boxes

  // Above srTrace (350) and the site's overlayPane (400) so triangles sit on top
  // of both the colour trace and the site's own sector markers (per the design doc).
  const EVENTS_PANE = 'srEvents';

  function ensureEventsPane(map) {
    if (map.getPane(EVENTS_PANE)) return;
    map.createPane(EVENTS_PANE);
    const p = map.getPane(EVENTS_PANE);
    p.style.zIndex = 360;
    p.style.pointerEvents = 'none';
  }

  // Guarded single-<style> injection, mirroring 02-styles.js's ensureStyles() pattern
  // exactly (unique id, string-built css, appended once). Kept in 05-map.js rather than
  // 02-styles.js because it's specific to the srEvents overlay this file owns; T9 folds
  // its corner-chip CSS into the same block.
  const FAN_GAP_PX = 10; // DEFAULT_CFG.FAN_GAP_PX per DESIGN-srEvents.md §4/§8

  function ensureEventStyles() {
    if (document.getElementById('sr-events-styles')) return;
    const css =
      // Braking-onset triangle chrome (transparent host, shadow allowed to bleed).
      '.sr-evt-tri-host{transform-origin:center center;}' +
      '.sr-evt-tri{display:block;background:transparent !important;border:none !important;' +
      'overflow:visible !important;pointer-events:auto;transform-origin:9px 9px;}' +
      // Corner coaching chip: dark instrument-panel card, matches .sr-leg-* family.
      '.sr-evt-chip-host{display:block;width:auto;height:auto;}' +
      '.sr-evt-chip{position:absolute;pointer-events:none;' +
      'background:rgba(17,19,23,.92);border:1px solid rgba(255,255,255,.10);' +
      'border-radius:8px;padding:7px 10px;max-width:168px;max-height:104px;overflow:hidden;' +
      'box-shadow:0 3px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05);' +
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;white-space:nowrap;' +
      'transition:opacity .12s ease;z-index:650;transform:translate(-50%,-100%);left:50%;top:100%;}' +
      '.sr-evt-chip.sr-evt-chip-hidden{opacity:0;}' +
      '.sr-evt-chip-title{font-size:9.5px;letter-spacing:.6px;text-transform:uppercase;' +
      'color:#838c9a;font-weight:600;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;}' +
      '.sr-evt-chip-row{display:flex;align-items:center;gap:6px;line-height:15px;}' +
      '.sr-evt-chip-row + .sr-evt-chip-row{margin-top:2px;}' +
      '.sr-evt-chip-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;}' +
      '.sr-evt-chip-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;' +
      'font-size:11px;font-weight:500;color:#e7e9ee;}' +
      '.sr-evt-chip-speed{flex:0 0 auto;font-size:11px;font-weight:600;color:#e7e9ee;' +
      'font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}' +
      '.sr-evt-chip-delta{flex:0 0 auto;font-size:9.5px;font-weight:500;' +
      'font-variant-numeric:tabular-nums;color:#838c9a;margin-left:2px;min-width:34px;text-align:right;}' +
      '.sr-evt-chip-delta.sr-evt-chip-delta-behind{color:#ff8a80;}' +
      '.sr-evt-chip-delta.sr-evt-chip-delta-ahead{color:#7fe0a3;}';
    const el = document.createElement('style');
    el.id = 'sr-events-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // Perpendicular-to-heading unit vector, in SCREEN px space (x right, y DOWN).
  //
  // Compass heading h (0=N, clockwise) as a travel-direction unit vector on screen
  // is (sin h, -cos h): h=0 (north) -> (0,-1) i.e. "up" the screen, which is correct
  // since y grows downward; h=90 (east) -> (1,0) i.e. "right", also correct.
  //
  // Rotating that travel vector +90° clockwise-on-screen (the "(x,y) -> (-y,x)" screen
  // rotation, which matches CSS's own clockwise-positive rotate() in a y-down system)
  // gives the perpendicular: (cos h, sin h).
  //
  // Sanity checks (see task/spec "always across the track, never along it"):
  //   h=0   (heading north): perp = (1, 0)  -> east/west offsets  -> across a N-S line. OK.
  //   h=90  (heading east):  perp = (0, 1)  -> north/south offsets -> across an E-W line. OK.
  function perpUnitPx(headingDeg) {
    const rad = (headingDeg * Math.PI) / 180;
    return { x: Math.cos(rad), y: Math.sin(rad) };
  }

  // T8: the braking-onset triangle glyph, rotated to travel heading and fanned out
  // per-triangle along the local track-perpendicular so overlapping riders' onsets at
  // the same corner land on different sides of the track instead of stacking.
  //
  // Fan offset is baked into the divIcon's iconAnchor (a per-marker screen-px vector
  // computed from THIS onset's own heading) rather than any single global anchor, so
  // it stays correct as the track curves — no zoomend hook needed (T10's concern).
  function renderOnsetMarker(onset, riderIndex, group) {
    if (!onset || !window.L) return;
    ensureEventStyles();

    const N = validRiders().length || 1;
    const offsetIndex = riderIndex - (N - 1) / 2; // e.g. N=2 -> ∓0.5; N=4 -> ∓1.5/∓0.5
    const offsetPx = offsetIndex * FAN_GAP_PX;
    const perp = perpUnitPx(onset.heading || 0);
    const dx = offsetPx * perp.x;
    const dy = offsetPx * perp.y;

    const color = riderColor(riderIndex);
    const size = 18; // TRIANGLE_SIZE_PX
    const half = size / 2;

    const html =
      '<div class="sr-evt-tri-host">' +
      '<svg class="sr-evt-tri" viewBox="0 0 16 16" width="14" height="14" ' +
      'style="transform:rotate(' + (onset.heading || 0) + 'deg);">' +
      '<defs><filter id="sr-evt-tri-shadow-' + riderIndex + '" x="-60%" y="-60%" width="220%" height="220%">' +
      '<feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-color="#000000" flood-opacity="0.55"/>' +
      '</filter></defs>' +
      '<polygon points="8,1.5 14.2,13.5 1.8,13.5" fill="' + color + '" stroke="#ffffff" ' +
      'stroke-width="1.5" stroke-linejoin="round" filter="url(#sr-evt-tri-shadow-' + riderIndex + ')"/>' +
      '</svg></div>';

    // iconAnchor is the point (in icon-local px, from the icon's top-left) that sits at
    // the marker's lat/lng. Centered anchor is (half, half); subtracting the fan offset
    // shifts the rendered icon by (dx, dy) in screen space (Leaflet positions the icon's
    // top-left at markerScreenPos - iconAnchor, so anchor -= offset => icon += offset).
    const icon = window.L.divIcon({
      className: 'sr-evt-tri',
      html: html,
      iconSize: [size, size],
      iconAnchor: [half - dx, half - dy],
    });

    window.L.marker([onset.lat, onset.lng], {
      icon: icon,
      pane: EVENTS_PANE,
      interactive: false,
    }).addTo(group);
  }

  // T9: the corner coaching label chip. Displays min-speed + brake-delta per rider.
  function renderCornerMarker(corner, group) {
    if (!corner || !window.L) return;
    ensureEventStyles();

    // Collect present riders at this corner (non-null perRider entries).
    const presentRiders = [];
    const perRiderList = corner.perRider || [];
    for (let i = 0; i < perRiderList.length; i++) {
      const pr = perRiderList[i];
      if (pr) {
        presentRiders.push({ riderIndex: i, perRider: pr });
      }
    }
    if (presentRiders.length === 0) return;

    // Anchor at the first present rider's apex; could average but simple is good.
    const firstPresent = presentRiders[0].perRider;
    const anchorLat = firstPresent.apexLat;
    const anchorLng = firstPresent.apexLng;

    // Build the chip HTML: title + rows (one per present rider).
    let html = '<div class="sr-evt-chip">';
    html += '<div class="sr-evt-chip-title">Corner</div>';

    // Sort riders by speed (fastest first = reference).
    presentRiders.sort((a, b) => b.perRider.minSpeed - a.perRider.minSpeed);

    // Build the brake delta lookup: referenceRider -> entry map for quick lookup.
    const brakeDeltaByRider = {};
    if (corner.brakeDelta) {
      brakeDeltaByRider[corner.brakeDelta.referenceRider] = null; // reference has no delta
      for (const entry of corner.brakeDelta.entries) {
        brakeDeltaByRider[entry.riderIndex] = entry;
      }
    }

    // Add one row per present rider.
    for (let i = 0; i < presentRiders.length && i < 4; i++) {
      const { riderIndex, perRider: pr } = presentRiders[i];
      const color = riderColor(riderIndex);
      const label = riderLabel(riderIndex);
      const speedDisplay = Math.round(pr.minSpeed * speedMult());

      html += '<div class="sr-evt-chip-row">';
      html += '<span class="sr-evt-chip-dot" style="background:' + color + ';"></span>';
      html += '<span class="sr-evt-chip-name" title="' + label + '">' + label + '</span>';
      html += '<span class="sr-evt-chip-speed">' + speedDisplay + ' ' + speedUnit() + '</span>';

      // Add delta only if present, >= 3 m, and not the reference rider.
      const delta = brakeDeltaByRider[riderIndex];
      if (delta && Math.abs(delta.metresLater) >= 3) {
        const sign = delta.metresLater > 0 ? '−' : '+';
        const deltaClass = delta.metresLater > 0 ? 'sr-evt-chip-delta-behind' : 'sr-evt-chip-delta-ahead';
        html += '<span class="sr-evt-chip-delta ' + deltaClass + '">' + sign + Math.round(Math.abs(delta.metresLater)) + ' m</span>';
      }

      html += '</div>';
    }

    html += '</div>';

    // Offset: 18px right + 14px up from the corner point (via iconAnchor).
    // Leaflet positions the icon's top-left at markerScreenPos - iconAnchor,
    // so we anchor at (18, -14) to offset right/up in screen space (y-down convention).
    const icon = window.L.divIcon({
      className: 'sr-evt-chip-host',
      html: html,
      iconSize: [0, 0],
      iconAnchor: [18, -14],
    });

    window.L.marker([anchorLat, anchorLng], {
      icon: icon,
      pane: EVENTS_PANE,
      interactive: false,
    }).addTo(group);
  }

  // T10: does `latlng` fall inside the map's current viewport? Used to cull
  // off-screen candidates at full LOD (Z >= LOD_ZOOM_FULL) so DOM stays light on
  // zoomed-in pans. Defensive: a map mid-transition can throw from getBounds(); treat
  // that as "can't tell, keep it" rather than silently dropping markers.
  function inViewport(map, lat, lng) {
    try {
      return map.getBounds().contains([lat, lng]);
    } catch (e) {
      return true;
    }
  }

  // T10: screen-space collapse for TRIANGLES only (corner chips use
  // collapseByRectIntersection below — a small ~18px glyph is well approximated by
  // anchor-point distance, but a large offset card is not, see chipRectAt()). Given
  // a list of `{ lat, lng, severity }`-shaped candidates (already LOD-filtered),
  // project each to a layer point and greedily collapse any two within `radiusPx`
  // of each other, keeping the higher-severity survivor. O(n^2) — n is at most a
  // few dozen markers per corner set, so a spatial index would be premature here.
  //
  // Processes candidates highest-severity-first so a high-severity marker always
  // "claims" its radius and suppresses nearby lower-severity ones, regardless of
  // input order.
  function collapseByScreenDistance(map, candidates, radiusPx) {
    const radius = radiusPx == null ? COLLAPSE_RADIUS_PX : radiusPx;
    const n = candidates.length;
    if (n <= 1) return candidates.slice();

    const pts = candidates.map((c) => map.latLngToLayerPoint([c.lat, c.lng]));
    const order = candidates.map((_, i) => i).sort((a, b) => candidates[b].severity - candidates[a].severity);

    const suppressed = new Array(n).fill(false);
    const kept = [];
    for (const i of order) {
      if (suppressed[i]) continue;
      kept.push(candidates[i]);
      for (const j of order) {
        if (j === i || suppressed[j]) continue;
        if (pts[i].distanceTo(pts[j]) < radius) suppressed[j] = true;
      }
    }
    return kept;
  }

  // T10 (chip-declutter fix): estimate a corner chip's rendered screen-space box for
  // a candidate anchored at [lat, lng], reproducing renderCornerMarker()'s exact
  // Leaflet + CSS placement chain so the estimate matches what getBoundingClientRect()
  // will report in the DOM:
  //
  //   1. Project the anchor lat/lng to a layer point via latLngToLayerPoint (same
  //      projection renderCornerMarker's L.marker uses).
  //   2. renderCornerMarker() sets iconAnchor: [18, -14] on a divIcon with
  //      iconSize: [0, 0]. Leaflet positions the icon host's top-left at
  //      (markerScreenPos - iconAnchor) = (anchorX - 18, anchorY + 14).
  //   3. Inside that (0x0) host, .sr-evt-chip is `position:absolute; left:50%;
  //      top:100%` — of a zero-size box that's just the host's own top-left point,
  //      i.e. still (anchorX - 18, anchorY + 14) — then
  //      `transform:translate(-50%,-100%)` shifts it by (-cardW/2, -cardH) using the
  //      chip's own rendered box. We use the CSS max box (CHIP_CARD_W x CHIP_CARD_H)
  //      as a conservative (over-)estimate, since smaller chips only shrink the
  //      overlap risk.
  //
  // Net top-left = (anchorX - 18 - CHIP_CARD_W/2, anchorY + 14 - CHIP_CARD_H).
  function chipRectAt(map, lat, lng) {
    const p = map.latLngToLayerPoint([lat, lng]);
    const left = p.x - 18 - CHIP_CARD_W / 2;
    const top = p.y + 14 - CHIP_CARD_H;
    return { left: left, top: top, right: left + CHIP_CARD_W, bottom: top + CHIP_CARD_H };
  }

  // Standard axis-aligned rect intersection, expanded by `gap` on all sides of `a`
  // (equivalent to requiring `gap` px of clearance between the two boxes).
  function rectsIntersect(a, b, gap) {
    const g = gap || 0;
    return (
      a.left - g < b.right &&
      b.left < a.right + g &&
      a.top - g < b.bottom &&
      b.top < a.bottom + g
    );
  }

  // T10 (chip-declutter fix): collapse corner-chip candidates by estimated RECT
  // intersection rather than anchor-point distance (see chipRectAt() above for why
  // distance alone is insufficient). Processes candidates highest-severity-first
  // (same ranking as collapseByScreenDistance) so the most significant corners'
  // chips always get first claim on the screen; any candidate whose estimated box
  // would overlap an already-kept chip's box (plus CHIP_GAP_PX clearance) is
  // suppressed. Guarantees zero overlapping rects among survivors, matching the
  // E2E's getBoundingClientRect() pairwise check exactly.
  function collapseByRectIntersection(map, candidates) {
    const n = candidates.length;
    if (n <= 1) return candidates.slice();

    const rects = candidates.map((c) => chipRectAt(map, c.lat, c.lng));
    const order = candidates.map((_, i) => i).sort((a, b) => candidates[b].severity - candidates[a].severity);

    const kept = [];
    const keptRects = [];
    for (const i of order) {
      const r = rects[i];
      let overlaps = false;
      for (const kr of keptRects) {
        if (rectsIntersect(r, kr, CHIP_GAP_PX)) { overlaps = true; break; }
      }
      if (overlaps) continue;
      kept.push(candidates[i]);
      keptRects.push(r);
    }
    return kept;
  }

  // T10: pick the surviving onsets for one rider at the current zoom/viewport, then
  // collapse near-duplicates. Zoom LOD and collapse are independent passes: LOD
  // decides the *candidate set* (top-K vs. viewport-culled-all), collapse then dedups
  // whatever survived that set.
  function lodFilterOnsets(map, riderOnsets, zoom) {
    let candidates;
    if (zoom < LOD_ZOOM_FULL) {
      candidates = riderOnsets.slice().sort((a, b) => b.severity - a.severity).slice(0, LOD_TOP_K);
    } else {
      candidates = riderOnsets.filter((o) => inViewport(map, o.lat, o.lng));
    }
    return collapseByScreenDistance(map, candidates);
  }

  // T10: corner chips only ever render at full LOD (Z >= LOD_ZOOM_FULL, per the
  // design doc's "no chips below LOD_ZOOM_FULL" rule), viewport-culled by the first
  // present rider's apex, then collapsed by estimated rendered-rect intersection
  // (collapseByRectIntersection — see chipRectAt() for why anchor distance alone
  // isn't enough for these large offset cards). Rank/severity proxy for collapse
  // ties = the corner's deepest (lowest) minSpeed across present riders — a slower
  // apex is the more significant corner to keep.
  function lodFilterCorners(map, corners, zoom) {
    if (zoom < LOD_ZOOM_FULL) return [];
    const candidates = [];
    for (const corner of corners) {
      const present = (corner.perRider || []).filter(Boolean);
      if (present.length === 0) continue;
      const anchor = present[0];
      if (!inViewport(map, anchor.apexLat, anchor.apexLng)) continue;
      const minSpeed = Math.min.apply(null, present.map((p) => p.minSpeed));
      candidates.push({ lat: anchor.apexLat, lng: anchor.apexLng, severity: -minSpeed, corner: corner });
    }
    return collapseByRectIntersection(map, candidates).map((c) => c.corner);
  }

  // T10: rebuild the rendered group from the cached `eventsModel` at the map's
  // CURRENT zoom/viewport. Cheap relative to buildCompareEvents() — pure filtering +
  // screen-space math over already-detected onsets/corners. Always clears + re-adds
  // so repeated calls (e.g. every zoomend) never leak or duplicate DOM.
  function rebuildEventsLayer() {
    const map = eventsModelMap;
    if (!map || !eventsModel || !window.L) return;

    if (eventsLayer && eventsLayerMap) {
      try { eventsLayerMap.removeLayer(eventsLayer); } catch (e) {}
    }

    ensureEventsPane(map);
    const group = window.L.layerGroup();
    const zoom = map.getZoom();

    const onsetsByRider = Array.isArray(eventsModel.onsets) ? eventsModel.onsets : [];
    for (let i = 0; i < onsetsByRider.length; i++) {
      const survivors = lodFilterOnsets(map, onsetsByRider[i] || [], zoom);
      for (const onset of survivors) renderOnsetMarker(onset, i, group);
    }

    const corners = Array.isArray(eventsModel.corners) ? eventsModel.corners : [];
    for (const corner of lodFilterCorners(map, corners, zoom)) renderCornerMarker(corner, group);

    group.addTo(map);
    eventsLayer = group;
    eventsLayerMap = map;
  }

  function renderCompareEvents() {
    const map = window.SRSRCNG && window.SRSRCNG.map;
    if (!isCompare() || !map || !window.L) return;

    // Map-instance identity guard (mirrors renderTrackColour/setMapDotAt): tear
    // down + rebuild whenever the Leaflet map instance changed (pane .html() swap).
    // T10: also unbind the old map's zoomend/moveend LOD handler here — it must
    // never fire on a dead/replaced map instance.
    if (eventsLayer && eventsLayerMap !== map) {
      try { eventsLayerMap.removeLayer(eventsLayer); } catch (e) {}
      eventsLayer = null;
      eventsLayerMap = null;
    }
    if (eventsLodHandler && eventsLodHandlerMap && eventsLodHandlerMap !== map) {
      try {
        eventsLodHandlerMap.off('zoomend', eventsLodHandler);
        eventsLodHandlerMap.off('moveend', eventsLodHandler);
      } catch (e) {}
      eventsLodHandler = null;
      eventsLodHandlerMap = null;
    }
    if (eventsModel && eventsModelMap !== map) {
      eventsModel = null;
      eventsModelMap = null;
    }
    if (eventsLayer && eventsLayerMap === map) return; // already built for this map instance

    let model;
    try {
      model = SR_TRACK.buildCompareEvents(validRiders().map((r) => r.data), SR_TRACK.DEFAULT_CFG);
    } catch (e) {
      console.warn('[serious-racing] buildCompareEvents failed, skipping srEvents overlay:', e);
      return; // leave the existing trace/chart untouched
    }
    if (!model || (!Array.isArray(model.onsets) && !Array.isArray(model.corners))) return;

    eventsModel = model;
    eventsModelMap = map;

    // T10: bind the LOD recompute exactly once per map instance (guards
    // double-binding on repeated renderCompareEvents() calls for the same map).
    if (eventsLodHandlerMap !== map) {
      const handler = () => rebuildEventsLayer();
      map.on('zoomend', handler);
      map.on('moveend', handler);
      eventsLodHandler = handler;
      eventsLodHandlerMap = map;
    }

    rebuildEventsLayer();
  }

