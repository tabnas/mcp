#!/usr/bin/env node
/* Copyright (c) 2026 tabnas, MIT License */

/* cli.ts
 * The unified `tabnas` CLI: the second front-end over core.ts.
 *
 * Subcommands map one-to-one onto the core operations, and `--json`
 * prints EXACTLY the core result JSON — the same bytes the MCP tool
 * returns for the same request (the golden contract; see
 * test/golden.test.js). Everything below is argument plumbing and human
 * rendering; no operation logic.
 *
 * Exit codes (also in README.md and --help):
 *   0  success (parse succeeded, grammar valid, all fixture rows passed)
 *   1  the operation ran and said no (parse failure, invalid grammar,
 *      fixture failures, unknown plugin)
 *   2  usage error (bad flags, missing/unreadable files, malformed
 *      grammar JSON file)
 *
 * No network access, ever. Input files may be '-' for stdin.
 */

import { readFileSync, statSync } from 'node:fs'

// Subpath import, not the barrel: '@tabnas/support' re-exports the
// fixture runner and so drags `node:test` into every `tabnas` command.
import { loadSpec, loadSpecDir } from '@tabnas/support/spec'

import {
  parseDetailed,
  validateGrammar,
  explainDetailed,
  testGrammar,
  listPlugins,
  describePlugin,
  stringifyResult,
  Invalid,
  TestRow,
} from './core'

import { compareGrammars, CompareReport } from './compat'

import { packageInfo } from './data'

// Type-only: the MCP server entry is loaded lazily (a runtime require in
// cmdMcp) so the `parse`/`validate`/etc. fast paths never pull the MCP
// SDK into memory.
import type * as McpModule from './mcp'


const USAGE = `usage: tabnas <command> [options]

commands:
  parse    [file|-] [--grammar g.json] [--json]   parse input, print the tree
  validate --grammar g.json [--json]              validate a serialized grammar
  diagnose [file|-] [--grammar g.json] [--json]   explain a parse failure
  test     --spec fixtures.tsv [--grammar g.json] [--json]
                                                  run TSV fixtures
  plugins  [name] [--json]                        list plugins / one descriptor
  compare  --a old.json --b new.json [--corpus dir|file] [--depth n] [--json]
                                                  grammar compatibility report
  mcp                                             run the MCP server (stdio)

options:
  --grammar <path>  serialized GrammarSpec JSON file
  --spec <path>     TSV fixture file (tabnas convention: line 1 is a header)
  --a <path>        baseline grammar, for compare (the deployed one)
  --b <path>        candidate grammar, for compare
  --corpus <path>   .tsv fixture file or a directory of them, replayed
                    through both grammars by compare
  --depth <n>       compare: derivation depth for generated inputs (0..5)
  --json            print the raw operation result JSON (the same bytes the
                    MCP tool returns)
  --help, -h        this help
  --version         print the package version

input is read from <file>, or from stdin when the argument is '-' or absent.

exit codes:
  0  success: parse succeeded / grammar valid / all fixture rows passed
  1  parse failure, invalid grammar, fixture failures, unknown plugin,
     or a compare that found any change between the two grammars
  2  usage error: unknown flags, missing or unreadable files
`


// A usage-level failure: wrong invocation, not a "no" from the engine.
class UsageError extends Error {}

type Flags = {
  json: boolean
  grammarPath?: string
  specPath?: string
  aPath?: string
  bPath?: string
  corpusPath?: string
  depth?: number
  positional: string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ('--json' === arg) {
      flags.json = true
    } else if ('--grammar' === arg) {
      if (undefined === argv[++i]) {
        throw new UsageError('--grammar requires a file path')
      }
      flags.grammarPath = argv[i]
    } else if ('--spec' === arg) {
      if (undefined === argv[++i]) {
        throw new UsageError('--spec requires a file path')
      }
      flags.specPath = argv[i]
    } else if ('--a' === arg) {
      if (undefined === argv[++i]) {
        throw new UsageError('--a requires a file path')
      }
      flags.aPath = argv[i]
    } else if ('--b' === arg) {
      if (undefined === argv[++i]) {
        throw new UsageError('--b requires a file path')
      }
      flags.bPath = argv[i]
    } else if ('--corpus' === arg) {
      if (undefined === argv[++i]) {
        throw new UsageError('--corpus requires a file or directory path')
      }
      flags.corpusPath = argv[i]
    } else if ('--depth' === arg) {
      if (undefined === argv[++i]) {
        throw new UsageError('--depth requires an integer')
      }
      const n = Number(argv[i])
      if (!Number.isInteger(n)) {
        throw new UsageError('--depth requires an integer')
      }
      flags.depth = n
    } else if ('-' === arg || !arg.startsWith('-')) {
      flags.positional.push(arg)
    } else {
      throw new UsageError(`unknown option: ${arg}`)
    }
  }
  return flags
}

function readSource(file: string | undefined): string {
  if (undefined === file || '-' === file) {
    try {
      return readFileSync(0, 'utf8')
    } catch (err) {
      throw new UsageError('cannot read stdin: ' + msg(err))
    }
  }
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ` + msg(err))
  }
}

function readGrammar(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ` + msg(err))
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new UsageError(`${path} is not valid JSON: ` + msg(err))
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function out(text: string): void {
  process.stdout.write(text + '\n')
}

function errline(text: string): void {
  process.stderr.write(text + '\n')
}

function isInvalid(result: unknown): result is Invalid {
  return null != result && 'object' === typeof result &&
    false === (result as Invalid).ok &&
    Array.isArray((result as Invalid).errors)
}

function renderInvalid(result: Invalid): void {
  errline('invalid:')
  for (const issue of result.errors) {
    errline(`  ${issue.path}: ${issue.message}`)
  }
}


// Each command returns the process exit code.

function cmdParse(flags: Flags): number {
  if (1 < flags.positional.length) {
    throw new UsageError('parse takes at most one input file')
  }
  const req = {
    input: readSource(flags.positional[0]),
    ...(undefined !== flags.grammarPath
      ? { grammar: readGrammar(flags.grammarPath) } : {}),
  }
  const { result, rendered } = parseDetailed(req)
  if (flags.json) {
    out(stringifyResult(result))
    return 'ok' in result && true === result.ok ? 0 : 1
  }
  if (isInvalid(result)) {
    renderInvalid(result)
    return 1
  }
  if (true === result.ok) {
    out(undefined === result.tree
      ? 'undefined' : JSON.stringify(result.tree, null, 2))
    return 0
  }
  // Parse failure: the engine's own rendered error message.
  errline(rendered ?? result.diagnostic.message)
  return 1
}

function cmdValidate(flags: Flags): number {
  if (0 < flags.positional.length) {
    throw new UsageError('validate takes no positional arguments')
  }
  if (undefined === flags.grammarPath) {
    throw new UsageError('validate requires --grammar <path>')
  }
  const result = validateGrammar({ grammar: readGrammar(flags.grammarPath) })
  if (flags.json) {
    out(stringifyResult(result))
    return true === result.ok ? 0 : 1
  }
  if (true === result.ok) {
    out(`grammar valid (builtin schema version ${result.v})`)
    return 0
  }
  renderInvalid(result)
  return 1
}

function cmdDiagnose(flags: Flags): number {
  if (1 < flags.positional.length) {
    throw new UsageError('diagnose takes at most one input file')
  }
  const req = {
    input: readSource(flags.positional[0]),
    ...(undefined !== flags.grammarPath
      ? { grammar: readGrammar(flags.grammarPath) } : {}),
  }
  const { result, rendered } = explainDetailed(req)
  if (flags.json) {
    out(stringifyResult(result))
    return 'failed' in result && false === result.failed ? 0 : 1
  }
  if (isInvalid(result)) {
    renderInvalid(result)
    return 1
  }
  if (false === result.failed) {
    out('input parses: nothing to diagnose')
    return 0
  }
  errline(rendered ?? result.diagnostic.message)
  if (null != result.registry) {
    errline('')
    errline(`registry[${result.registry.code}].message: ` +
      result.registry.message)
    errline(`registry[${result.registry.code}].hint: ` +
      result.registry.hint.replace(/\n/g, '\n  '))
  } else {
    errline('')
    errline(`code '${result.diagnostic.code}' is not in the bundled ` +
      'registry (a plugin-declared code?)')
  }
  return 1
}

function cmdTest(flags: Flags): number {
  if (0 < flags.positional.length) {
    throw new UsageError('test takes no positional arguments')
  }
  if (undefined === flags.specPath) {
    throw new UsageError('test requires --spec <path>')
  }
  const req = {
    spec: readSource(flags.specPath),
    ...(undefined !== flags.grammarPath
      ? { grammar: readGrammar(flags.grammarPath) } : {}),
  }
  const result = testGrammar(req)
  if (flags.json) {
    out(stringifyResult(result))
    return !isInvalid(result) && 0 === result.fail ? 0 : 1
  }
  if (isInvalid(result)) {
    renderInvalid(result)
    return 1
  }
  out(`pass ${result.pass} fail ${result.fail}`)
  for (const row of result.rows.filter((r: TestRow) => !r.ok)) {
    out(`  row ${row.row}: ${JSON.stringify(row.input)} ` +
      `expected ${row.expected || '(empty)'} got ${row.got}`)
  }
  return 0 === result.fail ? 0 : 1
}

function cmdPlugins(flags: Flags): number {
  if (1 < flags.positional.length) {
    throw new UsageError('plugins takes at most one name')
  }
  const name = flags.positional[0]
  if (undefined === name) {
    const result = listPlugins()
    if (flags.json) {
      out(stringifyResult(result))
      return 0
    }
    for (const p of result.plugins) {
      out(`${p.name}  ${'string' === typeof p.description ? p.description : ''}`)
    }
    return 0
  }
  const result = describePlugin({ name })
  if (flags.json) {
    out(stringifyResult(result))
    return isInvalid(result) ? 1 : 0
  }
  if (isInvalid(result)) {
    renderInvalid(result)
    return 1
  }
  out(JSON.stringify(result, null, 2))
  return 0
}


// Load the corpus for `compare`. A .tsv file or a directory of them, read
// through @tabnas/support so corpus handling has ONE implementation — the
// same loader the fixture runners use, with the same header and escape
// conventions. The fleet's 5,180 fixture rows are the corpus this phase was
// designed around, and they are already curated as meaningful inputs.
//
// The INPUT column only: an expectation column says what the old grammar did,
// and compare asks what the new one does, which is a different question.
function readCorpus(path: string): string[] {
  let files
  try {
    files = statSync(path).isDirectory() ? loadSpecDir(path) : [loadSpec(path)]
  } catch (err) {
    throw new UsageError(`cannot read corpus ${path}: ` + msg(err))
  }
  const out: string[] = []
  for (const file of files) {
    for (const row of file.rows) {
      const input = row.unesc(0)
      if ('' !== input) {
        out.push(input)
      }
    }
  }
  return out
}

function cmdCompare(flags: Flags): number {
  if (0 < flags.positional.length) {
    throw new UsageError('compare takes no positional arguments')
  }
  if (undefined === flags.aPath || undefined === flags.bPath) {
    throw new UsageError('compare requires --a <path> and --b <path>')
  }
  const req = {
    a: readGrammar(flags.aPath),
    b: readGrammar(flags.bPath),
    ...(undefined !== flags.corpusPath
      ? { corpus: readCorpus(flags.corpusPath) } : {}),
    ...(undefined !== flags.depth ? { depth: flags.depth } : {}),
  }
  const result = compareGrammars(req)
  if (flags.json) {
    out(stringifyResult(result))
    return isInvalid(result) || 0 < result.changes.length ? 1 : 0
  }
  if (isInvalid(result)) {
    renderInvalid(result)
    return 1
  }
  renderCompare(result)
  return 0 < result.changes.length ? 1 : 0
}

// The human rendering leads with confidence and its reason, because a reader
// who stops after one line should take away how much the report can be
// trusted — not a verdict it deliberately does not give.
function renderCompare(r: CompareReport): void {
  out(`confidence: ${r.confidence}`)
  out(`  ${r.why}`)
  out('')

  if (r.normalForm.identical) {
    out('normal form: identical')
  } else {
    out('normal form: differs')
  }

  out('')
  out('proven:')
  for (const p of r.proven) {
    out(`  [${p.status}] ${p.claim}`)
    out(`      ${p.basis}`)
    if (undefined !== p.detail) {
      out(`      ${p.detail}`)
    }
  }

  out('')
  out('observed:')
  for (const o of r.observed) {
    out(`  ${o.tier}: ran ${o.ran}, both accept ${o.bothAccept}, ` +
      `both reject ${o.bothReject}`)
    if (undefined !== o.note) {
      out(`      ${o.note}`)
    }
  }

  if (0 < r.changes.length) {
    out('')
    out(`changes (${r.changes.length}):`)
    for (const c of r.changes.slice(0, 20)) {
      out(`  ${c.kind}: ${c.detail}` +
        (undefined === c.input ? '' : `  input=${JSON.stringify(c.input)}`))
    }
    if (20 < r.changes.length) {
      out(`  ... and ${r.changes.length - 20} more`)
    }
  }

  if (0 < r.counterexamples.length) {
    out('')
    out(`counterexamples (${r.counterexamples.length}):`)
    for (const c of r.counterexamples.slice(0, 10)) {
      out(`  ${JSON.stringify(c.input)}`)
      out(`      ${c.why}`)
    }
    if (10 < r.counterexamples.length) {
      out(`  ... and ${r.counterexamples.length - 10} more`)
    }
  }
}

function cmdMcp(flags: Flags): number {
  if (0 < flags.positional.length) {
    throw new UsageError('mcp takes no arguments')
  }
  if (flags.json || undefined !== flags.grammarPath ||
    undefined !== flags.specPath) {
    throw new UsageError('mcp takes no options (it speaks MCP over stdio)')
  }
  // Start the stdio MCP server. It owns stdin/stdout for JSON-RPC — the
  // CLI writes NOTHING to stdout here — and the transport keeps the
  // process alive; when the client disconnects the server closes and the
  // process exits. Loaded lazily so the data-command paths never pay for
  // the MCP SDK. This is the entry the skills package's mcp.json invokes
  // as `npx --yes @tabnas/mcp@<version> mcp`.
  const mcp = require('./mcp') as typeof McpModule
  mcp.main().catch((err: unknown) => {
    errline('tabnas: ' + msg(err))
    process.exit(1)
  })
  return 0
}


export function run(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE)
    return 0
  }
  if (argv.includes('--version')) {
    out(packageInfo().version)
    return 0
  }

  const [command, ...rest] = argv
  if (undefined === command) {
    errline(USAGE)
    return 2
  }

  const flags = parseFlags(rest)

  switch (command) {
    case 'parse':
      return cmdParse(flags)
    case 'validate':
      return cmdValidate(flags)
    case 'diagnose':
      return cmdDiagnose(flags)
    case 'test':
      return cmdTest(flags)
    case 'plugins':
      return cmdPlugins(flags)
    case 'compare':
      return cmdCompare(flags)
    case 'mcp':
      return cmdMcp(flags)
    default:
      throw new UsageError(`unknown command: ${command}`)
  }
}

/* istanbul ignore next */
if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) {
      errline('tabnas: ' + err.message)
      errline("run 'tabnas --help' for usage")
      process.exitCode = 2
    } else {
      errline('tabnas: ' + msg(err))
      process.exitCode = 1
    }
  }
}
