/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* golden.test.js — the CLI and the MCP tools return BYTE-IDENTICAL JSON.
 *
 * One core, two front-ends, zero disagreement: for each of the six
 * operations, run the CLI (a real child process, --json) and the MCP tool
 * (in-process over the SDK's linked in-memory transport) on the identical
 * request and compare the bytes. This is the contract that makes the two
 * surfaces interchangeable for an agent — anything that breaks it is a
 * defect regardless of which side changed.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')

const { buildServer } = require('../dist/mcp.js')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')

const CLI = Path.join(__dirname, '..', 'dist', 'cli.js')

const GRAMMAR_FILE = Path.join(__dirname, 'json-grammar.fixture.json')
const GRAMMAR = JSON.parse(Fs.readFileSync(GRAMMAR_FILE, 'utf8'))

const BAD_GRAMMAR = { ref: {}, rule: { top: { open: [{ s: '#NR', a: '@evil' }] } } }

// A prototype-pollution poison grammar, parsed from JSON so `__proto__`
// is a real own key (as it would be off the wire or from a file). Both
// front-ends must reject it identically.
const POISON_GRAMMAR = JSON.parse(
  '{"rule":{},"options":{"__proto__":{"pwned":true}}}')

// A grammar smuggling a plugin (live code) through its options.
const PLUGINS_GRAMMAR = { options: { plugins: [] }, rule: {} }

const TSV = 'input\texpected\n' +
  '{"a":1}\t{"a":1}\n' +
  'nope\tERROR:unexpected\n' +
  '{"a":2}\t{"a":3}\n'

function runCli(args, stdin) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin ?? '',
    encoding: 'utf8',
  })
  assert.strictEqual(res.error, undefined)
  return res
}

describe('golden parity: CLI --json === MCP tool result', () => {
  let client = null
  let tmp = null

  before(async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'golden-test', version: '0.0.0' })
    await Promise.all([buildServer().connect(st), client.connect(ct)])

    tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'tabnas-mcp-golden-'))
    Fs.writeFileSync(Path.join(tmp, 'bad-grammar.json'),
      JSON.stringify(BAD_GRAMMAR))
    Fs.writeFileSync(Path.join(tmp, 'poison-grammar.json'),
      JSON.stringify(POISON_GRAMMAR))
    Fs.writeFileSync(Path.join(tmp, 'plugins-grammar.json'),
      JSON.stringify(PLUGINS_GRAMMAR))
    Fs.writeFileSync(Path.join(tmp, 'cases.tsv'), TSV)
  })

  after(async () => {
    if (client) {
      await client.close()
    }
    if (tmp) {
      Fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  async function mcpText(name, args) {
    const res = await client.callTool({ name, arguments: args })
    assert.notStrictEqual(res.isError, true,
      `tool ${name} errored: ${JSON.stringify(res.content)}`)
    assert.strictEqual(res.content.length, 1)
    assert.strictEqual(res.content[0].type, 'text')
    return res.content[0].text
  }

  // Each case: the MCP request, and the CLI invocation that expresses the
  // SAME request. The CLI prints the JSON plus one newline.
  const CASES = [
    {
      name: 'parse (success)',
      tool: 'parse',
      args: { input: '{"a":1}', grammar: GRAMMAR },
      cli: ['parse', '-', '--grammar', GRAMMAR_FILE, '--json'],
      stdin: '{"a":1}',
    },
    {
      name: 'parse (failure diagnostic)',
      tool: 'parse',
      args: { input: '{"a":', grammar: GRAMMAR },
      cli: ['parse', '-', '--grammar', GRAMMAR_FILE, '--json'],
      stdin: '{"a":',
    },
    {
      name: 'parse (no grammar: bare engine)',
      tool: 'parse',
      args: { input: 'a:1' },
      cli: ['parse', '-', '--json'],
      stdin: 'a:1',
    },
    {
      name: 'validate_grammar (valid)',
      tool: 'validate_grammar',
      args: { grammar: GRAMMAR },
      cli: ['validate', '--grammar', GRAMMAR_FILE, '--json'],
    },
    {
      name: 'validate_grammar (invalid: ref + non-builtin FuncRef)',
      tool: 'validate_grammar',
      args: { grammar: BAD_GRAMMAR },
      cli: () => ['validate', '--grammar',
        Path.join(tmp, 'bad-grammar.json'), '--json'],
    },
    {
      name: 'validate_grammar (poison: prototype pollution rejected)',
      tool: 'validate_grammar',
      args: { grammar: POISON_GRAMMAR },
      cli: () => ['validate', '--grammar',
        Path.join(tmp, 'poison-grammar.json'), '--json'],
    },
    {
      name: 'validate_grammar (plugins in grammar.options rejected)',
      tool: 'validate_grammar',
      args: { grammar: PLUGINS_GRAMMAR },
      cli: () => ['validate', '--grammar',
        Path.join(tmp, 'plugins-grammar.json'), '--json'],
    },
    {
      name: 'parse (poison grammar rejected identically)',
      tool: 'parse',
      args: { input: '1', grammar: POISON_GRAMMAR },
      cli: () => ['parse', '-', '--grammar',
        Path.join(tmp, 'poison-grammar.json'), '--json'],
      stdin: '1',
    },
    {
      name: 'explain_parse_error (failure)',
      tool: 'explain_parse_error',
      args: { input: '{"a":', grammar: GRAMMAR },
      cli: ['diagnose', '-', '--grammar', GRAMMAR_FILE, '--json'],
      stdin: '{"a":',
    },
    {
      name: 'explain_parse_error (clean parse)',
      tool: 'explain_parse_error',
      args: { input: '[1]', grammar: GRAMMAR },
      cli: ['diagnose', '-', '--grammar', GRAMMAR_FILE, '--json'],
      stdin: '[1]',
    },
    {
      name: 'test_grammar',
      tool: 'test_grammar',
      args: { spec: TSV, grammar: GRAMMAR },
      cli: () => ['test', '--spec', Path.join(tmp, 'cases.tsv'),
        '--grammar', GRAMMAR_FILE, '--json'],
    },
    {
      name: 'list_plugins',
      tool: 'list_plugins',
      args: {},
      cli: ['plugins', '--json'],
    },
    {
      name: 'describe_plugin',
      tool: 'describe_plugin',
      args: { name: '@tabnas/csv' },
      cli: ['plugins', '@tabnas/csv', '--json'],
    },
    {
      name: 'describe_plugin (not found)',
      tool: 'describe_plugin',
      args: { name: 'nope' },
      cli: ['plugins', 'nope', '--json'],
    },
  ]

  for (const c of CASES) {
    it(c.name, async () => {
      const text = await mcpText(c.tool, c.args)
      const argv = 'function' === typeof c.cli ? c.cli() : c.cli
      const res = runCli(argv, c.stdin)
      assert.strictEqual(res.stdout, text + '\n',
        `CLI stdout and MCP tool text differ for ${c.name}` +
        (res.stderr ? `\nstderr: ${res.stderr}` : ''))
    })
  }
})
