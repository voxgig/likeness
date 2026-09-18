/* The transcript corpus runner.
 *
 * spec/cli.aon compiles to spec/cli.json; this runs every entry in it as a
 * whole command, IN PROCESS. No subprocess, no shell quoting and no five
 * different ways of capturing output - which is possible only because the argv
 * shell is thin and the core is a library taking every impure input as a
 * parameter.
 *
 * The comparison itself lives in harness.ts, so that meta.test.ts can drive
 * exactly the same code with a deliberately broken entry and prove it reports.
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { check, entries, ROOT, type CliEntry } from './harness.js'

const all = entries<CliEntry>('cli')

test('the transcript corpus is not empty', () => {
  assert.ok(0 < all.length, 'spec/cli.json has no entries - did `make spec-build` run?')
})

test('every corpus id is unique', () => {
  const seen = new Set<string>()
  for (const e of all) {
    assert.ok(!seen.has(e.id), 'duplicate corpus id: ' + e.id)
    seen.add(e.id)
  }
})

/* No orphaned expectations.
 *
 * Renaming an entry leaves its old expectation file behind, and a stale file
 * that nothing reads is indistinguishable from one that everything reads until
 * someone edits the wrong one. Every file under spec/expect/ must be named by
 * an entry.
 */
test('no expectation file is unreferenced', () => {
  const dir = join(ROOT, 'spec', 'expect')
  const found: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else found.push(relative(ROOT, p).split(sep).join('/'))
    }
  }
  walk(dir)

  const used = new Set(all.map(e => e.out.stdout))
  const orphans = found.filter(f => !used.has(f))
  assert.deepStrictEqual(orphans, [], 'expectation files no entry refers to')
})

for (const e of all) {
  test('cli ' + e.id, async () => {
    const failures = await check(e)
    assert.deepStrictEqual(failures, [], e.id + ':\n  ' + failures.join('\n  '))
  })
}
