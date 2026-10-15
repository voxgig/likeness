#!/usr/bin/env node
/* Regenerate the committed expectation files under spec/expect/.
 *
 *   node tools/regen-expect.mjs
 *
 * THE CANONICAL PORT DEFINES THE BYTES. TypeScript is the reference
 * implementation, so the expectations are what it produces - stripped of the
 * declared non-parity fields for a `.json` entry, and verbatim for a `.txt`
 * one. Every other port is then held to those bytes.
 *
 * THIS IS NOT A TEST AND MUST NEVER BE RUN TO MAKE ONE PASS. Running it after
 * a change rewrites the contract to agree with whatever the code now does,
 * which is the exact opposite of what the corpus is for. The workflow is: read
 * the diff, and commit it only if the change was the one you meant to make. CI
 * never runs this; it runs the corpus.
 *
 * It needs the TypeScript port built (`cd typescript && npm run build`),
 * because it drives the real implementation through the real generated SDK's
 * offline transport - not a second model of them.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.cwd()
const DIST = join(ROOT, 'typescript', 'dist', 'test', 'harness.js')
if (!existsSync(DIST)) {
  console.error('  MISSING typescript/dist/test/harness.js - run `cd typescript && npm run build`')
  process.exit(2)
}

const { buildCtx, entries, located } = await import(DIST)
const { run } = await import(join(ROOT, 'typescript', 'dist', 'src', 'core.js'))
const { serialise, stripParityExceptions } = await import(join(ROOT, 'typescript', 'dist', 'src', 'envelope.js'))

const check = process.argv.includes('--check')
let wrote = 0
let stale = 0

// A file an entry asserts afterwards is written under spec/ like stdout. One
// held to a fixture, the configuration it brought, is compared and never written.
function files (e, ctx) {
  for (const [name, rel] of Object.entries(e.out.files ?? {})) {
    const at = located(ctx, name)
    const text = existsSync(at) ? readFileSync(at, 'utf8') : null
    const dst = join(ROOT, rel)
    const have = existsSync(dst) ? readFileSync(dst, 'utf8') : null
    if (null === text) { console.error(`  MISSING ${name} after ${e.id}`); stale++ }
    else if (check || !rel.startsWith('spec/')) {
      if (have !== text) { console.error(`  STALE   ${rel}`); stale++ }
    }
    else {
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, text)
      console.log(`  wrote   ${rel}`)
      wrote++
    }
  }
}

for (const e of entries('cli')) {
  const ctx = buildCtx(e)
  const r = await run(ctx)
  files(e, ctx)
  const dst = join(ROOT, e.out.stdout)

  const text = e.out.stdout.endsWith('.json')
    ? serialise(stripParityExceptions(JSON.parse(r.stdout)))
    : r.stdout

  if (check) {
    const have = existsSync(dst) ? readFileSync(dst, 'utf8') : null
    if (have !== text) { console.error(`  STALE   ${e.out.stdout}`); stale++ }
  }
  else {
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, text)
    console.log(`  wrote   ${e.out.stdout}  (exit ${r.exit}, ${r.calls.length} call(s))`)
    wrote++
  }
}

if (0 < stale) {
  console.error(`\nregen-expect: ${stale} expectation(s) do not match the canonical port.`)
  process.exit(1)
}
if (!check) console.log(`\nregen-expect: ${wrote} file(s) written`)
