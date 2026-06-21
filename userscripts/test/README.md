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

## Export-seam decision

Pure-logic modules (e.g. `SR_TRACK` in `userscripts/test/sr-track.js`) are authored
in a **separate file** with this guard at the bottom:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SR_TRACK;
} else {
  window.SR_TRACK = SR_TRACK;
}
```

- In **Node** (tests): `require('./sr-track.js')` returns the object normally.
- In the **browser** (Tampermonkey): `module` is `undefined`, so the guard falls
  through to `window.SR_TRACK` — no `ReferenceError`.

The module body is delimited by `=== BEGIN sr-track inline ===` / `=== END sr-track
inline ===` comments and is **copied verbatim** into the IIFE of
`serious-racing-lean-angle.user.js` (between matching marker comments).  There is no
build step: when you change `sr-track.js`, manually update the inlined copy in the
userscript.  A grep for `BEGIN sr-track inline` finds both locations.
