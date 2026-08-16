/* Copyright (c) 2026 Richard Rodger, MIT License */

// compat.ts — grammar compatibility (AX plan Phase 5).
//
// Answers TWO questions about a grammar change, reported separately:
//
//   1. Acceptance compatibility — does B still accept what A accepted?
//   2. Output compatibility    — for inputs both accept, is the tree the same?
//
// Output compatibility is the one users feel. A change that still accepts
// every historical document but reshapes the tree silently breaks every
// downstream consumer, and an acceptance-only test reports success.
//
// THE REPORT CARRIES EVIDENCE AND CONFIDENCE, NEVER A BARE VERDICT. Language
// inclusion is undecidable in general, so a tool that prints "compatible"
// without saying on what basis will eventually be wrong in production. There
// is deliberately no boolean in the result: `proven` says what was
// established and how, `observed` says what was run and how much, `changes`
// and `counterexamples` say what differs, and `confidence` says how much
// weight the absence of findings can bear. `confidence: 'low'` with a clear
// reason is a SUCCESSFUL run.
//
// Nothing here reports "incompatible" from a failure to prove compatibility.
// Outside the decidable subset the answer is `not-proven`, which is a
// statement about this tool, not about the grammars.

import {
  Invalid,
  ValidationIssue,
  buildInstance,
  invalid,
  isInvalid,
  validateGrammarInternal,
  checkOptionsPublic,
} from './core'


// ---------------------------------------------------------------------
// Bounds. Every one of these is a number the caller can see in the report
// rather than a silent truncation — same rule as core.ts's MAX_TEST_ROWS.

// Corpus rows accepted in one comparison.
export const MAX_CORPUS = 10000

// Inputs Tier 2 will generate before giving up. Generation is breadth-first
// over the rule graph, which grows fast; this bounds the work, and the report
// says when the cap was reached so "no counterexample" is never mistaken for
// "searched exhaustively".
export const MAX_GENERATED = 2000

// How deep a derivation may nest. Rule graphs are cyclic (a value contains a
// map contains a value), so an unbounded walk does not terminate.
export const MAX_DEPTH = 5
export const DEFAULT_DEPTH = 3


// ---------------------------------------------------------------------
// Types

export type CompareRequest = {
  // A is the baseline — the grammar already deployed. B is the candidate.
  a: Record<string, unknown>
  b: Record<string, unknown>
  // Inputs to replay through both (Tier 3/4). Supply the fixture corpus here.
  corpus?: string[]
  options?: Record<string, unknown>
  depth?: number
}

// Something established statically, with the reasoning that establishes it.
// `basis` is not decoration: it is what makes a `proven` entry checkable by
// a reader who does not trust the tool.
export type Proven = {
  claim: string
  basis: string
  status: 'proven' | 'not-proven'
  detail?: string
}

// Something measured rather than derived: what ran, how much of it, and what
// came back.
export type Observed = {
  tier: 'generated' | 'corpus'
  ran: number
  bothAccept: number
  bothReject: number
  note?: string
}

export type Change = {
  kind: 'newly-rejected' | 'newly-accepted' | 'tree-shape' | 'structural'
  detail: string
  input?: string
}

// A concrete input, worth more than any score: the reader can act on it.
export type Counterexample = {
  input: string
  aAccepts: boolean
  bAccepts: boolean
  why: string
}

export type CompareReport = {
  normalForm: {
    identical: boolean
    a: string
    b: string
  }
  proven: Proven[]
  observed: Observed[]
  changes: Change[]
  counterexamples: Counterexample[]
  confidence: 'high' | 'medium' | 'low'
  why: string
}

export type CompareResult = CompareReport | Invalid


// ---------------------------------------------------------------------
// Normal form
//
// A canonical rendering of a GrammarSpec, so two grammars that differ only in
// key order or spelling render identically. A textual diff of two normal
// forms is itself a useful output, and it is the input to every tier below.
//
// WHAT IS SORTED AND WHAT IS NOT is the whole correctness of this function.
// Rule NAMES sort: a rule table is a map, and map order carries no meaning.
// ALTERNATES DO NOT SORT. Alternates are first-match-wins, so their order IS
// the semantics — sorting them would make a narrowing change look like a
// no-op, which is precisely the wrong answer this phase exists to avoid.

// Options that cannot affect what a grammar accepts or what tree it builds.
// Deliberately short: an option is dropped only when its absence provably
// cannot change acceptance or shape. `error` and `hint` are message text,
// which the fleet treats as non-contractual (only the CODE is contractual
// across runtimes) and which no parse decision reads.
const COSMETIC_OPTIONS = ['error', 'hint']

// A token sequence, normalised to positions × permitted names. `undefined`
// becomes [] — the empty sequence, which matches unconditionally. That is not
// a curiosity: the catch-all `{ b: 1, a: '@value$' }` alt at the end of a
// close list is exactly this, and it is what makes anything after it dead.
function normSeq(s: unknown): string[][] {
  if (null == s) {
    return []
  }
  if ('string' === typeof s) {
    return s.trim().split(/\s+/).filter(Boolean).map((t) => [t])
  }
  if (Array.isArray(s)) {
    return s.map((pos) => {
      if ('string' === typeof pos) {
        return pos.trim().split(/\s+/).filter(Boolean)
      }
      if (Array.isArray(pos)) {
        return pos.filter((p): p is string => 'string' === typeof p)
      }
      return []
    })
  }
  // A FuncRef or anything else computed at runtime: not statically known.
  return [['?']]
}

function normAlt(alt: unknown): Record<string, unknown> {
  if (null == alt || 'object' !== typeof alt) {
    return {}
  }
  const src = alt as Record<string, unknown>
  const out: Record<string, unknown> = {}
  // Key order canonical (alphabetical); key ORDER within an alt carries no
  // meaning, unlike alt order within a list.
  for (const key of Object.keys(src).sort()) {
    if ('s' === key) {
      out.s = normSeq(src.s)
    } else if ('g' === key) {
      // Group tags: a comma string or an array, order-insensitive.
      const g = src.g
      const tags = 'string' === typeof g
        ? g.split(',').map((t) => t.trim()).filter(Boolean)
        : Array.isArray(g) ? g.map(String) : [String(g)]
      out.g = tags.sort()
    } else {
      out[key] = src[key]
    }
  }
  return out
}

function normRule(rule: unknown): Record<string, unknown> {
  if (null == rule || 'object' !== typeof rule) {
    return {}
  }
  const src = rule as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const phase of ['open', 'close']) {
    const alts = src[phase]
    if (undefined === alts) {
      continue
    }
    // Order preserved — see the header comment.
    out[phase] = Array.isArray(alts)
      ? alts.map(normAlt)
      : normAlt(alts)
  }
  for (const key of Object.keys(src).sort()) {
    if ('open' !== key && 'close' !== key) {
      out[key] = src[key]
    }
  }
  return out
}

export function normalForm(grammar: Record<string, unknown>): string {
  const out: Record<string, unknown> = {}

  for (const key of Object.keys(grammar).sort()) {
    if ('rule' === key) {
      const rules = grammar.rule
      if (null != rules && 'object' === typeof rules) {
        const rec = rules as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const name of Object.keys(rec).sort()) {
          sorted[name] = normRule(rec[name])
        }
        out.rule = sorted
      }
      continue
    }
    if ('options' === key) {
      const opts = grammar.options
      if (null != opts && 'object' === typeof opts) {
        const rec = opts as Record<string, unknown>
        const kept: Record<string, unknown> = {}
        for (const o of Object.keys(rec).sort()) {
          if (!COSMETIC_OPTIONS.includes(o)) {
            kept[o] = rec[o]
          }
        }
        out.options = kept
      }
      continue
    }
    out[key] = grammar[key]
  }

  return JSON.stringify(out, null, 2)
}


// ---------------------------------------------------------------------
// Tier 1 — provable
//
// Honest scope. Tabnas's model is a rule table of ordered alternates over a
// token stream, so the decidable parts are at the edges. Everything else is
// reported `not-proven`.

// Does alternate X shadow alternate Y — that is, does every token sequence Y
// would match also get taken by X first?
//
// X shadows Y when X's sequence is no longer than Y's and, position by
// position, Y's permitted tokens are a subset of X's. A SHORTER sequence
// shadows a longer one that starts the same way, because alternates are
// first-match-wins and the shorter one matches first. The empty sequence
// (an alt with no `s`) shadows everything.
//
// Returns null when the question is not statically decidable — a runtime
// FuncRef in `s`, marked '?' by normSeq.
function shadows(x: string[][], y: string[][]): boolean | null {
  if (x.some((p) => p.includes('?')) || y.some((p) => p.includes('?'))) {
    return null
  }
  if (0 === x.length) {
    return true
  }
  if (x.length > y.length) {
    return false
  }
  for (let i = 0; i < x.length; i++) {
    for (const t of y[i]) {
      if (!x[i].includes(t)) {
        return false
      }
    }
  }
  return true
}

// An alt whose match depends on a runtime condition may or may not fire, so
// it can never PROVE shadowing — it can only warn.
function isConditional(alt: Record<string, unknown>): boolean {
  return undefined !== alt.c
}

function altList(rule: unknown, phase: string): Record<string, unknown>[] {
  if (null == rule || 'object' !== typeof rule) {
    return []
  }
  const alts = (rule as Record<string, unknown>)[phase]
  if (Array.isArray(alts)) {
    return alts.map(normAlt)
  }
  if (null != alts && 'object' === typeof alts) {
    return [normAlt(alts)]
  }
  return []
}

function ruleMap(g: Record<string, unknown>): Record<string, unknown> {
  const r = g.rule
  return (null != r && 'object' === typeof r)
    ? r as Record<string, unknown>
    : {}
}

// Compare the token literals each grammar binds. This is a set comparison,
// and set comparison is decidable — one of the few places Phase 5 can say
// "proven" without qualification.
function fixedLiterals(g: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  const opts = g.options
  if (null == opts || 'object' !== typeof opts) {
    return out
  }
  const fixed = (opts as Record<string, unknown>).fixed
  if (null == fixed || 'object' !== typeof fixed) {
    return out
  }
  const token = (fixed as Record<string, unknown>).token
  if (null == token || 'object' !== typeof token) {
    return out
  }
  for (const v of Object.values(token as Record<string, unknown>)) {
    if ('string' === typeof v) {
      out.add(v)
    }
  }
  return out
}

function tier1(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): { proven: Proven[]; changes: Change[] } {
  const proven: Proven[] = []
  const changes: Change[] = []

  const ra = ruleMap(a)
  const rb = ruleMap(b)

  // --- rules removed ------------------------------------------------
  const removed = Object.keys(ra).filter((n) => !(n in rb))
  if (0 < removed.length) {
    changes.push({
      kind: 'structural',
      detail: `rules present in A and absent in B: ${removed.join(', ')}`,
    })
    proven.push({
      claim: 'B does not define every rule A defines',
      basis: 'rule-name set comparison (decidable)',
      status: 'proven',
      detail: removed.join(', '),
    })
  }
  const added = Object.keys(rb).filter((n) => !(n in ra))
  if (0 < added.length) {
    changes.push({
      kind: 'structural',
      detail: `rules present in B and absent in A: ${added.join(', ')}`,
    })
  }

  // --- fixed token literals -----------------------------------------
  const fa = fixedLiterals(a)
  const fb = fixedLiterals(b)
  const lost = [...fa].filter((t) => !fb.has(t))
  if (0 === fa.size && 0 === fb.size) {
    proven.push({
      claim: 'neither grammar rebinds fixed token literals',
      basis: 'options.fixed.token absent in both (set comparison)',
      status: 'proven',
    })
  } else if (0 === lost.length) {
    proven.push({
      claim: 'every fixed literal A binds, B also binds',
      basis: 'fixed-token set inclusion (decidable)',
      status: 'proven',
    })
  } else {
    proven.push({
      claim: 'B drops fixed literals A bound',
      basis: 'fixed-token set inclusion (decidable)',
      status: 'proven',
      detail: lost.map((t) => JSON.stringify(t)).join(', '),
    })
    changes.push({
      kind: 'newly-rejected',
      detail: `fixed literals bound by A and not by B: ${lost.join(' ')}`,
    })
  }

  // --- alternate ordering: the subtlety that produces wrong verdicts --
  //
  // "B is A plus some alternates" is monotone ONLY if ordering is preserved.
  // An alternate inserted EARLIER can shadow a later one and narrow the
  // accepted language while looking, in a set comparison, like an addition.
  // So this walks positions, not membership.
  let shadowChecked = 0
  let shadowUndecidable = 0

  for (const name of Object.keys(rb).sort()) {
    for (const phase of ['open', 'close']) {
      const alts = altList(rb[name], phase)
      const inA = altList(ra[name], phase)

      for (let i = 0; i < alts.length; i++) {
        for (let j = i + 1; j < alts.length; j++) {
          const x = alts[i].s as string[][] ?? []
          const y = alts[j].s as string[][] ?? []
          const sh = shadows(x, y)
          shadowChecked++
          if (null === sh) {
            shadowUndecidable++
            continue
          }
          if (!sh) {
            continue
          }
          // alts[j] is unreachable in B. Does it matter? Only if the same
          // alternate was REACHABLE in A — otherwise B merely inherited a
          // dead alt, which is not a change.
          const key = JSON.stringify(alts[j])
          const wasInA = inA.some((c) => JSON.stringify(c) === key)
          const wasShadowedInA = inA.some((c, ci) => {
            const cj = inA.findIndex((d) => JSON.stringify(d) === key)
            return -1 !== cj && ci < cj &&
              true === shadows(c.s as string[][] ?? [], y)
          })
          if (wasInA && !wasShadowedInA) {
            const cond = isConditional(alts[i])
            proven.push({
              claim: cond
                ? `rule '${name}'.${phase}: alternate ${j} MAY be shadowed ` +
                  `by alternate ${i}`
                : `rule '${name}'.${phase}: alternate ${j} is unreachable ` +
                  `in B, and was reachable in A`,
              basis: cond
                ? 'first-match-wins ordering; the shadowing alternate ' +
                  'carries a runtime condition (`c`), so shadowing is ' +
                  'possible but not certain'
                : 'first-match-wins ordering with position-wise token ' +
                  'subset (decidable)',
              status: cond ? 'not-proven' : 'proven',
              detail: `shadowing alternate: ${JSON.stringify(alts[i].s ?? null)}`,
            })
            changes.push({
              kind: 'newly-rejected',
              detail: `rule '${name}'.${phase} alternate ${j} became ` +
                `${cond ? 'possibly ' : ''}unreachable behind alternate ${i}`,
            })
          }
        }
      }
    }
  }

  if (0 < shadowChecked && 0 === shadowUndecidable) {
    proven.push({
      claim: 'every alternate pair was decidable for shadowing',
      basis: `${shadowChecked} ordered pairs compared position-wise; no ` +
        'runtime FuncRef in any token sequence',
      status: 'proven',
    })
  } else if (0 < shadowUndecidable) {
    proven.push({
      claim: 'some alternate pairs could not be decided',
      basis: `${shadowUndecidable} of ${shadowChecked} pairs have a token ` +
        'sequence computed at runtime (FuncRef), which no static analysis ' +
        'here can resolve',
      status: 'not-proven',
    })
  }

  // --- the honest limit ---------------------------------------------
  proven.push({
    claim: 'lexer-level language inclusion',
    basis: 'NOT ATTEMPTED. Regular-language inclusion between two regex ' +
      'token matchers is decidable by automata construction, and this tool ' +
      'does not implement it. Where a matcher regex differs, the tiers ' +
      'below supply evidence but no proof.',
    status: 'not-proven',
  })

  return { proven, changes }
}


// ---------------------------------------------------------------------
// Tier 2 — counterexample search
//
// Grammar-directed generation: walk B's rule graph to bounded depth, render
// each derivation to source, and test it against both grammars. A concrete
// counterexample is worth more than any score, because the reader can act on
// it immediately.

// Sample source text for the tokens a lexer produces rather than a literal
// table. Deliberately minimal and obviously-valid: the generator is looking
// for STRUCTURAL differences, and an exotic sample would find lexer
// differences it cannot then attribute.
const LEX_SAMPLES: Record<string, string> = {
  '#NR': '1',
  '#ST': '"s"',
  '#TX': 'x',
  '#VL': 'true',
  '#KEY': 'k',
  '#VAL': '1',
}

// Token name → its literal, read from the ENGINE rather than duplicated
// here: `tn.token` maps a name to its Tin and `tn.fixed` maps that Tin back
// to source text. A hard-coded punctuation table would be one more thing to
// drift out of step with the engine.
function literalTable(tn: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const inst = tn as { token?: Record<string, number>; fixed?: Record<string, unknown> }
  const token = inst?.token
  const fixed = inst?.fixed
  if (null == token || null == fixed) {
    return out
  }
  for (const [name, tin] of Object.entries(token)) {
    if ('#' !== name[0]) {
      continue
    }
    const src = (fixed as Record<string, unknown>)[String(tin)]
    if ('string' === typeof src) {
      out[name] = src
    }
  }
  return out
}

function renderToken(
  name: string, literals: Record<string, string>,
): string | null {
  if (undefined !== literals[name]) {
    return literals[name]
  }
  if (undefined !== LEX_SAMPLES[name]) {
    return LEX_SAMPLES[name]
  }
  return null
}

// Render one alternate's token sequence to source, honouring PUSH-BACK.
//
// `b: n` returns the last n matched tokens to the stream, so whatever runs
// next re-reads them. Emitting them here as well would double them —
// `val.open`'s `{ s: '#OB', p: 'map', b: 1 }` matches `{`, pushes it back, and
// `map` consumes it, so `val` must contribute nothing. Getting this wrong is
// how a generator produces `{{` and concludes the grammar rejects everything.
function emit(
  alt: Record<string, unknown>, literals: Record<string, string>,
): string | null {
  const seq = (alt.s as string[][]) ?? []
  const back = 'number' === typeof alt.b ? alt.b : 0
  const take = Math.max(0, seq.length - back)
  let text = ''
  for (let i = 0; i < take; i++) {
    const tok = seq[i][0]
    const lit = undefined === tok ? null : renderToken(tok, literals)
    if (null === lit) {
      return null
    }
    text += lit
  }
  return text
}

// Derivation over the rule graph: a rule's source is its open alternate, then
// any pushed child, then its close alternate. Depth bounds the descent,
// because the graph is cyclic by construction (a value contains a map
// contains a value).
//
// This models the engine, it is not the engine. A derivation it cannot render
// is skipped rather than guessed at, and the report says how many inputs
// actually ran — so "no counterexample" is never mistaken for "searched
// exhaustively".
function generate(
  g: Record<string, unknown>,
  literals: Record<string, string>,
  depth: number,
  cap: number,
): { inputs: string[]; capped: boolean } {
  const rules = ruleMap(g)
  const names = Object.keys(rules)
  if (0 === names.length) {
    return { inputs: [], capped: false }
  }
  // Start from the conventional entry rule when present, else every rule.
  const roots = names.includes('val') ? ['val'] : names

  const out: string[] = []
  const seen = new Set<string>()
  let capped = false

  const derive = (rule: string, d: number): string[] => {
    if (d > depth || undefined === rules[rule]) {
      return []
    }
    const closes = altList(rules[rule], 'close')
      .map((c) => emit(c, literals))
      .filter((c): c is string => null !== c)
    // A rule with no close alternate contributes no closing text.
    const tails = 0 === closes.length ? [''] : [...new Set(closes)]

    const results: string[] = []
    for (const alt of altList(rules[rule], 'open')) {
      const head = emit(alt, literals)
      if (null === head) {
        continue
      }
      const push = alt.p
      const middles = ('string' === typeof push && push !== rule)
        ? derive(push, d + 1)
        : ['']
      for (const mid of middles) {
        for (const tail of tails) {
          results.push(head + mid + tail)
          if (cap <= results.length) {
            capped = true
            return results
          }
        }
      }
    }
    return results
  }

  for (const root of roots) {
    for (const text of derive(root, 0)) {
      if ('' !== text && !seen.has(text)) {
        seen.add(text)
        out.push(text)
        if (cap <= out.length) {
          capped = true
          return { inputs: out, capped }
        }
      }
    }
  }

  return { inputs: out, capped }
}


// ---------------------------------------------------------------------
// Running both grammars

type Run =
  | { ok: true; tree: unknown }
  | { ok: false; code: string }

function runOne(tn: unknown, input: string): Run {
  try {
    const tree: unknown = (tn as { parse(s: string): unknown }).parse(input)
    return { ok: true, tree }
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    return { ok: false, code: 'string' === typeof code ? code : 'unknown' }
  }
}

// Tree comparison for OUTPUT compatibility. JSON of the tree, because that is
// what a downstream consumer actually receives — comparing internal node
// identity would report differences no consumer can observe.
function sameTree(x: unknown, y: unknown): boolean {
  try {
    return JSON.stringify(x) === JSON.stringify(y)
  } catch {
    return false
  }
}

function replay(
  tnA: unknown, tnB: unknown, inputs: string[], tier: 'generated' | 'corpus',
): { observed: Observed; changes: Change[]; counterexamples: Counterexample[] } {
  let bothAccept = 0
  let bothReject = 0
  const changes: Change[] = []
  const counterexamples: Counterexample[] = []

  for (const input of inputs) {
    const ra = runOne(tnA, input)
    const rb = runOne(tnB, input)

    if (ra.ok && !rb.ok) {
      // The finding that matters most: A accepted this and B does not.
      counterexamples.push({
        input,
        aAccepts: true,
        bAccepts: false,
        why: `A accepts; B rejects with '${rb.code}'`,
      })
      changes.push({ kind: 'newly-rejected', detail: rb.code, input })
      continue
    }
    if (!ra.ok && rb.ok) {
      bothReject += 0
      changes.push({
        kind: 'newly-accepted',
        detail: `A rejected with '${ra.code}'; B accepts`,
        input,
      })
      continue
    }
    if (!ra.ok && !rb.ok) {
      bothReject++
      continue
    }
    bothAccept++
    if (ra.ok && rb.ok && !sameTree(ra.tree, rb.tree)) {
      // Accepted by both, different tree. Acceptance testing reports success
      // here; the downstream consumer breaks anyway. This is the case Phase 5
      // exists to surface.
      changes.push({
        kind: 'tree-shape',
        detail: 'both accept, trees differ',
        input,
      })
      counterexamples.push({
        input,
        aAccepts: true,
        bAccepts: true,
        why: 'both accept, but the resulting trees differ',
      })
    }
  }

  return {
    observed: { tier, ran: inputs.length, bothAccept, bothReject },
    changes,
    counterexamples,
  }
}


// ---------------------------------------------------------------------
// compare_grammars

export function compareGrammars(req: CompareRequest): CompareResult {
  if (null == req || 'object' !== typeof req) {
    return invalid('$', 'request must be a JSON object')
  }
  if (null == req.a) {
    return invalid('$.a', 'a is required (the baseline grammar)')
  }
  if (null == req.b) {
    return invalid('$.b', 'b is required (the candidate grammar)')
  }

  // Both grammars go through the SAME firewall every other tool uses: no
  // non-builtin `ref`, no prototype-pollution keys, schema, engine load. A
  // hosted compare_grammars must be no more permissive than a hosted parse —
  // it takes two grammars instead of one, which is two chances to smuggle
  // code, not a reason to relax.
  const errors: ValidationIssue[] = []
  for (const [label, g] of [['a', req.a], ['b', req.b]] as const) {
    const res = validateGrammarInternal(g)
    for (const e of res.errors) {
      errors.push({ path: e.path.replace(/^\$/, `$.${label}`), message: e.message })
    }
  }
  if (0 < errors.length) {
    return { ok: false, errors }
  }

  const optbad = checkOptionsPublic(req.options)
  if (optbad) {
    return optbad
  }

  if (undefined !== req.corpus && !Array.isArray(req.corpus)) {
    return invalid('$.corpus', 'corpus must be an array of input strings')
  }
  const corpus = (req.corpus ?? []).filter((s) => 'string' === typeof s)
  if (MAX_CORPUS < corpus.length) {
    return invalid('$.corpus',
      `corpus has ${corpus.length} rows; the limit is ${MAX_CORPUS}`)
  }

  let depth = DEFAULT_DEPTH
  if (undefined !== req.depth) {
    if ('number' !== typeof req.depth || !Number.isInteger(req.depth) ||
      req.depth < 0 || MAX_DEPTH < req.depth) {
      return invalid('$.depth',
        `depth must be an integer in 0..${MAX_DEPTH}`)
    }
    depth = req.depth
  }

  const tnA = buildInstance(req.options, req.a)
  if (isInvalid(tnA)) {
    return tnA
  }
  const tnB = buildInstance(req.options, req.b)
  if (isInvalid(tnB)) {
    return tnB
  }

  const nfA = normalForm(req.a)
  const nfB = normalForm(req.b)
  const identical = nfA === nfB

  const { proven, changes } = tier1(req.a, req.b)
  const observed: Observed[] = []
  const counterexamples: Counterexample[] = []

  // Tier 2 — generated derivations from A, tested against B. Generating from
  // A is the direction that matters: the question is whether B still accepts
  // what A accepted.
  const gen = generate(req.a, literalTable(tnA), depth, MAX_GENERATED)
  if (0 < gen.inputs.length) {
    const r = replay(tnA, tnB, gen.inputs, 'generated')
    if (gen.capped) {
      r.observed.note = `generation stopped at the ${MAX_GENERATED}-input ` +
        'cap, so this is a sample, not an exhaustive search'
    }
    observed.push(r.observed)
    changes.push(...r.changes)
    counterexamples.push(...r.counterexamples)
  } else {
    observed.push({
      tier: 'generated',
      ran: 0,
      bothAccept: 0,
      bothReject: 0,
      note: 'no derivation could be rendered to source — every alternate ' +
        'needs a token whose text is neither a bound literal nor a known ' +
        'lexer sample',
    })
  }

  // Tier 3/4 — corpus replay, comparing acceptance AND tree shape.
  if (0 < corpus.length) {
    const r = replay(tnA, tnB, corpus, 'corpus')
    observed.push(r.observed)
    changes.push(...r.changes)
    counterexamples.push(...r.counterexamples)
  } else {
    observed.push({
      tier: 'corpus',
      ran: 0,
      bothAccept: 0,
      bothReject: 0,
      note: 'no corpus supplied; pass --corpus to replay real inputs, which ' +
        'is the only tier that measures what your documents actually do',
    })
  }

  const { confidence, why } = judge({
    identical, proven, observed, changes, counterexamples,
  })

  return {
    normalForm: { identical, a: nfA, b: nfB },
    proven,
    observed,
    changes,
    counterexamples,
    confidence,
    why,
  }
}


// Confidence is about how much weight the ABSENCE of findings can bear. It is
// never a restatement of "no changes found" — that is what `changes` already
// says. A run that found a counterexample is high-confidence about a
// DIFFERENCE; a run with no corpus and an unproven lexer change is
// low-confidence about anything.
function judge(x: {
  identical: boolean
  proven: Proven[]
  observed: Observed[]
  changes: Change[]
  counterexamples: Counterexample[]
}): { confidence: 'high' | 'medium' | 'low'; why: string } {
  if (x.identical) {
    return {
      confidence: 'high',
      why: 'the two normal forms are identical, so the grammars cannot ' +
        'differ in acceptance or output',
    }
  }

  if (0 < x.counterexamples.length) {
    return {
      confidence: 'high',
      why: `${x.counterexamples.length} concrete input(s) behave ` +
        'differently under the two grammars; a counterexample is direct ' +
        'evidence and needs no further support',
    }
  }

  const ran = x.observed.reduce((n, o) => n + o.ran, 0)
  const unproven = x.proven.filter((p) => 'not-proven' === p.status).length
  const corpusRan = x.observed.find((o) => 'corpus' === o.tier)?.ran ?? 0

  // A PROVEN structural change with no counterexample is the most easily
  // misread outcome in this whole report, so it gets its own answer rather
  // than falling into the empirical branches below. The static analysis
  // established that the grammars differ; the inputs that were run simply did
  // not reach the difference. Reporting that as "medium — everything agreed"
  // would invert the finding, which is exactly the wrong-verdict failure this
  // phase exists to avoid.
  const provenChange = x.proven.some((p) =>
    'proven' === p.status && (
      p.claim.includes('unreachable') ||
      p.claim.includes('does not define') ||
      p.claim.includes('drops fixed literals')))
  if (provenChange) {
    return {
      confidence: 'high',
      why: 'static analysis PROVED a structural difference (see `proven`), ' +
        `and none of the ${ran} input(s) run reached it. The grammars ` +
        'differ; the evidence here does not show how. Widen the corpus ' +
        'before concluding the difference is harmless.',
    }
  }

  if (0 === ran) {
    return {
      confidence: 'low',
      why: 'nothing was run: no corpus was supplied and no derivation could ' +
        'be generated, so the only basis is static analysis',
    }
  }

  if (0 < corpusRan && 2 >= unproven) {
    return {
      confidence: 'medium',
      why: `${ran} input(s) behaved identically under both grammars, ` +
        `including ${corpusRan} from the supplied corpus, and ` +
        `${unproven} area(s) remain unproven. Empirical agreement over a ` +
        'corpus is strong evidence, but it is not a proof of inclusion.',
    }
  }

  return {
    confidence: 'low',
    why: `${ran} input(s) agreed, but ${unproven} area(s) are unproven and ` +
      `${0 === corpusRan ? 'no corpus was replayed' : 'corpus coverage is ' +
        'thin'}. Absence of a counterexample from a bounded search is weak ` +
      'evidence.',
  }
}
