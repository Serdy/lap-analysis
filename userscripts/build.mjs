#!/usr/bin/env node
// Assembles the shipped userscript from src/ fragments — zero dependencies.
//
// The shipped artifact must be ONE file (Tampermonkey loads a single .user.js,
// @grant none, no in-page build). So we author small modules in src/ and concat
// them inside one IIFE here. SR_TRACK is the one shared module that also runs as
// a standalone, unit-tested file (src/sr-track.js): its marker-delimited body is
// injected so there is a single source of truth (no more hand-syncing two copies).
//
// Why plain concat works (no bundler): every top-level name in the IIFE is a
// hoisted `function` declaration or a module-level `let/const` only READ inside
// functions that run at the very end (poll/observer/resize). Order is irrelevant
// except that the bootstrap fragment (the only top-level executable code) is LAST.
//
// Usage:  node build.mjs   (or: npm run build)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'serious-racing-lean-angle.user.js');

const BEGIN = '// === BEGIN sr-track inline ===';
const END = '// === END sr-track inline ===';

const read = (f) => readFileSync(join(SRC, f), 'utf8');
const trimNL = (s) => s.replace(/\n$/, '');

// Extract the SR_TRACK body (markers included) from the canonical module and
// re-indent it two spaces so it nests cleanly inside the IIFE.
function srTrackBlock() {
  const text = read('sr-track.js');
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a === -1 || b === -1) {
    throw new Error('sr-track.js is missing the BEGIN/END sr-track inline markers');
  }
  const block = text.slice(a, b + END.length);
  return block.split('\n').map((line) => (line ? '  ' + line : line)).join('\n');
}

// Ordered NN-name.js fragments. 01-constants must come first (SR_TRACK is injected
// right after it); 07-bootstrap last (it holds the only top-level executable code).
const numbered = readdirSync(SRC).filter((f) => /^\d\d-.*\.js$/.test(f)).sort();
const [first, ...rest] = numbered;
if (first !== '01-constants.js') {
  throw new Error(`expected 01-constants.js first, got ${first}`);
}

const pieces = [
  trimNL(read('banner.js')),   // metadata + doc comment + IIFE open + 'use strict'
  trimNL(read(first)),         // 01-constants
  srTrackBlock(),              // injected canonical SR_TRACK
  ...rest.map((f) => trimNL(read(f))), // 02-styles .. 07-bootstrap (IIFE close)
];

writeFileSync(OUT, pieces.join('\n') + '\n');
console.log(`Built ${OUT} from ${numbered.length + 2} src fragments.`);
