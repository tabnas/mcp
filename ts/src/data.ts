/* Copyright (c) 2026 tabnas, MIT License */

/* data.ts
 * Loader for the bundled data/ files.
 *
 * The repo commits generated copies of the fleet's contract files in
 * data/ at the repo root (see tools/gen-data.js for why, and for how they
 * are regenerated). The build copies that directory into dist/data/, so
 * the ONE path this module reads — its own dist/data/ — works identically
 * in a repo checkout and in the published package. ts/test/data.test.js
 * keeps the copy honest (byte-compare against data/) and the committed
 * data honest (deep-compare against a regeneration from siblings).
 *
 * Everything is read lazily and cached: the CLI should not pay for
 * plugins.json to run `tabnas parse`, and the files cannot change under
 * a running process (they are package contents, not state).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(__dirname, 'data')

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

const textCache: Record<string, string> = {}
const jsonCache: Record<string, unknown> = {}

function text(name: string): string {
  if (!(name in textCache)) {
    textCache[name] = readFileSync(join(DATA_DIR, name), 'utf8')
  }
  return textCache[name]
}

function json(name: string): unknown {
  if (!(name in jsonCache)) {
    jsonCache[name] = JSON.parse(text(name))
  }
  return jsonCache[name]
}

// The directory the bundled files are read from (dist/data).
export function dataDir(): string {
  return DATA_DIR
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

// This package's own manifest (name/version — the MCP server identity).
export function packageInfo(): { name: string; version: string } {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  return { name: pkg.name, version: pkg.version }
}
