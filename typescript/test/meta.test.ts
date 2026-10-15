
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { check, entries, buildCtx, stdoutFailures, ROOT, type CliEntry } from './harness.js'
import { run } from '../src/core.js'
import { serialise } from '../src/envelope.js'

const all = entries<CliEntry>('cli')

function entry (id: string): CliEntry {
  const e = all.find(x => x.id === id)
  assert.ok(undefined !== e, 'no corpus entry with id ' + id)
  // A deep copy, so a mutation here cannot leak into the real runner.
  return JSON.parse(JSON.stringify(e)) as CliEntry
}

type Result = Record<string, any>

// The expected and actual results of omni's one result mismatch.
function sides (failures: string[]): [Result, Result] {
  assert.ok(1 === failures.length && failures[0].split('\n')[0].includes('result mismatch'), JSON.stringify(failures))
  const lines = Object.fromEntries(failures[0].split('\n').slice(1).map(ln =>
    [ln.slice(2, ln.indexOf(':')), ln.slice(ln.indexOf(':') + 1).trim()]))
  return [JSON.parse(lines.expected), JSON.parse(lines.actual)]
}

// The fields the expected and actual results disagree on.
function differs (failures: string[]): string[] {
  const [want, got] = sides(failures)
  return [...new Set([...Object.keys(want), ...Object.keys(got)])]
    .filter(k => !isDeepStrictEqual(want[k], got[k])).sort()
}

/* The control. If this ever fails, every test below is meaningless, because a
 * harness that reports failures for a correct entry proves nothing by
 * reporting them for a broken one.
 */
test('meta: the unmutated entry passes', async () => {
  assert.deepStrictEqual(await check(entry('list/all')), [])
})

test('meta: a wrong exit code is reported', async () => {
  const e = entry('list/all')
  e.out.exit = 3
  assert.deepStrictEqual(differs(await check(e)), ['exit'])
})

test('meta: stdout differing by ONE BYTE is reported', async () => {
  const e = entry('list/all')
  const real = join(ROOT, e.out.stdout)
  const tmpRel = 'spec/expect/.meta-one-byte.json'
  const tmp = join(ROOT, tmpRel)

  const text = readFileSync(real, 'utf8').replace('Retention', 'Retentiom')
  assert.ok(!text.includes('Retention policy'), 'the mutation did not apply')

  mkdirSync(join(ROOT, 'spec', 'expect'), { recursive: true })
  writeFileSync(tmp, text)
  try {
    e.out.stdout = tmpRel
    assert.deepStrictEqual(differs(await check(e)), ['stdout'])
  }
  finally { unlinkSync(tmp) }
})

test('meta: a vault left holding the wrong names is reported', async () => {
  const e = entry('secrets/remove')
  assert.ok(undefined !== e.out.vault, 'secrets/remove asserts no vault state')
  e.out.vault.names = ['joplin.apikey', 'notion.apikey']
  assert.deepStrictEqual(differs(await check(e)), ['vault'])
})

test('meta: a vault value that differs is reported', async () => {
  const e = entry('secrets/set-from-stdin')
  assert.ok(undefined !== e.out.vault?.values, 'secrets/set-from-stdin asserts no values')
  e.out.vault.values = { 'joplin.apikey': 'rotated-token\n' }
  const f = await check(e)
  const [want, got] = sides(f)
  assert.deepStrictEqual(differs(f), ['vault'])
  assert.deepStrictEqual(got.vault.names, want.vault.names)
  assert.notDeepStrictEqual(got.vault.values, want.vault.values)
})

test('meta: a prompt that was not expected is reported', async () => {
  const e = entry('secrets/passphrase-typed')
  e.out.prompts = []
  assert.deepStrictEqual(differs(await check(e)), ['prompts'])
})

test('meta: a MISSING call is reported', async () => {
  const e = entry('list/all')
  e.out.calls = []
  assert.deepStrictEqual(differs(await check(e)), ['calls'])
})

test('meta: an EXTRA call is reported', async () => {
  const e = entry('list/all')
  e.out.calls = [...e.out.calls, { instance: 'joplin', method: 'GET', path: '/notes' }]
  assert.deepStrictEqual(differs(await check(e)), ['calls'])
})

test('meta: a call with the right count but the wrong path is reported', async () => {
  const e = entry('list/all')
  e.out.calls = [{ instance: 'joplin', method: 'GET', path: '/folders' }]
  assert.deepStrictEqual(differs(await check(e)), ['calls'])
})

test('meta: unexpected stderr is reported', async () => {
  const e = entry('list/all')
  e.out.stderr = 'something the command never printed\n'
  assert.deepStrictEqual(differs(await check(e)), ['stderr'])
})

test('meta: a missing expectation file is an error, not a pass', async () => {
  // A `.json` path that does not exist must not read as "nothing to compare".
  const e = entry('list/all')
  e.out.stdout = 'spec/expect/.meta-does-not-exist.json'
  await assert.rejects(() => check(e), /ENOENT/)
})

test('meta: every failure is reported, not just the first', async () => {
  const e = entry('list/all')
  e.out.exit = 3
  e.out.calls = []
  e.out.stderr = 'no\n'
  assert.deepStrictEqual(differs(await check(e)), ['calls', 'exit', 'stderr'])
})

/* The bytes are the contract. These feed the stdout check output no port
 * produced: the right values in the wrong form. Before this check existed,
 * both harnesses parsed stdout and re-rendered it, so every one of these
 * passed.
 */
test('meta: the right values indented is reported', async () => {
  const e = entry('list/all')
  const r = await run(buildCtx(e))
  const indented = JSON.stringify(JSON.parse(r.stdout), null, 2) + '\n'
  const f = stdoutFailures(e, indented)
  assert.ok(f.some(x => x.startsWith('stdout is not in canonical form')), 'not reported: ' + JSON.stringify(f))
})

test('meta: the right values with a CRLF ending is reported', async () => {
  const e = entry('list/all')
  const r = await run(buildCtx(e))
  const f = stdoutFailures(e, r.stdout.replace(/\n$/, '\r\n'))
  assert.ok(f.some(x => x.startsWith('stdout is not in canonical form')), 'not reported: ' + JSON.stringify(f))
})

test('meta: a wrong port inside a which row is reported', async () => {
  const e = entry('meta/which')
  const r = await run(buildCtx(e))
  const parsed = JSON.parse(r.stdout)
  assert.ok(Array.isArray(parsed.data) && 0 < parsed.data.length, 'which produced no rows')
  parsed.data[0].port = 'WRONG'
  const f = stdoutFailures(e, serialise(parsed))
  assert.ok(f.some(x => x.startsWith('stdout differs')), 'not reported: ' + JSON.stringify(f))
})

test('meta: version reporting another port in its data is reported', async () => {
  const e = entry('meta/version')
  const r = await run(buildCtx(e))
  const parsed = JSON.parse(r.stdout)
  parsed.data.port = 'WRONG'
  const f = stdoutFailures(e, serialise(parsed))
  assert.ok(f.some(x => x.startsWith('data.port is')), 'not reported: ' + JSON.stringify(f))
})

test('meta: a written file that differs is reported', async () => {
  const e = entry('connections/add-joplin')
  e.out.files = { ...e.out.files, 'station.json': 'fixtures/config/several/station.json' }
  const f = await check(e)
  const [want, got] = sides(f)
  assert.deepStrictEqual(differs(f), ['files'])
  assert.notDeepStrictEqual(got.files['station.json'], want.files['station.json'])
})

test('meta: a file the entry says is not there, written, is reported', async () => {
  const e = entry('connections/add-joplin')
  e.out.absent = ['likeness.json']
  const f = await check(e)
  const [want, got] = sides(f)
  assert.deepStrictEqual(differs(f), ['absent'])
  assert.ok(want.absent.includes('likeness.json') && !got.absent.includes('likeness.json'), JSON.stringify(got))
})

test('meta: a file the entry names, never written, is reported', async () => {
  const e = entry('connections/add-joplin-needs-an-account')
  e.out.files = { 'station.json': 'spec/written/connections/add-joplin/station.json' }
  const f = await check(e)
  const [want, got] = sides(f)
  assert.deepStrictEqual(differs(f), ['files'])
  assert.ok(null !== want.files['station.json'] && null === got.files['station.json'], JSON.stringify(got.files))
})
