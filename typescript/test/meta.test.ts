
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('exit ')), 'no exit failure in ' + JSON.stringify(f))
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
    const f = await check(e)
    assert.ok(f.some(x => x.startsWith('stdout differs')), 'no stdout failure in ' + JSON.stringify(f))
  }
  finally { unlinkSync(tmp) }
})

test('meta: a vault left holding the wrong names is reported', async () => {
  const e = entry('secrets/remove')
  assert.ok(undefined !== e.out.vault, 'secrets/remove asserts no vault state')
  e.out.vault.names = ['joplin.apikey', 'notion.apikey']
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('vault names ')), 'no vault failure in ' + JSON.stringify(f))
})

test('meta: a vault value that differs is reported', async () => {
  const e = entry('secrets/set-from-stdin')
  assert.ok(undefined !== e.out.vault?.values, 'secrets/set-from-stdin asserts no values')
  e.out.vault.values = { 'joplin.apikey': 'rotated-token\n' }
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('vault value of ')), 'no value failure in ' + JSON.stringify(f))
})

test('meta: a prompt that was not expected is reported', async () => {
  const e = entry('secrets/passphrase-typed')
  e.out.prompts = []
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('prompts ')), 'no prompt failure in ' + JSON.stringify(f))
})

test('meta: a MISSING call is reported', async () => {
  const e = entry('list/all')
  e.out.calls = []
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('calls ')), 'no calls failure in ' + JSON.stringify(f))
})

test('meta: an EXTRA call is reported', async () => {
  const e = entry('list/all')
  e.out.calls = [...e.out.calls, { instance: 'joplin', method: 'GET', path: '/notes' }]
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('calls ')), 'no calls failure in ' + JSON.stringify(f))
})

test('meta: a call with the right count but the wrong path is reported', async () => {
  const e = entry('list/all')
  e.out.calls = [{ instance: 'joplin', method: 'GET', path: '/folders' }]
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('calls ')), 'no calls failure in ' + JSON.stringify(f))
})

test('meta: unexpected stderr is reported', async () => {
  const e = entry('list/all')
  e.out.stderr = 'something the command never printed\n'
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('stderr ')), 'no stderr failure in ' + JSON.stringify(f))
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
  const f = await check(e)
  assert.equal(f.length, 3, 'expected three failures, got ' + JSON.stringify(f))
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
