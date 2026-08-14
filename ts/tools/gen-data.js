/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* gen-data.js — regenerate the bundled data/ files from sibling checkouts.
 *
 * Published packages do not carry the fleet's contract files: the parser's
 * npm files do not include schema/, and plugin packages do not ship their
 * tabnas.plugin.json. So this repo BUNDLES generated copies in data/,
 * committed and shipped inside the npm package (the build copies data/
 * into ts/dist/data/). ADR-10: derive, never duplicate — everything here
 * is read from files humans already maintain, and a staleness test
 * (ts/test/data.test.js) fails CI when a regeneration was forgotten.
 *
 * The fleet layout is sibling checkouts beside this repo: ../<repo>
 * relative to the repo root (locally /workspace/<repo>; in CI the clones
 * polyglot-ci.yml makes). Sources:
 *
 *   ../parser/schema/error-codes.json       -> data/error-codes.json
 *   ../parser/schema/grammar.schema.json    -> data/grammar.schema.json
 *   ../parser/schema/diagnostic.schema.json -> data/diagnostic.schema.json
 *   ../parser/DIVERGENCE.md                 -> data/DIVERGENCE.md
 *   every <repo>/tabnas.plugin.json found   -> data/plugins.json
 *
 * Plugin manifests are discovered one and two levels below the fleet root
 * (two, because an aggregate checkout like ../tabnas/<repo> nests them —
 * csv and xml live only there today). Discovery is deterministic: paths
 * are visited in sorted order, descriptors are deduplicated by plugin
 * name (first path wins) and sorted by name. 21 manifests exist on main
 * today.
 *
 * Usage: node tools/gen-data.js   (or: npm run gen-data, from ts/)
 * Running it twice is byte-idempotent.
 */

const Fs = require('node:fs')
const Path = require('node:path')

// Repo root is two levels above this file (ts/tools/gen-data.js).
const REPO_ROOT = Path.join(__dirname, '..', '..')
const DATA_DIR = Path.join(REPO_ROOT, 'data')

// The verbatim copies: source path (under the fleet root), target name.
const COPIES = [
  { src: ['parser', 'schema', 'error-codes.json'], out: 'error-codes.json' },
  { src: ['parser', 'schema', 'grammar.schema.json'], out: 'grammar.schema.json' },
  { src: ['parser', 'schema', 'diagnostic.schema.json'], out: 'diagnostic.schema.json' },
  { src: ['parser', 'DIVERGENCE.md'], out: 'DIVERGENCE.md' },
]

// Directories that can never hold a sibling checkout.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'vendor'])

function listDirs(dir) {
  let entries
  try {
    entries = Fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') &&
      !SKIP_DIRS.has(e.name))
    .map((e) => Path.join(dir, e.name))
    .sort()
}

// Find every tabnas.plugin.json one or two levels below the fleet root,
// in sorted path order. The repo's own checkout is excluded (it is a
// sibling of the fleet like any other, and must not read itself).
function findManifests(fleetRoot, selfRoot) {
  const found = []
  for (const repo of listDirs(fleetRoot)) {
    if (selfRoot && Path.resolve(repo) === Path.resolve(selfRoot)) {
      continue
    }
    const direct = Path.join(repo, 'tabnas.plugin.json')
    if (Fs.existsSync(direct)) {
      found.push(direct)
    }
    for (const nested of listDirs(repo)) {
      const deep = Path.join(nested, 'tabnas.plugin.json')
      if (Fs.existsSync(deep)) {
        found.push(deep)
      }
    }
  }
  return found
}

// Build the plugins.json document from the manifests under fleetRoot.
// Deterministic: dedupe by descriptor name (first sorted path wins),
// then sort descriptors by name.
function buildPlugins(fleetRoot, selfRoot) {
  const byName = new Map()
  for (const file of findManifests(fleetRoot, selfRoot)) {
    let descriptor
    try {
      descriptor = JSON.parse(Fs.readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`gen-data: unreadable plugin manifest ${file}: ${err.message}`)
    }
    if ('string' !== typeof descriptor.name || '' === descriptor.name) {
      throw new Error(`gen-data: plugin manifest ${file} has no name`)
    }
    if (!byName.has(descriptor.name)) {
      byName.set(descriptor.name, descriptor)
    }
  }
  const plugins = [...byName.keys()].sort()
    .map((name) => byName.get(name))
  return {
    generated_from: 'sibling checkouts',
    plugins,
  }
}

// Regenerate everything IN MEMORY: { files: {name: text}, counts }.
// The staleness test compares this against the committed data/ files.
// Throws if the parser checkout (the schema source) is absent — callers
// that want to skip gracefully should check hasParser() first.
function buildData(fleetRoot, selfRoot) {
  fleetRoot = fleetRoot || Path.join(REPO_ROOT, '..')
  selfRoot = undefined === selfRoot ? REPO_ROOT : selfRoot

  const files = {}
  for (const copy of COPIES) {
    const src = Path.join(fleetRoot, ...copy.src)
    if (!Fs.existsSync(src)) {
      throw new Error(`gen-data: source not found: ${src} ` +
        '(is the parser sibling checked out beside this repo?)')
    }
    files[copy.out] = Fs.readFileSync(src, 'utf8')
  }

  const plugins = buildPlugins(fleetRoot, selfRoot)
  files['plugins.json'] = JSON.stringify(plugins, null, 2) + '\n'

  return { files, pluginCount: plugins.plugins.length }
}

// Is the schema source present under this fleet root?
function hasParser(fleetRoot) {
  fleetRoot = fleetRoot || Path.join(REPO_ROOT, '..')
  return Fs.existsSync(Path.join(fleetRoot, 'parser', 'schema'))
}

function main() {
  const { files, pluginCount } = buildData()
  Fs.mkdirSync(DATA_DIR, { recursive: true })
  for (const name of Object.keys(files)) {
    const target = Path.join(DATA_DIR, name)
    const next = files[name]
    const prev = Fs.existsSync(target) ? Fs.readFileSync(target, 'utf8') : null
    if (prev !== next) {
      Fs.writeFileSync(target, next)
      console.log(`gen-data: wrote ${Path.relative(REPO_ROOT, target)}`)
    } else {
      console.log(`gen-data: unchanged ${Path.relative(REPO_ROOT, target)}`)
    }
  }
  console.log(`gen-data: ${pluginCount} plugin descriptor(s) bundled`)
}

if (require.main === module) {
  main()
}

module.exports = { buildData, buildPlugins, findManifests, hasParser, REPO_ROOT, DATA_DIR }
