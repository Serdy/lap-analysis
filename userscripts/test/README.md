# Unit-test harness

Uses Node's built-in `node:test` runner — **no npm install required**.

## Run

```sh
cd userscripts/test
npm test          # calls: node --test
```

Or directly from any directory:

```sh
node --test userscripts/test/sr-track.test.js
```

Requires Node >= 18 (built-in test runner).  Current CI-tested version: 26.

## Build: one shipped file, one source of truth

The shipped `serious-racing-lean-angle.user.js` is **generated** — do not edit it by
hand.  Author in `userscripts/src/` and regenerate:

```sh
cd userscripts
node build.mjs        # or: npm run build
```

`build.mjs` concatenates the ordered `src/NN-*.js` fragments inside one IIFE and
**injects** the `SR_TRACK` body from `src/sr-track.js`.  `src/sr-track.js` is the
single source of truth: the tests require it directly and the userscript is built
from it, so the two can no longer drift.

The generated `serious-racing-lean-angle.user.js` is **git-ignored** — it is a build
artifact, not source.  Build it locally to test/install, or download it from the
GitHub Actions **userscript** workflow (uploaded as an artifact on every run).

## Export-seam decision

Pure-logic modules (e.g. `SR_TRACK` in `userscripts/src/sr-track.js`) are authored
in a **separate file** with this guard at the bottom:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SR_TRACK;
} else {
  window.SR_TRACK = SR_TRACK;
}
```

- In **Node** (tests): `require('../src/sr-track.js')` returns the object normally.
- In the **browser** (Tampermonkey): `module` is `undefined`, so the guard falls
  through to `window.SR_TRACK` — no `ReferenceError`.

The module body is delimited by `=== BEGIN sr-track inline ===` / `=== END sr-track
inline ===` comments; `build.mjs` extracts everything between those markers (the
export seam after the END marker is naturally excluded) and injects it into the
userscript.  No more hand-syncing — a grep for `BEGIN sr-track inline` still finds
both the source and the generated copy.
