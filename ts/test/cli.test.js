/* Copyright (c) 2026 tabnas, MIT License */
'use strict'

/* cli.test.js — the CLI's own surface: exit codes, human output, usage.
 *
 * Exit codes are a contract (README + --help): 0 success, 1 the
 * operation said no (parse failure, invalid grammar, fixture failures,
 * unknown plugin), 2 usage error. Scripts branch on these, so each one
 * gets a test.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')

const CLI = Path.join(__dirname, '..', 'dist', 'cli.js')
const GRAMMAR_FILE = Path.join(__dirname, 'json-grammar.fixture.json')

function run(args, stdin) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin ?? '',
    encoding: 'utf8',
  })
  assert.strictEqual(res.error, undefined)
  return res
}

describe('cli', () => {
  let tmp = null

  before(() => {
    tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'tabnas-mcp-cli-'))
    Fs.writeFileSync(Path.join(tmp, 'input.json'), '{"a":1}')
    Fs.writeFileSync(Path.join(tmp, 'bad-grammar.json'),
      JSON.stringify({ ref: {} }))
    Fs.writeFileSync(Path.join(tmp, 'not-json.json'), '{nope')
    Fs.writeFileSync(Path.join(tmp, 'ok.tsv'),
      'input\texpected\n{"a":1}\t{"a":1}\n')
    Fs.writeFileSync(Path.join(tmp, 'mixed.tsv'),
      'input\texpected\n{"a":1}\t{"a":1}\n{"a":2}\t{"a":3}\n')
  })

  after(() => {
    if (tmp) {
      Fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  describe('exit code 0 (success)', () => {
    it('parse: success, tree on stdout', () => {
      const res = run(['parse', Path.join(tmp, 'input.json'),
        '--grammar', GRAMMAR_FILE])
      assert.strictEqual(res.status, 0)
      assert.deepStrictEqual(JSON.parse(res.stdout), { a: 1 })
    })

    it('parse: stdin via -', () => {
      const res = run(['parse', '-', '--grammar', GRAMMAR_FILE], '[1,2]')
      assert.strictEqual(res.status, 0)
    })

    it('validate: valid grammar', () => {
      const res = run(['validate', '--grammar', GRAMMAR_FILE])
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /grammar valid/)
    })

    it('diagnose: input that parses', () => {
      const res = run(['diagnose', '-', '--grammar', GRAMMAR_FILE], '[1]')
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /nothing to diagnose/)
    })

    it('test: all rows pass', () => {
      const res = run(['test', '--spec', Path.join(tmp, 'ok.tsv'),
        '--grammar', GRAMMAR_FILE])
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /pass 1 fail 0/)
    })

    it('plugins: list and describe', () => {
      const list = run(['plugins'])
      assert.strictEqual(list.status, 0)
      assert.match(list.stdout, /@tabnas\/csv/)

      const one = run(['plugins', 'csv'])
      assert.strictEqual(one.status, 0)
      assert.strictEqual(JSON.parse(one.stdout).name, '@tabnas/csv')
    })

    it('--help documents the exit codes', () => {
      const res = run(['--help'])
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /exit codes/)
      assert.match(res.stdout, /2 {2}usage error/)
    })

    it('--version prints the package version', () => {
      const res = run(['--version'])
      assert.strictEqual(res.status, 0)
      assert.strictEqual(res.stdout.trim(),
        require('../package.json').version)
    })
  })

  describe('exit code 1 (the operation said no)', () => {
    it('parse: parse failure, engine-rendered message on stderr', () => {
      const res = run(['parse', '-', '--grammar', GRAMMAR_FILE], '{"a":')
      assert.strictEqual(res.status, 1)
      assert.strictEqual(res.stdout, '')
      assert.match(res.stderr, /unexpected/)
    })

    it('parse: invalid grammar', () => {
      const res = run(['parse', '-', '--grammar',
        Path.join(tmp, 'bad-grammar.json')], 'x')
      assert.strictEqual(res.status, 1)
      assert.match(res.stderr, /\$\.ref/)
    })

    it('parse: --json still prints the result JSON, exit still 1', () => {
      const res = run(
        ['parse', '-', '--grammar', GRAMMAR_FILE, '--json'], '{"a":')
      assert.strictEqual(res.status, 1)
      const parsed = JSON.parse(res.stdout)
      assert.strictEqual(parsed.ok, false)
      assert.strictEqual(parsed.diagnostic.code, 'unexpected')
    })

    it('validate: invalid grammar', () => {
      const res = run(['validate', '--grammar',
        Path.join(tmp, 'bad-grammar.json')])
      assert.strictEqual(res.status, 1)
      assert.match(res.stderr, /invalid/)
    })

    it('diagnose: failing input, registry hint on stderr', () => {
      const res = run(['diagnose', '-', '--grammar', GRAMMAR_FILE], '{"a":')
      assert.strictEqual(res.status, 1)
      assert.match(res.stderr, /registry\[unexpected\]/)
    })

    it('test: fixture failures', () => {
      const res = run(['test', '--spec', Path.join(tmp, 'mixed.tsv'),
        '--grammar', GRAMMAR_FILE])
      assert.strictEqual(res.status, 1)
      assert.match(res.stdout, /pass 1 fail 1/)
      assert.match(res.stdout, /row 3/)
    })

    it('plugins: unknown name', () => {
      const res = run(['plugins', 'no-such-plugin'])
      assert.strictEqual(res.status, 1)
      assert.match(res.stderr, /known plugins/)
    })
  })

  describe('exit code 2 (usage errors)', () => {
    const CASES = [
      [[], 'no command'],
      [['bogus'], 'unknown command'],
      [['parse', '--nope'], 'unknown option'],
      [['parse', 'a', 'b'], 'too many positionals'],
      [['validate'], 'validate without --grammar'],
      [['validate', '--grammar'], '--grammar without a path'],
      [['test'], 'test without --spec'],
      [['parse', '/no/such/file.txt'], 'unreadable input file'],
      [['parse', '-', '--grammar', '/no/such/grammar.json'],
        'unreadable grammar file'],
      // `mcp` starts a long-running server; a misuse must be rejected
      // BEFORE the server starts, or the process would hang. These prove
      // it fails fast with exit 2.
      [['mcp', 'extra'], 'mcp with an argument'],
      [['mcp', '--json'], 'mcp with an option'],
    ]

    for (const [args, name] of CASES) {
      it(name, () => {
        const res = run(args, 'x')
        assert.strictEqual(res.status, 2,
          `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`)
      })
    }

    it('grammar file that is not JSON', () => {
      const res = run(
        ['parse', '-', '--grammar', Path.join(tmp, 'not-json.json')], 'x')
      assert.strictEqual(res.status, 2)
      assert.match(res.stderr, /not valid JSON/)
    })
  })
})
