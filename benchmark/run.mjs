#!/usr/bin/env node
/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* run.mjs — the AX benchmark harness.
 *
 * Two modes, and the distinction matters:
 *
 *   --self-test   Prove the BENCHMARK works. For every task: materialise it,
 *                 apply the reference solution, and require the check to
 *                 pass; then materialise it again, apply the deliberately
 *                 wrong answer, and require the check to FAIL. This runs in
 *                 CI. It measures no agent — it measures the benchmark, so
 *                 that the benchmark cannot quietly rot into ten tasks that
 *                 are impossible, or ten checks that pass anything.
 *
 *   --scaffold    Materialise the tasks into a directory for an actual agent
 *                 run, and emit the scoring sheet. Running the agent, and
 *                 counting the transcript-derived metrics, is a human (or
 *                 scheduled) activity — see README.md.
 *
 * Nothing here runs an agent, and no output of this file should be read as a
 * claim that an agent has been measured.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { TASKS, METRICS } from './tasks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const CLI = join(REPO, 'ts', 'dist', 'cli.js')

function readSafe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const PKG = JSON.parse(readSafe(join(REPO, 'ts', 'package.json')) ?? '{"version":"0.0.0"}')

// Parsed positionally rather than with indexOf, so that the VALUE of --out is
// not also read as the task filter (it is a bare word, and that is exactly
// what the filter looks like).
const argv = process.argv.slice(2)
let MODE = 'self-test'
let ONLY = null
let OUT = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--scaffold') MODE = 'scaffold'
  else if (a === '--score') MODE = 'score'
  else if (a === '--self-test') MODE = 'self-test'
  else if (a === '--out') {
    OUT = argv[++i]
    if (!OUT) {
      console.error('--out requires a directory')
      process.exit(2)
    }
    OUT = resolve(OUT)
  } else if (a.startsWith('--')) {
    console.error(`unknown option: ${a}`)
    process.exit(2)
  } else if (ONLY === null) ONLY = a
  else {
    console.error(`unexpected argument: ${a}`)
    process.exit(2)
  }
}

if (!existsSync(CLI)) {
  console.error(`no CLI at ${CLI} — run \`npm run build\` in ts/ first`)
  process.exit(2)
}

// --- the environment handed to a task's setup / solve / check ---------------

function makeEnv(dir) {
  const cli = (args, cwd = dir) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input: '' })
  const node = (args, cwd = dir) =>
    spawnSync(process.execPath, args, { cwd, encoding: 'utf8', input: '' })
  return {
    cli,
    node,
    cliPath: CLI,
    pkgVersion: PKG.version,
    mkdir: (p) => mkdirSync(p, { recursive: true }),
  }
}

function materialise(task, dir) {
  mkdirSync(dir, { recursive: true })
  const env = makeEnv(dir)
  task.setup?.(dir, env)
  return env
}

// --- self-test --------------------------------------------------------------

function selfTest(tasks) {
  const root = join(tmpdir(), `tabnas-ax-selftest-${process.pid}`)
  let failures = 0

  for (const task of tasks) {
    // 1. the reference solution must pass
    const solved = join(root, `${task.id}-solved`)
    let env = materialise(task, solved)
    let verdict
    try {
      task.solve(solved, env)
      verdict = task.check(solved, env)
    } catch (e) {
      verdict = { pass: false, why: `reference solution threw: ${e.message}` }
    }
    if (verdict.pass) {
      console.log(`  ${task.id}  solvable`)
    } else {
      console.error(`  ${task.id}  REFERENCE SOLUTION FAILS ITS OWN CHECK — ${verdict.why}`)
      failures++
    }

    // 2. the wrong answer must be rejected
    const spoiled = join(root, `${task.id}-spoiled`)
    env = materialise(task, spoiled)
    let rejected
    try {
      task.spoil(spoiled, env)
      rejected = task.check(spoiled, env)
    } catch (e) {
      rejected = { pass: false, why: `check threw: ${e.message}` }
    }
    if (rejected.pass) {
      console.error(`  ${task.id}  CHECK ACCEPTS A WRONG ANSWER — it measures nothing`)
      failures++
    } else {
      console.log(`  ${task.id}  discriminates  (${rejected.why})`)
    }
  }

  rmSync(root, { recursive: true, force: true })
  return failures
}

// --- scaffold ---------------------------------------------------------------

function scaffold(tasks, root) {
  mkdirSync(root, { recursive: true })
  for (const task of tasks) {
    const dir = join(root, task.id)
    materialise(task, dir)
    writeFileSync(
      join(dir, 'TASK.md'),
      [
        `# ${task.title}`,
        '',
        task.prompt,
        '',
        '## Measured',
        '',
        ...task.measures.map((m) => `- ${m}`),
        '',
      ].join('\n'),
    )
  }

  const sheet = {
    $comment:
      'AX benchmark scoring sheet. One row per task per agent. `completed` is decided by ' +
      'run.mjs --score; the rest are counted from the agent transcript. No agent has been run.',
    agent: '<model or agent name>',
    date: '<YYYY-MM-DD>',
    metrics: Object.fromEntries(METRICS),
    results: tasks.map((t) => ({
      task: t.id,
      ...Object.fromEntries(METRICS.map(([k]) => [k, null])),
    })),
  }
  writeFileSync(join(root, 'scoresheet.json'), JSON.stringify(sheet, null, 2) + '\n')

  console.log(`  ${tasks.length} task(s) written to ${root}`)
  console.log('  each has TASK.md (the prompt) and its starting files')
  console.log('  scoresheet.json is the per-agent record to fill in')
}

// --- score ------------------------------------------------------------------

// Run each task's check against a directory an agent has worked in. This
// decides `completed` and nothing else: the remaining metrics are properties
// of HOW the agent got there, which only its transcript records.
function score(tasks, root) {
  let completed = 0
  const results = []

  for (const task of tasks) {
    const dir = join(root, task.id)
    if (!existsSync(dir)) {
      console.log(`  ${task.id}  ABSENT      (not attempted)`)
      results.push({ task: task.id, completed: false, why: 'task directory missing' })
      continue
    }
    let verdict
    try {
      verdict = task.check(dir, makeEnv(dir))
    } catch (e) {
      verdict = { pass: false, why: `check threw: ${e.message}` }
    }
    if (verdict.pass) {
      completed++
      console.log(`  ${task.id}  completed`)
    } else {
      console.log(`  ${task.id}  incomplete  (${verdict.why})`)
    }
    results.push({ task: task.id, completed: verdict.pass, why: verdict.why ?? null })
  }

  console.log(`\n${completed}/${tasks.length} task(s) completed.`)
  console.log('The other metrics are read from the agent transcript — see README.md.')
  writeFileSync(join(root, 'completion.json'), JSON.stringify({ completed, of: tasks.length, results }, null, 2) + '\n')
  return results
}

// --- main -------------------------------------------------------------------

const tasks = ONLY ? TASKS.filter((t) => t.id === ONLY || t.id.startsWith(ONLY)) : TASKS
if (!tasks.length) {
  console.error(`no task matching ${ONLY}`)
  process.exit(2)
}

if (MODE === 'scaffold') {
  scaffold(tasks, OUT ?? join(tmpdir(), 'tabnas-ax-benchmark'))
} else if (MODE === 'score') {
  const root = OUT ?? join(tmpdir(), 'tabnas-ax-benchmark')
  if (!existsSync(root)) {
    console.error(`no benchmark run at ${root} — scaffold one first`)
    process.exit(2)
  }
  console.log(`AX benchmark scoring — ${root}`)
  score(tasks, root)
} else {
  console.log(`AX benchmark self-test — ${tasks.length} task(s), CLI ${PKG.version}`)
  const failures = selfTest(tasks)
  if (failures) {
    console.error(`\n${failures} problem(s): the benchmark itself is broken.`)
    process.exit(1)
  }
  console.log('\nEvery task is solvable and every check rejects a wrong answer.')
}
