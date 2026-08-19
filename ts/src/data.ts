/* Copyright (c) 2026 tabnas, MIT License */

/* data.ts
 * Accessors for the bundled data/ files.
 *
 * The repo commits generated copies of the fleet's contract files in
 * data/ at the repo root (see tools/gen-data.js for why, and for how they
 * are regenerated). tools/embed-data.js then compiles that directory into
 * src/data-bundle.ts, and this module reads ONLY from that import.
 *
 * A STATIC IMPORT, not readFileSync, because this code has to run in a
 * runtime with no filesystem. The hosted Worker's `nodejs_compat` offers
 * `node:fs`, but its virtual root holds only what was imported — a file
 * read by path is not there at all. An import is the single form that
 * resolves everywhere this package runs: Node for the CLI and the stdio
 * server, workerd for the hosted endpoint. One path, so hosted and local
 * cannot serve different bytes.
 *
 * ts/test/data.test.js keeps the embedded copy honest (byte-compare
 * against data/) and the committed data honest (deep-compare against a
 * regeneration from siblings).
 *
 * Parsed forms are cached: the CLI should not pay to parse plugins.json
 * to run `tabnas parse`, and the text cannot change under a running
 * process (it is program text, not state).
 */

import { FILES, PACKAGE } from './data-bundle'

// One error-code registry entry: message and hint templates.
export type RegistryEntry = {
  message: string
  hint: string
}

// data/error-codes.json — the engine's generated error-code registry.
export type ErrorRegistry = {
  version: string
  codes: Record<string, RegistryEntry>
  goOnly?: Record<string, RegistryEntry>
  [key: string]: unknown
}

// One plugin descriptor — a repo's tabnas.plugin.json, verbatim.
export type PluginDescriptor = {
  name: string
  description?: string
  [key: string]: unknown
}

// data/plugins.json — every fleet plugin descriptor, sorted by name.
export type PluginIndex = {
  generated_from: string
  plugins: PluginDescriptor[]
}

const jsonCache: Record<string, unknown> = {}

function text(name: string): string {
  const found = FILES[name]
  if (undefined === found) {
    // Only reachable from a RESOURCES entry naming a file that
    // embed-data did not emit, i.e. a data/ file deleted without
    // updating the resource list. Say which, rather than serving
    // `undefined` as a resource body.
    throw new Error(`no bundled data file: ${name}`)
  }
  return found
}

function json(name: string): unknown {
  if (!(name in jsonCache)) {
    jsonCache[name] = JSON.parse(text(name))
  }
  return jsonCache[name]
}

// The names of every bundled file, sorted. There is no directory to list
// any more, and the test suite needs the embedded set without a
// hand-kept copy of it.
export function dataNames(): string[] {
  return Object.keys(FILES).sort()
}

// Parsed data/error-codes.json.
export function errorRegistry(): ErrorRegistry {
  return json('error-codes.json') as ErrorRegistry
}

// Parsed data/grammar.schema.json (JSON Schema draft 2020-12).
export function grammarSchema(): Record<string, unknown> {
  return json('grammar.schema.json') as Record<string, unknown>
}

// Parsed data/diagnostic.schema.json (JSON Schema draft 2020-12).
export function diagnosticSchema(): Record<string, unknown> {
  return json('diagnostic.schema.json') as Record<string, unknown>
}

// Parsed data/plugins.json.
export function pluginIndex(): PluginIndex {
  return json('plugins.json') as PluginIndex
}

// data/DIVERGENCE.md — the engine's TS/Go divergence record, as text.
export function divergence(): string {
  return text('DIVERGENCE.md')
}

// Raw text of any bundled file (the MCP resource handlers serve these
// verbatim, so a resource read is byte-identical to the committed file).
export function rawData(name: string): string {
  return text(name)
}

// This package's own manifest (name/version — the MCP server identity),
// embedded from package.json at build time.
export function packageInfo(): { name: string; version: string } {
  return { name: PACKAGE.name, version: PACKAGE.version }
}
