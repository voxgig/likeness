
import { test } from 'node:test'
import assert from 'node:assert'
import { existsSync, readdirSync, statSync } from 'node:fs'
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

test('no expectation file is unreferenced', () => {
  const found: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else found.push(relative(ROOT, p).split(sep).join('/'))
    }
  }
  // spec/written holds the files a command writes, as spec/expect holds what it prints.
  for (const dir of ['expect', 'written']) {
    if (existsSync(join(ROOT, 'spec', dir))) walk(join(ROOT, 'spec', dir))
  }

  const used = new Set(all.flatMap(e => [e.out.stdout, ...Object.values(e.out.files ?? {})]))
  const orphans = found.filter(f => !used.has(f))
  assert.deepStrictEqual(orphans, [], 'expectation files no entry refers to')
})

for (const e of all) {
  test('cli ' + e.id, async () => {
    const failures = await check(e)
    assert.deepStrictEqual(failures, [], e.id + ':\n  ' + failures.join('\n  '))
  })
}
