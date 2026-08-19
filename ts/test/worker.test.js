/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* The hosted MCP endpoint (Phase 4).
 *
 * Driven through the Worker's own `fetch` handler rather than through
 * wrangler: the handler takes a Request and returns a Response, so the
 * transport is testable without a runtime, a deploy, or credentials.
 *
 * The security assertions here are the point of the file. A hosted parser
 * that executes supplied code is not a worse version of this service, it is
 * a different and unacceptable one, so the `ref` refusal is pinned over HTTP
 * and not merely assumed from core's unit tests.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')

const worker = require('../dist/worker')
const { handle } = worker
// Limits and the telemetry sink come from budget.js, not the entry
// module: workerd refuses a non-function named export on a Worker
// entrypoint, so worker.ts must not export the constant.
const { MAX_BODY_BYTES, RATE_LIMIT, setTelemetrySink } =
  require('../dist/budget')

const GRAMMAR = require('./json-grammar.fixture.json')

const post = (body, headers) =>
  handle(new Request('https://mcp.tabnas.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

const rpc = (method, params, id = 1) => post({ jsonrpc: '2.0', id, method, params })

const get = (path) =>
  handle(new Request('https://mcp.tabnas.dev' + path, { method: 'GET' }))

describe('hosted worker: discovery', () => {
  it('answers /health', async () => {
    const res = await get('/health')
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.ok, true)
    assert.strictEqual(body.service, 'tabnas-mcp')
  })

  it('answers HEAD on the read-only endpoints, not 404', async () => {
    // Uptime monitors commonly probe with HEAD. Gating on GET alone sent
    // them to the 404 fall-through, so a healthy service read as down.
    for (const path of ['/health', '/.well-known/mcp']) {
      const res = await handle(new Request('https://mcp.tabnas.dev' + path,
        { method: 'HEAD' }))
      assert.strictEqual(res.status, 200, `HEAD ${path}`)
      // A HEAD response carries the headers of the GET and no body.
      assert.match(res.headers.get('content-type'), /application\/json/)
    }
  })

  it('/.well-known/mcp states the tools, the limits and the privacy rule', async () => {
    const body = await (await get('/.well-known/mcp')).json()
    assert.strictEqual(body.transport, 'streamable-http')
    assert.strictEqual(body.endpoint, '/mcp')
    assert.deepStrictEqual(body.tools.sort(), [
      'compare_grammars', 'describe_plugin', 'explain_parse_error',
      'list_plugins', 'parse', 'test_grammar', 'validate_grammar',
    ])
    assert.strictEqual(body.limits.body_bytes, MAX_BODY_BYTES)
    // compare_grammars is the most expensive tool hosted here, so its caps
    // are served alongside the body cap rather than found by hitting them.
    assert.ok(0 < body.limits.compare_corpus_rows)
    assert.ok(0 < body.limits.compare_generated_inputs)
    // The promise is load-bearing: it is what makes the local/hosted split
    // honest, so it is served, not just written on a web page.
    assert.match(body.privacy, /never logged/)
    assert.match(body.local, /npx/)
  })

  it('refuses anything but POST /mcp', async () => {
    assert.strictEqual((await get('/mcp')).status, 405)
    assert.strictEqual((await get('/nope')).status, 404)
  })
})

describe('hosted worker: protocol', () => {
  it('initializes and lists the seven tools', async () => {
    const init = await (await rpc('initialize')).json()
    assert.strictEqual(init.result.serverInfo.name, 'tabnas')

    const list = await (await rpc('tools/list')).json()
    assert.strictEqual(list.result.tools.length, 7)
  })

  it('serves the contract files as resources', async () => {
    const list = await (await rpc('resources/list')).json()
    assert.ok(list.result.resources.length >= 5)

    const uri = list.result.resources[0].uri
    const read = await (await rpc('resources/read', { uri })).json()
    assert.ok(read.result.contents[0].text.length > 0)

    const missing = await (await rpc('resources/read', { uri: 'nope://x' })).json()
    assert.strictEqual(missing.error.code, -32600)
  })

  it('calls a tool and returns the same bytes the local server would', async () => {
    const res = await rpc('tools/call', {
      name: 'parse',
      arguments: { input: '{"a":1}', grammar: GRAMMAR },
    })
    const body = await res.json()
    const result = JSON.parse(body.result.content[0].text)
    assert.strictEqual(result.ok, true)
    assert.deepStrictEqual(result.tree, { a: 1 })

    // Byte-identical to the shared core's own answer: hosted and local are
    // one implementation, and this is what says so.
    const local = require('../dist/mcp').callTool('parse', { input: '{"a":1}', grammar: GRAMMAR })
    assert.strictEqual(body.result.content[0].text, local)
  })

  it('rejects malformed JSON, non-JSON-RPC, unknown methods and batches', async () => {
    assert.strictEqual((await (await post('{nope')).json()).error.code, -32700)
    assert.strictEqual((await (await post({ hello: 1 })).json()).error.code, -32600)
    assert.strictEqual((await (await rpc('tools/nope')).json()).error.code, -32601)

    // A batch multiplies the CPU one body can buy, so it is refused outright
    // rather than partially served.
    const batch = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    assert.strictEqual(batch.status, 400)
    assert.match((await batch.json()).error.message, /batched/)
  })
})

describe('hosted worker: budget', () => {
  it('refuses an oversized body with a correctable diagnostic', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1)
    const res = await post(big)
    assert.strictEqual(res.status, 413)

    const body = await res.json()
    assert.strictEqual(body.code, 'limit_exceeded')
    assert.strictEqual(body.ceiling, MAX_BODY_BYTES)
    assert.ok(body.actual > MAX_BODY_BYTES)
    // An agent must be able to correct rather than guess, so the answer names
    // the limit and the way round it.
    assert.match(body.hint, /npx/)
  })

  it('refuses on a lying content-length before reading the body', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'content-length': String(MAX_BODY_BYTES + 1) })
    assert.strictEqual(res.status, 413)
    assert.strictEqual((await res.json()).code, 'limit_exceeded')
  })
})

describe('hosted worker: the ref firewall', () => {
  // THE security rule of Phase 4. A GrammarSpec may carry `ref` function
  // references; accepting one turns "validate this grammar" into "execute
  // supplied code". Pinned here over HTTP because that is the surface an
  // attacker actually reaches — core's own tests prove the rule, this proves
  // the transport does not route around it.
  const poison = {
    v: 2,
    ref: { '@evil': 'process.exit' },
    rule: { val: { open: [{ s: '#VAL', a: '@evil' }] } },
  }

  it('refuses a grammar carrying a non-builtin ref', async () => {
    for (const [name, args] of [
      ['validate_grammar', { grammar: poison }],
      ['parse', { input: '1', grammar: poison }],
    ]) {
      const body = await (await rpc('tools/call', { name, arguments: args })).json()
      const result = JSON.parse(body.result.content[0].text)
      assert.notStrictEqual(result.ok, true, `${name} accepted a ref grammar`)
    }
  })

  it('refuses a prototype-polluting grammar, and does not get polluted', async () => {
    const pollute = { v: 2, rule: { __proto__: { open: [] }, val: { open: [] } } }
    await rpc('tools/call', { name: 'validate_grammar', arguments: { grammar: pollute } })
    assert.strictEqual({}.polluted, undefined)
    assert.strictEqual(Object.prototype.polluted, undefined)
  })
})

describe('hosted worker: telemetry records shape, never content', () => {
  const seen = []
  before(() => setTelemetrySink((t) => seen.push(t)))
  after(() => setTelemetrySink(() => {}))

  it('emits a bucket and a status, and nothing from the document', async () => {
    seen.length = 0
    const src = '{"secret":"hunter2"}'
    await rpc('tools/call', { name: 'parse', arguments: { input: src, grammar: GRAMMAR } })

    assert.strictEqual(seen.length, 1)
    const t = seen[0]
    assert.strictEqual(t.tool, 'parse')
    assert.strictEqual(t.status, 'ok')
    assert.strictEqual(t.bytes_bucket, '<=1k')
    assert.strictEqual(typeof t.duration_ms, 'number')

    // The privacy promise, asserted rather than trusted: nothing in the
    // emitted record may carry the document, and the size is a bucket
    // rather than a length (an exact byte count is a weak fingerprint).
    const serialized = JSON.stringify(t)
    assert.ok(!serialized.includes('hunter2'), 'telemetry leaked document content')
    assert.ok(!serialized.includes('secret'), 'telemetry leaked a document key')
    assert.ok(!/"bytes":\s*\d+/.test(serialized), 'telemetry recorded an exact size')
  })

  it('records the error code when a tool answers no', async () => {
    seen.length = 0
    await rpc('tools/call', { name: 'parse', arguments: { input: '{"a":}', grammar: GRAMMAR } })
    assert.strictEqual(seen[0].status, 'error')
    assert.strictEqual(seen[0].code, 'unexpected')
  })
})

describe('hosted worker: rate limiting', () => {
  // The binding itself is the platform's, and workerd.test.js proves it is
  // bound and enforcing. What belongs here is the branch: given a limiter
  // that says no, does the endpoint refuse correctly and correctably?
  const refusing = { MCP_LIMIT: { limit: async () => ({ success: false }) } }
  const allowing = { MCP_LIMIT: { limit: async () => ({ success: true }) } }

  const call = (env, path = '/mcp') => handle(new Request(
    'https://mcp.tabnas.dev' + path,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
    env)

  it('refuses with 429 and a structured, correctable body', async () => {
    const res = await call(refusing)
    assert.strictEqual(res.status, 429)
    const body = await res.json()
    assert.strictEqual(body.code, 'rate_limited')
    assert.strictEqual(body.ceiling, RATE_LIMIT.limit)
    assert.strictEqual(body.period_seconds, RATE_LIMIT.period)
    // The refusal has to name the way out, or an agent can only retry.
    assert.match(body.hint, /npx --yes @tabnas\/mcp mcp/)
  })

  it('passes the request through when the limiter allows it', async () => {
    const res = await call(allowing)
    assert.strictEqual(res.status, 200)
  })

  it('bills a request that would have been rejected for size', async () => {
    // Order matters: if the size cap ran first, an attacker would get
    // unlimited free 413s and the cap would become the cheap way in.
    const res = await handle(new Request('https://mcp.tabnas.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        'content-length': String(MAX_BODY_BYTES + 1) },
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    }), refusing)
    assert.strictEqual(res.status, 429, 'size cap ran before the rate limit')
  })

  it('does not rate limit health or discovery', async () => {
    for (const path of ['/health', '/.well-known/mcp']) {
      const res = await handle(
        new Request('https://mcp.tabnas.dev' + path), refusing)
      assert.strictEqual(res.status, 200, path + ' was rate limited')
    }
  })

  it('serves unlimited when no binding is present', async () => {
    // A missing binding must not take the endpoint down; workerd.test.js
    // is what proves the binding is really there in the deployed config.
    const res = await call(undefined)
    assert.strictEqual(res.status, 200)
  })
})
