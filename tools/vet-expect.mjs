#!/usr/bin/env node
/*
 * Every committed JSON expectation is an envelope, so every one must satisfy
 * spec/def/envelope.aontu, and every row `list` or `get` answers is a note,
 * which must satisfy spec/def/note.aontu. The fields stripped before the byte
 * comparison are put back first, with values any port could have written.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const EXPECT = join(ROOT, 'spec', 'expect')
const OUT = join(ROOT, 'build', 'vet-expect')
const AONTU = (process.env.AONTU || 'npx --yes aontu@0.76.0').split(' ')

function walk (dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)])
}

function put (kind, name, value) {
  const to = join(OUT, kind, name)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, JSON.stringify(value))
  return relative(ROOT, to)
}

function vet (at, schema, files) {
  if (0 === files.length) {
    console.error('vet-expect: nothing to vet against ' + at)
    process.exit(1)
  }
  const r = spawnSync(AONTU[0], [...AONTU.slice(1), 'vet', '--at', at, schema, ...files],
    { cwd: ROOT, stdio: 'inherit' })
  if (0 !== r.status) {
    console.error('vet-expect: a committed expectation does not satisfy ' + at + ' (exit ' + r.status + ')')
    process.exit(1)
  }
}

rmSync(OUT, { recursive: true, force: true })
const envelopes = []
const notes = []
for (const f of walk(EXPECT).filter(f => f.endsWith('.json')).sort()) {
  const name = relative(EXPECT, f)
  const env = JSON.parse(readFileSync(f, 'utf8'))
  env.port = 'ts'
  env.meta = { ...env.meta, elapsed_ms: 0 }
  envelopes.push(put('envelope', name, env))
  if (['list', 'get'].includes(env.cmd?.[0]) && Array.isArray(env.data)) {
    env.data.forEach((row, i) => notes.push(put('note', name.replace(/\.json$/, '.' + i + '.json'), row)))
  }
}

vet('$.Envelope', 'spec/def/envelope.aontu', envelopes)
vet('$.Note', 'spec/def/note.aontu', notes)
console.log('vet-expect: ok - ' + envelopes.length + ' envelopes and ' + notes.length + ' notes')
