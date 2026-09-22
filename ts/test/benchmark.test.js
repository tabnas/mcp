/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* benchmark.test.js — the AX benchmark's third property (tabnas/mcp#7).
 *
 * `run.mjs --self-test` proves two things per task: the reference
 * solution passes the check, and a plausible wrong answer is rejected.
 * Neither says anything about the STARTING state, so 04-fix-grammar
 * could tell an agent "grammar.json is rejected by `tabnas validate`"
 * while the scaffolded grammar validated cleanly. The task then scored
 * an agent down for the benchmark's own mistake.
 *
 * The premise closes that gap: every task declares what its unsolved
 * setup must do, and the self-test checks it. This file pins the two
 * halves the self-test cannot prove about itself — that the declaration
 * is mandatory, and that the assertion can fail.
 */

const { describe, it, before } = require('node:test')
const Assert = require('node:assert')
const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')
const { pathToFileURL } = require('node:url')

const BENCH = Path.join(__dirname, '..', '..', 'benchmark')
const load = (f) => import(pathToFileURL(Path.join(BENCH, f)).href)

let TASKS
let harness

before(async () => {
  ;({ TASKS } = await load('tasks.mjs'))
  harness = await load('harness.mjs')
})

function tempdir(name) {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), `tabnas-ax-${name}-`))
}

function task(id) {
  const found = TASKS.find((t) => t.id === id)
  Assert.ok(found, `no task ${id}`)
  return found
}

describe('benchmark-premise', () => {
  it('every-task-declares-one', () => {
    for (const t of TASKS) {
      Assert.ok(t.premise, `${t.id} declares no premise`)
      Assert.equal(typeof t.premise.says, 'string', `${t.id}: premise.says`)
      Assert.ok(0 < t.premise.says.length, `${t.id}: premise.says is empty`)
      Assert.equal(typeof t.premise.holds, 'function', `${t.id}: premise.holds`)
    }
  })

  it('a-task-without-one-fails-the-self-test', () => {
    const verdict = harness.checkPremise({ id: 'x', setup() {} }, tempdir('none'), null)
    Assert.equal(verdict.pass, false)
    Assert.match(verdict.why, /no premise/)
  })

  // The defect itself: the prompt claims `tabnas validate` rejects the
  // scaffolded grammar, so the scaffolded grammar has to be rejected by
  // `tabnas validate`.
  it('04-starting-state-is-rejected-by-validate', () => {
    const dir = tempdir('04')
    const env = harness.makeEnv(dir)
    const t = task('04-fix-grammar')
    t.setup(dir, env)

    const valid = env.cli(['validate', '--grammar', 'grammar.json', '--json'], dir)
    Assert.notEqual(valid.status, 0, 'the prompt says validate rejects it, and it did not')
    Assert.match(valid.stdout, /mapp/)

    Assert.deepEqual(harness.checkPremise(t, dir, env), { pass: true })
  })

  // And the assertion has to be able to fail, or it measures nothing:
  // a setup that has drifted into validating is exactly the rot #7
  // describes.
  it('04-premise-rejects-a-drifted-setup', () => {
    const dir = tempdir('04-drift')
    const env = harness.makeEnv(dir)
    const t = task('04-fix-grammar')
    t.setup(dir, env)
    t.solve(dir, env) // the starting state no longer exhibits the failure

    const verdict = harness.checkPremise(t, dir, env)
    Assert.equal(verdict.pass, false)
    Assert.ok(verdict.why, 'a failed premise has to say why')
  })
})
