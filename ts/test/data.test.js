/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* data.test.js — the bundled data/ files are honest.
 *
 * Three gates:
 *
 * 1. STALENESS: regenerate the data IN MEMORY from the sibling checkouts
 *    (tools/gen-data.js buildData) and compare against the committed
 *    files, so a parser schema change or a plugin-manifest change that
 *    forgets `npm run gen-data` fails here instead of shipping stale
 *    copies. Skips gracefully when the parser sibling is absent (a bare
 *    `npx` install has no siblings; CI clones parser and support).
 *
 * 2. PARTIAL FLEETS: CI clones only parser and support, so the plugin
 *    comparison cannot demand all 21 repos. Instead: every manifest that
 *    IS present must match its committed descriptor exactly, and a
 *    present manifest missing from the committed set fails. A committed
 *    descriptor whose repo is not checked out is left alone. With a full
 *    fleet this collapses to exact equality.
 *
 * 3. SHIPPED COPY: dist/data (what dist/data.js actually reads, and what
 *    the npm package ships) is byte-identical to the committed data/.
 */

const { describe, it } = require('node:test')
const assert = require('node:assert')
const Fs = require('node:fs')
const Path = require('node:path')

const { buildData, hasParser, REPO_ROOT, DATA_DIR } =
  require('../tools/gen-data.js')

const data = require('../dist/data.js')

const NAMES = [
  'error-codes.json',
  'grammar.schema.json',
  'diagnostic.schema.json',
  'DIVERGENCE.md',
  'plugins.json',
]

function committed(name) {
  return Fs.readFileSync(Path.join(DATA_DIR, name), 'utf8')
}


describe('data', () => {
  it('committed copies are not stale (regenerate from siblings)', (t) => {
    if (!hasParser()) {
      t.skip('no ../parser sibling checkout: cannot regenerate; ' +
        'run in the fleet layout (or CI, which clones parser) to check ' +
        'staleness')
      return
    }

    const { files } = buildData()

    for (const name of NAMES.filter((n) => 'plugins.json' !== n)) {
      assert.strictEqual(committed(name), files[name],
        `data/${name} is stale: run npm run gen-data (from ts/) and ` +
        'commit the result')
    }

    const regenerated = JSON.parse(files['plugins.json'])
    const bundled = JSON.parse(committed('plugins.json'))
    assert.strictEqual(bundled.generated_from, 'sibling checkouts')

    const bundledByName = new Map(bundled.plugins.map((p) => [p.name, p]))
    for (const p of regenerated.plugins) {
      assert.ok(bundledByName.has(p.name),
        `plugin ${p.name} has a manifest in the fleet but is not in ` +
        'data/plugins.json: run npm run gen-data and commit')
      assert.deepStrictEqual(bundledByName.get(p.name), p,
        `data/plugins.json entry for ${p.name} is stale: run ` +
        'npm run gen-data and commit')
    }

    // Committed descriptors whose repos are absent are fine (partial
    // fleet); with a full fleet the two sets are equal.
    if (regenerated.plugins.length === bundled.plugins.length) {
      assert.deepStrictEqual(bundled, regenerated)
    }
  })

  it('descriptors are sorted by name and carry a name', () => {
    const bundled = JSON.parse(committed('plugins.json'))
    const names = bundled.plugins.map((p) => p.name)
    assert.ok(0 < names.length, 'no bundled plugin descriptors')
    assert.deepStrictEqual(names, [...names].sort())
    assert.strictEqual(new Set(names).size, names.length,
      'duplicate plugin names')
  })

  it('regeneration is deterministic (build twice, compare)', (t) => {
    if (!hasParser()) {
      t.skip('no ../parser sibling checkout')
      return
    }
    assert.deepStrictEqual(buildData().files, buildData().files)
  })

  it('dist/data is byte-identical to the committed data/', () => {
    // dist/data.js reads ONLY dist/data (the shipped copy, made by the
    // build's copy-data step); a stale copy would silently serve old
    // schemas to every tool and resource.
    for (const name of NAMES) {
      const shipped = Fs.readFileSync(
        Path.join(data.dataDir(), name), 'utf8')
      assert.strictEqual(shipped, committed(name),
        `dist/data/${name} differs from data/${name}: run npm run build`)
    }
  })

  it('loaders parse and expose the expected shapes', () => {
    assert.strictEqual(typeof data.errorRegistry().codes.unexpected.message,
      'string')
    assert.strictEqual(data.grammarSchema().$id,
      'https://tabnas.dev/schema/grammar.schema.json')
    assert.strictEqual(data.diagnosticSchema().$id,
      'https://tabnas.dev/schema/diagnostic.schema.json')
    assert.ok(Array.isArray(data.pluginIndex().plugins))
    assert.ok(data.divergence().startsWith('# Divergences'))
    assert.strictEqual(data.packageInfo().name, '@tabnas/mcp')
  })

  it('repo layout: data/ lives at the repo root', () => {
    assert.strictEqual(Path.resolve(DATA_DIR),
      Path.resolve(Path.join(REPO_ROOT, 'data')))
  })
})
