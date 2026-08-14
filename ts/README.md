# @tabnas/mcp

The tabnas agent tooling: an [MCP](https://modelcontextprotocol.io)
server (stdio) and the unified `tabnas` CLI, two thin front-ends over
one core so they cannot disagree — for the same request, the CLI's
`--json` output and the MCP tool result are byte-identical.

Six tools only: `parse`, `validate_grammar`, `explain_parse_error`,
`test_grammar`, `list_plugins`, `describe_plugin`. Five resources:
the serialized-grammar schema, the diagnostic schema, the error-code
registry, the plugin descriptors, and the engine's divergence record —
all bundled, generated copies of the fleet's contract files.

## Install

```bash
npm install -g @tabnas/mcp     # the `tabnas` CLI
npx --yes @tabnas/mcp          # run the MCP server (stdio)
```

## CLI

```
tabnas parse    [file|-] [--grammar g.json] [--json]
tabnas validate --grammar g.json [--json]
tabnas diagnose [file|-] [--grammar g.json] [--json]
tabnas test     --spec fixtures.tsv [--grammar g.json] [--json]
tabnas plugins  [name] [--json]
tabnas mcp                                        # run the MCP server (stdio)
```

Exit codes: `0` success, `1` the operation said no (parse failure,
invalid grammar, fixture failures, unknown plugin), `2` usage error.
`tabnas --help` has the details. The CLI never touches the network.
`tabnas mcp` runs the stdio MCP server (the entry the skills package's
`mcp.json` invokes as `npx --yes @tabnas/mcp@0.1.0 mcp`).

Serialized grammars and their options are validated before use by a
firewall that rejects a prototype-pollution key (`__proto__`,
`constructor`, `prototype`) anywhere in the tree, a `ref` key, a
non-builtin function reference, a `plugins` key, and grammars over 5000
rules: a grammar is data, never code.

Full documentation:
[github.com/tabnas/mcp](https://github.com/tabnas/mcp).
