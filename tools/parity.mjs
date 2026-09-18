#!/usr/bin/env node
/* The cross-port byte comparison.
 *
 *   node tools/parity.mjs <dir>              # compare every port under <dir>
 *   node tools/parity.mjs <dir> --selftest   # prove the comparison goes red
 *
 * Each port's test suite writes its RAW transcript output under <dir>/<port>/
 * when LIKENESS_PARITY_OUT is set. This compares them.
 *
 * THREE CHECKS, AND THE SECOND TWO ARE THE INTERESTING ONES.
 *
 *   1. Every port produced an answer for every entry. A port that silently
 *      emitted nothing would otherwise pass the other two by having nothing to
 *      disagree with.
 *
 *   2. With the declared non-parity fields removed BY NAME AND RECURSIVELY,
 *      the bytes are IDENTICAL. That is the parity claim.
 *
 *   3. With nothing removed, the bytes DIFFER, and each port's envelope names
 *      itself. Every envelope carries its own `port`, so five raw outputs can
 *      never be identical - and a run where they were would mean one port was
 *      reporting another's name, which check 2 alone would applaud.
 *
 * Both ports also check themselves against the committed expectations in their
 * own suites. This is not a duplicate of that: it compares the ports to EACH
 * OTHER, so it still holds if an expectation file is wrong.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const dir = process.argv[2]
const selftest = process.argv.includes('--selftest')

if (undefined === dir || !existsSync(dir)) {
  console.error('usage: node tools/parity.mjs <dir> [--selftest]')
  console.error('  <dir> holds one subdirectory per port, written by each port\'s suite')
  process.exit(2)
}

const PARITY_EXCEPTIONS = ['port', 'elapsed_ms']

function strip (v) {
  if (Array.isArray(v)) return v.map(strip)
  if (null !== v && 'object' === typeof v) {
    const out = {}
    for (const k of Object.keys(v)) {
      if (PARITY_EXCEPTIONS.includes(k)) continue
      out[k] = strip(v[k])
    }
    return out
  }
  return v
}

function render (v) {
  if (null === v) return 'null'
  if ('boolean' === typeof v) return v ? 'true' : 'false'
  if ('number' === typeof v) return String(v)
  if ('string' === typeof v) return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(render).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + render(v[k])).join(',') + '}'
}

// An emitted file is `exit N`, the stdout block, then the stderr block. Split
// rather than parsed, because the stdout of a human-output entry is not JSON
// and must still be compared.
function parse (text) {
  const a = text.indexOf('\n--stdout--\n')
  const b = text.indexOf('--stderr--\n', a)
  return {
    exit: text.slice(0, a).replace('exit ', '').trim(),
    stdout: text.slice(a + '\n--stdout--\n'.length, b),
    stderr: text.slice(b + '--stderr--\n'.length),
  }
}

// stdout with the declared exceptions removed, for check 2. Human output has
// no envelope and so is compared verbatim.
function comparable (stdout) {
  const t = stdout.trimEnd()
  if (!t.startsWith('{')) return stdout
  try { return render(strip(JSON.parse(t))) + '\n' }
  catch { return stdout }
}

function entriesUnder (base) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!name.endsWith('.out')) continue
      out.push(relative(base, p).split(sep).join('/').replace(/\.out$/, ''))
    }
  }
  walk(base)
  return out
}

const ports = readdirSync(dir).filter(p => statSync(join(dir, p)).isDirectory()).sort()
if (ports.length < 2) {
  console.error(`parity: found ${ports.length} port(s) under ${dir}; at least two are needed`)
  process.exit(2)
}

const ids = entriesUnder(join(dir, ports[0]))
const reference = ports[0]
let bad = 0

console.log(`  comparing ${ports.join(', ')} over ${ids.length} entries`)

for (const id of ids) {
  const got = {}
  let complete = true
  for (const p of ports) {
    const f = join(dir, p, id + '.out')
    if (!existsSync(f)) {
      // Check 1.
      console.error(`  MISSING  ${p} produced nothing for ${id}`)
      bad++
      complete = false
      continue
    }
    got[p] = parse(readFileSync(f, 'utf8'))
  }
  if (!complete) continue

  if (selftest) {
    // Introduce a single-port difference and require it to be reported. A
    // comparison nobody has seen go red might be comparing nothing at all.
    got[ports[1]].stdout = got[ports[1]].stdout.replace(/"count":(\d+)/, '"count":999')
  }

  for (const p of ports.slice(1)) {
    // Check 2: the parity claim.
    const a = comparable(got[reference].stdout)
    const b = comparable(got[p].stdout)
    if (a !== b) {
      console.error(`  DIFFERS  ${id}: ${reference} and ${p} disagree on stdout`)
      console.error(`           ${reference}: ${a.trimEnd().slice(0, 160)}`)
      console.error(`           ${p}: ${b.trimEnd().slice(0, 160)}`)
      bad++
    }
    if (got[reference].exit !== got[p].exit) {
      console.error(`  DIFFERS  ${id}: exit ${got[reference].exit} vs ${got[p].exit}`)
      bad++
    }
    if (got[reference].stderr !== got[p].stderr) {
      console.error(`  DIFFERS  ${id}: stderr differs`)
      bad++
    }
  }

  // Check 3: the canonical name check. Only for entries whose stdout is an
  // envelope - human output carries no `port` and is expected to be identical.
  const t = got[reference].stdout.trimEnd()
  if (t.startsWith('{')) {
    for (const p of ports) {
      let name
      try { name = JSON.parse(got[p].stdout.trimEnd()).port }
      catch { name = undefined }
      if (name !== p) {
        console.error(`  NAME     ${id}: ${p} reported port "${name}"`)
        bad++
      }
    }
    for (const p of ports.slice(1)) {
      if (got[reference].stdout === got[p].stdout) {
        console.error(`  IDENTICAL ${id}: ${reference} and ${p} produced the same RAW bytes,` +
          ' which cannot happen while each carries its own port')
        bad++
      }
    }
  }
}

if (selftest) {
  if (0 === bad) {
    console.error('\nparity --selftest: a deliberate single-port difference was NOT reported.' +
      ' The comparison is not comparing anything.')
    process.exit(1)
  }
  console.log(`\nparity --selftest: ok - the deliberate difference was reported (${bad} finding(s))`)
  process.exit(0)
}

if (0 < bad) {
  console.error(`\nparity: ${bad} difference(s) between ports.`)
  process.exit(1)
}
console.log(`\nparity: ok - ${ports.length} ports agree on ${ids.length} entries,` +
  ' and each names itself')
