/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* mcp.test.js — the MCP surface itself.
 *
 * Two layers:
 *
 * - In-process (linked in-memory transport): tool list and schemas,
 *   resource list and reads (byte-identical to the committed data/),
 *   unknown-name handling.
 *
 * - A stdio SMOKE test: spawn the real dist/mcp.js as a child process,
 *   perform an MCP initialize + tools/list over stdio, and assert the six
 *   tools. Timeout-guarded at both the test and the request level, so a
 *   wedged server fails rather than hangs.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const Fs = require('node:fs')
const Path = require('node:path')

const { buildServer, TOOLS, RESOURCES } = require('../dist/mcp.js')
const { parse, stringifyResult } = require('../dist/core.js')
const { packageInfo } = require('../dist/data.js')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const DATA_DIR = Path.join(__dirname, '..', '..', 'data')
const MCP_MAIN = Path.join(__dirname, '..', 'dist', 'mcp.js')
const CLI_MAIN = Path.join(__dirname, '..', 'dist', 'cli.js')

const TOOL_NAMES = [
  'parse',
  'validate_grammar',
  'explain_parse_error',
  'test_grammar',
  'list_plugins',
  'describe_plugin',
  'compare_grammars',
]

const RESOURCE_FILES = {
  'tabnas://schema/grammar': 'grammar.schema.json',
  'tabnas://schema/diagnostic': 'diagnostic.schema.json',
  'tabnas://errors': 'error-codes.json',
  'tabnas://plugins': 'plugins.json',
  'tabnas://divergence': 'DIVERGENCE.md',
}


describe('mcp server (in-process)', () => {
  let client = null

  before(async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'mcp-test', version: '0.0.0' })
    await Promise.all([buildServer().connect(st), client.connect(ct)])
  })

  after(async () => {
    if (client) {
      await client.close()
    }
  })

  it('serves exactly the seven tools, with object input schemas', async () => {
    const { tools } = await client.listTools()
    assert.deepStrictEqual(tools.map((t) => t.name), TOOL_NAMES)
    for (const tool of tools) {
      assert.strictEqual(tool.inputSchema.type, 'object', tool.name)
      assert.ok(tool.description, tool.name + ' needs a description')
    }
    // The exported definition list is the same seven, same order.
    assert.deepStrictEqual(TOOLS.map((t) => t.name), TOOL_NAMES)
  })

  it('serves the five resources, byte-identical to data/', async () => {
    const { resources } = await client.listResources()
    assert.deepStrictEqual(
      resources.map((r) => r.uri), Object.keys(RESOURCE_FILES))
    assert.deepStrictEqual(
      RESOURCES.map((r) => r.uri), Object.keys(RESOURCE_FILES))

    for (const [uri, file] of Object.entries(RESOURCE_FILES)) {
      const res = await client.readResource({ uri })
      assert.strictEqual(res.contents.length, 1)
      assert.strictEqual(res.contents[0].uri, uri)
      assert.strictEqual(res.contents[0].text,
        Fs.readFileSync(Path.join(DATA_DIR, file), 'utf8'),
        uri + ' must serve the committed file verbatim')
    }
  })

  it('a tool result is a single text content of core JSON', async () => {
    const res = await client.callTool(
      { name: 'validate_grammar', arguments: { grammar: { rule: {} } } })
    assert.deepStrictEqual(res.content,
      [{ type: 'text', text: '{"ok":true,"v":1}' }])
  })

  it('an unknown tool name is an isError result', async () => {
    const res = await client.callTool(
      { name: 'no_such_tool', arguments: {} })
    assert.strictEqual(res.isError, true)
  })

  it('an unknown resource read fails', async () => {
    await assert.rejects(
      client.readResource({ uri: 'tabnas://nope' }),
      /unknown resource/)
  })

  it('a non-diagnostic engine throw surfaces the clean errors shape', async () => {
    // options.parser.start set to a non-function makes the engine throw a
    // raw TypeError; the MCP tool must return the same {ok:false} bytes
    // core produces, never an isError/stack — the front-ends agree.
    const args = { input: '1', options: { parser: { start: 'x' } } }
    const res = await client.callTool({ name: 'parse', arguments: args })
    assert.notStrictEqual(res.isError, true)
    assert.strictEqual(res.content[0].text, stringifyResult(parse(args)))
    const parsed = JSON.parse(res.content[0].text)
    assert.strictEqual(parsed.ok, false)
    assert.strictEqual(parsed.errors[0].path, '')
  })
})


describe('mcp server (stdio smoke)', () => {
  it('initialize + tools/list over real stdio', { timeout: 30000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_MAIN],
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-smoke', version: '0.0.0' })

    try {
      await client.connect(transport)

      const version = client.getServerVersion()
      assert.strictEqual(version.name, 'tabnas')
      assert.strictEqual(version.version, packageInfo().version)

      const { tools } = await client.listTools(undefined,
        { timeout: 10000 })
      assert.deepStrictEqual(tools.map((t) => t.name), TOOL_NAMES)

      const res = await client.callTool(
        { name: 'list_plugins', arguments: {} }, undefined,
        { timeout: 10000 })
      const parsed = JSON.parse(res.content[0].text)
      assert.ok(Array.isArray(parsed.plugins) && 0 < parsed.plugins.length)
    } finally {
      await client.close()
    }
  })

  it('the `tabnas mcp` CLI subcommand serves the same server over stdio',
    { timeout: 30000 }, async () => {
      // The skills package's mcp.json runs `npx --yes @tabnas/mcp mcp`, so
      // the CLI's `mcp` subcommand must start the identical stdio server —
      // and it must put NOTHING on stdout except JSON-RPC (a banner there
      // would corrupt the protocol).
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_MAIN, 'mcp'],
        stderr: 'pipe',
      })
      const client = new Client({ name: 'cli-mcp-smoke', version: '0.0.0' })

      try {
        await client.connect(transport)

        const version = client.getServerVersion()
        assert.strictEqual(version.name, 'tabnas')
        assert.strictEqual(version.version, packageInfo().version)

        const { tools } = await client.listTools(undefined, { timeout: 10000 })
        assert.deepStrictEqual(tools.map((t) => t.name), TOOL_NAMES)
      } finally {
        await client.close()
      }
    })
})
