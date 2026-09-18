
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { check, entries, ROOT, type CliEntry } from './harness.js'

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

test('meta: a MISSING call is reported', async () => {
  const e = entry('list/all')
  e.out.calls = []
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('calls ')), 'no calls failure in ' + JSON.stringify(f))
})

test('meta: an EXTRA call is reported', async () => {
  const e = entry('list/all')
  e.out.calls = [...e.out.calls, { instance: 'jot', method: 'GET', path: '/notes' }]
  const f = await check(e)
  assert.ok(f.some(x => x.startsWith('calls ')), 'no calls failure in ' + JSON.stringify(f))
})

test('meta: a call with the right count but the wrong path is reported', async () => {
  const e = entry('list/all')
  e.out.calls = [{ instance: 'jot', method: 'GET', path: '/folders' }]
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
