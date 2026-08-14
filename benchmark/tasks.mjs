/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* tasks.mjs — the ten AX benchmark tasks, as data.
 *
 * Each task is a self-contained job an agent is asked to do with tabnas, and
 * a CHECK that decides mechanically whether it did it. The check is the
 * important half: "did the agent seem to manage?" is not a measurement, and a
 * grader nobody has tried to fool is not evidence.
 *
 * Every task therefore carries three things beside its prompt:
 *
 *   setup      files materialised into a fresh working directory before the
 *              agent starts. This is the task's starting state.
 *   solve      a REFERENCE solution — what a correct answer does. It exists
 *              so `run.mjs --self-test` can prove the task is solvable and
 *              the check passes on a real solution, rather than the task
 *              silently rotting into something impossible.
 *   spoil      a plausible WRONG answer. `run.mjs --self-test` requires the
 *              check to reject it. A check that cannot fail measures nothing,
 *              and every check here has been made to fail on purpose once.
 *
 * The tasks are the ten from the agent-experience plan (§29): install, parse,
 * create a grammar, fix a broken grammar, explain a failure, add a rule,
 * write fixtures, upgrade a plugin, compare two grammars, integrate.
 *
 * Scoring an actual agent is a separate activity — see README.md. This file
 * defines what "done" means; it does not run agents, and nothing here should
 * be read as a claim that any agent has been measured.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// --- shared fixtures --------------------------------------------------------

// A minimal JSON grammar in the serialized GrammarSpec form the CLI accepts.
// Small on purpose: a task should fail because the agent got it wrong, not
// because the fixture was too big to reason about.
export const JSON_GRAMMAR = {
  v: 2,
  options: { tokenSet: { KEY: ['#ST'], VAL: ['#ST', '#NR', '#VL'] } },
  rule: {
    val: {
      open: [
        { s: '#OB', p: 'map', b: 1, a: '@reset$' },
        { s: '#OS', p: 'list', b: 1, a: '@reset$' },
        { s: '#VAL', a: '@reset$' },
      ],
      close: [
        { s: '#ZZ', a: '@value$' },
        { b: 1, a: '@value$' },
      ],
    },
    map: {
      open: [
        { s: '#OB #CB', b: 1, a: '@object$' },
        { s: '#OB', p: 'pair', a: '@object$' },
      ],
      close: [{ s: '#CB' }],
    },
    list: {
      open: [
        { s: '#OS #CS', b: 1, a: '@array$' },
        { s: '#OS', p: 'elem', a: '@array$' },
      ],
      close: [{ s: '#CS' }],
    },
    pair: {
      open: [{ s: '#KEY #CL', p: 'val', a: '@key$' }],
      close: [
        { s: '#CA', r: 'pair', a: '@setval$' },
        { b: 1, a: '@setval$' },
      ],
    },
    elem: {
      open: [{ p: 'val' }],
      close: [
        { s: '#CA', r: 'elem', a: '@push$' },
        { b: 1, a: '@push$' },
      ],
    },
  },
}

const json = (v) => JSON.stringify(v, null, 2) + '\n'

// Read a file the agent was asked to produce. Missing or unreadable is a
// failure of the task, not of the harness, so it is reported as such rather
// than thrown.
function read(dir, name) {
  try {
    return readFileSync(join(dir, name), 'utf8')
  } catch {
    return null
  }
}

function readJson(dir, name) {
  const text = read(dir, name)
  if (text === null) return { ok: false, why: `${name} was not created` }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, why: `${name} is not valid JSON: ${e.message}` }
  }
}

const pass = () => ({ pass: true })
const fail = (why) => ({ pass: false, why })

// --- the ten tasks ----------------------------------------------------------

export const TASKS = [
  {
    id: '01-install',
    title: 'Install tabnas and prove it runs',
    // Deliberately does not name the command: finding it is the task. An
    // agent that has read the docs knows `tabnas` ships from @tabnas/mcp.
    prompt:
      'Make the tabnas command-line tool available, and write the version it ' +
      'reports to version.txt in the working directory.',
    measures: ['completion', 'invalid commands attempted'],
    setup() {},
    solve(dir, { cli }) {
      writeFileSync(join(dir, 'version.txt'), cli(['--version']).stdout)
    },
    spoil(dir) {
      writeFileSync(join(dir, 'version.txt'), 'tabnas 9.9.9\n')
    },
    check(dir, { pkgVersion }) {
      const text = read(dir, 'version.txt')
      if (text === null) return fail('version.txt was not created')
      if (!text.includes(pkgVersion)) {
        return fail(`version.txt says ${text.trim()}, not the installed ${pkgVersion}`)
      }
      return pass()
    },
  },

  {
    id: '02-parse',
    title: 'Parse a supplied document',
    prompt:
      'Parse input.json with the grammar in grammar.json and write the ' +
      'resulting value to out.json.',
    measures: ['completion', 'steps to first successful parse'],
    setup(dir) {
      writeFileSync(join(dir, 'grammar.json'), json(JSON_GRAMMAR))
      writeFileSync(join(dir, 'input.json'), '{"a":1,"b":[2,3]}')
    },
    solve(dir, { cli }) {
      const res = cli(['parse', 'input.json', '--grammar', 'grammar.json', '--json'], dir)
      writeFileSync(join(dir, 'out.json'), json(JSON.parse(res.stdout).tree))
    },
    spoil(dir) {
      writeFileSync(join(dir, 'out.json'), json({ a: 1 }))
    },
    check(dir) {
      const got = readJson(dir, 'out.json')
      if (!got.ok) return fail(got.why)
      const want = { a: 1, b: [2, 3] }
      return JSON.stringify(got.value) === JSON.stringify(want)
        ? pass()
        : fail(`out.json is ${JSON.stringify(got.value)}, expected ${JSON.stringify(want)}`)
    },
  },

  {
    id: '03-create-grammar',
    title: 'Create a simple grammar',
    prompt:
      'Write grammar.json: a tabnas grammar that parses a bare comma-separated ' +
      'list of numbers, such as "1,2,3", into an array. It must validate with ' +
      '`tabnas validate` and parse samples/list.txt.',
    measures: ['completion', 'retries', 'hallucinated APIs'],
    setup(dir, { mkdir }) {
      mkdir(join(dir, 'samples'))
      writeFileSync(join(dir, 'samples', 'list.txt'), '1,2,3')
    },
    solve(dir) {
      // The list/elem/val machinery from the JSON grammar, started at `list`
      // and with the brackets removed: a bare comma-separated sequence. The
      // `val` rule is kept rather than folded into `elem` — it is what runs
      // @value$ to turn the matched token into the element's node, and
      // without it the array comes out empty.
      writeFileSync(
        join(dir, 'grammar.json'),
        json({
          v: 2,
          options: { rule: { start: 'list' }, tokenSet: { VAL: ['#NR'] } },
          rule: {
            list: {
              open: [{ p: 'elem', a: '@array$' }],
              close: [{ s: '#ZZ' }, { b: 1 }],
            },
            elem: {
              open: [{ p: 'val' }],
              close: [
                { s: '#CA', r: 'elem', a: '@push$' },
                { b: 1, a: '@push$' },
              ],
            },
            val: {
              open: [{ s: '#VAL', a: '@reset$' }],
              close: [
                { s: '#ZZ', a: '@value$' },
                { b: 1, a: '@value$' },
              ],
            },
          },
        }),
      )
    },
    spoil(dir) {
      // Valid JSON, but not a grammar the engine will accept.
      writeFileSync(join(dir, 'grammar.json'), json({ rules: 'numbers separated by commas' }))
    },
    check(dir, { cli }) {
      const valid = cli(['validate', '--grammar', 'grammar.json'], dir)
      if (valid.status !== 0) return fail('`tabnas validate` rejected grammar.json')
      const parsed = cli(
        ['parse', 'samples/list.txt', '--grammar', 'grammar.json', '--json'],
        dir,
      )
      if (parsed.status !== 0) return fail('the grammar did not parse samples/list.txt')
      let value
      try {
        value = JSON.parse(parsed.stdout).tree
      } catch {
        return fail('parse output was not JSON')
      }
      return Array.isArray(value) && value.length === 3
        ? pass()
        : fail(`parsed ${JSON.stringify(value)}, expected an array of three numbers`)
    },
  },

  {
    id: '04-fix-grammar',
    title: 'Fix a deliberately broken grammar',
    prompt:
      'grammar.json is rejected by `tabnas validate`. Fix it in place so it ' +
      'validates and still parses input.json.',
    measures: ['completion', 'retries', 'steps to first successful parse'],
    setup(dir) {
      // `p` names a rule that does not exist. The engine reports this, so the
      // task is diagnosable rather than guesswork.
      const broken = structuredClone(JSON_GRAMMAR)
      broken.rule.val.open[0].p = 'mapp'
      writeFileSync(join(dir, 'grammar.json'), json(broken))
      writeFileSync(join(dir, 'input.json'), '{"a":1}')
    },
    solve(dir) {
      const g = JSON.parse(readFileSync(join(dir, 'grammar.json'), 'utf8'))
      g.rule.val.open[0].p = 'map'
      writeFileSync(join(dir, 'grammar.json'), json(g))
    },
    spoil() {
      // Change nothing: the grammar stays broken.
    },
    check(dir, { cli }) {
      const valid = cli(['validate', '--grammar', 'grammar.json'], dir)
      if (valid.status !== 0) return fail('grammar.json still does not validate')
      const parsed = cli(['parse', 'input.json', '--grammar', 'grammar.json'], dir)
      return parsed.status === 0 ? pass() : fail('the fixed grammar no longer parses input.json')
    },
  },

  {
    id: '05-explain-failure',
    title: 'Explain a parse failure',
    prompt:
      'bad.json does not parse with grammar.json. Write diagnosis.json ' +
      'containing the failure\'s error code, row and column, as ' +
      '{"code":..., "row":..., "col":...}.',
    measures: ['completion', 'hallucinated APIs'],
    setup(dir) {
      writeFileSync(join(dir, 'grammar.json'), json(JSON_GRAMMAR))
      writeFileSync(join(dir, 'bad.json'), '{"a":}')
    },
    solve(dir, { cli }) {
      const res = cli(['diagnose', 'bad.json', '--grammar', 'grammar.json', '--json'], dir)
      const e = JSON.parse(res.stdout).diagnostic
      writeFileSync(join(dir, 'diagnosis.json'), json({ code: e.code, row: e.row, col: e.col }))
    },
    spoil(dir) {
      // A plausible invention: the shape is right, the code is not one the
      // engine raises here.
      writeFileSync(join(dir, 'diagnosis.json'), json({ code: 'syntax_error', row: 1, col: 6 }))
    },
    check(dir, { cli }) {
      const got = readJson(dir, 'diagnosis.json')
      if (!got.ok) return fail(got.why)
      const res = cli(['diagnose', 'bad.json', '--grammar', 'grammar.json', '--json'], dir)
      let want
      try {
        want = JSON.parse(res.stdout).diagnostic
      } catch {
        return fail('harness could not read the reference diagnostic')
      }
      if (got.value.code !== want.code) {
        return fail(`code is ${JSON.stringify(got.value.code)}, the engine raises ${JSON.stringify(want.code)}`)
      }
      if (got.value.row !== want.row || got.value.col !== want.col) {
        return fail(
          `position ${got.value.row}:${got.value.col}, the engine reports ${want.row}:${want.col}`,
        )
      }
      return pass()
    },
  },

  {
    id: '06-add-rule',
    title: 'Add a rule to an existing grammar',
    prompt:
      'grammar.json parses JSON objects and arrays but rejects a bare ' +
      'top-level number. Extend it so numbers.txt (which contains 42) parses ' +
      'to the number 42, without breaking object.json.',
    measures: ['completion', 'retries', 'test failures'],
    setup(dir) {
      // VAL omits #NR, so a bare number has no alternate to match.
      const g = structuredClone(JSON_GRAMMAR)
      g.options.tokenSet.VAL = ['#ST', '#VL']
      writeFileSync(join(dir, 'grammar.json'), json(g))
      writeFileSync(join(dir, 'numbers.txt'), '42')
      writeFileSync(join(dir, 'object.json'), '{"a":"x"}')
    },
    solve(dir) {
      const g = JSON.parse(readFileSync(join(dir, 'grammar.json'), 'utf8'))
      g.options.tokenSet.VAL = ['#ST', '#NR', '#VL']
      writeFileSync(join(dir, 'grammar.json'), json(g))
    },
    spoil() {
      // Leave it rejecting numbers.
    },
    check(dir, { cli }) {
      const num = cli(['parse', 'numbers.txt', '--grammar', 'grammar.json', '--json'], dir)
      if (num.status !== 0) return fail('numbers.txt still does not parse')
      let value
      try {
        value = JSON.parse(num.stdout).tree
      } catch {
        return fail('parse output was not JSON')
      }
      if (value !== 42) return fail(`numbers.txt parsed to ${JSON.stringify(value)}, expected 42`)
      const obj = cli(['parse', 'object.json', '--grammar', 'grammar.json'], dir)
      return obj.status === 0 ? pass() : fail('object.json no longer parses — the change was a regression')
    },
  },

  {
    id: '07-write-fixtures',
    title: 'Write parser fixtures',
    prompt:
      'Write cases.tsv: tabnas fixtures for grammar.json with a header row, ' +
      'at least three passing cases, and at least one row that pins a ' +
      'rejection by its error code. All rows must pass `tabnas test`.',
    measures: ['completion', 'test failures', 'hallucinated APIs'],
    setup(dir) {
      writeFileSync(join(dir, 'grammar.json'), json(JSON_GRAMMAR))
    },
    solve(dir) {
      writeFileSync(
        join(dir, 'cases.tsv'),
        [
          'input\texpected',
          '{"a":1}\t{"a":1}',
          '[1,2]\t[1,2]',
          '{"a":[1,{"b":2}]}\t{"a":[1,{"b":2}]}',
          '{"a":}\tERROR:unexpected',
          '',
        ].join('\n'),
      )
    },
    spoil(dir) {
      // Three passing rows, but the rejection is a bare ERROR: it asserts
      // only that something failed, which is the weaker contract this task
      // exists to rule out.
      writeFileSync(
        join(dir, 'cases.tsv'),
        ['input\texpected', '{"a":1}\t{"a":1}', '[1,2]\t[1,2]', '{"a":2}\t{"a":2}', '{"a":}\tERROR', ''].join('\n'),
      )
    },
    check(dir, { cli }) {
      const text = read(dir, 'cases.tsv')
      if (text === null) return fail('cases.tsv was not created')
      const rows = text.split('\n').filter((l) => l.trim() && l.includes('\t')).slice(1)
      if (rows.length < 4) return fail(`only ${rows.length} data rows; need at least four`)
      const coded = rows.filter((r) => /\tERROR:[a-z][a-z0-9_]*\s*$/.test(r))
      if (coded.length < 1) {
        return fail('no row pins a rejection by code — a bare ERROR asserts only that it failed')
      }
      const res = cli(['test', '--spec', 'cases.tsv', '--grammar', 'grammar.json'], dir)
      return res.status === 0 ? pass() : fail('`tabnas test` reported failing rows')
    },
  },

  {
    id: '08-upgrade-plugin',
    title: 'Upgrade a plugin descriptor',
    prompt:
      'tabnas.plugin.json is out of step with the package it describes: its ' +
      'name and Go module do not match ts/package.json and go/go.mod, and it ' +
      'carries a version field it should not. Correct it.',
    measures: ['completion', 'retries'],
    setup(dir, { mkdir }) {
      mkdir(join(dir, 'ts'))
      mkdir(join(dir, 'go'))
      writeFileSync(
        join(dir, 'ts', 'package.json'),
        json({ name: '@tabnas/widget', version: '0.4.1', homepage: 'https://github.com/tabnas/widget' }),
      )
      writeFileSync(join(dir, 'go', 'go.mod'), 'module github.com/tabnas/widget/go\n\ngo 1.24\n')
      writeFileSync(
        join(dir, 'tabnas.plugin.json'),
        json({
          $schema: 'https://tabnas.dev/schema/plugin.schema.json',
          name: '@tabnas/gadget',
          go: 'github.com/tabnas/gadget/go',
          version: '0.4.1',
          engine: '@tabnas/parser',
          versionSource: 'ts/package.json',
        }),
      )
    },
    solve(dir) {
      const d = JSON.parse(readFileSync(join(dir, 'tabnas.plugin.json'), 'utf8'))
      d.name = '@tabnas/widget'
      d.go = 'github.com/tabnas/widget/go'
      delete d.version
      writeFileSync(join(dir, 'tabnas.plugin.json'), json(d))
    },
    spoil(dir) {
      // Fixes the name but keeps the version field — the trap this task sets,
      // since a descriptor carrying a version goes stale at the next release.
      const d = JSON.parse(readFileSync(join(dir, 'tabnas.plugin.json'), 'utf8'))
      d.name = '@tabnas/widget'
      d.go = 'github.com/tabnas/widget/go'
      writeFileSync(join(dir, 'tabnas.plugin.json'), json(d))
    },
    check(dir) {
      const got = readJson(dir, 'tabnas.plugin.json')
      if (!got.ok) return fail(got.why)
      const d = got.value
      if (d.name !== '@tabnas/widget') return fail(`name is ${JSON.stringify(d.name)}`)
      if (d.go !== 'github.com/tabnas/widget/go') return fail(`go is ${JSON.stringify(d.go)}`)
      if ('version' in d) {
        return fail('the descriptor still carries a version field; versionSource names where it lives')
      }
      if (d.versionSource !== 'ts/package.json') return fail('versionSource was lost')
      return pass()
    },
  },

  {
    id: '09-compare-grammars',
    title: 'Compare two grammar versions',
    prompt:
      'a.json and b.json are two versions of one grammar. Exactly one input ' +
      'in samples/ is accepted by one and rejected by the other. Write ' +
      'difference.txt containing just that filename.',
    measures: ['completion', 'steps to first successful parse'],
    setup(dir, { mkdir }) {
      const a = structuredClone(JSON_GRAMMAR)
      const b = structuredClone(JSON_GRAMMAR)
      b.options.tokenSet.VAL = ['#ST', '#VL'] // b rejects bare numbers
      writeFileSync(join(dir, 'a.json'), json(a))
      writeFileSync(join(dir, 'b.json'), json(b))
      mkdir(join(dir, 'samples'))
      writeFileSync(join(dir, 'samples', 'one.txt'), '{"a":"x"}')
      writeFileSync(join(dir, 'samples', 'two.txt'), '7')
      writeFileSync(join(dir, 'samples', 'three.txt'), '["x"]')
    },
    solve(dir, { cli }) {
      for (const f of ['one.txt', 'two.txt', 'three.txt']) {
        const ra = cli(['parse', `samples/${f}`, '--grammar', 'a.json'], dir).status === 0
        const rb = cli(['parse', `samples/${f}`, '--grammar', 'b.json'], dir).status === 0
        if (ra !== rb) {
          writeFileSync(join(dir, 'difference.txt'), f + '\n')
          return
        }
      }
    },
    spoil(dir) {
      writeFileSync(join(dir, 'difference.txt'), 'one.txt\n')
    },
    check(dir) {
      const text = read(dir, 'difference.txt')
      if (text === null) return fail('difference.txt was not created')
      const name = text.trim()
      return name === 'two.txt'
        ? pass()
        : fail(`difference.txt names ${JSON.stringify(name)}; the differing sample is two.txt`)
    },
  },

  {
    id: '10-integrate',
    title: 'Integrate tabnas into a small application',
    prompt:
      'Write app.mjs: a Node script that reads a filename from argv, parses ' +
      'it with grammar.json using tabnas, and prints the number of top-level ' +
      'keys. Running `node app.mjs input.json` must print 3.',
    measures: ['completion', 'hallucinated APIs', 'test failures'],
    setup(dir) {
      writeFileSync(join(dir, 'grammar.json'), json(JSON_GRAMMAR))
      writeFileSync(join(dir, 'input.json'), '{"a":1,"b":2,"c":3}')
    },
    solve(dir, { cliPath }) {
      // Shelling out to the CLI is a legitimate integration and the one an
      // agent can verify end to end; using the library API directly is
      // equally acceptable, which is why the check only looks at output.
      writeFileSync(
        join(dir, 'app.mjs'),
        [
          "import { execFileSync } from 'node:child_process'",
          `const CLI = ${JSON.stringify(cliPath)}`,
          'const file = process.argv[2]',
          "const out = execFileSync(process.execPath, [CLI, 'parse', file, '--grammar', 'grammar.json', '--json'], { encoding: 'utf8' })",
          'console.log(Object.keys(JSON.parse(out).tree).length)',
          '',
        ].join('\n'),
      )
    },
    spoil(dir) {
      // Prints a hard-coded answer instead of parsing anything.
      writeFileSync(join(dir, 'app.mjs'), 'console.log(3)\n')
    },
    check(dir, { node }) {
      const first = node(['app.mjs', 'input.json'], dir)
      if (first.status !== 0) return fail('`node app.mjs input.json` exited non-zero')
      if (first.stdout.trim() !== '3') {
        return fail(`printed ${JSON.stringify(first.stdout.trim())}, expected 3`)
      }
      // A second input the agent never saw. A script that prints a constant
      // passes the first check and fails this one, which is the point.
      writeFileSync(join(dir, 'other.json'), '{"x":1,"y":2}')
      const second = node(['app.mjs', 'other.json'], dir)
      if (second.status !== 0) return fail('the script failed on a second input')
      return second.stdout.trim() === '2'
        ? pass()
        : fail(`printed ${JSON.stringify(second.stdout.trim())} for a two-key document — it is not really parsing`)
    },
  },
]

// The measurements the plan asks for, recorded per task run. Completion is
// the only one this harness can decide on its own; the rest are counted from
// the agent's transcript, which is why a run needs one.
export const METRICS = [
  ['completed', 'did the task check pass'],
  ['retries', 'how many times the agent re-attempted after a failure'],
  ['invalid_commands', 'commands invoked that do not exist or were malformed'],
  ['hallucinated_apis', 'references to tabnas functions, flags or files that do not exist'],
  ['docs_consulted', 'documentation pages or resources opened'],
  ['test_failures', 'failing test or fixture runs before the final state'],
  ['steps_to_first_parse', 'agent actions until the first successful parse'],
]
