/* Copyright (c) 2026 tabnas, MIT License */

/* core.ts
 * The six operations, as pure functions over plain JSON.
 *
 * This file is the ONLY place operation logic lives. The MCP server
 * (mcp.ts) and the `tabnas` CLI (cli.ts) are thin wrappers that serialize
 * the exact objects returned here — `stringifyResult` is the one
 * serializer both use, and the golden tests (test/golden.test.js) assert
 * the two front-ends produce byte-identical JSON for identical requests.
 * If a behaviour belongs to one front-end only (a flag, an exit code, a
 * human rendering), it lives in that front-end; everything else is here.
 *
 * Security (ADR-10, non-negotiable): a serialized grammar is data, never
 * code. `validate_grammar` — and every operation that accepts a grammar,
 * which validates it first — rejects a grammar carrying a `ref` key (live
 * functions are not JSON; the serialized form has none) and any FuncRef
 * string that is not a `$`-suffixed builtin the engine itself provides.
 * "Validate this grammar" must never become "run this code".
 *
 * Every operation builds a FRESH Tabnas instance per call. Instances are
 * mutable (options, grammar, plugins) and sharing one across calls would
 * let one request's grammar leak into the next.
 */

import { Tabnas, BUILTIN_REFS } from '@tabnas/parser'
import type { TabnasErrorJSON } from '@tabnas/parser'

// Subpath imports, NOT the '@tabnas/support' barrel. The barrel
// re-exports the fixture runner, which imports `node:test`: importing it
// here would load Node's test runner into every CLI invocation and every
// MCP server process, and would make this file unbundlable for the
// hosted Worker, where `node:test` does not exist. The pieces below are
// the runtime-safe ones.
import { parseSpec } from '@tabnas/support/spec'
import {
  isErrorExpect, errorCode, parseExpect, equalValue, formatValue,
} from '@tabnas/support/expect'

import type { ErrorObject } from 'ajv/dist/2020'

// The Ajv validator for data/grammar.schema.json, PRECOMPILED at build
// time by tools/build-validator.js. Ajv normally compiles a schema by
// calling `new Function` on generated source; the hosted Worker forbids
// code generation from strings, so a runtime `ajv.compile()` here fails
// on every grammar-accepting tool once deployed. Compiling ahead of
// time is Ajv's own answer (ajv/dist/standalone) and changes nothing
// observable: same generated code, same ErrorObject shapes.
import grammarValidate from './grammar-validator'

import {
  errorRegistry, pluginIndex, PluginDescriptor,
} from './data'


// The A1 structured diagnostic — the engine's TabnasError.toJSON() shape,
// pinned by data/diagnostic.schema.json.
export type Diagnostic = TabnasErrorJSON

// One validation problem: where, and what.
export type ValidationIssue = {
  path: string
  message: string
}

// The shared rejection shape: invalid grammar, invalid request field,
// refused spec, unknown plugin. `errors` distinguishes it from a parse
// failure's `diagnostic`.
export type Invalid = {
  ok: false
  errors: ValidationIssue[]
}

export type ParseRequest = {
  input: string
  grammar?: Record<string, unknown>
  options?: Record<string, unknown>
}

export type ParseResult =
  | { ok: true; tree: unknown }
  | { ok: false; diagnostic: Diagnostic }
  | Invalid

export type ValidateGrammarRequest = {
  grammar: Record<string, unknown>
}

export type ValidateGrammarResult =
  | { ok: true; v: number }
  | Invalid

export type ExplainRequest = {
  input: string
  grammar?: Record<string, unknown>
}

export type RegistryHit = {
  code: string
  message: string
  hint: string
}

export type ExplainResult =
  | { failed: false }
  | { failed: true; diagnostic: Diagnostic; registry: RegistryHit | null }
  | Invalid

export type TestGrammarRequest = {
  spec: string
  grammar?: Record<string, unknown>
  options?: {
    inputCol?: number | string
    expectedCol?: number | string
  }
}

export type TestRow = {
  row: number
  input: string
  expected: string
  got: string
  ok: boolean
}

export type TestGrammarResult =
  | { pass: number; fail: number; rows: TestRow[] }
  | Invalid

export type ListPluginsResult = {
  plugins: PluginDescriptor[]
}

export type DescribePluginRequest = {
  name: string
}

export type DescribePluginResult = PluginDescriptor | Invalid


// Refuse to run a fixture with more rows than this (Phase-4 budget
// thinking: an operation's cost must be bounded by something the caller
// can see).
export const MAX_TEST_ROWS = 10000

// Refuse a grammar with more rules than this. A grammar's engine load
// cost is linear in its rule count, so an unbounded grammar is a CPU-DoS
// lever (a 10^6-rule grammar takes ~a minute to load). The cap is
// generous — real fleet grammars are tens of rules — and, like
// MAX_TEST_ROWS, it is a bound the caller can see rather than a silent
// truncation.
export const MAX_GRAMMAR_RULES = 5000


// The one serializer both front-ends use. Key order is the insertion
// order of the objects built in this file (and, inside a diagnostic, the
// engine's own toJSON order), so the bytes are stable for a given
// request. An `undefined` value (a parse with no grammar produces an
// undefined tree) is omitted by JSON.stringify — that omission is part of
// the golden contract too.
export function stringifyResult(result: unknown): string {
  return JSON.stringify(result)
}


// ---------------------------------------------------------------------
// Grammar validation: prototype-pollution firewall, security scan,
// structural schema, engine load.

// Keys that let a serialized document reach Object.prototype through a
// merge. The engine's grammar install deep-merges the spec (tabnas.ts
// deep()/merge → utility.ts) with NO __proto__ guard, so a grammar or
// request options carrying one of these keys ANYWHERE in its nested
// structure would pollute Object.prototype for the whole process — and a
// polluted prototype then corrupts every later parse, in this process and
// any it is embedded in. `constructor`/`prototype` are here for the same
// reason: `constructor.prototype` is the classic two-hop route to the
// same target. None of these is ever a legitimate data key in a
// serialized grammar or in TabnasOptions, so refusing them outright costs
// nothing real and closes the ADR-10 "data, never code" hole completely.
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

// Walk an arbitrary JSON value and report every own key that could
// pollute a prototype through a merge. Uses getOwnPropertyNames (not
// Object.keys) so a `__proto__` data property — which JSON.parse creates
// as a real own property — is seen even though it hides behind the
// inherited accessor; reads child values through the descriptor for the
// same reason. A poisoned subtree is reported and not descended into.
function scanForbiddenKeys(
  val: unknown, path: string, out: ValidationIssue[],
): void {
  if (null === val || 'object' !== typeof val) {
    return
  }
  if (Array.isArray(val)) {
    val.forEach((v, i) => scanForbiddenKeys(v, `${path}[${i}]`, out))
    return
  }
  for (const key of Object.getOwnPropertyNames(val)) {
    const childPath = `${path}.${key}`
    if (FORBIDDEN_KEYS.includes(key)) {
      out.push({
        path: childPath,
        message: `forbidden key '${key}': refused to prevent prototype ` +
          'pollution (a serialized grammar and its options are data, ' +
          'never a route to Object.prototype)',
      })
      continue
    }
    const desc = Object.getOwnPropertyDescriptor(val, key)
    if (desc && 'value' in desc) {
      scanForbiddenKeys(desc.value, childPath, out)
    }
  }
}

// The refusal message for a `plugins` key: a plugin is live code, and
// these operations accept only data — whether it arrives as a request
// option or inside a grammar's options.
const PLUGINS_MESSAGE =
  'plugins cannot be supplied through this interface: a plugin is live ' +
  'code, and these operations accept only data'

const REF_SHAPED = /^@[A-Za-z_$][\w$.-]*$/

// Alt keys whose string values the engine resolves as function
// references (grammar.schema.json $defs.alt; ts/src/rules.ts
// resolveFunctionRef). `a` may also be an array of refs.
const ALT_FUNC_KEYS = ['b', 'p', 'r', 'a', 'e', 'h', 'c'] as const

function isBuiltinRef(v: string): boolean {
  return v.endsWith('$') &&
    Object.prototype.hasOwnProperty.call(BUILTIN_REFS, v)
}

function builtinNames(): string {
  return Object.keys(BUILTIN_REFS).sort().join(', ')
}

function badRef(v: string, path: string): ValidationIssue {
  return {
    path,
    message: `unknown function reference '${v}': a serialized grammar ` +
      `may only name $-suffixed engine builtins (${builtinNames()})`,
  }
}

// Scan an options tree for ref-shaped strings. The engine's serialized
// option forms that are NOT function references pass: '@@...' (escaped
// literal '@'), '@SKIP' (deep-merge sentinel), '@/re/flags' and
// '@~/re/flags' (serialized RegExps). A `$`-suffixed builtin passes. Any
// other ref-shaped '@name' string is a reference the engine would try to
// resolve from a ref bag this operation refuses to accept — reject it.
// A non-ref-shaped '@' string (a bare '@' fixed-token, say) is data.
function scanOptionsRefs(
  val: unknown, path: string, out: ValidationIssue[],
): void {
  if ('string' === typeof val) {
    if ('@' !== val[0] ||
      val.startsWith('@@') ||
      '@SKIP' === val ||
      /^@~?\/.*\/[\w]*$/.test(val) ||
      isBuiltinRef(val)) {
      return
    }
    if (REF_SHAPED.test(val)) {
      out.push(badRef(val, path))
    }
    return
  }
  if (Array.isArray(val)) {
    val.forEach((v, i) => scanOptionsRefs(v, `${path}[${i}]`, out))
    return
  }
  if (null !== val && 'object' === typeof val) {
    const rec = val as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      scanOptionsRefs(rec[k], `${path}.${k}`, out)
    }
  }
}

// In an alt's function-reference positions the engine treats EVERY
// '@'-prefixed string as a reference, so here the rule is strict: it must
// be a `$`-suffixed builtin, full stop.
function scanAltRefs(
  alt: unknown, path: string, out: ValidationIssue[],
): void {
  if (null == alt || 'object' !== typeof alt || Array.isArray(alt)) {
    return
  }
  const rec = alt as Record<string, unknown>
  for (const k of ALT_FUNC_KEYS) {
    const v = rec[k]
    if ('string' === typeof v && v.startsWith('@')) {
      if (!isBuiltinRef(v)) {
        out.push(badRef(v, `${path}.${k}`))
      }
    } else if ('a' === k && Array.isArray(v)) {
      v.forEach((item, i) => {
        if ('string' === typeof item && item.startsWith('@') &&
          !isBuiltinRef(item)) {
          out.push(badRef(item, `${path}.a[${i}]`))
        }
      })
    }
  }
}

function altsOf(stateVal: unknown): unknown[] {
  if (Array.isArray(stateVal)) {
    return stateVal
  }
  if (null != stateVal && 'object' === typeof stateVal) {
    const alts = (stateVal as Record<string, unknown>).alts
    if (Array.isArray(alts)) {
      return alts
    }
  }
  return []
}

// The ADR-10 security scan over a whole grammar.
function scanGrammarRefs(gs: Record<string, unknown>): ValidationIssue[] {
  const out: ValidationIssue[] = []

  if ('ref' in gs) {
    out.push({
      path: '$.ref',
      message: "'ref' is not part of the serialized grammar form: live " +
        'functions are not JSON, and a grammar carrying them is code, ' +
        'not data. Name $-suffixed engine builtins instead.',
    })
  }

  if (null != gs.options && 'object' === typeof gs.options) {
    scanOptionsRefs(gs.options, '$.options', out)
  }

  if (null != gs.rule && 'object' === typeof gs.rule) {
    const rules = gs.rule as Record<string, unknown>
    for (const rulename of Object.keys(rules)) {
      const rulespec = rules[rulename]
      if (null == rulespec || 'object' !== typeof rulespec) {
        continue
      }
      for (const state of ['open', 'close']) {
        const alts = altsOf((rulespec as Record<string, unknown>)[state])
        alts.forEach((alt, i) =>
          scanAltRefs(alt, `$.rule.${rulename}.${state}[${i}]`, out))
      }
    }
  }

  return out
}


// The compiled validator's call shape. The generated module has no
// types of its own, and this is the whole of what core uses: call it,
// then read `.errors` when it says no.
type CompiledValidator = {
  (data: unknown): boolean
  errors?: ErrorObject[] | null
}

// Ajv is still a REGULAR dependency: the precompiled function requires
// Ajv's runtime helpers (equal, ucs2length, ...). Structural validation
// is runtime behaviour of validate_grammar, not test tooling. The
// engine's no-dependency rule does not apply to this repo (it is
// tooling, not the engine).
function structuralValidator(): CompiledValidator {
  return grammarValidate as unknown as CompiledValidator
}

function pathOfPointer(pointer: string): string {
  if ('' === pointer) {
    return '$'
  }
  return '$' + pointer.split('/').slice(1).map((seg) => {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~')
    if (/^\d+$/.test(key)) {
      return `[${key}]`
    }
    if (/^[A-Za-z_$][\w$]*$/.test(key)) {
      return `.${key}`
    }
    return `[${JSON.stringify(key)}]`
  }).join('')
}

function structuralIssues(gs: Record<string, unknown>): ValidationIssue[] {
  const validate = structuralValidator()
  if (validate(gs)) {
    return []
  }
  const out: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const err of (validate.errors ?? []) as ErrorObject[]) {
    const path = pathOfPointer(err.instancePath)
    let message = err.message ?? 'invalid'
    const params = err.params as Record<string, unknown> | undefined
    if ('additionalProperties' === err.keyword && params?.additionalProperty) {
      message += `: '${params.additionalProperty}'`
    }
    const key = path + ' ' + message
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ path, message })
    }
  }
  return out
}


// Full grammar validation, all layers. Engine load runs only when the
// security scan and the structural walk both pass: those two decide the
// grammar is DATA, and only then is it worth (and safe to reason about)
// handing to the engine.
export function validateGrammarInternal(grammar: unknown): {
  errors: ValidationIssue[]
  v: number
} {
  if (null == grammar || 'object' !== typeof grammar ||
    Array.isArray(grammar)) {
    return {
      errors: [{
        path: '$',
        message: 'grammar must be a JSON object (the serialized ' +
          'GrammarSpec form; see data/grammar.schema.json)',
      }],
      v: 0,
    }
  }

  const gs = grammar as Record<string, unknown>
  const v = 'number' === typeof gs.v ? gs.v : 1

  // FIRST firewall layer: prototype-pollution keys, a `plugins` key in
  // grammar.options, and the rule-count cap. These run before the schema
  // and before ANY engine load — a poisoned or oversized grammar must
  // never reach deep()/grammar(). A hit here short-circuits: the grammar
  // is rejected outright, so no later layer touches it.
  const firewall: ValidationIssue[] = []
  scanForbiddenKeys(gs, '$', firewall)

  if (null != gs.options && 'object' === typeof gs.options &&
    !Array.isArray(gs.options) &&
    Object.prototype.hasOwnProperty.call(gs.options, 'plugins')) {
    firewall.push({ path: '$.options.plugins', message: PLUGINS_MESSAGE })
  }

  if (null != gs.rule && 'object' === typeof gs.rule &&
    !Array.isArray(gs.rule)) {
    const ruleCount = Object.keys(gs.rule as Record<string, unknown>).length
    if (ruleCount > MAX_GRAMMAR_RULES) {
      firewall.push({
        path: '$.rule',
        message: `grammar has ${ruleCount} rules; refusing to load more ` +
          `than ${MAX_GRAMMAR_RULES}`,
      })
    }
  }

  if (0 < firewall.length) {
    return { errors: firewall, v }
  }

  const errors = [
    ...scanGrammarRefs(gs),
    ...structuralIssues(gs),
  ]

  if (0 === errors.length) {
    try {
      new Tabnas().grammar(gs as never)
    } catch (err) {
      errors.push({
        path: '$',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { errors, v }
}


// ---------------------------------------------------------------------
// Request plumbing shared by the operations.

export function invalid(path: string, message: string): Invalid {
  return { ok: false, errors: [{ path, message }] }
}

// A non-diagnostic engine throw, as the shared rejection shape with an
// empty path (the throw is not attributable to one request field). Both
// front-ends serialize this identically, so a request that provokes a
// raw engine error looks the same through the CLI and the MCP tool.
function nonDiagnosticError(err: unknown): Invalid {
  return invalid('', err instanceof Error ? err.message : String(err))
}

// Exported as checkOptionsPublic below for compat.ts, which must apply the
// SAME options firewall as every other operation rather than a copy of it.
function checkOptions(options: unknown): Invalid | null {
  if (undefined === options) {
    return null
  }
  if (null == options || 'object' !== typeof options ||
    Array.isArray(options)) {
    return invalid('$.options', 'options must be a JSON object (TabnasOptions)')
  }
  // FIRST firewall layer, same as for grammars: refuse prototype-pollution
  // keys anywhere in the options tree before anything reads them.
  const poison: ValidationIssue[] = []
  scanForbiddenKeys(options, '$.options', poison)
  if (0 < poison.length) {
    return { ok: false, errors: poison }
  }
  if (Object.prototype.hasOwnProperty.call(options, 'plugins')) {
    return invalid('$.options.plugins', PLUGINS_MESSAGE)
  }
  const errors: ValidationIssue[] = []
  scanOptionsRefs(options, '$.options', errors)
  if (0 < errors.length) {
    return { ok: false, errors }
  }
  return null
}

// A fresh instance with request options and grammar applied, or the
// Invalid result explaining why not. The grammar has been validated by
// the time this runs, so a failure here is an options/grammar interplay
// the validation instance could not see.
export function buildInstance(
  options: Record<string, unknown> | undefined,
  grammar: Record<string, unknown> | undefined,
): Tabnas | Invalid {
  let tn: Tabnas
  try {
    tn = new Tabnas(options as never)
  } catch (err) {
    return invalid('$.options',
      err instanceof Error ? err.message : String(err))
  }
  if (undefined !== grammar) {
    try {
      tn.grammar(grammar as never)
    } catch (err) {
      return invalid('$.grammar',
        err instanceof Error ? err.message : String(err))
    }
  }
  return tn
}

export function isInvalid(v: unknown): v is Invalid {
  return null != v && 'object' === typeof v &&
    false === (v as Invalid).ok && Array.isArray((v as Invalid).errors)
}

// A thrown value that carries the engine's structured diagnostic.
function isDiagnosticError(err: unknown): err is {
  toJSON(): Diagnostic
  code: string
  message: string
} {
  const e = err as { toJSON?: unknown; code?: unknown }
  return null != err && 'function' === typeof e.toJSON &&
    'string' === typeof e.code
}


// ---------------------------------------------------------------------
// 1. parse

// `parseDetailed` is the implementation; `parse` is its plain-JSON face.
// The extra `rendered` field carries the engine's own multi-line rendered
// error message for the CLI's human (non---json) output — it is NOT part
// of the result JSON, which both front-ends must emit byte-identically.
export function parseDetailed(req: ParseRequest): {
  result: ParseResult
  rendered?: string
} {
  if ('string' !== typeof req?.input) {
    return { result: invalid('$.input', 'input must be a string') }
  }

  const optbad = checkOptions(req.options)
  if (optbad) {
    return { result: optbad }
  }

  if (undefined !== req.grammar) {
    const { errors } = validateGrammarInternal(req.grammar)
    if (0 < errors.length) {
      return { result: { ok: false, errors } }
    }
  }

  const tn = buildInstance(req.options, req.grammar)
  if (isInvalid(tn)) {
    return { result: tn }
  }

  try {
    const tree: unknown = tn.parse(req.input)
    return { result: { ok: true, tree } }
  } catch (err) {
    if (isDiagnosticError(err)) {
      return {
        result: { ok: false, diagnostic: err.toJSON() },
        rendered: err.message,
      }
    }
    // A non-diagnostic engine throw (e.g. options.parser.start set to a
    // non-function) is a rejected request, not a crash — return the clean
    // errors shape a bad grammar/options gets, so both front-ends agree
    // instead of one surfacing a raw stack and the other something else.
    return { result: nonDiagnosticError(err) }
  }
}

// Does this input parse, and to what tree? A fresh engine instance per
// call; `options` applied first, then `grammar` (validated before it is
// loaded — an invalid grammar is rejected with the validate_grammar error
// shape). With no grammar the instance is exactly what `new Tabnas()`
// gives: the bare engine, which defines no rules, so every input yields
// an undefined tree.
export function parse(req: ParseRequest): ParseResult {
  return parseDetailed(req).result
}


// ---------------------------------------------------------------------
// 2. validate_grammar

// Is this serialized GrammarSpec valid? Three layers: the ADR-10 security
// scan (no `ref`, builtins-only FuncRefs), a structural validation
// against data/grammar.schema.json (Ajv, draft 2020-12), and — when both
// pass — an engine load into a fresh instance, whose thrown message
// becomes the error. On success `v` is the grammar's declared builtin
// config-schema version (absent means 1).
export function validateGrammar(
  req: ValidateGrammarRequest,
): ValidateGrammarResult {
  if (null == req || !('grammar' in req)) {
    return invalid('$.grammar', 'grammar is required')
  }
  const { errors, v } = validateGrammarInternal(req.grammar)
  if (0 < errors.length) {
    return { ok: false, errors }
  }
  return { ok: true, v }
}


// ---------------------------------------------------------------------
// 3. explain_parse_error

export function explainDetailed(req: ExplainRequest): {
  result: ExplainResult
  rendered?: string
} {
  if ('string' !== typeof req?.input) {
    return { result: invalid('$.input', 'input must be a string') }
  }

  if (undefined !== req.grammar) {
    const { errors } = validateGrammarInternal(req.grammar)
    if (0 < errors.length) {
      return { result: { ok: false, errors } }
    }
  }

  const tn = buildInstance(undefined, req.grammar)
  if (isInvalid(tn)) {
    return { result: tn }
  }

  try {
    tn.parse(req.input)
    return { result: { failed: false } }
  } catch (err) {
    if (isDiagnosticError(err)) {
      const diagnostic = err.toJSON()
      return {
        result: {
          failed: true,
          diagnostic,
          registry: registryEntry(diagnostic.code),
        },
        rendered: err.message,
      }
    }
    // As in parse: a non-diagnostic engine throw becomes the clean errors
    // shape, so the CLI and the MCP tool agree.
    return { result: nonDiagnosticError(err) }
  }
}

// Parse, and on failure return the A1 diagnostic PLUS the registry entry
// for its code from data/error-codes.json — null when the code is not in
// the registry (a plugin-declared code, say: the bundled registry holds
// only the engine's own codes).
export function explainParseError(req: ExplainRequest): ExplainResult {
  return explainDetailed(req).result
}

// The registry entry for an error code, or null. Exposed for tests and
// for front-ends that want the hint text without re-parsing.
export function registryEntry(code: string): RegistryHit | null {
  const entry = errorRegistry().codes[code]
  if (null == entry) {
    return null
  }
  return { code, message: entry.message, hint: entry.hint }
}


// ---------------------------------------------------------------------
// 4. test_grammar

// Run TSV fixture content through @tabnas/support's loader and
// expectation helpers against a fresh instance with the grammar applied.
// The content follows the fleet convention (support's parseSpec): line 1
// is a header, blank lines and tab-less '#' lines are skipped, the input
// column is escape-decoded, the expected column is raw — JSON, or
// ERROR / ERROR:<code>. Column selection defaults to positions 0 and 1;
// options.inputCol / options.expectedCol select by position or header
// name. Refuses a spec with more than MAX_TEST_ROWS rows.
export function testGrammar(req: TestGrammarRequest): TestGrammarResult {
  if ('string' !== typeof req?.spec || '' === req.spec) {
    return invalid('$.spec', 'spec is required: TSV fixture content ' +
      '(line 1 is the header line)')
  }

  if (undefined !== req.grammar) {
    const { errors } = validateGrammarInternal(req.grammar)
    if (0 < errors.length) {
      return { ok: false, errors }
    }
  }

  let spec
  try {
    spec = parseSpec('spec.tsv', req.spec)
  } catch (err) {
    return invalid('$.spec',
      err instanceof Error ? err.message : String(err))
  }

  if (0 === spec.rows.length) {
    return invalid('$.spec', 'no data rows (line 1 is consumed as the ' +
      'header line; are the columns tab-separated?)')
  }

  if (spec.rows.length > MAX_TEST_ROWS) {
    return invalid('$.spec', `spec has ${spec.rows.length} rows; ` +
      `refusing to run more than ${MAX_TEST_ROWS}`)
  }

  let inputCol: number
  let expectedCol: number
  try {
    inputCol = spec.rows[0].resolve(req.options?.inputCol ?? 0)
  } catch (err) {
    return invalid('$.options.inputCol',
      err instanceof Error ? err.message : String(err))
  }
  try {
    expectedCol = spec.rows[0].resolve(req.options?.expectedCol ?? 1)
  } catch (err) {
    return invalid('$.options.expectedCol',
      err instanceof Error ? err.message : String(err))
  }

  const tn = buildInstance(undefined, req.grammar)
  if (isInvalid(tn)) {
    return tn
  }

  const rows: TestRow[] = []
  let pass = 0
  let fail = 0

  for (const row of spec.rows) {
    const input = row.unesc(inputCol)
    const expected = row.col(expectedCol)

    let tree: unknown = undefined
    let threw: unknown = null
    try {
      tree = tn.parse(input)
    } catch (err) {
      threw = err
    }

    const code = (threw as { code?: unknown })?.code
    const got = null == threw
      ? formatValue(tree)
      : 'ERROR' + ('string' === typeof code ? ':' + code : '')

    let ok: boolean
    if (isErrorExpect(expected)) {
      const want = errorCode(expected)
      ok = null != threw && ('' === want || code === want)
    } else {
      let want: unknown
      try {
        want = parseExpect(expected)
      } catch (err) {
        return invalid('$.spec', `${row.where()}: ` +
          (err instanceof Error ? err.message : String(err)))
      }
      ok = null == threw && equalValue(tree, want)
    }

    rows.push({ row: row.line, input, expected, got, ok })
    if (ok) {
      pass++
    } else {
      fail++
    }
  }

  return { pass, fail, rows }
}


// ---------------------------------------------------------------------
// 5. list_plugins / 6. describe_plugin

// Every bundled plugin descriptor (data/plugins.json), sorted by name.
export function listPlugins(): ListPluginsResult {
  return { plugins: pluginIndex().plugins }
}

// The full descriptor for one plugin. Accepts the exact package name
// ('@tabnas/csv') or the bare fleet name ('csv').
export function describePlugin(req: DescribePluginRequest): DescribePluginResult {
  if ('string' !== typeof req?.name || '' === req.name) {
    return invalid('$.name', 'name is required')
  }
  const all = pluginIndex().plugins
  const hit = all.find((p) =>
    p.name === req.name || p.name === '@tabnas/' + req.name)
  if (undefined === hit) {
    return invalid('$.name',
      `unknown plugin '${req.name}'; known plugins: ` +
      all.map((p) => p.name).join(', '))
  }
  return hit
}


// The options firewall, for compat.ts. Same function, exported under a
// name that says it crosses a module boundary on purpose.
export const checkOptionsPublic = checkOptions
