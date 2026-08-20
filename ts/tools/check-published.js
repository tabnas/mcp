#!/usr/bin/env node
/* Copyright (c) 2026 tabnas, MIT License */

/* check-published.js — do the PUBLISHED surfaces agree with this checkout?
 *
 * A release of this package updates seven places, and pushing a `ts/v*` tag
 * updates exactly one of them (npm, via release.yml and OIDC). Every other
 * surface is a separate step, and on 2026-08-20 two of them were silently
 * behind: the deployed Worker served 0.1.7 while npm and the registry said
 * 0.1.9.
 *
 * Two of the seven had no gate at all before this file:
 *
 *   npm dist-tag latest    <-> ts/package.json      GATED (verify.sh)
 *   server.json            <-> ts/package.json      GATED (data.test.js)
 *   skills/mcp.json pin    <-> npm                  GATED (skills validate --online)
 *   web src/data           <-> skills               GATED (gen-ax-data --check)
 *   MCP REGISTRY ENTRY     <-> npm                  <- this file
 *   DEPLOYED WORKER        <-> ts/package.json      <- this file, and parity.mjs
 *
 * Both are network reads of live services, so this cannot live in the
 * default test run: `npm test` must pass offline. It is the online
 * counterpart, the same split skills draws with `validate.js --online`.
 *
 * Reports every surface rather than exiting on the first mismatch — after a
 * release you want the whole picture, not the first thing that is wrong.
 *
 * Usage:
 *   node tools/check-published.js          # compare against this checkout
 *   node tools/check-published.js --json   # machine-readable
 *
 * Exits 1 on any disagreement.
 */

'use strict'

const Fs = require('node:fs')
const Path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = Path.join(__dirname, '..', '..')
const JSON_OUT = process.argv.includes('--json')

const pkg = JSON.parse(
  Fs.readFileSync(Path.join(REPO, 'ts', 'package.json'), 'utf8'))
const EXPECT = pkg.version

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const surfaces = []
function record(name, got, note) {
  surfaces.push({ name, expected: EXPECT, got, ok: got === EXPECT, note })
}

async function main() {
  // npm — the one surface a tag push actually updates.
  try {
    record('npm dist-tag latest',
      execFileSync('npm', ['view', pkg.name, 'version'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  } catch (e) { record('npm dist-tag latest', null, e.message) }

  // The registry mirrors downstream directories and caches what it is told,
  // so a stale entry advertises a version that may not exist yet.
  try {
    const d = await get(
      'https://registry.modelcontextprotocol.io/v0/servers?search=tabnas')
    // The registry keeps EVERY published version and returns them all;
    // exactly one carries isLatest. Taking the first entry by name reported
    // 0.1.9 as current while 0.1.11 sat beside it — this checker's own bug,
    // and precisely the failure mode it exists to catch.
    const entries = (d.servers || [])
      .filter((s) => s.server && s.server.name === 'dev.tabnas/mcp')
    const latest = entries.find((s) =>
      s._meta?.['io.modelcontextprotocol.registry/official']?.isLatest)
    record('MCP registry entry',
      latest ? latest.server.version : null,
      entries.length === 0 ? 'no dev.tabnas/mcp entry found'
        : latest ? undefined : 'entries exist but none is marked isLatest')
  } catch (e) { record('MCP registry entry', null, e.message) }

  // The hosted endpoint. Nothing redeploys it on release; it is the surface
  // most likely to lag, and the one whose lag is least visible.
  try {
    const h = await get('https://mcp.tabnas.dev/health')
    record('deployed Worker', h.version)
  } catch (e) { record('deployed Worker', null, e.message) }

  // The exact pin an agent installs. skills' own CI checks the pin EXISTS on
  // npm; nothing checks it is the CURRENT one.
  const pinFile = Path.join(REPO, '..', 'skills', 'mcp.json')
  if (Fs.existsSync(pinFile)) {
    const m = /@tabnas\/mcp@([0-9][^"' ]*)/.exec(Fs.readFileSync(pinFile, 'utf8'))
    record('skills/mcp.json pin', m ? m[1] : null,
      m ? undefined : 'no pin found')
  } else {
    surfaces.push({ name: 'skills/mcp.json pin', expected: EXPECT, got: null,
      ok: true, note: 'sibling not checked out — skipped' })
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ package: pkg.name, expected: EXPECT, surfaces }, null, 2))
  } else {
    console.log(`${pkg.name} — this checkout is ${EXPECT}\n`)
    for (const s of surfaces) {
      const mark = s.ok ? 'ok  ' : 'STALE'
      const got = s.got == null ? '—' : s.got
      console.log(`  ${mark}  ${s.name.padEnd(24)} ${got}` +
        (s.note ? `   (${s.note})` : ''))
    }
  }

  const bad = surfaces.filter((s) => !s.ok)
  if (bad.length) {
    console.error(`\n${bad.length} surface(s) disagree with this checkout.`)
    console.error('  npm behind      -> the release did not complete; check release.yml')
    console.error('  registry behind -> mcp-publisher publish')
    console.error('  Worker behind   -> npm run worker-deploy')
    console.error('  skills pin      -> node tools/sync-mcp-pin.js --apply, in ../skills')
    process.exit(1)
  }
  console.log('\nEvery published surface matches this checkout.')
}

main().catch((e) => { console.error(e); process.exit(1) })
