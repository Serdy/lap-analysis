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

  // Corner-chip zones derived from `eventsModel` (see buildEventZones below) —
  // built once per eventsModel, alongside it, so per-frame chip visibility
  // work is pure window-arithmetic over this cache. Braking-onset arrows no
  // longer consult zones at all (see onsetVisible).
  let eventsZones = null;

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

  // --- Dynamic visibility windows (position-driven, not a play/pause flag) ---
  // A braking-onset arrow for rider i shows only while that rider's OWN live
  // cumulative distance d_i sits inside [onsetDist - EVENT_LEAD_M, onsetDist +
  // EVENT_TAIL_M]. EVENT_LEAD_M is a small forward peek so the arrow appears just
  // before the rider gets there (rather than snapping in exactly on top of them);
  // EVENT_TAIL_M keeps it up for a while after so a paused rider still sees it.
  const EVENT_LEAD_M = 15;   // metres before onsetDist the arrow starts showing
  const EVENT_TAIL_M = 100;  // metres after onsetDist the arrow keeps showing
  // Corner chips key off each rider's APEX distance instead — the chip should
  // appear as a rider reaches the slowest point of the corner (later than the
  // braking-onset arrows, which fire at the brake point) and persist until the
  // slowest rider has cleared it. CHIP_LEAD_M is intentionally smaller than
  // EVENT_LEAD_M: we want it to snap in right as a rider reaches the apex, not
  // announce it early. CHIP_TAIL_M mirrors EVENT_TAIL_M so it lingers for a
  // paused/slow rider, capped by the next zone's apex (see
  // nextZoneApexDistForRider) the same way arrows are capped by the next brake
  // point.
  const CHIP_LEAD_M = 12;    // metres before apexDist the chip starts showing
  const CHIP_TAIL_M = 100;   // metres after apexDist the chip keeps showing
  // Corner chips have no per-rider exit distance in the detection model. Rather
  // than a flat window around the clustered corner distance, chips now follow
  // their ZONE's grouped visibility (see buildEventZones/chipVisible below) —
  // the chip appears/disappears based on every participating rider's own apex
  // distance, governed by the slowest (last) rider through the zone. This is a
  // separate visibility rule from the braking-onset arrows (onsetVisible, keyed
  // per-rider off that rider's own brakePointDist, no zone/grouping) — each
  // arrow fires independently the instant ITS OWN rider reaches the brake point.

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
  const CHIP_CARD_W = 128; // .sr-evt-chip max-width
  const CHIP_CARD_H = 80;  // .sr-evt-chip max-height
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
      // Deliberately small/dense: no rider name (colour dot identifies the rider),
      // just speed + delta per row.
      '.sr-evt-chip-host{display:block;width:auto;height:auto;}' +
      '.sr-evt-chip{position:absolute;pointer-events:none;' +
      'background:rgba(17,19,23,.92);border:1px solid rgba(255,255,255,.10);' +
      'border-radius:6px;padding:4px 7px;max-width:128px;max-height:80px;overflow:hidden;' +
      'box-shadow:0 3px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05);' +
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;white-space:nowrap;' +
      'transition:opacity .12s ease;z-index:650;transform:translate(-50%,-100%);left:50%;top:100%;}' +
      '.sr-evt-chip.sr-evt-chip-hidden{opacity:0;}' +
      '.sr-evt-chip-title{font-size:8px;letter-spacing:.5px;text-transform:uppercase;' +
      'color:#838c9a;font-weight:600;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;}' +
      '.sr-evt-chip-row{display:flex;align-items:center;gap:5px;line-height:12px;}' +
      '.sr-evt-chip-row + .sr-evt-chip-row{margin-top:2px;}' +
      '.sr-evt-chip-dot{flex:0 0 auto;width:5px;height:5px;border-radius:50%;}' +
      '.sr-evt-chip-speed{flex:1 1 auto;font-size:10px;font-weight:600;color:#e7e9ee;' +
      'font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}' +
      '.sr-evt-chip-delta{flex:0 0 auto;font-size:9px;font-weight:500;' +
      'font-variant-numeric:tabular-nums;color:#ff8a80;margin-left:2px;min-width:30px;text-align:right;}';
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

  // Convert a SCREEN-space vector (x right, y down) into the CSS rotation degrees
  // for the arrow glyph, whose 0deg orientation points map-NORTH i.e. screen "up"
  // (-y). A vector (vx,vy) is "up" when vx=0,vy=-1 -> want 0deg; "right" when
  // vx=1,vy=0 -> want 90deg (clockwise-positive, matching CSS rotate()). That's
  // exactly atan2(vx, -vy) in degrees.
  function screenVectorToDeg(vx, vy) {
    return (Math.atan2(vx, -vy) * 180) / Math.PI;
  }

  // T8: the braking-onset triangle glyph, fanned out per-triangle along the local
  // track-perpendicular so overlapping riders' onsets at the same corner land on
  // different sides of the track instead of stacking.
  //
  // Fan offset is baked into the divIcon's iconAnchor (a per-marker screen-px vector
  // computed from THIS onset's own heading) rather than any single global anchor, so
  // it stays correct as the track curves — no zoomend hook needed (T10's concern).
  //
  // Rotation points the arrow AT THE TRACK: opposite its own fan-offset direction,
  // i.e. inward from wherever it's been pushed out to. A rider offset to the +perp
  // side (offsetIndex > 0) points back along -perp; a rider offset to the -perp
  // side points along +perp. offsetIndex === 0 (only possible with an odd rider
  // count, e.g. the middle rider of 3) has no side to point in from — it falls back
  // to a deterministic perpendicular pick (+perp) rather than crashing or picking
  // randomly; this is a minor case since 2-rider compare is the norm.
  function renderOnsetMarker(onset, riderIndex, group) {
    if (!onset || !window.L) return;
    ensureEventStyles();

    const N = validRiders().length || 1;
    const offsetIndex = riderIndex - (N - 1) / 2; // e.g. N=2 -> ∓0.5; N=4 -> ∓1.5/∓0.5
    const offsetPx = offsetIndex * FAN_GAP_PX;
    const heading = onset.heading || 0;
    const perp = perpUnitPx(heading);
    const dx = offsetPx * perp.x;
    const dy = offsetPx * perp.y;

    // Inward = opposite the offset's own side. Deterministic fallback (+perp) when
    // offsetIndex is exactly 0 (odd rider count, centre rider — no side of its own).
    const inwardSign = offsetIndex === 0 ? 1 : -Math.sign(offsetIndex);
    const inwardX = inwardSign * perp.x;
    const inwardY = inwardSign * perp.y;
    const rotationDeg = screenVectorToDeg(inwardX, inwardY);

    const color = riderColor(riderIndex);
    const size = 18; // TRIANGLE_SIZE_PX, bumped from 14 so the inward-pointing arrow reads clearly
    const half = size / 2;

    const html =
      '<div class="sr-evt-tri-host">' +
      '<svg class="sr-evt-tri" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" ' +
      'style="transform:rotate(' + rotationDeg + 'deg);">' +
      '<defs><filter id="sr-evt-tri-shadow-' + riderIndex + '" x="-60%" y="-60%" width="220%" height="220%">' +
      '<feDropShadow dx="0" dy="1.2" stdDeviation="1.6" flood-color="#000000" flood-opacity="0.55"/>' +
      '</filter></defs>' +
      '<polygon points="8,1.2 13.6,12.6 8,9.8 2.4,12.6" fill="' + color + '" stroke="#ffffff" ' +
      'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" filter="url(#sr-evt-tri-shadow-' + riderIndex + ')"/>' +
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

    // Add one row per present rider: [colour dot] [speed] [delta]. No rider name —
    // the colour dot (title-tooltipped with the rider's name) is the only identity
    // cue, to keep the chip small.
    for (let i = 0; i < presentRiders.length && i < 4; i++) {
      const { riderIndex, perRider: pr } = presentRiders[i];
      const color = riderColor(riderIndex);
      const label = riderLabel(riderIndex);
      const speedDisplay = Math.round(pr.minSpeed * speedMult());

      html += '<div class="sr-evt-chip-row">';
      html += '<span class="sr-evt-chip-dot" title="' + label + '" style="background:' + color + ';"></span>';
      html += '<span class="sr-evt-chip-speed">' + speedDisplay + ' ' + speedUnit() + '</span>';

      // brakeDelta.entries' metresLater is ALWAYS >= 0 by construction (it's the
      // gap to the earliest/reference braker — see _computeBrakeDelta in
      // sr-track.js). Never render a "-" sign here: this is "braked N m later
      // than the reference", not a signed positive/negative comparison.
      const delta = brakeDeltaByRider[riderIndex];
      if (delta && delta.metresLater >= 3) {
        html += '<span class="sr-evt-chip-delta">+' + Math.round(delta.metresLater) + ' m</span>';
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

  // --- Live per-rider position (d_i) — drives the dynamic show/hide windows ---
  //
  // There is no exposed "current playback index" anywhere (site-owned or ours) that
  // survives across both our own #sr-play control AND a foreign/older copy of this
  // script owning playback. The one thing that reliably exists in both cases is the
  // MOVING DOT on window.SRSRCNG.map: a Leaflet circleMarker whose fillColor equals
  // the rider's colour (see setMapDotAt above; the site's own native dot uses the
  // same colour convention with different radius/stroke). So instead of hooking any
  // particular playback implementation, we scan the map's circleMarkers by colour
  // every frame and track which same-coloured candidate is ACTUALLY MOVING.
  //
  // Per rider we keep: the last latlng of every same-coloured candidate seen (keyed
  // by Leaflet's own _leaflet_id, since a candidate can be replaced/recreated), and
  // which id was last confirmed "active" (i.e. the one we trust for d_i). Each frame:
  //   1. Enumerate current same-colour circleMarker candidates.
  //   2. If any candidate's latlng differs from what we saw for that id last frame,
  //      it's moving -> becomes the new active id for this rider.
  //   3. Otherwise keep the previous active id (a paused-but-in-window dot must stay
  //      readable, not fall back to "no signal").
  //   4. If we've never seen movement and have no previous active id, the rider is
  //      treated as parked at the start (d_i = 0) so nothing spuriously shows.
  let riderDotState = []; // riderDotState[i] = { lastLatLngById: Map, activeId: number|null, lastActiveLatLng: {lat,lng}|null, lastDist: number, lastSearchIdx: number }

  function ensureRiderDotState(i) {
    if (!riderDotState[i]) {
      riderDotState[i] = {
        lastLatLngById: new Map(),
        activeId: null,
        lastActiveLatLng: null,
        lastDist: 0,
        lastSearchIdx: 0,
      };
    }
    return riderDotState[i];
  }

  // Reset all tracked dot state (used on map-instance change so stale Leaflet ids
  // from a dead map are never compared against the new map's ids).
  function resetRiderDotState() {
    riderDotState = [];
  }

  // --- "Latch on, don't remove" state ---
  //
  // Once a braking-onset arrow or a corner chip has been inside its normal
  // appearance window at least once this session, it stays visible for the
  // rest of playback — markers accumulate into a trail rather than
  // appearing/disappearing as each rider passes through. Effective
  // visibility everywhere below is `currentlyInWindow OR latched`.
  //
  // Two latch sets, keyed to match the two visibility rules they shadow:
  //   - latchedChipZones: zone indices (chipVisible) -> corner chips (chips
  //     stay grouped-by-corner: the chip is a shared card, not per-rider).
  //   - latchedOnsets: "riderIndex:dist" keys (onsetVisible) -> EVERY
  //     braking-onset arrow, keyed on that rider's own onset — no
  //     zone/grouping concept for arrows. Each rider's arrow appears purely
  //     off that rider's own live distance vs. that rider's own onset
  //     window, whether or not the onset happens to be matched to a
  //     clustered corner.
  // Kept separate (not reusing eventsZones' own objects) because they must be
  // clearable independently of the cached detection model (a backward seek
  // clears the latch but not eventsModel/eventsZones).
  let latchedChipZones = new Set();
  let latchedOnsets = new Set();

  // Per-rider high-water mark of live distance, used to detect a backward
  // seek/replay (see maybeResetLatchOnRewind below). Parallel to validRiders();
  // reset alongside the latch sets so a fresh map/lap starts clean.
  let riderMaxDistSeen = [];

  // Clears every latch set and the high-water-mark tracker. Called on
  // map-instance teardown (fresh map/pane swap: nothing has been reached yet)
  // and on a detected backward seek/replay (the trail re-accumulates from the
  // rewound position).
  function resetEventsLatch() {
    latchedChipZones = new Set();
    latchedOnsets = new Set();
    riderMaxDistSeen = [];
  }

  // How far a rider's live distance must drop below its own previously-seen
  // max before we treat it as a real rewind/restart rather than jitter in the
  // dot-tracking (small backward wobble must NOT clear the trail).
  const LATCH_REWIND_M = 200;

  // Detect a backward seek/replay from this frame's live distances and, if
  // found, clear the latch so the trail re-accumulates from the new position.
  // Must run BEFORE the current frame's window checks update the latch sets,
  // so a rewind clears stale latches before anything re-evaluates them this
  // same frame. Updates riderMaxDistSeen unconditionally afterwards (on a
  // clear, the reset high-water marks get seeded fresh from `liveDistances`
  // below via the normal per-rider max update).
  function maybeResetLatchOnRewind(liveDistances) {
    let rewound = false;
    for (let i = 0; i < liveDistances.length; i++) {
      const d = liveDistances[i];
      if (d == null) continue;
      const prevMax = riderMaxDistSeen[i];
      if (typeof prevMax === 'number' && d < prevMax - LATCH_REWIND_M) {
        rewound = true;
        break;
      }
    }
    if (rewound) resetEventsLatch();
    for (let i = 0; i < liveDistances.length; i++) {
      const d = liveDistances[i];
      if (d == null) continue;
      if (!(typeof riderMaxDistSeen[i] === 'number') || d > riderMaxDistSeen[i]) {
        riderMaxDistSeen[i] = d;
      }
    }
  }

  // Find every circleMarker-ish layer on `map` whose fillColor matches `color`
  // (case-insensitive hex compare — Leaflet options are stored as given).
  function findCircleMarkersByColor(map, color) {
    const layers = map._layers || {};
    const out = [];
    const wanted = String(color || '').toLowerCase();
    for (const id in layers) {
      const l = layers[id];
      const isCircleMarkerish =
        l && typeof l.getLatLng === 'function' && typeof l.getRadius === 'function' && l.options;
      if (!isCircleMarkerish) continue;
      const fill = String(l.options.fillColor || l.options.color || '').toLowerCase();
      if (fill === wanted) out.push(l);
    }
    return out;
  }

  const DIST_EPS = 1e-9; // latlng float-equality tolerance (Leaflet coords are floats)

  // Does `layer`'s Leaflet options match OUR dot style (setMapDotAt above: radius 6,
  // white stroke)? The site's own native playback dot uses the same fillColor
  // convention but radius 4 / black stroke, so this is enough to tell them apart.
  function isOurDotStyle(layer) {
    const opts = layer && layer.options;
    if (!opts) return false;
    const stroke = String(opts.color || '').toLowerCase();
    return opts.radius === 6 && stroke === '#ffffff';
  }

  // Advance rider i's tracked "active" dot for this frame and return its latlng, or
  // null if no candidate exists at all (e.g. dot not yet created before first seek).
  //
  // Disambiguation when MULTIPLE same-coloured candidates exist (e.g. the site's
  // native playback dot AND our own #sr-play playback dot both present/moving at
  // once — not expected in normal use, but not impossible if a foreign/older copy
  // of this script or the site's own control drives its dot concurrently with ours):
  // Leaflet's `_layers` object has no defined iteration order guarantee across
  // browsers/versions, so picking "whichever moved first" in that loop is
  // effectively arbitrary. We break the tie deterministically by preferring OUR
  // dot style (radius 6, white stroke via isOurDotStyle) as the position source,
  // since we know its exact rendering and it's the one we're actively driving.
  // This is a *preference*, not a requirement: if no candidate matches our style
  // (e.g. a bare site-native dot, the QA-verified case), we fall back to the
  // existing "moved since last frame" heuristic among the remaining candidates,
  // unchanged from before.
  function trackRiderDot(map, i, color) {
    const st = ensureRiderDotState(i);
    const candidates = findCircleMarkersByColor(map, color);
    if (candidates.length === 0) return st.lastActiveLatLng;

    let movedId = null;
    let movedOursId = null;
    for (const c of candidates) {
      const id = c._leaflet_id;
      const ll = c.getLatLng();
      const prev = st.lastLatLngById.get(id);
      const moved = !prev || Math.abs(prev.lat - ll.lat) > DIST_EPS || Math.abs(prev.lng - ll.lng) > DIST_EPS;
      if (moved && movedId === null) movedId = id;
      if (moved && movedOursId === null && isOurDotStyle(c)) movedOursId = id;
      st.lastLatLngById.set(id, { lat: ll.lat, lng: ll.lng });
    }

    // Prefer our-style dot among the moved candidates; fall back to whichever
    // moved (first-seen order) when ours isn't among them.
    const winnerId = movedOursId !== null ? movedOursId : movedId;

    if (winnerId !== null) {
      st.activeId = winnerId;
      st.lastActiveLatLng = st.lastLatLngById.get(winnerId);
    } else if (st.activeId === null) {
      // Never seen movement yet — fall back to the first candidate's current
      // position (typically the start/finish line) rather than reporting nothing.
      // Prefer our-style dot here too, for the same determinism reason.
      const ours = candidates.find(isOurDotStyle);
      const first = ours || candidates[0];
      st.activeId = first._leaflet_id;
      st.lastActiveLatLng = st.lastLatLngById.get(first._leaflet_id);
    }
    // else: nothing moved this frame — keep the previously active id/latlng so a
    // paused dot still reports its last real position.

    return st.lastActiveLatLng;
  }

  // Nearest-sample scan for latlng -> normalised cumulative distance, per
  // CLAUDE.md's `p[3] - data[0][3]` convention (same units as onset/corner dist).
  // Starts from the rider's last-known index and searches outward so a dot moving
  // forward in small steps (the common case) resolves in O(1) amortised, while a
  // large jump (seek/loop-restart) still finds the true nearest point via full scan.
  function nearestDistanceForLatLng(riderData, lat, lng, hintIdx) {
    const n = riderData.length;
    if (n === 0) return 0;
    const dist0 = riderData[0][3];

    let bestIdx = -1;
    let bestD2 = Infinity;
    // Local window around the hint first (cheap path for continuous playback).
    const WINDOW = 40;
    const lo = Math.max(0, (hintIdx || 0) - WINDOW);
    const hi = Math.min(n - 1, (hintIdx || 0) + WINDOW);
    for (let k = lo; k <= hi; k++) {
      const p = riderData[k];
      const dlat = p[0] - lat, dlng = p[1] - lng;
      const d2 = dlat * dlat + dlng * dlng;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = k; }
    }
    // If the local window's best match isn't convincingly close, fall back to a
    // full scan (handles seeks/restarts that jump far from the last index).
    const CLOSE_ENOUGH = 1e-8; // ~ generous; a real GPS point should land far closer
    if (bestIdx === -1 || bestD2 > CLOSE_ENOUGH) {
      for (let k = 0; k < n; k++) {
        const p = riderData[k];
        const dlat = p[0] - lat, dlng = p[1] - lng;
        const d2 = dlat * dlat + dlng * dlng;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = k; }
      }
    }
    return { dist: riderData[bestIdx][3] - dist0, idx: bestIdx };
  }

  // Compute each valid rider's current cumulative distance d_i from the live map
  // dots. Returns an array parallel to validRiders(); a rider with no readable dot
  // yet gets d_i = 0 (parked at the start line — matches "nothing shows at idle").
  function computeLiveRiderDistances(map) {
    const riders = validRiders();
    const out = new Array(riders.length).fill(0);
    for (let i = 0; i < riders.length; i++) {
      const color = riderColor(i);
      const latlng = trackRiderDot(map, i, color);
      if (!latlng) continue;
      const st = ensureRiderDotState(i);
      const found = nearestDistanceForLatLng(riders[i].data, latlng.lat, latlng.lng, st.lastSearchIdx);
      st.lastDist = found.dist;
      st.lastSearchIdx = found.idx;
      out[i] = found.dist;
    }
    return out;
  }

  function inWindow(d, lo, hi) {
    return d >= lo && d <= hi;
  }

  // Per-rider cap: rider i's NEXT braking onset (in distance order, strictly
  // greater than `afterDist`) among that rider's own onsets — used as the "or
  // until my own next brake point" upper bound so one lingering arrow can
  // never overlap the following onset for the SAME rider. Returns Infinity if
  // rider i has no later onset (nothing to cap against). `riderOnsets` is
  // that one rider's detectBrakingOnsets() output (already sorted by dist per
  // sr-track.js), so a single forward scan suffices.
  function nextOnsetDistForRider(riderOnsets, afterDist) {
    for (const o of riderOnsets || []) {
      if (o.dist > afterDist) return o.dist;
    }
    return Infinity;
  }

  // Is rider i's braking onset at `onsetDist` currently in its visibility
  // window? This is the ONLY visibility rule for braking-onset arrows — every
  // onset, whether or not it happens to be matched to a clustered corner,
  // shows purely off THAT rider's own live distance vs. THAT rider's own
  // onset window. There is deliberately no cross-rider grouping here: a fast
  // rider's arrow must not make a slow rider's arrow (or vice versa) appear
  // early just because they share a corner.
  function onsetVisible(riderDist, onsetDist, hi) {
    const cappedHi = hi == null ? onsetDist + EVENT_TAIL_M : Math.min(onsetDist + EVENT_TAIL_M, hi);
    return inWindow(riderDist, onsetDist - EVENT_LEAD_M, cappedHi);
  }

  // --- Zones: group a corner + its riders' matched braking onsets so they all
  // appear/disappear TOGETHER, governed by the SLOWEST (last) rider through the
  // zone, per the task spec — rather than each rider's arrow living/dying on its
  // own independent window (which made a fast rider's arrow vanish while the
  // slow rider was still approaching the same corner).
  //
  // Built ONCE per eventsModel (cached alongside it as `eventsZones`), not per
  // frame: it is pure derivation from buildCompareEvents()'s already-computed
  // corners/onsets (via perRider[].brakePointDist, the matched-onset distance
  // per CLAUDE.md/task spec), so there is nothing to recompute on the visibility
  // rAF loop beyond the cheap per-frame window check.
  //
  // A rider's apex distance isn't precomputed anywhere in the detection model:
  // buildCompareEvents()'s exposed perRider entries carry apexLat/apexLng (and
  // minSpeed/entryDist/brakePointDist) but NOT the internal apexIdx sample
  // index used to derive them inside sr-track.js's detectCorners — that index
  // never makes it out of the corner-clustering step. Rather than change
  // sr-track.js's public shape, resolve the apex's normalised distance the
  // same way the live dot-tracking code already does for a lat/lng it only
  // has approximately: nearest-sample lookup in that rider's own `data` array
  // via nearestDistanceForLatLng (see below), applied to the EXACT apex
  // lat/lng (so it resolves to the true apex sample, distance 0 error).
  // Returns null if the rider/coords are missing (defensive — never throws on
  // a malformed model).
  function apexDistFor(riderIndex, apexLat, apexLng) {
    const riders = validRiders();
    const rider = riders[riderIndex];
    const data = rider && rider.data;
    if (!data || !data[0] || typeof apexLat !== 'number' || typeof apexLng !== 'number') return null;
    return nearestDistanceForLatLng(data, apexLat, apexLng, 0).dist;
  }

  // Zones now exist ONLY to drive the CORNER CHIP's grouped visibility
  // (braking-onset arrows are fully per-rider/per-onset — see onsetVisible —
  // and no longer consult zones at all).
  //
  // Shape: Array<{ cornerIdx, corner,
  //                members: Array<{riderIndex, onsetDist}>,
  //                apexMembers: Array<{riderIndex, apexDist}> }>
  // one entry per corner that has >=1 rider with a matched brakePointDist.
  // `members` here is used only as that "has >=1 matched rider" guard — a
  // corner with zero matched riders is dropped from zones entirely and its
  // chip falls back to being simply never shown. `apexMembers` is a SEPARATE
  // list (not reusing `members`) because it keys off every present rider
  // (perRider[i] !== null), not just riders with a matched brakePointDist —
  // the chip's apex timing shouldn't depend on whether that rider's brake
  // onset happened to match this corner.
  function buildEventZones(model) {
    const corners = Array.isArray(model.corners) ? model.corners : [];
    const zones = [];
    for (let c = 0; c < corners.length; c++) {
      const corner = corners[c];
      const members = [];
      const apexMembers = [];
      for (const pr of corner.perRider || []) {
        if (!pr) continue;
        if (typeof pr.brakePointDist === 'number' && isFinite(pr.brakePointDist)) {
          members.push({ riderIndex: pr.riderIndex, onsetDist: pr.brakePointDist });
        }
        const apexDist = apexDistFor(pr.riderIndex, pr.apexLat, pr.apexLng);
        if (typeof apexDist === 'number' && isFinite(apexDist)) {
          apexMembers.push({ riderIndex: pr.riderIndex, apexDist: apexDist });
        }
      }
      if (members.length > 0) zones.push({ cornerIdx: c, corner: corner, members: members, apexMembers: apexMembers });
    }
    return zones;
  }

  // Apex-timing cap for the CHIP (mirrors nextOnsetDistForRider's role for
  // arrows, but for apex distances and scoped to zones/corners rather than
  // raw onsets): the next zone (in corner order) that ALSO has rider i in its
  // apexMembers — caps the chip's lingering window so it can't bleed into the
  // following corner's chip. Returns Infinity if rider i has no later zone.
  function nextZoneApexDistForRider(zones, zoneIdx, riderIndex) {
    for (let z = zoneIdx + 1; z < zones.length; z++) {
      for (const m of zones[z].apexMembers || []) {
        if (m.riderIndex === riderIndex) return m.apexDist;
      }
    }
    return Infinity;
  }

  // Is zone `zones[zoneIdx]`'s CHIP visible right now? Grouped visibility:
  // visible while ANY present rider's live distance sits in
  // [thatRider'sApexDist - CHIP_LEAD_M, thatRider'sApexDist + CHIP_TAIL_M],
  // keyed off apexMembers (every present rider), capped by that rider's next
  // zone apex. This is deliberately a separate function/window from the
  // (now fully per-rider, non-grouped) braking-onset arrows: the chip is
  // meant to appear later (at the apex) than the arrows (at the brake point),
  // and to stay grouped-by-corner (a shared card) while the arrows must not —
  // e.g. arrow visible while a rider is still approaching, chip not yet, or
  // vice versa once the fast rider has passed the apex but the slow one is
  // still braking.
  function chipVisible(zones, zoneIdx, liveDistances) {
    const zone = zones[zoneIdx];
    for (const m of zone.apexMembers || []) {
      const d = liveDistances[m.riderIndex];
      if (d == null) continue;
      const hi = Math.min(m.apexDist + CHIP_TAIL_M, nextZoneApexDistForRider(zones, zoneIdx, m.riderIndex));
      if (inWindow(d, m.apexDist - CHIP_LEAD_M, hi)) return true;
    }
    return false;
  }

  // --- Latch update: "once in-window, stays visible" ---
  //
  // Called once per live-distance sample (from eventsVisibilityTick, the only
  // place liveDistances is freshly computed every frame). For every chip
  // zone / braking onset currently in its normal window, marks it latched.
  // Latched membership is additive-only here — clearing only ever happens via
  // resetEventsLatch (map teardown / rewind detection), never here.
  function updateEventsLatch(zones, onsetsByRider, liveDistances) {
    for (let z = 0; z < zones.length; z++) {
      if (chipVisible(zones, z, liveDistances)) latchedChipZones.add(z);
    }
    for (let i = 0; i < onsetsByRider.length; i++) {
      const d = liveDistances[i] || 0;
      const riderOnsets = onsetsByRider[i] || [];
      for (const o of riderOnsets) {
        const key = i + ':' + o.dist;
        const hi = nextOnsetDistForRider(riderOnsets, o.dist);
        if (onsetVisible(d, o.dist, hi)) latchedOnsets.add(key);
      }
    }
  }

  // Effective visibility = currently in-window OR latched. These wrap the raw
  // window checks so rebuildEventsLayer/visibilitySignature never need to know
  // about the latch sets directly.
  function chipEffectivelyVisible(zones, zoneIdx, liveDistances) {
    return latchedChipZones.has(zoneIdx) || chipVisible(zones, zoneIdx, liveDistances);
  }

  // riderOnsets = that rider's own onsets (already sorted by dist), used to
  // resolve the per-rider "next onset" tail cap (see nextOnsetDistForRider).
  function onsetEffectivelyVisible(riderIndex, onset, riderOnsets, liveDistances) {
    const key = riderIndex + ':' + onset.dist;
    if (latchedOnsets.has(key)) return true;
    const d = liveDistances[riderIndex] || 0;
    const hi = nextOnsetDistForRider(riderOnsets, onset.dist);
    return onsetVisible(d, onset.dist, hi);
  }

  // T10: rebuild the rendered group from the cached `eventsModel`/`eventsZones` at
  // the map's CURRENT zoom/viewport, restricted to onsets/corners that are inside
  // their live position-driven visibility window (per-rider window for EVERY
  // braking onset — see onsetVisible above; grouped-by-zone for the corner
  // chip only — see chipVisible). Cheap relative to buildCompareEvents() —
  // pure filtering + screen-space math over already-detected onsets/corners.
  // Always clears + re-adds so repeated calls (e.g. every zoomend, or the
  // dynamic-visibility loop below) never leak or duplicate DOM.
  function rebuildEventsLayer() {
    const map = eventsModelMap;
    if (!map || !eventsModel || !window.L) return;

    if (eventsLayer && eventsLayerMap) {
      try { eventsLayerMap.removeLayer(eventsLayer); } catch (e) {}
    }

    ensureEventsPane(map);
    const group = window.L.layerGroup();
    const zoom = map.getZoom();
    const liveDistances = computeLiveRiderDistances(map);
    const zones = eventsZones || [];

    // Which zone indices are effectively visible for the CORNER CHIP (apex
    // window OR latched). The chip is the only thing left keyed off zones —
    // braking-onset arrows below are fully per-rider/per-onset.
    const chipVisibleZoneIdx = [];
    for (let z = 0; z < zones.length; z++) {
      if (chipEffectivelyVisible(zones, z, liveDistances)) chipVisibleZoneIdx.push(z);
    }

    // Braking-onset arrows: every onset, for every rider, shows purely off
    // THAT rider's own live distance vs. THAT onset's own window (in-window
    // OR latched) — no grouping/zone concept, so red's arrow can never appear
    // just because blue reached a shared corner first, or vice versa.
    const onsetsByRider = Array.isArray(eventsModel.onsets) ? eventsModel.onsets : [];
    for (let i = 0; i < onsetsByRider.length; i++) {
      const riderOnsets = onsetsByRider[i] || [];
      const windowed = riderOnsets.filter((o) => onsetEffectivelyVisible(i, o, riderOnsets, liveDistances));
      const survivors = lodFilterOnsets(map, windowed, zoom);
      for (const onset of survivors) renderOnsetMarker(onset, i, group);
    }

    const cornersOut = [];
    for (const z of chipVisibleZoneIdx) cornersOut.push(zones[z].corner);
    for (const corner of lodFilterCorners(map, cornersOut, zoom)) renderCornerMarker(corner, group);

    group.addTo(map);
    eventsLayer = group;
    eventsLayerMap = map;
  }

  // --- T-dynamic: cheap per-frame visibility signature, used to decide whether the
  // (comparatively expensive, DOM-touching) rebuildEventsLayer() actually needs to
  // run this tick. Pure arithmetic over the cached eventsModel — no Leaflet
  // projection, no DOM — so it's safe to call every rAF frame.
  //
  // It's just a string gate: a cheap identity of "which onsets/corners are
  // visible right now" that we can compare with !== to skip rebuildEventsLayer()
  // (DOM rebuild + allocations) on frames where nothing entered/left a window.
  //
  // Mirrors rebuildEventsLayer()'s own visibility split: every braking onset
  // (for every rider) uses the fully per-rider onsetVisible() window — no
  // zone/grouping concept. The corner CHIP is a separate gate keyed off
  // chipVisible() (apex-distance based, still grouped by zone) — included
  // here as its own 'cz'+z token so the signature (and therefore the DOM
  // rebuild decision) changes exactly when a chip would actually
  // appear/disappear, independent of any onset's own visibility.
  //
  // Both checks are EFFECTIVE visibility (in-window OR latched — see
  // updateEventsLatch/onsetEffectivelyVisible/chipEffectivelyVisible above),
  // since once something latches on it must keep contributing its token so
  // the signature (and therefore the rendered set) doesn't regress. Because
  // latching is monotonic (only grows, until an explicit reset), the
  // signature reaches a stable value once nothing new is entering a window —
  // no per-frame churn.
  function visibilitySignature(liveDistances) {
    if (!eventsModel) return '';
    const parts = [];
    const zones = eventsZones || [];
    const onsetsByRider = Array.isArray(eventsModel.onsets) ? eventsModel.onsets : [];
    for (let i = 0; i < onsetsByRider.length; i++) {
      const riderOnsets = onsetsByRider[i] || [];
      for (const o of riderOnsets) {
        if (onsetEffectivelyVisible(i, o, riderOnsets, liveDistances)) parts.push('o' + i + ':' + o.idx);
      }
    }
    for (let z = 0; z < zones.length; z++) {
      if (!chipEffectivelyVisible(zones, z, liveDistances)) continue;
      parts.push('cz' + z);
    }
    return parts.join(',');
  }

  // --- T-dynamic: rAF loop driving the position-based show/hide windows. Recomputes
  // each rider's live d_i every frame (cheap: a handful of circleMarker lookups + a
  // bounded nearest-point scan) but only touches the DOM (via rebuildEventsLayer)
  // when the visible onset/corner SET actually changed, so a steady-state frame with
  // nothing entering/leaving a window costs effectively nothing beyond the signature
  // computation.
  let eventsRafId = null;
  let eventsRafMap = null;
  let lastVisibilitySignature = null;

  function eventsVisibilityTick() {
    const map = eventsModelMap;
    const liveMap = window.SRSRCNG && window.SRSRCNG.map;
    if (!map || map !== eventsRafMap || !eventsModel || map !== liveMap) {
      eventsRafId = null;
      eventsRafMap = null;
      return;
    }
    const liveDistances = computeLiveRiderDistances(map);
    // Backward seek/replay detection must run BEFORE the latch is updated from
    // this frame's distances, so a real rewind clears stale latches first.
    maybeResetLatchOnRewind(liveDistances);
    const zones = eventsZones || [];
    const onsetsByRider = Array.isArray(eventsModel.onsets) ? eventsModel.onsets : [];
    updateEventsLatch(zones, onsetsByRider, liveDistances);
    const sig = visibilitySignature(liveDistances);
    if (sig !== lastVisibilitySignature) {
      lastVisibilitySignature = sig;
      rebuildEventsLayer();
    }
    eventsRafId = window.requestAnimationFrame(eventsVisibilityTick);
  }

  // Idempotent: starting twice for the same map is a no-op (guards repeated
  // renderCompareEvents() calls, same pattern as the zoomend/moveend handler).
  function startEventsVisibilityLoop(map) {
    if (eventsRafId && eventsRafMap === map) return;
    stopEventsVisibilityLoop();
    eventsRafMap = map;
    lastVisibilitySignature = null; // force one rebuild on first tick
    eventsRafId = window.requestAnimationFrame(eventsVisibilityTick);
  }

  function stopEventsVisibilityLoop() {
    if (eventsRafId) {
      try { window.cancelAnimationFrame(eventsRafId); } catch (e) {}
    }
    eventsRafId = null;
    eventsRafMap = null;
  }

  function renderCompareEvents() {
    const map = window.SRSRCNG && window.SRSRCNG.map;
    if (!isCompare() || !map || !window.L) return;

    // Map-instance identity guard (mirrors renderTrackColour/setMapDotAt): tear
    // down + rebuild whenever the Leaflet map instance changed (pane .html() swap).
    // T10: also unbind the old map's zoomend/moveend LOD handler here — it must
    // never fire on a dead/replaced map instance. T-dynamic: same for the
    // position-visibility rAF loop, plus the per-rider dot-tracking state (stale
    // Leaflet _leaflet_ids from the dead map must never leak into the new map's
    // "did it move" comparison).
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
    if (eventsRafMap && eventsRafMap !== map) {
      stopEventsVisibilityLoop();
      resetRiderDotState();
      resetEventsLatch();
    }
    if (eventsModel && eventsModelMap !== map) {
      eventsModel = null;
      eventsModelMap = null;
      eventsZones = null;
    }
    if (eventsLayer && eventsLayerMap === map) {
      startEventsVisibilityLoop(map); // guards its own double-start; cheap if already running
      return; // already built for this map instance
    }

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
    eventsZones = buildEventZones(model);

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
    startEventsVisibilityLoop(map);
  }

