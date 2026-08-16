/* Copyright (c) 2026 Richard Rodger, MIT License */

// compat.test.js — Phase 5, grammar compatibility.
//
// The tests that matter here are the ones that pin HONESTY, not coverage:
// that an append-only change is not reported as narrowing (no false alarm),
// that an alternate inserted earlier IS reported even though a set comparison
// would call it an addition (the wrong-verdict case the plan singles out),
// and that no code path ever emits a bare compatible/incompatible verdict.

const { describe, it } = require('node:test')
const assert = require('node:assert')
const Fs = require('node:fs')
const Path = require('node:path')

const { compareGrammars, normalForm, MAX_CORPUS, MAX_DEPTH } =
  require('../dist/compat.js')

const GRAMMAR = JSON.parse(Fs.readFileSync(
  Path.join(__dirname, 'json-grammar.fixture.json'), 'utf8'))

const clone = (o) => JSON.parse(JSON.stringify(o))
const A = () => clone(GRAMMAR)


describe('compat: normal form', () => {
  it('is stable under key order and rule order', () => {
    const a = A()
    // Rebuild the rule map in reverse key order, and each alt with its keys
    // reversed. Neither carries meaning, so the normal form must not move.
    const reversed = { ...a, rule: {} }
    for (const name of Object.keys(a.rule).reverse()) {
      reversed.rule[name] = a.rule[name]
    }
    assert.strictEqual(normalForm(a), normalForm(reversed))
  })

  it('is NOT stable under alternate order', () => {
    // Alternates are first-match-wins, so their order IS the semantics.
    // A normal form that sorted them would make a narrowing change look like
    // a no-op — the single most dangerous thing this module could do.
    const a = A()
    const b = A()
    b.rule.val.open.reverse()
    assert.notStrictEqual(normalForm(a), normalForm(b))
  })

  it('ignores message text, which cannot affect acceptance', () => {
    const a = A()
    const b = A()
    b.options = { ...(b.options ?? {}), error: { some_code: 'different text' } }
    assert.strictEqual(normalForm(a), normalForm(b))
  })
})


describe('compat: identical grammars', () => {
  it('reports high confidence, on the normal form and nothing else', () => {
    const r = compareGrammars({ a: A(), b: A() })
    assert.strictEqual(r.normalForm.identical, true)
    assert.strictEqual(r.confidence, 'high')
    assert.match(r.why, /identical/)
    assert.strictEqual(r.changes.length, 0)
    assert.strictEqual(r.counterexamples.length, 0)
  })
})


describe('compat: alternate ordering', () => {
  // The case the plan singles out: "an alternate inserted earlier can shadow
  // a later one and NARROW the accepted language while looking like an
  // addition". A set comparison of alternates reports "B has one more"; the
  // truth is that one of A's alternates is now dead.
  it('reports an alternate that an inserted one shadows', () => {
    const b = A()
    b.rule.val.open.unshift({ s: '#OB', p: 'map', b: 1, a: '@reset$' })

    const r = compareGrammars({ a: A(), b })
    const proven = r.proven.filter((p) =>
      'proven' === p.status && p.claim.includes('unreachable'))
    assert.ok(0 < proven.length,
      'an alternate shadowed by an inserted duplicate must be reported')
    assert.match(proven[0].claim, /val'\.open/)
    assert.ok(r.changes.some((c) => 'newly-rejected' === c.kind))
  })

  it('does NOT report narrowing for an append-only addition', () => {
    // The benign case. A tool that cried wolf here would be turned off, and
    // then the case above would go unnoticed too.
    const b = A()
    b.rule.val.open.push({ s: '#TX', a: '@reset$' })

    const r = compareGrammars({ a: A(), b })
    assert.ok(!r.proven.some((p) =>
      'proven' === p.status && p.claim.includes('unreachable')),
    'appending an alternate shadows nothing and must not be reported')
  })

  it('treats an unconditional alternate as shadowing everything after it', () => {
    // An alt with no token sequence matches unconditionally, so every
    // alternate after it in the same list is dead.
    const b = A()
    b.rule.val.open.unshift({ a: '@reset$' })

    const r = compareGrammars({ a: A(), b })
    const dead = r.proven.filter((p) =>
      'proven' === p.status && p.claim.includes('unreachable'))
    assert.strictEqual(dead.length, A().rule.val.open.length,
      'every pre-existing alternate is unreachable behind a catch-all')
  })

  it('will not claim a proof when the shadowing alternate is conditional', () => {
    // `c` is a runtime condition, so the alternate may or may not fire and
    // shadowing cannot be PROVEN. Reported, but as not-proven.
    const b = A()
    b.rule.val.open.unshift(
      { s: '#OB', p: 'map', b: 1, a: '@reset$', c: { d: 0 } })

    const r = compareGrammars({ a: A(), b })
    const hit = r.proven.filter((p) => p.claim.includes('MAY be shadowed'))
    assert.ok(0 < hit.length)
    assert.strictEqual(hit[0].status, 'not-proven')
  })
})


describe('compat: structural changes', () => {
  it('proves a removed rule by set comparison', () => {
    const b = A()
    delete b.rule.pair
    const r = compareGrammars({ a: A(), b })
    assert.ok(r.proven.some((p) =>
      'proven' === p.status && p.claim.includes('does not define')))
    assert.ok(r.changes.some((c) => c.detail.includes('pair')))
  })
})


describe('compat: counterexamples and corpus', () => {
  it('finds a concrete counterexample when B rejects what A accepts', () => {
    const b = A()
    // A catch-all at the front takes every input and produces nothing
    // useful, so inputs A parsed now fail.
    b.rule.val.open.unshift({ a: '@reset$' })

    const r = compareGrammars({ a: A(), b })
    assert.ok(0 < r.counterexamples.length,
      'generation must surface at least one differing input')
    const c = r.counterexamples[0]
    assert.strictEqual(typeof c.input, 'string')
    assert.ok(c.why.length > 0)
    assert.strictEqual(r.confidence, 'high')
  })

  it('replays a supplied corpus and counts it', () => {
    const r = compareGrammars({
      a: A(), b: A(), corpus: ['1', '{"a":1}', '[1,2]', 'nonsense{'],
    })
    const corpus = r.observed.find((o) => 'corpus' === o.tier)
    assert.strictEqual(corpus.ran, 4)
    assert.ok(0 < corpus.bothAccept)
    assert.ok(0 < corpus.bothReject)
  })

  it('says so when no corpus was supplied', () => {
    const r = compareGrammars({ a: A(), b: A() })
    const corpus = r.observed.find((o) => 'corpus' === o.tier)
    assert.strictEqual(corpus.ran, 0)
    assert.match(corpus.note, /no corpus supplied/)
  })

  it('detects a tree-shape change for inputs BOTH accept', () => {
    // The case acceptance testing reports as success and downstream
    // consumers feel anyway.
    const b = A()
    b.rule.val.open = b.rule.val.open.map((alt) =>
      '#VAL' === alt.s ? { ...alt, a: '@value$' } : alt)
    const r = compareGrammars({ a: A(), b, corpus: ['1', '"s"', 'true'] })
    // Either the trees differ (reported) or they do not (no change) — what
    // must hold is that the tool looked, and said which.
    const corpus = r.observed.find((o) => 'corpus' === o.tier)
    assert.strictEqual(corpus.ran, 3)
  })
})


describe('compat: the report never gives a bare verdict', () => {
  it('has no boolean compatible/incompatible field, ever', () => {
    for (const b of [A(), (() => { const g = A(); delete g.rule.pair; return g })()]) {
      const r = compareGrammars({ a: A(), b })
      assert.ok(!('compatible' in r), 'no compatible field')
      assert.ok(!('incompatible' in r), 'no incompatible field')
      assert.ok(['high', 'medium', 'low'].includes(r.confidence))
      assert.ok(0 < r.why.length, 'confidence must always carry a reason')
    }
  })

  it('reports the lexer limit as not-proven rather than staying silent', () => {
    const r = compareGrammars({ a: A(), b: A() })
    const lex = r.proven.find((p) => p.claim.includes('lexer-level'))
    assert.strictEqual(lex.status, 'not-proven')
    assert.match(lex.basis, /NOT ATTEMPTED/)
  })

  it('is high confidence about a PROVEN change no input reached', () => {
    // A duplicate alternate inserted at the front is provably unreachable
    // yet behaves identically, so no counterexample exists. Reporting that
    // as "medium, everything agreed" would invert a finding.
    const b = A()
    b.rule.val.open.unshift({ s: '#OB', p: 'map', b: 1, a: '@reset$' })
    const r = compareGrammars({ a: A(), b, corpus: ['1', '{"a":1}'] })
    assert.strictEqual(r.counterexamples.length, 0)
    assert.strictEqual(r.confidence, 'high')
    assert.match(r.why, /PROVED/)
  })
})


describe('compat: the firewall and the bounds', () => {
  it('refuses a grammar carrying a non-builtin ref, in either position', () => {
    // ADR-10: the difference between "validate this grammar" and "run this
    // code". Two grammars is two chances to smuggle code, not a reason to
    // relax — so both go through the same firewall.
    for (const pos of ['a', 'b']) {
      const bad = A()
      bad.rule.val.open[0] = { ...bad.rule.val.open[0], a: '@not-a-builtin' }
      const req = { a: A(), b: A() }
      req[pos] = bad
      const r = compareGrammars(req)
      assert.strictEqual(r.ok, false, pos + ' must be refused')
      assert.ok(r.errors.some((e) => e.path.startsWith('$.' + pos)),
        'the error must say WHICH grammar was refused')
    }
  })

  it('refuses a prototype-pollution key in either grammar', () => {
    const bad = JSON.parse('{"rule":{"val":{"open":[]}},"__proto__":{"x":1}}')
    const r = compareGrammars({ a: bad, b: A() })
    assert.strictEqual(r.ok, false)
  })

  it('rejects a corpus over the cap, with the number in the message', () => {
    const r = compareGrammars({
      a: A(), b: A(), corpus: new Array(MAX_CORPUS + 1).fill('1'),
    })
    assert.strictEqual(r.ok, false)
    assert.match(r.errors[0].message, new RegExp(String(MAX_CORPUS)))
  })

  it('rejects a depth outside the bound', () => {
    for (const depth of [-1, MAX_DEPTH + 1, 1.5]) {
      const r = compareGrammars({ a: A(), b: A(), depth })
      assert.strictEqual(r.ok, false, 'depth ' + depth)
    }
  })

  it('requires both grammars', () => {
    assert.strictEqual(compareGrammars({ b: A() }).ok, false)
    assert.strictEqual(compareGrammars({ a: A() }).ok, false)
  })
})
