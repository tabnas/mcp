/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* copy-data.js — copy the committed data/ files into ts/dist/data/.
 *
 * The npm package root is ts/ and its published files are LICENSE and
 * dist/ only, while the committed data lives at the REPO root (data/),
 * beside ts/ — the fleet's layout for cross-runtime artifacts. Copying
 * data/ into dist/data/ at build time is what makes the bundle actually
 * ship: dist/data.js reads ONLY from its own dist/data/, so the same
 * path works in a repo checkout and in an installed package.
 *
 * Run by `npm run build` after tsc. ts/test/data.test.js asserts the
 * copy is byte-identical to data/, so a stale dist cannot pass the suite.
 */

const Fs = require('node:fs')
const Path = require('node:path')

const REPO_ROOT = Path.join(__dirname, '..', '..')
const SRC = Path.join(REPO_ROOT, 'data')
const OUT = Path.join(__dirname, '..', 'dist', 'data')

if (!Fs.existsSync(SRC)) {
  console.error('copy-data: no data/ directory at repo root; ' +
    'run `npm run gen-data` first')
  process.exit(1)
}

Fs.mkdirSync(OUT, { recursive: true })
for (const name of Fs.readdirSync(SRC).sort()) {
  Fs.copyFileSync(Path.join(SRC, name), Path.join(OUT, name))
}
