/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* harness.mjs — the parts of the AX benchmark that run a task.
 *
 * Separate from run.mjs because run.mjs is a script: importing it parses
 * argv and runs a mode. The self-test, the scaffolder, the scorer and
 * ts/test/benchmark.test.js all need the same three things, and a second
 * copy of them in the test suite would be free to disagree with the one
 * the benchmark uses.
 *
 * Nothing here runs an agent.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const REPO = join(HERE, '..')
export const CLI = join(REPO, 'ts', 'dist', 'cli.js')

export function readSafe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export const PKG = JSON.parse(
  readSafe(join(REPO, 'ts', 'package.json')) ?? '{"version":"0.0.0"}',
)

// The environment handed to a task's setup, premise, solve and check.
export function makeEnv(dir) {
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

export function materialise(task, dir) {
  mkdirSync(dir, { recursive: true })
  const env = makeEnv(dir)
  task.setup?.(dir, env)
  return env
}

// Check a task's PREMISE: that its unsolved starting state does what its
// prompt says it does. A task that declares none fails, because an
// undeclared premise is the state 04-fix-grammar was in when it told an
// agent its grammar was rejected by a command that accepted it.
export function checkPremise(task, dir, env) {
  const premise = task.premise
  if (null == premise || 'function' !== typeof premise.holds) {
    return {
      pass: false,
      why: `${task.id} declares no premise: say what its unsolved setup must do`,
    }
  }

  let verdict
  try {
    verdict = premise.holds(dir, env)
  } catch (e) {
    return { pass: false, why: `premise threw: ${e.message}` }
  }

  if (null == verdict || 'object' !== typeof verdict) {
    return { pass: false, why: 'premise returned no verdict' }
  }

  return verdict.pass ? { pass: true } : { pass: false, why: verdict.why ?? 'premise did not hold' }
}
