# Design Spec: `srEvents` — Braking-Onset Triangles + Corner Coaching Labels

Status: draft, ready for implementation. One open validation item flagged below.

> **VALIDATE BEFORE SHIP:** the Z ≥ 15 / Z < 15 zoom LOD threshold in this spec is a
> best-guess default, not measured against a real Leaflet session on
> `serious-racing.com`. Leaflet zoom-to-metres-per-pixel varies by tile provider and
> latitude, and track maps here range from short karting circuits to full-size GP
> layouts. **Load a real lap, zoom through the range, and confirm 15 is actually the
> crossover where individual corners become legible enough for text labels** — nudge
> the constant in `DEFAULT_CFG.LOD_ZOOM` if not, everything else in this spec is
> independent of the exact number.

## Table of contents

1. [Concept](#1-concept)
2. [Data inputs](#2-data-inputs)
3. [Triangle marker — SVG, rotation, drop-shadow](#3-triangle-marker--svg-rotation-drop-shadow)
4. [Fan-out overlap resolution (10px gap formula)](#4-fan-out-overlap-resolution-10px-gap-formula)
5. [Corner coaching label — HTML + CSS](#5-corner-coaching-label--html--css)
6. [Anchor offset (18px outward + 14px up)](#6-anchor-offset-18px-outward--14px-up)
7. [Clutter / LOD rules](#7-clutter--lod-rules)
8. [DEFAULT_CFG token object](#8-default_cfg-token-object)
9. [Contrast reasoning per basemap](#9-contrast-reasoning-per-basemap)
10. [States](#10-states)
11. [Accessibility & interaction notes](#11-accessibility--interaction-notes)
12. [Implementation notes for engineers](#12-implementation-notes-for-engineers)

---

## 1. Concept

`srEvents` is a new Leaflet overlay layer (own pane, like the existing `srTrace`
accel/brake-colour pane) that marks **braking onsets** on the lap map as small
triangles, and — per corner, at low zoom-out only when there's room — a compact dark
"coaching chip" comparing riders' entry speed at that braking point.

This is additive to the existing accel/brake-colour trace
(`userscripts/src/03-data.js` `renderTrackColour`) — it does not replace it. The
colour trace shows continuous brake/accel state; `srEvents` calls out the **discrete
moment** braking begins, which is the actionable coaching cue ("you brake 8m later
than them here").

## 2. Data inputs

All derived client-side from data already in `window.SRSRCNG`, per
`CLAUDE.md`'s documented shape — no server change needed.

- **Braking onset detection**: walk `riders[i].data` column 4 (`longAccel`, m/s²).
  An onset is the first sample in a run where `longAccel <= -BRAKE_ONSET_THRESHOLD`
  (see `DEFAULT_CFG.BRAKE_ONSET_THRESHOLD`) that follows at least
  `DEFAULT_CFG.MIN_RUN` samples (0.4s @ 10Hz) of non-braking. This reuses the same
  dead-band/`MIN_RUN` absorption logic as `SR_TRACK` (`userscripts/src/sr-track.js`)
  so onset points are consistent with the colour trace's green/yellow/red bands —
  an onset triangle should always land exactly on the trace's green→red transition.
- **Position**: `riders[i].data[onsetIdx]` columns 0–1 (`lat`, `lng`).
- **Heading** (for triangle rotation): bearing from `data[onsetIdx-1]` to
  `data[onsetIdx+1]` (2-point average bearing, not just the immediate next point, to
  reduce GPS jitter). Fallback to `[onsetIdx, onsetIdx+1]` if `onsetIdx` is 0.
- **Severity** (for triangle sizing/z-order in LOD): peak `|longAccel|` (col 4) within
  the braking run that starts at this onset — i.e. how hard the braking gets, not just
  that it started.
- **Speed at onset** (for the coaching chip): `data[onsetIdx][2] * speedMultiplier`
  (mph → km/h per the base-unit gotcha in `CLAUDE.md`).
- **Corner grouping** for the coaching label: reuse `SRSRCNG.customSectors` /
  `trackSectorCoordsList` if present (already segments the track into named
  corners/sectors); if absent, fall back to spatial clustering of onset points within
  `DEFAULT_CFG.CORNER_CLUSTER_RADIUS_M` of each other across riders.
- **Multi-rider**: in comparison mode (`isCompare()`, ≥2 valid riders, see
  `userscripts/src/03-data.js`), onsets are computed **per rider** and grouped into
  the same corner cluster so the coaching chip can show a delta.

---

## 3. Triangle marker — SVG, rotation, drop-shadow

### Rotation convention

**0° = triangle points up the screen (north), tip in direction of travel.** The
marker sits *at* the braking-onset point with its tip pointing along the rider's
heading at that instant (i.e., "this is where braking starts, and this is which way
they're going"). Rotation is applied clockwise from north, matching
`leaflet-rotated-marker`'s existing `rotationAngle` convention already used for the
vehicle marker (per `CLAUDE.md`'s rendering-stack notes), so the same bearing math
used elsewhere in the codebase applies directly — no new bearing convention to learn.

```
rotationAngle = bearingDegrees(data[i-1], data[i+1])  // 0-360, clockwise from north
```

### SVG markup (literal, copy-paste)

Base triangle, authored pointing up (tip at top, flat base at bottom), 18×18 viewbox,
rotation applied via a wrapper transform (not baked into the path) so severity-based
scaling and rotation compose cleanly without recomputing points.

```html
<svg
  class="sr-evt-tri"
  viewBox="0 0 18 18"
  width="18"
  height="18"
  style="transform: rotate({{rotationDeg}}deg) scale({{severityScale}});"
>
  <defs>
    <filter id="sr-evt-tri-shadow-{{riderIndex}}" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow
        dx="0"
        dy="1"
        stdDeviation="1.4"
        flood-color="#000000"
        flood-opacity="0.55"
      />
    </filter>
  </defs>
  <path
    d="M9 1.5 L16.5 15.5 L1.5 15.5 Z"
    fill="{{riderColor}}"
    stroke="#ffffff"
    stroke-width="1.25"
    stroke-linejoin="round"
    filter="url(#sr-evt-tri-shadow-{{riderIndex}})"
  />
</svg>
```

Notes on the literal values:

- `M9 1.5 L16.5 15.5 L1.5 15.5 Z` — an isoceles triangle, tip at `(9, 1.5)`, base
  corners at `(16.5, 15.5)` and `(1.5, 15.5)`. Slightly inset from the 18×18 box edges
  so the white stroke doesn't clip.
- `stroke:#ffffff` at `1.25px` — this is the **contrast anchor**: a white 1.25px ring
  around a coloured fill reads on both basemaps (see §9) without needing two SVG
  variants.
- `feDropShadow` (not the older `feGaussianBlur`+`feOffset`+`feMerge` combo) — modern
  browsers (the site already assumes an evergreen browser stack; Tampermonkey
  requires Chrome/Firefox/Edge) support it directly, one filter primitive, cheap to
  render for potentially dozens of markers per lap.
- Each rider gets its own `filter id` suffixed by `riderIndex` — SVG filter ids must
  be unique per document when multiple marker instances share a `<defs>`-less inline
  SVG (Leaflet divIcons render each marker's SVG as its own standalone fragment, so in
  practice this only matters if markers are ever batched into one `<svg>` root; keep
  the suffix regardless, it's free and prevents a future refactor from silently
  breaking shadows).
- `severityScale` — see `DEFAULT_CFG.SEVERITY_SCALE_MIN/MAX` in §8; ranges roughly
  `0.8`–`1.25` so hard-braking onsets read as slightly larger without the smallest
  ones disappearing.

### The `.sr-evt-tri` transparent-chrome rule

Leaflet `divIcon`/`L.marker` wrappers add a default white box + shadow DOM chrome
around icon content. This rule strips it so only the SVG paints — it must ship
alongside the SVG in `ensureEventStyles()` (see §5):

```css
.sr-evt-tri {
  display: block;
  background: transparent !important;
  border: none !important;
  overflow: visible !important; /* the drop-shadow filter bleeds outside the 18x18 box */
  pointer-events: auto; /* re-enabled per-marker for hover/tap; see §11 */
}
```

`overflow: visible` is required — without it the `feDropShadow` blur radius (up to
~1.4px stdDeviation, roughly 4-5px visual spread) clips at the icon box edge and the
shadow looks cut off on one side.

### Rotation wrapper (Leaflet divIcon host)

The rotation and scale transform lives on the `<svg>` element's inline `style`
(shown above), **not** on the divIcon's outer wrapper `<div>` — Leaflet's own marker
positioning uses CSS transforms on that outer div (`translate3d(...)` for
positioning), and stacking a second `rotate()` on the same element composes
incorrectly (rotation would apply around the wrong origin, since Leaflet's transform
already includes a translate). Keep them on separate nodes:

```html
<div class="sr-evt-tri-host"> <!-- Leaflet divIcon wrapper: gets Leaflet's translate3d -->
  <svg class="sr-evt-tri" style="transform: rotate({{rotationDeg}}deg) scale({{severityScale}});">
    ...
  </svg>
</div>
```

```css
.sr-evt-tri-host {
  transform-origin: center center;
}
.sr-evt-tri {
  transform-origin: 9px 9px; /* dead centre of the 18x18 viewbox, so rotation doesn't drift the marker off its lat/lng */
}
```

---

## 4. Fan-out overlap resolution (10px gap formula)

**Problem**: in comparison mode, 2-4 riders can brake at nearly the same GPS point
for the same corner. Stacking triangles exactly on top of each other hides all but
the topmost.

**Rule**: if N triangles' anchor points project to within
`DEFAULT_CFG.COLLAPSE_RADIUS_PX` (24px, see §7) of each other in screen space, fan
them out around their shared centroid on a small arc, perpendicular to the local
track heading (so the fan opens *across* the track, not along it — staying legible
against the direction of travel).

Formula, screen-space, applied after Leaflet projects lat/lng → pixel:

```
gap = 10px                         // DEFAULT_CFG.FAN_GAP_PX
n   = number of overlapping triangles at this cluster
perpAngle = trackHeadingDeg + 90    // perpendicular to direction of travel

for i in 0..n-1:
  offsetIndex = i - (n - 1) / 2     // centers the fan: e.g. n=3 -> [-1, 0, 1]; n=4 -> [-1.5,-0.5,0.5,1.5]
  offsetPx    = offsetIndex * gap
  dx = offsetPx * cos(perpAngle)
  dy = offsetPx * sin(perpAngle)
  triangle[i].screenPos = clusterCentroidPx + (dx, dy)
```

- `gap = 10px` is edge-to-edge breathing room for an 18px-wide triangle at
  `severityScale ~1.0` — center-to-center spacing of 10px on triangles ~15-18px wide
  gives a clean shingled/overlapping-shield look (each triangle still ~40-45%
  visible) rather than a jarring full gap; tune only if visual QA says otherwise.
- Fan order (`i` assignment) is by **rider index**, not severity — keeps a rider's
  triangle in a consistent relative fan position corner-to-corner, so the eye learns
  "leftmost = me, rightmost = them" instead of it jumping around.
  Applies from n=2 upward (`n − 1` fan positions on either side of centre, so at
  n=2 the two markers sit at `±gap/2`, i.e. 5px each side of centroid).
- Re-run this pass on every zoom/pan (screen-space distances change), not just once
  on data load — hook it into the same `moveend`/`zoomend` cycle the `srTrace` layer
  already redraws on.

---

## 5. Corner coaching label — HTML + CSS

### CSS (drop into `ensureEventStyles()`, following `02-styles.js`'s exact
guarded-`<style>`-tag pattern)

```js
function ensureEventStyles() {
  if (document.getElementById('sr-events-styles')) return;
  const css =
    // Braking-onset triangle chrome (transparent host, shadow allowed to bleed).
    '.sr-evt-tri-host{transform-origin:center center;}' +
    '.sr-evt-tri{display:block;background:transparent !important;border:none !important;' +
    'overflow:visible !important;pointer-events:auto;transform-origin:9px 9px;}' +
    // Corner coaching chip: dark instrument-panel card, matches .sr-leg-* family.
    '.sr-evt-chip{position:absolute;pointer-events:none;' +
    'background:rgba(17,19,23,.92);border:1px solid rgba(255,255,255,.10);' +
    'border-radius:8px;padding:7px 10px;max-width:168px;max-height:104px;overflow:hidden;' +
    'box-shadow:0 3px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05);' +
    'font-family:' + AXIS_FONT_FAMILY + ';white-space:nowrap;' +
    'transition:opacity .12s ease;z-index:650;}' +
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
```

Mirrors `02-styles.js`'s `ensureStyles()` exactly: a single guarded `<style>` element
keyed by a unique id (`sr-events-styles`, parallel to `sr-tele-styles`), string-built
CSS, appended once to `<head>`, using the already-declared `AXIS_FONT_FAMILY`
constant from `01-constants.js` rather than inventing a second font stack.

### HTML template (per corner cluster)

```html
<div class="sr-evt-chip" id="sr-evt-chip-{{cornerId}}">
  <div class="sr-evt-chip-title">{{cornerLabel}}</div>

  <!-- one row per rider at this corner, ordered fastest-in first -->
  <div class="sr-evt-chip-row">
    <span class="sr-evt-chip-dot" style="background:{{riderColor}};"></span>
    <span class="sr-evt-chip-name" title="{{riderFullName}}">{{riderName}}</span>
    <span class="sr-evt-chip-speed">{{speedKmh}}</span>
    <!-- delta span omitted entirely for the reference (fastest) row, and omitted
         for any row where |delta| < 3 km/h — see suppression rule below -->
    <span class="sr-evt-chip-delta sr-evt-chip-delta-behind">{{deltaSign}}{{deltaKmh}}</span>
  </div>
  <!-- repeat .sr-evt-chip-row per rider, max 4 rows -->
</div>
```

Field notes:

- `{{cornerLabel}}` — from `customSectors`/`trackSectorCoordsList` name if available
  (e.g. `"Turn 4"`); else a synthesized `"Corner @ {distanceM}m"` using cumulative
  lap distance at the cluster's centroid.
- `{{riderName}}` — truncated via CSS `text-overflow:ellipsis` on
  `.sr-evt-chip-name` (container is `min-width:0` inside a flex row so ellipsis
  actually engages — a common flexbox gotcha, called out explicitly so it isn't
  dropped in implementation). Max effective width ≈ `168px chip − ~10px padding×2 −
  7px dot − 6px gap − ~34px speed − ~34px delta − 6px gaps ≈ 65-75px`, roughly 9-11
  characters at 11px before eliding — plan on usernames being cut, hence the
  `title=""` attribute for full name on native tooltip hover.
- `{{speedKmh}}` — `tabular-nums` for column alignment across rows, formatted
  `"{{value.toFixed(0)}} km/h"`.
- **<3 m/s delta suppression rule**: only render the `.sr-evt-chip-delta` span when
  `Math.abs(deltaKmh) >= 3`. Below that, GPS-derived speed noise means the delta
  isn't a trustworthy coaching signal — showing it invites the rider to chase noise.
  When suppressed, the row simply has no delta span (not a blank/zero one) so the
  row's flex layout doesn't leave an awkward gap.
- Delta sign/color: `deltaKmh = riderSpeed - fastestSpeed` (always ≤ 0 for
  non-reference rows by construction, so in practice `deltaSign` is always `"−"` and
  the class is always `sr-evt-chip-delta-behind` for real usage — the `-ahead`
  variant is defined for symmetry/future reuse, e.g. if the reference row becomes a
  user-selectable "compare to me" pivot rather than always-fastest).
- Row cap: **max 4 rows** (`DEFAULT_CFG.MAX_CHIP_RIDERS`). With `max-height:104px`
  and ~17px per row + title, 4 rows fits without scrolling; a 5th+ rider's data is
  simply not shown in the chip (this is the "4-rider-degraded" state, §10).

---

## 6. Anchor offset (18px outward + 14px up)

The chip is a floating annotation, not a Leaflet popup — it must not obscure the
triangle(s) it describes, and must not get clipped by fan-out siblings.

```
chipAnchorPx = clusterCentroidPx
             + (18px * outwardUnitVector)   // outwardUnitVector = away from track centerline, i.e. same perpAngle as fan-out, sign chosen toward open space
             + (0px, -14px)                  // -14px = up the screen (Leaflet/CSS y-down convention)
```

- **18px outward**: measured from the fan cluster's centroid (not from the nearest
  individual triangle), along the same perpendicular-to-heading axis used for fan-out
  (§4) — so the chip sits to the side of the fan, not on top of any triangle in it.
  Direction (`+`/`-` along that axis) is chosen by whichever side has more open map
  space at render time (check distance to viewport edge); default to the outside of
  the corner (away from the track's local curvature center) when both sides are
  equally open, since that's normally where runoff/gravel is on the actual map image,
  keeping the chip off the racing line's visual density.
- **14px up**: lifts the chip's bottom edge clear of the triangle tips, matching the
  visual weight of a speech-bubble tail without actually drawing one (no CSS
  `::after` arrow — the offset + drop-shadow depth cue is enough, and an arrow would
  need to rotate per fan-side which adds complexity for little gain at this size).
- The chip's own `transform: translate(-50%, -100%)` should be applied at render
  (anchor the chip's bottom-center to `chipAnchorPx`), so the 18px/14px numbers are
  pure offset math independent of chip width (which varies with rider count / name
  length).

---

## 7. Clutter / LOD rules

Two zoom bands, driven by `map.getZoom()` on `zoomend` (reuse the same event the
`srTrace` pane already listens to for redraws):

### Z < 15 (zoomed out / whole-track view)

- **Triangles only** — no coaching chips at all (no room to lay them out without
  overlapping each other or the track).
- **Per rider, only the top-3 most severe braking onsets** are drawn
  (`DEFAULT_CFG.LOW_ZOOM_TOP_N = 3`), ranked by the severity metric from §2 (peak
  `|longAccel|` in the run). This keeps the map from turning into a triangle
  minefield on a 15-corner track while still surfacing "the 3 hardest stops" —
  usually exactly the corners worth coaching on.
- Triangles still fan-out per §4 if their severity-filtered survivors still overlap
  within `COLLAPSE_RADIUS_PX`.
- Triangle `severityScale` still applies (harder brake = visibly bigger), which
  doubles as a cue for *why* these 3 were chosen over others.

### Z ≥ 15 (zoomed to a section / single corner)

- **Everything in the current viewport** is drawn — all riders' onsets, not just
  top-3, since there's now room and the whole point of zooming in is to inspect one
  braking zone closely.
- **Coaching chips render** for any corner cluster with ≥2 riders' onsets within
  `CORNER_CLUSTER_RADIUS_M` of each other and currently inside the viewport bounds
  (`map.getBounds()`) — off-screen clusters aren't rendered (standard viewport
  culling, avoids paying layout cost for chips nobody can see).
- Single-rider corners at Z ≥ 15 still get a triangle, just no chip (a coaching
  comparison needs ≥2 riders — see the "single-lap" state in §10).

### Collapse radius (both zoom bands)

- `COLLAPSE_RADIUS_PX = 24` — the screen-space distance (px) under which two or more
  onset points are treated as "the same cluster" for fan-out (§4) and for coaching
  chip grouping (§5/§7). 24px is roughly the footprint of two 18px triangles plus a
  few px of visual slop — close enough that unclustered triangles would visibly
  overlap, per real-device pixel density this is CSS px (Leaflet already normalizes
  for devicePixelRatio), so it behaves consistently on retina/hiDPI.
- Recompute clustering on every `zoomend`/`moveend` (screen-space distances change
  with zoom; lat/lng distances don't).

---

## 8. `DEFAULT_CFG` token object

Follows the existing `SR_TRACK.DEFAULT_CFG` convention in
`userscripts/src/sr-track.js` (a single flat config object with commented
constants an engineer can tune without hunting through render logic). Proposed as
`SR_EVENTS.DEFAULT_CFG` in a new `sr-track.js`-sibling module (or appended to
`sr-track.js` itself if the team prefers one shared config surface — either works,
this spec doesn't require a new file).

```js
const DEFAULT_CFG = {
  // --- Detection ---
  BRAKE_ONSET_THRESHOLD: 0.5,      // m/s^2, longAccel <= -this marks braking; matches
                                    // SR_TRACK's existing dead-band so onset triangles
                                    // land exactly on the colour trace's red transition
  MIN_RUN: 4,                      // samples (0.4s @ 10Hz) of non-braking required before
                                    // a new onset counts; mirrors SR_TRACK.DEFAULT_CFG.MIN_RUN
  CORNER_CLUSTER_RADIUS_M: 12,     // meters; onsets within this of each other (across riders)
                                    // are treated as "the same corner" for coaching chips

  // --- Triangle marker ---
  TRIANGLE_SIZE_PX: 18,            // base width/height of the SVG viewbox
  SEVERITY_SCALE_MIN: 0.8,         // scale applied at the softest tracked onset
  SEVERITY_SCALE_MAX: 1.25,        // scale applied at the hardest onset in this lap/comparison
  STROKE_COLOR: '#ffffff',
  STROKE_WIDTH_PX: 1.25,
  SHADOW_DX: 0,
  SHADOW_DY: 1,
  SHADOW_BLUR_STDDEV: 1.4,
  SHADOW_COLOR: '#000000',
  SHADOW_OPACITY: 0.55,

  // --- Fan-out (overlap resolution) ---
  COLLAPSE_RADIUS_PX: 24,          // screen-space px; onsets closer than this fan out
  FAN_GAP_PX: 10,                  // center-to-center spacing along the fan arc

  // --- Coaching chip ---
  CHIP_BG: 'rgba(17,19,23,.92)',
  CHIP_BORDER: 'rgba(255,255,255,.10)',
  CHIP_RADIUS_PX: 8,
  CHIP_MAX_WIDTH_PX: 168,
  CHIP_MAX_HEIGHT_PX: 104,
  CHIP_ANCHOR_OUTWARD_PX: 18,      // offset from cluster centroid, along perpendicular-to-heading
  CHIP_ANCHOR_UP_PX: 14,           // offset upward (screen -y) from cluster centroid
  MAX_CHIP_RIDERS: 4,              // rows shown before truncating ("4-rider-degraded" state
  DELTA_SUPPRESS_THRESHOLD_KMH: 3, // |delta| below this is not rendered (GPS noise floor)

  // --- Zoom-based LOD ---
  LOD_ZOOM: 15,                    // UNVALIDATED — sanity-check against a real track, see top-of-doc note
  LOW_ZOOM_TOP_N: 3,               // per-rider onsets kept at Z < LOD_ZOOM, ranked by severity

  // --- Colors (reuse existing rider colors, no new palette) ---
  // Triangle fill = per-rider color from SRSRCNG.seriesColors / riderColor(i)
  //   (see userscripts/src/03-data.js riderColor()) — not redefined here.
};
```

All values are also individually referenced by name earlier in this doc so an
engineer can grep either direction (spec → code or code → spec).

---

## 9. Contrast reasoning per basemap

Per `CLAUDE.md`, the site swaps between two basemaps: `mapType` = `osm-mapnik`
(light streets/satellite-ish OSM raster) and `mapTypeOther` = `carto-dark` (already
near-black), with `mapFilter` applying `blur/brightness/contrast/grayscale`
adjustments on top of either.

- **osm-mapnik (light basemap)**: base tile colors run from off-white pavement
  (~`#e8e8e0`) through mid-grey roads to saturated green terrain — a busy, medium-to-
  light background. A saturated rider-color fill (e.g. the existing `seriesColors`
  reds/blues, similar lightness to `COLORS.speed`/`#ff5c52` used in the telemetry
  chart) sits at roughly 3.5-5:1 contrast against these midtones on its own, which is
  borderline for a small 18px shape. The **1.25px white stroke** (§3) is what
  actually carries contrast here: white against mid-value map tiles is consistently
  ≥4.5:1, and it also crisply separates two adjacent same-hue-family rider triangles
  in a fan (§4) that might otherwise blend into each other and the terrain.
- **carto-dark (dark basemap)**: near-black tiles (~`#1a1a1a`–`#2b2b2b`) mean
  saturated rider colors read at high contrast (8:1+) on their own — the risk here
  isn't legibility, it's that a plain colored shape with no edge can look like it's
  "floating" with no grounding, and dark-on-dark drop shadow (§3, `#000` @ 0.55
  opacity) does nothing useful. The same **white stroke** still functions as the
  primary contrast/definition device (a bright ring reads immediately against near-
  black), while the `feDropShadow` mainly earns its keep here by adding *directional*
  depth (a 1px offset + soft blur) rather than raw contrast, since it visually lifts
  the triangle off the flat dark tile the way it does over any light UI chrome — no
  basemap-conditional shadow needed.
- **Net decision**: one SVG (§3), no basemap-conditional variants. The white
  stroke + drop-shadow combination was chosen specifically because it is the single
  design that works on both without branching — avoids doubling the marker code path
  and the state-explosion of testing two visual variants across the fan-out/LOD
  logic in §4/§7.
- **Coaching chip**: independent of basemap — it's `rgba(17,19,23,.92)`, i.e. always
  a dark, near-opaque card regardless of what's under it (same pattern the existing
  telemetry panel `#sr-tele-panel` uses, per `02-styles.js`'s
  `linear-gradient(180deg,#1b1e24,#0d0f13)`). This sidesteps basemap contrast
  entirely for the chip — text contrast is always dark-chip-vs-light-text
  (`#e7e9ee` on `rgba(17,19,23,.92)` ≈ 14:1), unaffected by whatever's underneath.
  The one thing to verify visually is the chip's *shadow* against a light basemap —
  `box-shadow:0 3px 10px rgba(0,0,0,.45)` should still read as "this card is
  floating above the map" rather than blending into the map's own dark regions (e.g.
  shadow terrain, dark tile pixels) — flagged as a lightweight visual QA item, not a
  blocking redesign risk.

---

## 10. States

### Default (single lap, Z ≥ 15, no overlaps)

- One triangle per detected braking onset for the primary rider, at full
  `severityScale`, no fan-out needed, pointing along heading.
- No coaching chip (needs ≥2 riders per §7).

### Fanned-overlap (comparison mode, ≥2 riders brake within `COLLAPSE_RADIUS_PX`)

- Triangles fan per §4's formula, ordered by rider index, gap 10px along the
  perpendicular-to-heading axis.
- At Z ≥ 15: a coaching chip anchors to the cluster centroid per §6, one row per
  rider ordered fastest-first, delta rows suppressed under 3 km/h per §5.
- Hover/tap on any triangle in the fan brings that triangle to front (raise
  z-index) and, if a chip exists for its cluster, briefly emphasizes that rider's row
  (e.g. row background tint using that rider's color at low opacity) — a nice-to-have
  polish pass, not required for v1.

### Low-zoom-collapsed (Z < `LOD_ZOOM`)

- Only top-3-by-severity triangles per rider are drawn (§7); all coaching chips are
  hidden entirely (add `.sr-evt-chip-hidden` rather than removing chip DOM nodes, so
  re-showing on zoom-in doesn't require rebuilding them — cheap opacity toggle via
  the `.sr-evt-chip-hidden{opacity:0;}` rule already in the CSS block).
- Triangles still individually sized by `severityScale`, so the visual hierarchy
  ("these are the 3 biggest stops") holds even without chips.

### 4-rider-degraded (comparison with `MAX_CHIP_RIDERS` exceeded)

- Chip shows exactly 4 rows: the fastest-in reference rider plus the next 3 by
  finishing position/speed at that point (not just "first 4 in array order" — rank
  by speed at onset, so the riders shown are the most relevant comparison, not
  arbitrary).
- No "+N more" affordance in v1 (would need another row slot inside the fixed
  104px `max-height`, cutting into the 4-row budget) — flagged as a follow-up if a
  5-rider comparison URL turns out to be common; not blocking for initial ship since
  today's documented comparison flows in `CLAUDE.md` describe 2-rider `/laptimes/
  <a>,<lap>,<b>,<lap>/` URLs.

### Empty (no braking events detected)

- Applies to a lap with no `longAccel` data usable (mirrors `SR_TRACK.validity`'s
  bail condition in `userscripts/src/03-data.js renderTrackColour`) — if that
  bail fires for the colour trace, `srEvents` also renders nothing (no triangles, no
  chips) rather than guessing. No error UI needed; this is a silent no-op layer, same
  posture as the existing trace's bail path.

### Loading / transient

- On pane swap (`.html()`-swapped map pane per `CLAUDE.md`'s DOM-mutation gotcha),
  triangles and chips are removed and rebuilt via the same `MutationObserver`
  re-render hook the chart/map-dot code already uses — there is no separate
  "loading" visual state; the layer simply isn't present until the next render pass
  completes (sub-frame, no spinner needed given the data is already in-memory).

### Error / disabled

- Not user-toggleable in v1 (no on/off control specified) — if one is added later,
  the natural pattern is a legend-header icon-button matching the existing
  `.sr-play-btn` treatment in `02-styles.js`, out of scope for this spec.

---

## 11. Accessibility & interaction notes

- **Pointer target size**: the 18px SVG triangle is under the ~24-44px touch target
  recommended for direct interaction. Since `pointer-events:auto` is set on
  `.sr-evt-tri` (§3) for hover/tap-to-highlight, wrap each marker's Leaflet icon in a
  divIcon whose **hit area** is padded to at least 28×28px via a transparent
  pseudo-element or an oversized invisible host div, rather than relying on the
  visual 18px shape as the click target. This matters especially at
  `SEVERITY_SCALE_MIN` (0.8×, ~14px effective).
- **Keyboard**: this is a map-canvas overlay (Leaflet markers are not naturally
  tab-stoppable, and neither is the rest of this map's interaction model per
  `CLAUDE.md` — the existing scrubber/legend are the only keyboard-relevant
  surfaces). No new keyboard requirement introduced beyond what the map already
  supports; do not silently add `tabindex` to dozens of triangle markers as that
  would create a new, noisy tab-stop sequence with no matching visual focus ring
  design — flag to the team if keyboard support for map markers becomes a
  requirement, since it's a bigger scope item than this feature.
- **Color is not the only signal**: rider identity in the fan (§4) and chip (§5) is
  conveyed by color dot **and** name text side-by-side — never color alone — so a
  colorblind user can still map "which triangle is which rider" via the chip's text
  rows. The triangle-vs-triangle distinction in a fan does rely on hue (plus fan
  *position*, which is a second, non-color channel per rider per §4's "consistent
  relative fan position" rule) as a deliberate mitigation.
- **Contrast**: chip text `#e7e9ee` (names/speeds) and `#838c9a` (title/delta-neutral)
  on `rgba(17,19,23,.92)` — both exceed WCAG AA 4.5:1 for normal-size text (`#e7e9ee`
  ≈14:1, `#838c9a` ≈4.9:1). `#ff8a80` (behind-delta) on the same background ≈5.4:1,
  also AA-compliant. Numbers here are computed against the chip's own background,
  independent of basemap per §9's design goal.
- **Motion**: the only animation is the `.sr-evt-chip` opacity transition (`.12s
  ease`) for show/hide on LOD threshold crossing — short, non-looping, no
  vestibular-motion concern. No motion is introduced on the triangles themselves
  (no pulsing/bouncing) to avoid visually competing with the existing playback dot
  animation (`requestAnimationFrame`-driven per `CLAUDE.md`) during lap playback.
- **Screen readers**: out of scope for v1 — this is a canvas/SVG map annotation
  layer with no existing accessible-map-data-table alternative anywhere else in the
  product (the site itself doesn't provide one for its own markers), so `srEvents`
  is consistent with, not a regression from, the current baseline. Flagged, not
  silently ignored: if the product later adds a data-table fallback for the map,
  braking onsets + coaching deltas should be included as rows.

---

## 12. Implementation notes for engineers

- **New pane, not a new layer inside `srTrace`**: create a dedicated Leaflet pane
  (e.g. `srEvents`, following the exact `ensureTracePane` pattern in
  `userscripts/src/03-data.js`) at a z-index **above** `srTrace` (350) and the
  site's `overlayPane` (400) — e.g. `500` — so triangles sit above both the colour
  trace and the site's own sector markers, but the coaching chips (rendered as plain
  absolutely-positioned `<div>`s over the map container, not Leaflet markers — they
  don't need to pan/zoom-project themselves once positioned, easier to lay out with
  ordinary CSS flex/ellipsis) sit in a normal DOM layer above the Leaflet pane stack
  entirely (`z-index:650` is already set in the CSS in §5).
- **Redraw triggers**: hook `zoomend` (LOD band + fan-out recompute, §4/§7) and
  `moveend` (viewport culling for chips, §7) on `SRSRCNG.map`, plus the existing
  `MutationObserver` re-render-on-pane-swap hook already used elsewhere in this
  userscript (see `CLAUDE.md`'s "Applying changes without source/server access"
  section) — don't invent a second observer.
- **Reuse, don't fork, `SR_TRACK`'s onset math**: the `MIN_RUN`-absorption logic in
  `userscripts/src/03-data.js` (`renderTrackColour`'s while-loop merging short runs)
  and `SR_TRACK.DEFAULT_CFG.MIN_RUN` should be the single source of truth for what
  counts as a "run" — `srEvents`' onset detector should consume the same banded
  array `SR_TRACK.quantize`/`computeScore` already produces (an onset is simply "band
  transitions into red here") rather than re-deriving its own independent
  threshold pass. This guarantees triangles always land exactly on colour-trace
  transitions, which is the whole point of the two layers agreeing.
- **Tests**: this repo unit-tests `sr-track.js` under
  `userscripts/test/sr-track.test.js` / `sr-track.design.test.js` /
  `sr-track.events.test.js` (see `userscripts/test/README.md`) with no browser —
  the onset-detection and clustering math in §2/§7 should get the same treatment
  (pure functions over fixture `riders[].data` arrays), leaving only the DOM/SVG
  rendering itself as manually/visually verified.
