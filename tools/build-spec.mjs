#!/usr/bin/env node
/* Compile the aontu ground truth to the JSON every port reads.
 *
 *   node tools/build-spec.mjs          # write spec/*.json
 *   node tools/build-spec.mjs --check  # fail if the committed JSON is stale
 *
 * NEVER HAND-EDIT THE JSON. It is build output; the .aon file is the source,
 * and `make spec-fresh` runs the --check mode so drift fails a build rather
 * than being discovered a month later when a port disagrees with the spec it
 * claims to implement.
 *
 * The ports read JSON rather than aontu because four of the five have no aontu
 * implementation, and adding one to each would be five more things to keep in
 * agreement. One compile step, one artefact, five readers.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const AONTU_RAW = (process.env.AONTU || 'aontu').trim()
const AONTU = AONTU_RAW.split(/\s+/)

// Data files only: a shape file under spec/def/ is a truth rather than a
// value, so it has nothing to compile.
const SOURCES = [
  'errors.aon', 'caps.aon', 'sources.aon', 'replica.aon',
  // The two corpora. They are ground truth like everything else here: written
  // in aontu, checked against spec/def/corpus.aon, and compiled to the JSON
  // that each port's harness runs. A port reads the JSON; nobody writes it.
  'unit.aon', 'cli.aon',
]

const check = process.argv.includes('--check')
let stale = 0
let wrote = 0

for (const name of SOURCES) {
  const src = join('spec', name)
  const dst = join('spec', name.replace(/\.aon$/, '.json'))
  if (!existsSync(src)) {
    console.error(`  MISSING ${src}`)
    process.exit(2)
  }

  let out
  try {
    out = execFileSync(AONTU[0], [...AONTU.slice(1), src], { encoding: 'utf8' })
  }
  catch (err) {
    console.error(`  FAILED  ${src} did not evaluate`)
    console.error(String(err.stdout || err.stderr || err.message))
    process.exit(2)
  }

  // Re-render through our own serialiser rules rather than trusting aontu's
  // spacing: sorted keys and exactly one trailing newline, so the committed
  // bytes are stable whatever the compiler does with whitespace.
  const value = JSON.parse(out)
  const text = JSON.stringify(sortDeep(value), null, 2) + '\n'

  if (check) {
    const have = existsSync(dst) ? readFileSync(dst, 'utf8') : ''
    if (have !== text) {
      console.error(`  STALE   ${dst} does not match ${src}`)
      stale++
    }
    else console.log(`  fresh   ${dst}`)
  }
  else {
    writeFileSync(dst, text)
    console.log(`  wrote   ${dst}`)
    wrote++
  }
}

function sortDeep (v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (null !== v && 'object' === typeof v) {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k])
    return out
  }
  return v
}

if (check && 0 < stale) {
  console.error(`\nbuild-spec: ${stale} stale file(s). Run \`make spec-build\` and commit the result.`)
  process.exit(1)
}
if (!check) console.log(`\nbuild-spec: ${wrote} file(s) written`)
