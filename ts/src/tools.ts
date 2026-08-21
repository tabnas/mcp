/* Copyright (c) 2026 tabnas, MIT License */

/* tools.ts
 * The tool and resource SURFACE: what the seven tools are called, what
 * they accept, what the five resources are, and how a call reaches core.
 *
 * Split out of mcp.ts so it carries NO transport. mcp.ts adds stdio and
 * the MCP SDK; worker.ts adds HTTP; both get the surface from here, so
 * the two front-ends cannot drift in what they expose — and neither
 * front-end drags in the other's transport. That last part is load
 * bearing for the Worker: importing mcp.ts would pull the SDK's stdio
 * server (and its `node:process` use) plus a `require.main === module`
 * bootstrap into a bundle that has no stdin to serve and no main module
 * to be.
 *
 * Nothing here decides anything: every operation is core.ts, reached
 * through `callTool`, which returns the one serialization both
 * front-ends emit verbatim.
 */

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

import { compareGrammars } from './compat'


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
      'validation against the bundled grammar schema, an engine ' +
      'load in a fresh instance, and a check that every rule reference ' +
      '(`p`, `r`) names a rule the grammar actually defines — a ' +
      'dangling reference loads cleanly and then fails at parse time ' +
      'with `unknown_rule`. Returns {ok:true, v} (v = declared ' +
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
  {
    name: 'compare_grammars',
    description: 'Grammar compatibility (AX plan Phase 5): does candidate ' +
      'grammar B still accept what baseline A accepted, and does it build ' +
      'the same tree for inputs both accept? Returns EVIDENCE AND ' +
      'CONFIDENCE, never a bare verdict: {normalForm, proven[], ' +
      'observed[], changes[], counterexamples[], confidence, why}. ' +
      "confidence:'low' with a stated reason is a successful run, not a " +
      'failure — language inclusion is undecidable in general, so anything ' +
      'outside the decidable subset is reported not-proven rather than ' +
      'incompatible. Supply `corpus` (real inputs) for the tier that ' +
      'measures what your documents actually do.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          description: 'Baseline grammar: the serialized GrammarSpec ' +
            'already deployed.',
        },
        b: {
          type: 'object',
          description: 'Candidate grammar: the serialized GrammarSpec ' +
            'proposed to replace it.',
        },
        corpus: {
          type: 'array',
          items: { type: 'string' },
          description: 'Inputs to replay through both grammars, comparing ' +
            'acceptance and tree shape.',
        },
        options: {
          type: 'object',
          description: 'TabnasOptions applied to both instances.',
        },
        depth: {
          type: 'integer',
          minimum: 0,
          maximum: 5,
          description: 'Derivation depth for generated inputs (default 3).',
        },
      },
      required: ['a', 'b'],
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
    case 'compare_grammars':
      return stringifyResult(compareGrammars(req))
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
