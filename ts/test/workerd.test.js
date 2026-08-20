/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* workerd.test.js — the hosted endpoint, in the runtime it deploys to.
 *
 * WHY THIS FILE EXISTS. worker.test.js drives the same `handle()` as a
 * plain function under Node, which is fast and covers the logic, but it
 * cannot see anything about the RUNTIME. Every deploy-blocking defect
 * this repo had was invisible to it and to the other 130 tests:
 *
 *   - `@tabnas/support`'s barrel pulled in `node:test`, which workerd
 *     does not implement, so the bundle would not build.
 *   - tsc emits CommonJS, so wrangler saw no default export and read the
 *     Worker as service-worker format.
 *   - data.ts read its files with readFileSync at runtime; there is no
 *     filesystem, so every resource read and /health would have thrown.
 *   - the entry module exported a number (MAX_BODY_BYTES), and workerd
 *     type-checks named exports: startup error, not a build error.
 *
 * All four pass a Node test suite and fail a deploy. So this file boots
 * the REAL wrangler.json in REAL workerd and speaks HTTP to it. It is
 * slower than the rest of the suite by seconds, and it is the only test
 * whose failure means "this will not deploy".
 *
 * It deliberately does not mock or skip: if wrangler or the workerd
 * binary is missing the suite fails, because a green run is supposed to
 * mean the hosted endpoint works.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const Fs = require('node:fs')
const Path = require('node:path')

const { callTool, RESOURCES } = require('../dist/tools')
const GRAMMAR = require('./json-grammar.fixture.json')

const DATA_DIR = Path.join(__dirname, '..', '..', 'data')
const CONFIG = Path.join(__dirname, '..', '..', 'wrangler.json')

// Read from the deploy config, not retyped: this test's whole job is to
// prove the deployed configuration behaves, so it must assert against
// that file rather than a copy of its numbers.
const LIMITER = JSON.parse(Fs.readFileSync(CONFIG, 'utf8'))
  .ratelimits.find((r) => 'MCP_LIMIT' === r.name).simple

// Booting workerd and bundling the Worker is seconds, not milliseconds.
const BOOT_MS = 120_000

let worker = null

// Set when the host cannot run workerd. Distinguished from a real failure by
// what the error says: an unsupported platform is a fact about the machine,
// anything else is a fact about the code and must still fail.
let incapable = null

function whyIncapable(err) {
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  const mac = /Unsupported macOS version[^.]*\.[^.]*\./i.exec(text)
  if (mac) return mac[0].replace(/\s+/g, ' ').trim()
  if (/glibc|Unsupported platform|not supported on this/i.test(text)) {
    return text.replace(/\s+/g, ' ').slice(0, 200)
  }
  return null
}

// Wraps `it` so every case reports the same reason rather than eleven
// identical cancellations with no cause attached.
const wit = (name, fn) => it(name, async (t) => {
  if (incapable) {
    t.skip('host cannot run workerd — see the banner above; CI enforces this')
    return
  }
  return fn(t)
})

async function start() {
  const { unstable_startWorker } = await import('wrangler')
  return unstable_startWorker({
    config: CONFIG,
    dev: {
      // Ephemeral port: the suite must not collide with a `wrangler dev`
      // the developer already has open on 8787.
      server: { port: 0 },
      inspector: false,
    },
  })
}

// The origin is irrelevant to the Worker (it routes on pathname) but a
// Request needs an absolute URL, so use the real hostname it deploys to.
const url = (path) => 'https://mcp.tabnas.dev' + path

const get = (path) => worker.fetch(url(path))

// Every request in this file carries a per-RUN client address, because the
// limiter's counters outlive the workerd instance: two runs inside the same
// 60-second window otherwise share a bucket, and the later tests in the
// file start with the earlier runs' requests already counted. That is not
// hypothetical — running this file three times in a row put the shared
// default bucket over the ceiling and failed five unrelated assertions
// (resource reads, byte parity, the ref refusal) with 429s that looked like
// real defects.
//
// A pid-derived address in 10.0.0.0/8 is obviously synthetic and never
// routable. Off-edge nobody sets cf-connecting-ip, so the header passes
// through; at the edge Cloudflare overwrites it, which is why this is safe
// to rely on in a test and impossible to forge in production.
const RUN = process.pid
const ip = (n) => `10.${RUN % 251}.${(RUN >> 8) % 251}.${n}`
const IP_DEFAULT = ip(1)   // everything that is not about rate limiting
const IP_BURST = ip(2)     // the test that deliberately exhausts a bucket
const IP_OTHER = ip(3)     // proves buckets are per-IP, not global

const post = (body, headers) => worker.fetch(url('/mcp'), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-connecting-ip': IP_DEFAULT,
    ...(headers ?? {}),
  },
  body: 'string' === typeof body ? body : JSON.stringify(body),
})

// The limiter buckets on cf-connecting-ip. Off-edge nobody sets it, so
// every request in this file would otherwise share one bucket and the
// rate-limit test would starve the rest. Each test that cares gets its
// own address.
const postAs = (ip, body) => post(body, { 'cf-connecting-ip': ip })


const rpc = async (method, params, id = 1) =>
  (await post({ jsonrpc: '2.0', id, method, params })).json()


describe('hosted worker in workerd', { timeout: BOOT_MS }, () => {
  before(async () => {
    try {
      worker = await start()
    } catch (e) {
      incapable = whyIncapable(e)
      // Not a capability problem: let it fail, loudly, as before.
      if (!incapable) throw e
      console.error(`\n  SKIPPING the workerd suite: ${incapable}`)
      console.error('  This gate still runs in CI on ubuntu, macOS and Windows.\n')
    }
  }, { timeout: BOOT_MS })
  after(async () => { if (worker) await worker.dispose() })

  wit('builds and boots at all', async () => {
    // Reaching this assertion is most of the value: it means the bundle
    // resolved every import, workerd accepted the module's exports, and
    // the entry really is modules-format with a default handler.
    const res = await get('/health')
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.ok, true)
    assert.strictEqual(body.service, 'tabnas-mcp')
    // Served from the embedded PACKAGE, so this is also the proof that
    // the build-time version embed replaced the package.json file read.
    assert.strictEqual(body.version, require('../package.json').version)
  })

  wit('answers HEAD on the read-only endpoints', async () => {
    // Worth pinning in workerd too: whether a HEAD reaches the handler at
    // all is the runtime's business, not the handler's.
    for (const path of ['/health', '/.well-known/mcp']) {
      const res = await worker.fetch(url(path), { method: 'HEAD' })
      assert.strictEqual(res.status, 200, `HEAD ${path}`)
    }
  })

  wit('serves discovery with its limits', async () => {
    const body = await (await get('/.well-known/mcp')).json()
    assert.strictEqual(body.transport, 'streamable-http')
    assert.strictEqual(body.endpoint, '/mcp')
    assert.strictEqual(body.tools.length, 7)
    assert.ok(0 < body.limits.body_bytes)
    assert.match(body.privacy, /never logged/)
    // Reported straight from wrangler.json, so the advertised ceiling and
    // the enforced one cannot drift apart.
    assert.strictEqual(body.limits.requests_per_ip, LIMITER.limit)
    assert.strictEqual(body.limits.rate_period_seconds, LIMITER.period)
  })

  wit('initialize and tools/list answer', async () => {
    const init = await rpc('initialize', {})
    assert.strictEqual(init.result.serverInfo.name, 'tabnas')
    const list = await rpc('tools/list')
    assert.deepStrictEqual(
      list.result.tools.map((t) => t.name).sort(),
      ['compare_grammars', 'describe_plugin', 'explain_parse_error',
        'list_plugins', 'parse', 'test_grammar', 'validate_grammar'])
  })

  wit('every resource reads back byte-identical to the committed data/',
    async () => {
      // The whole point of the embedded bundle. Under Node this passed
      // by reading the same files off disk that it compared against;
      // here there is no disk, so it can only pass if the data really
      // did become part of the module graph.
      for (const r of RESOURCES) {
        const res = await rpc('resources/read', { uri: r.uri })
        const got = res.result.contents[0].text
        const want = Fs.readFileSync(Path.join(DATA_DIR, r.file), 'utf8')
        assert.strictEqual(got, want, `${r.uri} differs from data/${r.file}`)
      }
    })

  wit('hosted and local answer the same bytes for the same request',
    async () => {
      // The golden contract, extended across runtimes: same core, same
      // serializer, therefore the same string — not merely the same
      // meaning. If these ever differ, the "one implementation" claim in
      // the README is false.
      const args = { input: '{"a":1,"b":[2,3]}', grammar: GRAMMAR }
      const res = await rpc('tools/call', { name: 'parse', arguments: args })
      assert.strictEqual(res.result.content[0].text, callTool('parse', args))
    })

  wit('refuses a grammar carrying a ref (ADR-10), in the real runtime',
    async () => {
      // Pinned here and not only in Node: this is the assertion that a
      // hosted parser never becomes a hosted code executor, so it is
      // worth proving against the deployed transport.
      const res = await rpc('tools/call', {
        name: 'validate_grammar',
        arguments: { grammar: { rule: { r: { ref: 'evil' } } } },
      })
      const out = JSON.parse(res.result.content[0].text)
      assert.strictEqual(out.ok, false)
      assert.ok(out.errors.some((e) => /ref/.test(e.message)),
        'expected a ref refusal, got ' + JSON.stringify(out.errors))
    })

  wit('enforces the body cap with a structured diagnostic', async () => {
    const { MAX_BODY_BYTES } = require('../dist/budget')
    const res = await post('x'.repeat(MAX_BODY_BYTES + 1))
    assert.strictEqual(res.status, 413)
    const body = await res.json()
    assert.strictEqual(body.code, 'limit_exceeded')
    assert.strictEqual(body.ceiling, MAX_BODY_BYTES)
  })

  wit('refuses batched requests', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    assert.strictEqual(res.status, 400)
  })

  wit('the rate limiter is bound, and enforces at the configured ceiling',
    async () => {
      // The one assertion that cannot be made anywhere else: a fake
      // limiter in a Node test proves the branch, not that wrangler.json
      // actually binds one. If the `ratelimits` block is dropped, this is
      // what fails — before an unlimited public parser is deployed.
      const tick = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
      let refusedAt = -1
      for (let i = 1; i <= LIMITER.limit + 5; i++) {
        const res = await postAs(IP_BURST, tick)
        if (429 === res.status) {
          refusedAt = i
          const body = await res.json()
          assert.strictEqual(body.code, 'rate_limited')
          assert.strictEqual(body.ceiling, LIMITER.limit)
          break
        }
      }
      assert.notStrictEqual(refusedAt, -1,
        `no 429 within ${LIMITER.limit + 5} requests: the MCP_LIMIT ` +
        'binding is missing or not enforcing')
      // Exact here because miniflare's limiter is a deterministic local
      // counter. PRODUCTION IS NOT EXACT: Cloudflare counts per key PER
      // DATA CENTRE and approximately, so a live burst can pass well
      // beyond the ceiling before refusals begin (measured: ~125 of 150
      // concurrent requests served before the first 429). This assertion
      // is a configuration gate — the binding is attached and carries
      // these numbers — not a promise about edge behaviour.
      assert.strictEqual(refusedAt, LIMITER.limit + 1,
        'refused at the wrong request number — if this run reused a ' +
        'previous run\'s bucket the count starts part-used, which is why ' +
        'the address is derived per run')
    })

  wit('buckets per IP rather than globally', async () => {
    // A global counter would look identical until the first two clients
    // arrive, then take the service down for everyone at once.
    const res = await postAs(IP_OTHER,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.strictEqual(res.status, 200,
      'a second IP was refused: the limiter is keyed globally')
  })
})
