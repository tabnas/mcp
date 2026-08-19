/* Copyright (c) 2026 tabnas, MIT License */

/* mcp.ts
 * The MCP server front-end: the tool and resource surface from tools.ts,
 * served over stdio.
 *
 * This file is TRANSPORT ONLY. The surface itself (TOOLS, RESOURCES,
 * callTool) lives in tools.ts and is re-exported here, so the hosted
 * Worker can take the same surface without taking the stdio server with
 * it. All operation logic lives in core.ts; every tool handler is
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

import { TOOLS, RESOURCES, callTool } from './tools'

import { packageInfo, rawData } from './data'

// The surface is re-exported so `@tabnas/mcp` keeps one public entry: a
// consumer (or a test) that wants the tool list should not have to know
// it was split out for the Worker's benefit.
export { TOOLS, RESOURCES, callTool } from './tools'


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
