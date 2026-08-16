/* Copyright (c) 2026 tabnas, MIT License */

// The hosted MCP endpoint (plan Phase 4): mcp.tabnas.dev.
//
// Deliberately THIN. Transport, request validation, budget enforcement and
// shape-only telemetry live here; every parsing decision is the shared core
// that the stdio server and the CLI already use. Hosted and local therefore
// cannot diverge in what they answer — the golden tests cover both because
// there is only one implementation to cover.
//
// A separate Worker from the website's, on purpose: `web` is
// `output: "static"`, and converting it to host tools would couple docs
// deploys to service deploys and put an untrusted-input execution path
// inside the marketing site.
//
// WHAT THIS SERVICE DOES NOT HAVE, and must never grow: shell, filesystem,
// outbound network, and `ref`-resolved functions in a grammar. The last is
// the load-bearing one — a GrammarSpec may carry `ref` function references,
// and accepting one turns "validate this grammar" into "execute supplied
// code". The core's request firewall rejects them, and this file must not
// route around it.
//
// PRIVACY, non-negotiable: document content is never logged, never stored,
// never used for training. `telemetry()` below records shape only — tool
// name, size bucket, duration, status, error code. If that is not enough
// for you, run `npx @tabnas/mcp` locally; that is the recommended path
// regardless, and it is free, private and reproducible.

import { callTool, TOOLS, RESOURCES } from './mcp'

import { MAX_CORPUS, MAX_GENERATED } from './compat'
import { packageInfo, rawData } from './data'

// --- budget -----------------------------------------------------------------

// Parsing attacker-controlled text on shared infrastructure means limits are
// correctness, not tuning. The two that the engine itself enforces
// (MAX_GRAMMAR_RULES, MAX_TEST_ROWS) live in core; these are the transport's.
export const MAX_BODY_BYTES = 256 * 1024

// A limit breach answers with a documented, structured diagnostic rather than
// a bare 413: an agent has to be able to correct rather than guess, which
// means it needs the ceiling and which limit it hit.
function limitExceeded(limit: string, ceiling: number, actual: number) {
  return {
    status: 'failure' as const,
    code: 'limit_exceeded',
    limit,
    ceiling,
    actual,
    message: `request exceeds the ${limit} limit of ${ceiling}`,
    hint:
      `The hosted endpoint bounds ${limit} at ${ceiling}. Run the same tool ` +
      'locally with `npx --yes @tabnas/mcp mcp` for unbounded input — it is ' +
      'the same code with the same answers.',
  }
}

// --- telemetry --------------------------------------------------------------

export type Telemetry = {
  tool: string
  bytes_bucket: string
  duration_ms: number
  status: 'ok' | 'error'
  code?: string
}

// Size as a BUCKET, never a length: an exact byte count of a document is a
// weak fingerprint of the document, and this service promises not to hold
// facts about content.
function bucket(bytes: number): string {
  if (bytes <= 1024) return '<=1k'
  if (bytes <= 16 * 1024) return '<=16k'
  if (bytes <= 64 * 1024) return '<=64k'
  return '<=256k'
}

// Overridable so tests can observe what would be emitted, and so a deploy can
// wire a sink without this file knowing about one.
export let emit: (t: Telemetry) => void = () => {}
export function setTelemetrySink(sink: (t: Telemetry) => void): void {
  emit = sink
}

// --- JSON-RPC ---------------------------------------------------------------

type RpcId = string | number | null

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601

// The MCP methods this endpoint answers. Stateless by design: every call is
// self-contained, so there are no sessions, no Durable Objects and no store —
// which is what makes the service cheap, horizontally trivial, and honest
// about privacy. `initialize` is answered so a client can negotiate, but
// nothing is remembered afterwards.
function handleRpc(msg: any): { body: unknown; telemetry?: Partial<Telemetry> } {
  const id: RpcId = msg?.id ?? null

  if (msg?.jsonrpc !== '2.0' || typeof msg?.method !== 'string') {
    return { body: rpcError(id, INVALID_REQUEST, 'not a JSON-RPC 2.0 request') }
  }

  switch (msg.method) {
    case 'initialize':
      return {
        body: rpcResult(id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'tabnas', version: packageInfo().version },
        }),
      }

    case 'tools/list':
      return { body: rpcResult(id, { tools: TOOLS }) }

    case 'resources/list':
      return {
        body: rpcResult(id, {
          resources: RESOURCES.map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          })),
        }),
      }

    case 'resources/read': {
      const uri = msg.params?.uri
      const hit = RESOURCES.find((r) => r.uri === uri)
      if (!hit) {
        return { body: rpcError(id, INVALID_REQUEST, `unknown resource: ${uri}`) }
      }
      return {
        body: rpcResult(id, {
          contents: [{ uri: hit.uri, mimeType: hit.mimeType, text: rawData(hit.file) }],
        }),
      }
    }

    case 'tools/call': {
      const name = msg.params?.name
      if (typeof name !== 'string') {
        return { body: rpcError(id, INVALID_REQUEST, 'tools/call requires params.name') }
      }
      try {
        const text = callTool(name, msg.params?.arguments)
        // A tool that answers "no" is a successful call with a failure
        // result — the same distinction the CLI draws with exit code 1 —
        // so the code is read back out for telemetry rather than inferred.
        let code: string | undefined
        try {
          const parsed = JSON.parse(text)
          code = parsed?.error?.code ?? parsed?.diagnostic?.code
        } catch {
          /* the result is not always an object; telemetry can live without it */
        }
        return {
          body: rpcResult(id, { content: [{ type: 'text', text }] }),
          telemetry: { tool: name, status: code ? 'error' : 'ok', code },
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          body: rpcError(id, METHOD_NOT_FOUND, message),
          telemetry: { tool: String(name), status: 'error', code: 'unknown_tool' },
        }
      }
    }

    default:
      return { body: rpcError(id, METHOD_NOT_FOUND, `unknown method: ${msg.method}`) }
  }
}

// --- HTTP -------------------------------------------------------------------

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // The tool surface is public and identical for every caller, so a browser
  // client is a legitimate consumer.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, mcp-protocol-version',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) + '\n', { status, headers: JSON_HEADERS })
}

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: JSON_HEADERS })
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 'tabnas-mcp', version: packageInfo().version })
  }

  // Discovery: what this endpoint is, and what it will not do. Stating the
  // limits here means a client can see the ceilings before it hits one.
  if (request.method === 'GET' && url.pathname === '/.well-known/mcp') {
    return json({
      name: 'tabnas',
      version: packageInfo().version,
      transport: 'streamable-http',
      endpoint: '/mcp',
      tools: TOOLS.map((t) => t.name),
      resources: RESOURCES.map((r) => r.uri),
      // Every bound the caller can hit, stated up front. compare_grammars
      // is the most expensive tool here — it parses each corpus row and each
      // generated derivation twice, once per grammar — so its caps belong
      // beside the body cap rather than being discovered by hitting them.
      limits: {
        body_bytes: MAX_BODY_BYTES,
        compare_corpus_rows: MAX_CORPUS,
        compare_generated_inputs: MAX_GENERATED,
      },
      privacy: 'Document content is never logged, stored, or used for training.',
      local: 'npx --yes @tabnas/mcp mcp',
    })
  }

  if (url.pathname !== '/mcp') {
    return json({ error: 'not found' }, 404)
  }
  if (request.method !== 'POST') {
    return json({ error: 'POST required' }, 405)
  }

  // Cap by declared length first — cheapest possible rejection — then by what
  // actually arrived, because Content-Length is a claim, not a measurement.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return json(limitExceeded('request body bytes', MAX_BODY_BYTES, declared), 413)
  }

  const raw = await request.text()
  const bytes = new TextEncoder().encode(raw).length
  if (bytes > MAX_BODY_BYTES) {
    return json(limitExceeded('request body bytes', MAX_BODY_BYTES, bytes), 413)
  }

  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return json(rpcError(null, PARSE_ERROR, 'request body is not valid JSON'), 400)
  }

  // A batch is a legitimate JSON-RPC request, but it multiplies the CPU a
  // single body can buy. Refused rather than silently partially served.
  if (Array.isArray(msg)) {
    return json(rpcError(null, INVALID_REQUEST, 'batched requests are not supported'), 400)
  }

  const started = Date.now()
  const { body, telemetry } = handleRpc(msg)
  emit({
    tool: telemetry?.tool ?? String((msg as any)?.method ?? 'unknown'),
    bytes_bucket: bucket(bytes),
    duration_ms: Date.now() - started,
    status: telemetry?.status ?? 'ok',
    ...(telemetry?.code ? { code: telemetry.code } : {}),
  })

  return json(body)
}

export default { fetch: handle }
