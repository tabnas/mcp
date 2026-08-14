/* Copyright (c) 2026 tabnas, MIT License */

/* mcp.ts
 * The MCP server front-end: six tools and five resources over stdio.
 *
 * All operation logic lives in core.ts; every tool handler is
 * request-in, `stringifyResult(coreResult)`-out as text content, so a
 * tool result is byte-identical to the CLI's --json output for the same
 * request (test/golden.test.js holds the two to that).
 *
 * This file is also the package's main module, so importing it must not
 * touch stdio: the transport starts only when the file is run directly
 * (`node dist/mcp.js`, or an MCP client config pointing at it).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import {
  parse,
  validateGrammar,
  explainParseError,
  testGrammar,
  listPlugins,
  describePlugin,
  stringifyResult,
  MAX_TEST_ROWS,
} from './core'

import { packageInfo, rawData } from './data'


// The serialized-GrammarSpec argument, shared by four tools. The full
// JSON Schema is large and self-referential, so tools carry a summary and
// point at the tabnas://schema/grammar resource for the real thing —
// which is also exactly what validate_grammar checks against.
const GRAMMAR_ARG = {
  type: 'object',
  description: 'Serialized GrammarSpec (pure JSON, no functions). ' +
    'Schema: resource tabnas://schema/grammar. Grammars are validated ' +
    'before use; a `ref` key or a non-builtin function reference is ' +
    'rejected.',
} as const

// Tool definitions: names, descriptions and JSON Schema inputs matching
// the core contracts. Exported so tests can pin the six names.
export const TOOLS = [
  {
    name: 'parse',
    description: 'Parse input with the tabnas engine. Returns ' +
      '{ok:true, tree} or, on parse failure, {ok:false, diagnostic} — ' +
      'the structured diagnostic described by resource ' +
      'tabnas://schema/diagnostic. An invalid grammar is rejected as ' +
      '{ok:false, errors:[{path,message}]}. Without a grammar the bare ' +
      'engine is used, which defines no rules and produces an undefined ' +
      'tree for every input.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Source text to parse.',
        },
        grammar: GRAMMAR_ARG,
        options: {
          type: 'object',
          description: 'TabnasOptions applied to the fresh instance ' +
            'before the grammar. Data only: a plugins entry is rejected.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_grammar',
    description: 'Validate a serialized GrammarSpec. Structural ' +
      'validation against the bundled grammar schema plus an engine ' +
      'load in a fresh instance. Returns {ok:true, v} (v = declared ' +
      'builtin config-schema version, absent means 1) or {ok:false, ' +
      'errors:[{path,message}]}. Security: a grammar carrying a `ref` ' +
      'key, or any function reference that is not a $-suffixed engine ' +
      'builtin, is rejected — validating a grammar never runs supplied ' +
      'code.',
    inputSchema: {
      type: 'object',
      properties: {
        grammar: GRAMMAR_ARG,
      },
      required: ['grammar'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_parse_error',
    description: 'Parse input and explain the failure. Returns ' +
      '{failed:false} when the input parses; otherwise {failed:true, ' +
      'diagnostic, registry} where registry is the error-code registry ' +
      'entry {code,message,hint} for the diagnostic code (resource ' +
      'tabnas://errors), or null for a code the bundled registry does ' +
      'not know (e.g. a plugin-declared code).',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Source text to parse.',
        },
        grammar: GRAMMAR_ARG,
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  {
    name: 'test_grammar',
    description: 'Run TSV fixture content against a grammar in a fresh ' +
      'instance, using the fleet fixture convention (@tabnas/support): ' +
      'line 1 is a header, the input column is escape-decoded, the ' +
      'expected column is JSON or ERROR / ERROR:<code>. Returns ' +
      '{pass, fail, rows:[{row,input,expected,got,ok}]}. Refuses more ' +
      'than ' + MAX_TEST_ROWS + ' rows.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'TSV fixture content (not a path).',
        },
        grammar: GRAMMAR_ARG,
        options: {
          type: 'object',
          properties: {
            inputCol: {
              type: ['integer', 'string'],
              description: 'Input column, by position or header name. ' +
                'Default 0.',
            },
            expectedCol: {
              type: ['integer', 'string'],
              description: 'Expected column, by position or header ' +
                'name. Default 1.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['spec'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_plugins',
    description: 'List every bundled tabnas plugin descriptor ' +
      '(tabnas.plugin.json of each fleet repo), sorted by name. ' +
      'Returns {plugins:[...]}.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'describe_plugin',
    description: 'The full descriptor for one plugin, by package name ' +
      "('@tabnas/csv') or bare fleet name ('csv'). Unknown names get " +
      '{ok:false, errors} naming the known plugins.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Plugin name.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
] as const

// Resource definitions: the bundled data/ files, served verbatim.
export const RESOURCES = [
  {
    uri: 'tabnas://schema/grammar',
    name: 'grammar.schema.json',
    description: 'JSON Schema (draft 2020-12) for the serialized ' +
      'GrammarSpec — the pure-JSON grammar form the parse, ' +
      'validate_grammar, explain_parse_error and test_grammar tools ' +
      'accept.',
    mimeType: 'application/json',
    file: 'grammar.schema.json',
  },
  {
    uri: 'tabnas://schema/diagnostic',
    name: 'diagnostic.schema.json',
    description: 'JSON Schema (draft 2020-12) for the structured ' +
      'diagnostic a failed parse emits.',
    mimeType: 'application/json',
    file: 'diagnostic.schema.json',
  },
  {
    uri: 'tabnas://errors',
    name: 'error-codes.json',
    description: "The engine's error-code registry: message and hint " +
      'templates per code. Only the code is contractual across runtimes.',
    mimeType: 'application/json',
    file: 'error-codes.json',
  },
  {
    uri: 'tabnas://plugins',
    name: 'plugins.json',
    description: 'Every fleet plugin descriptor (tabnas.plugin.json), ' +
      'sorted by name.',
    mimeType: 'application/json',
    file: 'plugins.json',
  },
  {
    uri: 'tabnas://divergence',
    name: 'DIVERGENCE.md',
    description: "The engine's TypeScript/Go divergence record: where " +
      'the two runtimes produce a different result for the same input.',
    mimeType: 'text/markdown',
    file: 'DIVERGENCE.md',
  },
] as const


// Dispatch one tool call to core. Exported for tests that want the
// handler without a transport; throws on an unknown tool name.
export function callTool(name: string, args: unknown): string {
  const req = (args ?? {}) as never
  switch (name) {
    case 'parse':
      return stringifyResult(parse(req))
    case 'validate_grammar':
      return stringifyResult(validateGrammar(req))
    case 'explain_parse_error':
      return stringifyResult(explainParseError(req))
    case 'test_grammar':
      return stringifyResult(testGrammar(req))
    case 'list_plugins':
      return stringifyResult(listPlugins())
    case 'describe_plugin':
      return stringifyResult(describePlugin(req))
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}


// Build the MCP server (name "tabnas", version from package.json) with
// the six tools and five resources wired to core and data.
export function buildServer(): Server {
  const server = new Server(
    { name: 'tabnas', version: packageInfo().version },
    { capabilities: { tools: {}, resources: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const text = callTool(
        request.params.name, request.params.arguments)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: 'error: ' + (err instanceof Error ? err.message : String(err)),
        }],
        isError: true,
      }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const hit = RESOURCES.find((r) => r.uri === request.params.uri)
    if (undefined === hit) {
      throw new Error(`unknown resource: ${request.params.uri}`)
    }
    return {
      contents: [{
        uri: hit.uri,
        mimeType: hit.mimeType,
        text: rawData(hit.file),
      }],
    }
  })

  return server
}


// Serve MCP over stdio until the client disconnects.
export async function main(): Promise<void> {
  const server = buildServer()
  await server.connect(new StdioServerTransport())
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
