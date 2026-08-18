# tabnas/mcp

The tabnas agent tooling: **one TypeScript codebase, two front-ends** —
an [MCP](https://modelcontextprotocol.io) server (stdio) and the unified
`tabnas` CLI — sharing a single core (`ts/src/core.ts`) so the two can
never disagree. For each operation the CLI's `--json` output and the MCP
tool result are **byte-identical**, and the test suite holds them to it.

Published as `@tabnas/mcp`. This repo is TypeScript-only: it is tooling
over the engine, not a parity package, so there is no Go port.

## Install

```bash
npm install -g @tabnas/mcp     # the `tabnas` CLI
npx --yes @tabnas/mcp          # run the MCP server directly (stdio)
```

MCP client configuration (stdio):

```json
{
  "mcpServers": {
    "tabnas": {
      "command": "npx",
      "args": ["--yes", "@tabnas/mcp@0.1.3", "mcp"]
    }
  }
}
```

The server is started by the `mcp` subcommand of the CLI
(`tabnas mcp`), which is exactly what the skills package's `mcp.json`
invokes as `npx --yes @tabnas/mcp@0.1.3 mcp`. (`--yes` matters: on a
cache miss `npx` would otherwise prompt on the stdin the MCP transport
owns. Pin an exact version so the tools cannot drift under an installed
client.)

## The seven tools

| Tool | Answers | Result |
| --- | --- | --- |
| `parse` | does this input parse, and to what tree? | `{ok:true, tree}` \| `{ok:false, diagnostic}` |
| `validate_grammar` | is this serialized GrammarSpec valid? | `{ok:true, v}` \| `{ok:false, errors:[{path,message}]}` |
| `explain_parse_error` | why did this parse fail? | `{failed:false}` \| `{failed:true, diagnostic, registry}` |
| `test_grammar` | do these TSV fixtures pass? | `{pass, fail, rows:[{row,input,expected,got,ok}]}` |
| `list_plugins` | what grammar plugins exist? | `{plugins:[...]}` |
| `describe_plugin` | one plugin's full descriptor | the `tabnas.plugin.json` object |
| `compare_grammars` | does a grammar change still accept what the old one accepted, and build the same trees? | `{normalForm, proven[], observed[], changes[], counterexamples[], confidence, why}` |

Notes on the contracts:

- Every operation builds a **fresh engine instance** per call. `parse`
  applies `options` first, then `grammar`. With no grammar the instance
  is exactly what `new Tabnas()` gives — the bare engine defines no
  rules, so every input yields an undefined tree (serialized as
  `{"ok":true}`).
- A `grammar` argument is **validated before it is used**, by every
  operation that accepts one; an invalid grammar is rejected with the
  `validate_grammar` error shape `{ok:false, errors:[{path,message}]}`.
- `validate_grammar` layers: an ADR-10 security scan (below), structural
  validation against the bundled `grammar.schema.json` (Ajv,
  draft 2020-12), then an engine load in a fresh instance whose thrown
  message becomes the error. `v` is the grammar's declared builtin
  config-schema version (absent means 1).
- **Security (ADR-10):** a serialized grammar and its options are data,
  never code. A firewall runs first on every grammar-accepting op and on
  request options, rejecting: any own key named `__proto__`,
  `constructor`, or `prototype` anywhere in the tree (prototype-pollution
  defense — the engine's grammar merge has no `__proto__` guard); a `ref`
  key (live functions are not JSON); any function reference that is not a
  `$`-suffixed engine builtin; a `plugins` key, whether a request option
  or inside `grammar.options` (a plugin is live code); and grammars over
  5000 rules (a CPU bound). "Validate this grammar" never becomes "run
  this code", or "pollute this process".
- A non-diagnostic engine throw (e.g. `options.parser.start` set to a
  non-function) is caught and returned as the same clean
  `{ok:false, errors:[{path:"",message}]}` shape, so the CLI and the MCP
  tool agree.
- `explain_parse_error` joins the diagnostic with the bundled error-code
  registry entry (`{code, message, hint}`); `registry` is `null` for a
  code the registry does not know (e.g. a plugin-declared code).
- `test_grammar` takes TSV **content** in the fleet fixture convention
  (`@tabnas/support`): line 1 is a header, the input column is
  escape-decoded, the expected column is JSON or `ERROR` /
  `ERROR:<code>`. Columns default to positions 0 and 1;
  `options.inputCol` / `options.expectedCol` select by position or
  header name. Specs over 10000 rows are refused.

MCP **resources** (served verbatim from the bundled [`data/`](data)):
`tabnas://schema/grammar`, `tabnas://schema/diagnostic`,
`tabnas://errors`, `tabnas://plugins`, `tabnas://divergence`.

## CLI

```
tabnas parse    [file|-] [--grammar g.json] [--json]
tabnas validate --grammar g.json [--json]
tabnas diagnose [file|-] [--grammar g.json] [--json]
tabnas test     --spec fixtures.tsv [--grammar g.json] [--json]
tabnas plugins  [name] [--json]
tabnas compare  --a old.json --b new.json [--corpus dir|file] [--depth n] [--json]
tabnas mcp                                        # run the MCP server (stdio)
```

Input comes from `file`, or stdin when the argument is `-` or absent.
The CLI never touches the network. `tabnas mcp` starts the stdio MCP
server (the same server as `npx @tabnas/mcp`); it speaks JSON-RPC on
stdout and prints nothing else there.

`--json` prints **exactly** the core result JSON — the same bytes the
MCP tool returns for the same request (stable key order; the golden
contract, enforced by `ts/test/golden.test.js`). Without `--json` you
get a readable rendering; a parse failure prints the engine's own
rendered error message.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | success: parse succeeded / grammar valid / all fixture rows passed |
| 1 | the operation said no: parse failure, invalid grammar, fixture failures, unknown plugin |
| 2 | usage error: unknown flags or command, missing/unreadable files, malformed grammar JSON |

## Grammar compatibility (`compare`)

Two questions, reported separately, because they fail differently:

1. **Acceptance** — does the candidate still accept what the baseline
   accepted?
2. **Output** — for inputs both accept, is the resulting tree the same?

The second is the one users feel. A change that still accepts every
historical document but reshapes the tree silently breaks every downstream
consumer, and an acceptance-only test reports success.

**The report carries evidence and confidence, never a bare verdict.** There
is deliberately no `compatible: true` field. Language inclusion is
undecidable in general, so a tool that printed one would eventually be wrong
in production:

- `proven[]` — what was established statically, and on what basis. Anything
  outside the decidable subset is `not-proven`, which is a statement about
  this tool, **not** a claim that the grammars are incompatible.
- `observed[]` — what actually ran, and how much of it.
- `changes[]` / `counterexamples[]` — concrete differences, with inputs.
- `confidence` + `why` — how much weight the *absence* of findings can bear.
  `confidence: "low"` with a stated reason is a **successful** run.

The check that earns its keep is alternate **ordering**. Alternates are
first-match-wins, so one inserted earlier can shadow a later one and narrow
the accepted language while a set comparison calls it an addition. `compare`
walks positions, not membership, and reports a shadowed alternate that used
to be reachable.

`--corpus` takes a `.tsv` fixture file or a directory of them, loaded through
`@tabnas/support` — the same loader the fixture runners use. Real inputs are
the only tier that measures what your documents actually do:

```bash
tabnas compare --a v1.json --b v2.json --corpus ../json/test/spec
```

Exit code is 1 when any change is found, so it works as a release gate.

## Bundled data

Published packages do not carry the fleet's contract files (the parser's
npm files exclude `schema/`; plugin packages do not ship
`tabnas.plugin.json`), so this repo commits generated copies in
[`data/`](data): the grammar and diagnostic schemas, the error-code
registry, `DIVERGENCE.md`, and every fleet plugin descriptor
(`plugins.json`, sorted by name). Regenerate from sibling checkouts
(`../<repo>` beside this repo) with:

```bash
cd ts && npm run gen-data
```

The build copies `data/` into `ts/dist/data/` (that copy is what ships
in the npm package and what the code reads), and the test suite fails on
a stale regeneration or a stale copy. Derive, never duplicate (ADR-10).

## Build & test

```bash
cd ts
npm install
npm test        # builds first, then runs every test/*.test.js
```

Working in the fleet layout (sibling checkouts beside this repo),
symlink the siblings after `npm install` so you test against source:

```bash
rm -rf node_modules/@tabnas/parser node_modules/@tabnas/support
ln -s ../../../parser/ts node_modules/@tabnas/parser
ln -s ../../../support/ts node_modules/@tabnas/support
```

## CI

The intended workflow is staged at [`ci/ci.yml`](ci/ci.yml) — a caller
of the org's `tabnas/.github` `polyglot-ci.yml` (ts-only, with `parser`
and `support` cloned as siblings). Automation cannot push workflow
files (admin ADR-8), so a maintainer promotes `ci/ci.yml` to
`.github/workflows/ci.yml` via the admin rollout scripts.

## License

MIT. See [LICENSE](LICENSE).
