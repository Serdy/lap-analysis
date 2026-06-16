# serious-racing

Notes for working on the **serious-racing.com** lap-analysis UI (the goal of this
workspace is to improve that UI, primarily the lap map / telemetry view).

Reference page used for investigation:
`https://serious-racing.com/laptimes/118852,12/?pane=map`

## How the lap page is rendered (architecture)

It is a **hybrid**, not pure server-side rendering:

- **Server-side**: the page shell *and all lap telemetry* are rendered by the backend
  and embedded inline into one large (~487 KB) JS global, `window.SRSRCNG`. To change
  the *data*, you change the server.
- **Client-side**: the entire map + chart visualization is drawn in the browser from
  that embedded data. To change the *presentation/interaction*, JS alone is enough.

The `?pane=...` query (e.g. `?pane=map`) is **client-side tab switching**, handled by
`load-panes` via jQuery `.html()` swaps — not a server route. `SRSRCNG.currentlyViewing`
tracks the active pane.

## The `window.SRSRCNG` data object (read this first)

Everything the UI draws is already in the page. Key fields:

- `mapCoords` — the lap GPS trace, array of `[lat, lng, …]` points.
- `graphData` — speed-only series vs distance (drives the Flot speed chart). One
  series of `[distance_m, speed]` pairs, **speed already in the display unit** (km/h) =
  `riders[].data col2 * speedMultiplier`.
- `riders` — **the richest telemetry, one entry per lap on screen**. Each
  `riders[i].data` is an array of points, 6 columns each:
  `[lat, lng, speed(mph base unit), cumulativeDistance(m), longAccel(m/s²), leanAngle(°)]`.
  - **col 2 (speed) is the BASE unit (mph), NOT km/h.** Multiply by `speedMultiplier`
    (1.609344) and label with `speedUnit` to get the displayed value — e.g. 125.49 →
    `125.49 * 1.609344 = 201.96 km/h` (matches the site header + `graphData`). Plotting the
    raw col2 makes speed look ~38% too low.
  - `leanAngle` (col 5) is present client-side, clamped to **±40°**, and is a
    GPS-derived *estimate* (it saturates hard at ±40, so ~half the points sit pinned).
  - `cumulativeDistance` (col 3) is offset; normalise with `p[3] - data[0][3]` to get
    lap distance, which then lines up 1:1 with `graphData`'s x-axis (same point count).
- `maxMphs` / `minMphs` — annotated extreme-speed points.
- `accels` / `decels`, `customSectors`, `trackSectorCoordsList` — sector data.
- `track.trackmap` — a small static track *thumbnail* PNG (e.g.
  `/static/trackmaps/Motopark_Krakow_CCW_26440.png`). This is **not** the main map.
- `map`, `minimap`, `polyLines`, `dataMarker` — live Leaflet objects, populated by JS.
- `mapType` (`osm-mapnik`), `mapTypeOther` (`carto-dark`), `mapBoxAccessToken`,
  `mapFilter` (e.g. `['blur:0px','brightness:120%','contrast:80%','grayscale:..']`),
  `tileCachePrefix` (`/static/tiles`).
- `speedUnit` (`km/h`), `speedMultiplier` (1.609344), `seriesColors`.

## Rendering stack (all client-side)

- **Map = Leaflet 1.9.4**. Instantiated as `L.map("track-map-canvas", {center, zoomSnap:.2, …})`
  (a minimap on `#mini-track-map-canvas`). Real slippy tiles via `L.tileLayer`
  (OSM mapnik / carto-dark / Mapbox).
- **Tile styling** = `leaflet-tilelayer-colorfilter` applies `SRSRCNG.mapFilter`.
- **Lap line** = `L.polyline` (×2 — trace + highlight/split). Currently a flat-colored line.
- **Vehicle marker** = `leaflet-rotated-marker` (rotates to heading).
- **Playback** = `MainLoop.js` (fixed-timestep game loop) animates the marker along the
  trace, synced to the `#mapslider` scrubber.
- **Charts** = Flot (`jquery.flot.*`) + jqPlot (canvas), with the jqPlot highlighter/cursor
  plugins loaded.
- **Base**: jQuery 3.3.1, Bootstrap 4.

### Key DOM ids
`#track-map-canvas` (main map), `#mini-track-map-canvas` (minimap),
`#track-map-controls`, `#mapslider` / `#mapsliderSlider` (scrubber),
`#map-container`, `#sidebar-map-container`, `#mobile-graph-map*`, `#toggleMap`.

### Custom JS bundles (`/static/js/srsrcng/`)
`analysis-*.min.js` (the map/chart drawing logic — `L.tileLayer`, `L.polyline`,
`colorFilter`, `MainLoop`), `load-panes-*` (pane switching), `load-images-*`,
`navclick-*`, `navsearch-*`, `sharing-*`, `tracklist-*`.

## Can the UI be improved with JS only? — Yes

The map/chart layer is **already pure client-side JS reading from `window.SRSRCNG`**, so
presentation and interaction can be improved without any server change. Candidate
JS-only upgrades:

- **Speed-gradient trace**: replace the flat `L.polyline` with multi-segment / canvas
  overlay colored by speed from `graphData` (green→red).
- **Smoother playback**: interpolate marker position between GPS points (already on MainLoop).
- **Map↔chart hover sync**: highlight the on-track position when hovering the speed graph
  (jqPlot highlighter is already loaded).
- **Tooltips** on `minMphs` / `maxMphs` points; cleaner basemap via tile swap / `mapFilter` tweak.
- **Telemetry chart (Speed + Acc/Brk G + Lean)**: all three are in `riders[].data` (cols
  2, 4, 5) — no server change. Plotted on a **time** x-axis (points are a fixed 0.1 s /
  10 Hz apart, so `time[i] = i*0.1` and the last sample == `rider.laptime`). G-force =
  `col4 / 9.81`. Implemented as a 3-y-axis Flot chart with manual crosshair + multi-value
  tooltip in `userscripts/serious-racing-lean-angle.user.js` (Flot crosshair/tooltip
  plugins are NOT loaded — only flot core + categories/resize/threshold). The legend
  doubles as a live readout: each label shows the current value (Speed km/h, Acc/Brk G,
  Lean L/R°), colour-matched to its series and updated on hover.
- **Chart→map hover sync**: hovering the telemetry chart moves a red dot on the live
  Leaflet map (`window.SRSRCNG.map`) to that point's GPS position (`riders[].data` cols
  0–1) via an `L.circleMarker` we own — implemented in the same userscript.
- **Accel/brake-coloured trace**: the lap line is recoloured green (accelerating) /
  yellow (steady) / red (braking) from longitudinal accel (`riders[].data` col 4, dead-band
  ±0.5 m/s²). Drawn as our own `L.polyline` runs (consecutive same-colour points merged) in a
  **custom pane at z-index 350 (below `overlayPane`)** so the moving playback dot (a
  CircleMarker in `overlayPane`) and sector markers stay on top; the site's flat lap line is
  hidden (`setStyle({opacity:0})`) since ours replaces it.
- **Own playback**: the site's play/scrubber bar (`#track-map-controls`) is hidden and
  replaced with our own play button (in the chart legend header). It animates a dot along the
  speed line + the crosshair + the map dot + the legend readout over the lap, in real time
  (`requestAnimationFrame`, advancing `i += dt/0.1`). Solves crosshair-during-playback without
  hooking the site's MainLoop.
- **Comparison mode**: when `SRSRCNG.riders` has **≥2 valid riders** (a compare URL like
  `/laptimes/<mine>,<lap>,<theirs>,<lap>/`), the chart switches to **speed-only, one line per
  rider, on a TIME axis**. Hover/playback sample every rider at the **same elapsed time**
  (`seekToTime`, each clamped to its own lap length), so the faster rider's chart dot + map
  dot **pull ahead** — you see who's leading on the track (verified ~75 m apart after 7 s).
  Playback paces off the **longest** lap (`paceRider`) so the whole race plays. The legend
  shows each rider's live speed (per-rider `seriesColors`). The accel-colour overlay is skipped
  so the site's own per-rider traces stay visible, and the site's static start-line markers
  (`SRSRCNG.dataMarker`) are hidden. Single laps keep the 3-channel time-axis view.

**Needs server work (not JS-only)**: anything requiring *more/different data* than is
embedded — higher-frequency GPS, channels not in `riders[].data` (brake/throttle), or
multi-lap overlays not present in `SRSRCNG`. NOTE: lean angle is **not** in this list —
it ships in `riders[].data` col 5 (see the `SRSRCNG` section above).

## Applying changes without source/server access

We don't own the app source. JS-only enhancements are shipped as a **Tampermonkey/
Greasemonkey userscript** matched on `https://serious-racing.com/laptimes/*`, reading
`window.SRSRCNG` directly. See `userscripts/`. Key facts for hooking the chart layer:

- The speed chart is **Flot**; its placeholder is `#sidebar-graph-container` and the live
  plot object is `jQuery('#sidebar-graph-container').data('plot')`.
- Prefer rendering an *own* Flot chart in an injected panel over mutating the site's plot —
  the site redraws/resizes its chart and would clobber added series.
- The map pane is `.html()`-swapped on pane changes, so injected DOM must be re-added via a
  `MutationObserver` (panel gone + `#map-container` present → re-render), and Flot
  must be redrawn on `resize` (it doesn't auto-resize).
- Layout (map pane): `#comparison-main` > `.row.no-gutters.full-height` with `#data-container`
  (`col-md-9`) + `.comparison-sidebar` (`col-md-3`, holds the speed chart + rider header).
  `#data-container` is a fixed-height column (≈ viewport − topnav); `#map-container` inside it
  holds `#track-map-canvas` (the Leaflet map) **and** `#track-map-controls` (the play/scrubber
  bar, ~48px). Naively appending below `#map-container` pushes content past the fold.
- **Split view**: to dock our telemetry chart at the bottom *and keep it visible*, make
  `#map-container` a flex column (`display:flex;flex-direction:column;height:100%`), set
  `#track-map-canvas` to `flex:1 1 0;min-height:0;height:auto` (all `!important` — the site
  pins an explicit px height), append our chart as the last child, then call
  `SRSRCNG.map.invalidateSize()` so Leaflet re-renders at the new size. The redundant site
  speed-only chart is hidden (`#sidebar-graph-container`'s `.loadgraph`/`.row` → `display:none`).
- Authoring in **TypeScript** is fine, but the injected userscript must be plain compiled JS
  (no build step runs in the page). Current scripts are hand-written JS for simplicity.

## Gotchas

- Don't trust markdown/`WebFetch`-style scrapes of this page: they strip `<script>` tags
  and make it look like a static `<img>`-based map. The real map is Leaflet, and the data
  lives in the inline `SRSRCNG` script.
- The big `SRSRCNG` inline script is ~487 KB — most of the page weight is embedded telemetry.
- Static assets are versioned: paths like `/static/css/62/…` and `?v=<hash>` query strings.
