/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* core.test.js — unit tests for the six operations.
 *
 * The parse-failure diagnostic is validated against
 * data/diagnostic.schema.json with a dependency-free structural walk
 * (the walker idea from parser's ts/test/schema.test.js): no JSON Schema
 * package in the assertion path, so a test failure is about the
 * diagnostic, never about a validator's opinion of the schema.
 */

const { describe, it } = require('node:test')
const assert = require('node:assert')
const Fs = require('node:fs')
const Path = require('node:path')

const {
  parse, parseDetailed, validateGrammar, explainParseError, testGrammar,
  listPlugins, describePlugin, registryEntry, stringifyResult,
  MAX_TEST_ROWS, MAX_GRAMMAR_RULES,
} = require('../dist/core.js')

const DATA_DIR = Path.join(__dirname, '..', '..', 'data')

// A real serialized JSON grammar (function-free, engine builtins only) —
// parser's own json-builder fixture, copied here as a test fixture.
const GRAMMAR = JSON.parse(Fs.readFileSync(
  Path.join(__dirname, 'json-grammar.fixture.json'), 'utf8'))


// Minimal structural walk covering the keywords the bundled schemas use:
// type (with integer and const), anyOf, $ref into $defs, properties /
// additionalProperties, items, required, pattern, minimum.
function walk(data, schema, root, path, out) {
  path = path || '$'
  out = out || []

  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref)
    if (!m || !root.$defs || !root.$defs[m[1]]) {
      out.push(path + ': unresolvable $ref ' + schema.$ref)
      return out
    }
    return walk(data, root.$defs[m[1]], root, path, out)
  }

  if (schema.anyOf) {
    for (const sub of schema.anyOf) {
      if (0 === walk(data, sub, root, path, []).length) {
        return out
      }
    }
    out.push(path + ': no anyOf branch matched')
    return out
  }

  if (undefined !== schema.const && data !== schema.const) {
    out.push(path + ': expected const ' + JSON.stringify(schema.const))
    return out
  }

  if (schema.type) {
    const t = Array.isArray(data) ? 'array'
      : null === data ? 'null' : typeof data
    const ok = 'integer' === schema.type
      ? 'number' === t && Number.isInteger(data)
      : schema.type === t
    if (!ok) {
      out.push(path + ': expected ' + schema.type + ', got ' + t)
      return out
    }
  }

  if ('string' === typeof data && schema.pattern &&
    !new RegExp(schema.pattern).test(data)) {
    out.push(path + ': does not match pattern ' + schema.pattern)
  }

  if ('number' === typeof data && undefined !== schema.minimum &&
    data < schema.minimum) {
    out.push(path + ': below minimum ' + schema.minimum)
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((item, i) =>
      walk(item, schema.items, root, path + '[' + i + ']', out))
  }

  if (null !== data && 'object' === typeof data && !Array.isArray(data)) {
    const props = schema.properties || {}
    for (const req of schema.required || []) {
      if (!(req in data)) {
        out.push(path + ': missing required property "' + req + '"')
      }
    }
    for (const key of Object.keys(data)) {
      if (key in props) {
        walk(data[key], props[key], root, path + '.' + key, out)
      } else if (false === schema.additionalProperties) {
        out.push(path + ': unknown property "' + key + '"')
      } else if (schema.additionalProperties &&
        'object' === typeof schema.additionalProperties) {
        walk(data[key], schema.additionalProperties, root,
          path + '.' + key, out)
      }
    }
  }

  return out
}


describe('parse', () => {
  it('parses with a grammar', () => {
    const result = parse({ input: '{"a":1}', grammar: GRAMMAR })
    // The engine's @object$ builtin builds null-prototype maps; the JSON
    // bytes are the contract, so assert on the golden serialization.
    assert.strictEqual(stringifyResult(result), '{"ok":true,"tree":{"a":1}}')
  })

  it('bare engine: no grammar means no rules, undefined tree', () => {
    // The base instance is exactly what `new Tabnas()` gives — the bare
    // engine defines no rules, so every input yields an undefined tree,
    // which the golden serialization omits.
    const result = parse({ input: 'a:1' })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.tree, undefined)
    assert.strictEqual(stringifyResult(result), '{"ok":true}')
  })

  it('failure diagnostic satisfies data/diagnostic.schema.json', () => {
    const result = parse({ input: '{"a":', grammar: GRAMMAR })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.diagnostic.code, 'unexpected')

    const schema = JSON.parse(Fs.readFileSync(
      Path.join(DATA_DIR, 'diagnostic.schema.json'), 'utf8'))
    assert.deepStrictEqual(walk(result.diagnostic, schema, schema), [],
      'the diagnostic must satisfy the bundled diagnostic schema')
  })

  it('rendered engine message is carried beside (not inside) the result', () => {
    const { result, rendered } = parseDetailed(
      { input: '{"a":', grammar: GRAMMAR })
    assert.strictEqual(result.ok, false)
    assert.ok(rendered.includes('unexpected'),
      'rendered should be the engine\'s own error message')
    assert.ok(!('rendered' in result))
  })

  it('invalid grammar is rejected with the validate_grammar shape', () => {
    const result = parse({ input: 'x', grammar: { ref: {}, rule: {} } })
    assert.strictEqual(result.ok, false)
    assert.ok(Array.isArray(result.errors))
    assert.ok(result.errors.some((e) => '$.ref' === e.path))
  })

  it('non-string input is rejected', () => {
    const result = parse({ input: 42 })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.input')
  })

  it('options are applied before the grammar', () => {
    // A fixed token defined via options, used by the grammar's rules.
    const result = parse({
      input: '1+2',
      options: { fixed: { token: { '#PL': '+' } } },
      grammar: {
        options: { rule: { start: 'val' } },
        rule: {
          val: { open: [{ s: '#NR #PL #NR' }] },
        },
      },
    })
    assert.strictEqual(result.ok, true)
  })

  it('options carrying plugins are refused (code, not data)', () => {
    const result = parse({ input: 'x', options: { plugins: [] } })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.options.plugins')
  })
})


describe('validate_grammar', () => {
  it('accepts a real serialized grammar and reports v', () => {
    assert.deepStrictEqual(
      validateGrammar({ grammar: GRAMMAR }), { ok: true, v: 2 })
  })

  it('absent v means version 1', () => {
    assert.deepStrictEqual(
      validateGrammar({ grammar: { rule: { top: { open: [{ s: '#NR' }] } } } }),
      { ok: true, v: 1 })
  })

  it('rejects a ref key (functions are not data)', () => {
    const result = validateGrammar({ grammar: { ref: {}, rule: {} } })
    assert.strictEqual(result.ok, false)
    assert.ok(result.errors.some((e) =>
      '$.ref' === e.path && e.message.includes('code, not data')))
  })

  it('rejects a non-builtin FuncRef in an alt', () => {
    const result = validateGrammar({
      grammar: { rule: { top: { open: [{ s: '#NR', a: '@evil' }] } } },
    })
    assert.strictEqual(result.ok, false)
    assert.ok(result.errors.some((e) =>
      '$.rule.top.open[0].a' === e.path && e.message.includes("'@evil'")))
  })

  it('rejects a non-builtin FuncRef in an action array and in close alts', () => {
    const result = validateGrammar({
      grammar: {
        rule: {
          top: {
            open: [{ s: '#NR', a: ['@node$', '@sneaky'] }],
            close: [{ s: '#NR', p: '@also-bad' }],
          },
        },
      },
    })
    assert.strictEqual(result.ok, false)
    const paths = result.errors.map((e) => e.path)
    assert.ok(paths.includes('$.rule.top.open[0].a[1]'))
    assert.ok(paths.includes('$.rule.top.close[0].p'))
  })

  it('rejects a ref-shaped non-builtin in options, allows sentinels', () => {
    const bad = validateGrammar({
      grammar: { options: { value: { def: { x: { val: '@steal' } } } } },
    })
    assert.strictEqual(bad.ok, false)
    assert.ok(bad.errors[0].message.includes("'@steal'"))

    // '@@literal' (escape), '@SKIP', '@/re/' and a bare '@' are data, not
    // function references; a $-suffixed builtin is allowed.
    const good = validateGrammar({
      grammar: {
        options: {
          a: '@@literal',
          b: '@SKIP',
          c: '@/ab+/i',
          d: '@~/ab+/i',
          e: '@',
          f: '@node$',
        },
      },
    })
    assert.deepStrictEqual(good, { ok: true, v: 1 })
  })

  it('accepts builtin FuncRefs in alts', () => {
    assert.deepStrictEqual(
      validateGrammar({
        grammar: { rule: { top: { open: [{ s: '#NR', a: '@node$' }] } } },
      }),
      { ok: true, v: 1 })
  })

  it('structural layer: a bogus alt key fails against the schema', () => {
    const result = validateGrammar({
      grammar: { rule: { top: { open: [{ s: '#NR', zz: 1 }] } } },
    })
    assert.strictEqual(result.ok, false)
    assert.ok(result.errors.some((e) => e.message.includes("'zz'")),
      JSON.stringify(result.errors))
  })

  it('engine layer: a structurally valid grammar the engine refuses', () => {
    // v:99 passes the schema (deliberately no maximum there — the ceiling
    // is the engine's), then the engine load rejects it, and the thrown
    // message is the error.
    const result = validateGrammar({ grammar: { v: 99, rule: {} } })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors.length, 1)
    assert.strictEqual(result.errors[0].path, '$')
    assert.ok(result.errors[0].message.includes('builtin schema version 99'))
  })

  it('rejects a non-object grammar', () => {
    for (const grammar of [null, [], 'x', 7]) {
      const result = validateGrammar({ grammar })
      assert.strictEqual(result.ok, false, JSON.stringify(grammar))
    }
    const missing = validateGrammar({})
    assert.strictEqual(missing.ok, false)
    assert.strictEqual(missing.errors[0].path, '$.grammar')
  })
})


describe('firewall: prototype pollution (ADR-10 ship-blocker)', () => {
  // The engine's grammar install deep-merges the spec with no __proto__
  // guard, so a poison key anywhere in a grammar or in request options
  // would pollute Object.prototype for the whole process. The firewall
  // must reject it on EVERY grammar-accepting op and on request options,
  // through the validate_grammar error shape, and — the proof that
  // matters — no pollution must occur.

  const POISON_KEYS = ['__proto__', 'constructor', 'prototype']

  // Build via JSON.parse so `__proto__` is a real own property, exactly
  // as a request coming off the wire (or a --grammar file) would be.
  function poisonGrammarInOptions(key) {
    return JSON.parse(
      `{"rule":{},"options":{"${key}":{"polluted_by_${key}":"yes"}}}`)
  }
  function poisonGrammarInAltData(key, altKey) {
    return JSON.parse(
      `{"rule":{"t":{"open":[{"s":"#NR","${altKey}":` +
      `{"${key}":{"polluted_by_${key}":"yes"}}}]}}}`)
  }

  it('validate_grammar rejects each poison key in options', () => {
    for (const key of POISON_KEYS) {
      const result = validateGrammar({ grammar: poisonGrammarInOptions(key) })
      assert.strictEqual(result.ok, false, key)
      assert.strictEqual(result.errors[0].path, `$.options.${key}`)
      assert.ok(result.errors[0].message.includes('prototype pollution'), key)
    }
  })

  it('validate_grammar rejects each poison key nested in alt u and k', () => {
    for (const key of POISON_KEYS) {
      for (const altKey of ['u', 'k']) {
        const result = validateGrammar({
          grammar: poisonGrammarInAltData(key, altKey),
        })
        assert.strictEqual(result.ok, false, `${key} in ${altKey}`)
        assert.strictEqual(result.errors[0].path,
          `$.rule.t.open[0].${altKey}.${key}`)
      }
    }
  })

  it('every grammar-accepting op rejects a poison grammar, no pollution', () => {
    const sentinels = POISON_KEYS.map((k) => `polluted_by_${k}`)
    for (const key of POISON_KEYS) {
      const runners = [
        () => parse({ input: '1', grammar: poisonGrammarInOptions(key) }),
        () => parse({ input: '1', grammar: poisonGrammarInAltData(key, 'u') }),
        () => explainParseError(
          { input: '1', grammar: poisonGrammarInAltData(key, 'k') }),
        () => testGrammar({
          spec: 'input\texpected\n1\t1\n',
          grammar: poisonGrammarInOptions(key),
        }),
      ]
      for (const run of runners) {
        const result = run()
        assert.strictEqual(result.ok, false, key)
        assert.ok(result.errors[0].message.includes('prototype pollution'))
      }
    }
    // The proof: nothing reached Object.prototype.
    const probe = {}
    for (const s of sentinels) {
      assert.strictEqual(probe[s], undefined,
        `Object.prototype was polluted with ${s}`)
    }
  })

  it('request-level options: a poison key is rejected, no pollution', () => {
    const req = {
      input: 'x',
      options: JSON.parse('{"foo":{"__proto__":{"pwned":true}}}'),
    }
    const result = parse(req)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.options.foo.__proto__')
    assert.strictEqual(({}).pwned, undefined,
      'Object.prototype was polluted via request options')
  })

  it('positive: a legitimate $-builtin grammar still passes', () => {
    // Do not over-reject: @node$ and the json-builder fixture are clean.
    assert.deepStrictEqual(
      validateGrammar({
        grammar: { rule: { top: { open: [{ s: '#NR', a: '@node$' }] } } },
      }),
      { ok: true, v: 1 })
    assert.deepStrictEqual(
      validateGrammar({ grammar: GRAMMAR }), { ok: true, v: 2 })
  })
})


describe('firewall: plugins are refused as data (not just at request level)', () => {
  it('a plugins key inside grammar.options is rejected', () => {
    for (const op of [
      (g) => validateGrammar({ grammar: g }),
      (g) => parse({ input: '1', grammar: g }),
      (g) => explainParseError({ input: '1', grammar: g }),
      (g) => testGrammar({ spec: 'input\texpected\n1\t1\n', grammar: g }),
    ]) {
      const result = op({ options: { plugins: [] }, rule: {} })
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.errors[0].path, '$.options.plugins')
    }
  })

  it('a plugins key in request options is still rejected', () => {
    const result = parse({ input: 'x', options: { plugins: [] } })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.options.plugins')
  })
})


describe('firewall: grammar rule-count cap (CPU-DoS bound)', () => {
  function grammarWith(nRules) {
    const rule = {}
    for (let i = 0; i < nRules; i++) {
      rule['r' + i] = { open: [{ s: '#NR' }] }
    }
    return { rule }
  }

  it('rejects a grammar over MAX_GRAMMAR_RULES', () => {
    const result = validateGrammar(
      { grammar: grammarWith(MAX_GRAMMAR_RULES + 1) })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.rule')
    assert.ok(result.errors[0].message.includes(String(MAX_GRAMMAR_RULES)))
  })

  it('accepts a grammar exactly at the cap', () => {
    const result = validateGrammar({ grammar: grammarWith(MAX_GRAMMAR_RULES) })
    assert.strictEqual(result.ok, true)
  })

  it('the cap is checked before the engine load on parse too', () => {
    const result = parse(
      { input: '1', grammar: grammarWith(MAX_GRAMMAR_RULES + 1) })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.rule')
  })
})


describe('non-diagnostic engine throw becomes the clean errors shape', () => {
  it('options.parser.start:"x" -> {ok:false} with an empty path', () => {
    // A non-function start is neither a diagnostic nor a validation
    // finding; without the catch one front-end would surface a raw
    // TypeError and the other something else. Both must see {ok:false}.
    const result = parse({ input: '1', options: { parser: { start: 'x' } } })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '')
    assert.strictEqual(typeof result.errors[0].message, 'string')

    // parseDetailed carries no `rendered` for this path (there is no
    // engine-rendered frame — it was a raw throw).
    const detailed = parseDetailed(
      { input: '1', options: { parser: { start: 'x' } } })
    assert.strictEqual(detailed.result.ok, false)
  })
})


describe('explain_parse_error', () => {
  it('reports failed:false for a clean parse', () => {
    assert.deepStrictEqual(
      explainParseError({ input: '[1]', grammar: GRAMMAR }),
      { failed: false })
  })

  it('returns the diagnostic plus its registry entry', () => {
    const result = explainParseError({ input: '{"a":', grammar: GRAMMAR })
    assert.strictEqual(result.failed, true)
    assert.strictEqual(result.diagnostic.code, 'unexpected')

    const registry = JSON.parse(Fs.readFileSync(
      Path.join(DATA_DIR, 'error-codes.json'), 'utf8'))
    assert.deepStrictEqual(result.registry, {
      code: 'unexpected',
      message: registry.codes.unexpected.message,
      hint: registry.codes.unexpected.hint,
    })
  })

  it('registry is null for a code the registry does not know', () => {
    assert.strictEqual(registryEntry('no_such_plugin_code'), null)
    assert.ok(null != registryEntry('unexpected'))
  })
})


describe('test_grammar', () => {
  const TSV = [
    'input\texpected',
    '{"a":1}\t{"a":1}',
    '[1,2]\t[1,2]',
    'nope\tERROR:unexpected',
    '[1,2\tERROR',
    '{"a":2}\t{"a":3}',
    '[3]\tERROR:unexpected',
  ].join('\n') + '\n'

  it('counts pass and fail rows, reporting each', () => {
    const result = testGrammar({ grammar: GRAMMAR, spec: TSV })
    assert.strictEqual(result.pass, 4)
    assert.strictEqual(result.fail, 2)
    assert.strictEqual(result.rows.length, 6)

    // Physical line numbers, raw expected cells, rendered got cells.
    assert.deepStrictEqual(result.rows[0], {
      row: 2, input: '{"a":1}', expected: '{"a":1}',
      got: '{"a":1}', ok: true,
    })
    assert.deepStrictEqual(result.rows[2], {
      row: 4, input: 'nope', expected: 'ERROR:unexpected',
      got: 'ERROR:unexpected', ok: true,
    })
    // A value row whose parse succeeded with the wrong value.
    assert.deepStrictEqual(result.rows[4], {
      row: 6, input: '{"a":2}', expected: '{"a":3}',
      got: '{"a":2}', ok: false,
    })
    // An ERROR row whose parse succeeded.
    assert.deepStrictEqual(result.rows[5], {
      row: 7, input: '[3]', expected: 'ERROR:unexpected',
      got: '[3]', ok: false,
    })
  })

  it('escape-decodes the input column (fleet fixture convention)', () => {
    const result = testGrammar({
      grammar: GRAMMAR,
      spec: 'input\texpected\n[1,\\n2]\t[1,2]\n',
    })
    assert.strictEqual(result.pass, 1)
    assert.strictEqual(result.rows[0].input, '[1,\n2]')
  })

  it('selects columns by header name', () => {
    const result = testGrammar({
      grammar: GRAMMAR,
      spec: 'note\tsrc\twant\nfirst\t[1]\t[1]\n',
      options: { inputCol: 'src', expectedCol: 'want' },
    })
    assert.strictEqual(result.pass, 1)

    const bad = testGrammar({
      grammar: GRAMMAR,
      spec: 'input\texpected\n[1]\t[1]\n',
      options: { inputCol: 'nope' },
    })
    assert.strictEqual(bad.ok, false)
    assert.strictEqual(bad.errors[0].path, '$.options.inputCol')
  })

  it('refuses more than MAX_TEST_ROWS rows', () => {
    const rows = new Array(MAX_TEST_ROWS + 1).fill('[1]\t[1]')
    const result = testGrammar({
      grammar: GRAMMAR,
      spec: 'input\texpected\n' + rows.join('\n') + '\n',
    })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.spec')
    assert.ok(result.errors[0].message.includes(String(MAX_TEST_ROWS)))
  })

  it('refuses an empty spec (a silent pass is not a pass)', () => {
    const result = testGrammar({ grammar: GRAMMAR, spec: 'input\texpected\n' })
    assert.strictEqual(result.ok, false)
  })

  it('an invalid expected-JSON cell fails the operation, naming the row', () => {
    const result = testGrammar({
      grammar: GRAMMAR,
      spec: 'input\texpected\n[1]\t{nope\n',
    })
    assert.strictEqual(result.ok, false)
    assert.ok(result.errors[0].message.includes('spec.tsv:2'))
  })
})


describe('plugins', () => {
  it('lists every bundled descriptor, sorted by name', () => {
    const { plugins } = listPlugins()
    assert.ok(0 < plugins.length)
    const names = plugins.map((p) => p.name)
    assert.deepStrictEqual(names, [...names].sort())
    for (const p of plugins) {
      assert.strictEqual(typeof p.name, 'string')
      assert.strictEqual(typeof p.description, 'string')
    }
  })

  it('describes a plugin by package name and by bare fleet name', () => {
    const byFull = describePlugin({ name: '@tabnas/csv' })
    assert.strictEqual(byFull.name, '@tabnas/csv')
    const byBare = describePlugin({ name: 'csv' })
    assert.deepStrictEqual(byBare, byFull)
  })

  it('not-found names the known plugins', () => {
    const result = describePlugin({ name: 'no-such-plugin' })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errors[0].path, '$.name')
    assert.ok(result.errors[0].message.includes('@tabnas/csv'))
  })
})
