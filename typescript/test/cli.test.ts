
import { test } from 'node:test'
import assert from 'node:assert'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { CLI_OMNI, cliRunner, corpus, entries, resolved, ROOT, type CliEntry } from './harness.js'

const all = entries<CliEntry>('cli')

// Entries this port cannot answer yet, each with the upstream cause it waits on
// and the entry as that cause predicts this port answers it.
const WAITING: Record<string, [string, (e: CliEntry) => CliEntry]> = {}

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

test('every entry waiting upstream is in the corpus', () => {
  const ids = new Set(all.map(e => e.id))
  assert.deepStrictEqual(Object.keys(WAITING).filter(id => !ids.has(id)).sort(), [])
})

const SPEC = corpus('cli')

function group (name: string, set: CliEntry[]) {
  return { OMNI: CLI_OMNI, cli: { [name]: { set: set.map(e => resolved(e)) } } }
}

for (const name of Object.keys(SPEC).sort()) {
  test('cli ' + name, async () => {
    const set = SPEC[name].set as CliEntry[]
    const ids = new Set(set.map(e => e.id))
    const wait = Object.fromEntries(Object.entries(WAITING)
      .filter(([id]) => ids.has(id)).map(([id, [cause]]) => [id, { cause }]))
    const spec = group(name, set)
    await (await cliRunner(spec)).runsetflags(spec.cli[name], { null: false, all: true, wait })
  })
}

// A wait holds an entry only while it fails; this holds it to failing for its
// declared cause alone, so the declaration cannot hide a second difference.
if (0 < Object.keys(WAITING).length) {
  test('cli waiting entries differ only as their cause predicts', async () => {
    const spec = group('predicted', all.filter(e => Object.hasOwn(WAITING, e.id)).map(e => WAITING[e.id][1](e)))
    await (await cliRunner(spec)).runsetflags(spec.cli.predicted, { null: false, all: true })
  })
}
