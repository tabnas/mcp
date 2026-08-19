#!/usr/bin/env node
/* Copyright (c) 2026 tabnas, MIT License */

/* parity.mjs — prove the hosted endpoint answers exactly what local does.
 *
 * The repo's central claim is that there is ONE implementation: the CLI, the
 * stdio server and the hosted Worker are three front-ends over core.ts, and
 * for the same request they return the same bytes. The test suite holds the
 * first two to that, and workerd.test.js holds the third — but only against
 * a LOCAL workerd. Nothing checked the thing actually deployed.
 *
 * This does. For each request below it calls core directly and POSTs the
 * same request to the endpoint, then compares the result strings byte for
 * byte. Not "equivalent": identical. A divergence here means the deployed
 * bundle is not the code in this repo, which is the only way the claim can
 * break once the tests are green.
 *
 * It also times every hosted call, because the same round trip that proves
 * parity measures latency, and Phase 4's exit criteria want both. The
 * percentiles it reports are what SLO.md's budget is set from.
 *
 * The agent benchmark (run.mjs) deliberately does NOT run hosted: its tasks
 * create files and run a CLI, and the hosted endpoint has no filesystem and
 * no shell. Those tasks measure an agent's workflow; this measures the
 * service.
 *
 * Usage:
 *   node benchmark/parity.mjs                          # against mcp.tabnas.dev
 *   node benchmark/parity.mjs --endpoint http://…/mcp  # against anything else
 *   node benchmark/parity.mjs --runs 20                # more latency samples
 *
 * Exits 1 on any divergence, any error, or an unreachable endpoint.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const require = createRequire(import.meta.url)

const { callTool } = require(join(REPO, 'ts', 'dist', 'tools.js'))
const GRAMMAR = JSON.parse(
  readFileSync(join(REPO, 'ts', 'test', 'json-grammar.fixture.json'), 'utf8'))

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf(name)
  return i < 0 ? fallback : argv[i + 1]
}
const ENDPOINT = flag('--endpoint', 'https://mcp.tabnas.dev/mcp')
// 40 samples plus the 10 case calls is 50 requests — under the endpoint's
// 60/minute per-IP limit, which this harness must not trip: a 429 is not a
// latency measurement, and burning the budget would make a rerun lie.
// 25 samples plus the 10 case calls is 35 requests. Deliberately well under
// the endpoint's 60/minute per-IP limit, because two runs inside one minute
// share that budget — sizing it to exactly 60 would make the second run of
// any pair fail.
const RUNS = Number(flag('--runs', '25'))

// One case per tool. Chosen to exercise the answer, not just the happy path:
// a failing parse, an invalid grammar and a fixture set with a failure row all
// have richer output than their successful twins, so they are the better
// parity probes.
const CASES = [
  ['parse', { input: '{"a":1,"b":[2,3]}', grammar: GRAMMAR }],
  ['parse', { input: '{"a":', grammar: GRAMMAR }],
  ['validate_grammar', { grammar: GRAMMAR }],
  ['validate_grammar', { grammar: { rule: { r: { ref: 'evil' } } } }],
  ['explain_parse_error', { input: '{"a":', grammar: GRAMMAR }],
  ['test_grammar', {
    spec: 'input\texpected\n{"a":1}\t{"a":1}\n{"b":\tERROR\n',
    grammar: GRAMMAR,
  }],
  ['list_plugins', {}],
  ['describe_plugin', { name: 'json' }],
  ['describe_plugin', { name: 'no-such-plugin' }],
  ['compare_grammars', { a: GRAMMAR, b: GRAMMAR }],
]

async function hosted(name, args) {
  const started = process.hrtime.bigint()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  if (429 === res.status) {
    throw new Error('rate limited — wait 60s, or lower --runs; this harness ' +
      'is sized to stay under the per-IP limit and something else is ' +
      'sharing your IP')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`rpc error: ${body.error.message}`)
  return { text: body.result.content[0].text, ms }
}

function percentile(sorted, p) {
  if (0 === sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[i]
}

console.log(`AX parity — local core vs ${ENDPOINT}`)

let failures = 0
const timings = []

for (const [name, args] of CASES) {
  const label = `${name}(${Object.keys(args).join(',') || '—'})`
  let local
  try {
    local = callTool(name, args)
  } catch (e) {
    console.error(`  ${label}  LOCAL THREW — ${e.message}`)
    failures++
    continue
  }

  let remote
  try {
    remote = await hosted(name, args)
  } catch (e) {
    console.error(`  ${label}  HOSTED FAILED — ${e.message}`)
    failures++
    continue
  }
  timings.push(remote.ms)

  if (local === remote.text) {
    console.log(`  ${label}  identical  (${remote.ms.toFixed(0)}ms)`)
  } else {
    console.error(`  ${label}  DIVERGED`)
    console.error(`    local  ${local.slice(0, 160)}`)
    console.error(`    hosted ${remote.text.slice(0, 160)}`)
    failures++
  }
}

// Latency: repeat the cheapest call so the numbers describe the service
// rather than the heaviest tool in the set.
for (let i = 0; i < RUNS; i++) {
  try {
    timings.push((await hosted('list_plugins', {})).ms)
  } catch (e) {
    // Not a parity failure. Parity is the assertion this harness makes and
    // it has already been made above; latency is a measurement, and a short
    // sample is worth reporting rather than discarding. Exiting 1 here would
    // report "the hosted endpoint diverged" when it did no such thing.
    console.warn(`  latency sampling stopped after ${timings.length} ` +
      `samples — ${e.message}`)
    break
  }
}

const sorted = [...timings].sort((a, b) => a - b)
console.log('')
console.log(`  samples ${sorted.length}` +
  `  p50 ${percentile(sorted, 50).toFixed(0)}ms` +
  `  p95 ${percentile(sorted, 95).toFixed(0)}ms` +
  `  p99 ${percentile(sorted, 99).toFixed(0)}ms` +
  `  max ${sorted[sorted.length - 1].toFixed(0)}ms`)

if (failures) {
  console.error(`\n${failures} divergence(s) or failure(s).`)
  process.exit(1)
}
console.log('\nHosted and local answer identically for every tool.')
