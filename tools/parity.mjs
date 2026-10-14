#!/usr/bin/env node
/* The cross-port byte comparison.
 *
 *   node tools/parity.mjs <dir>              # compare every port under <dir>
 *   node tools/parity.mjs <dir> --selftest   # prove the comparison goes red
 *
 * Each port's test suite writes its RAW transcript output under <dir>/<port>/
 * when LIKENESS_PARITY_OUT is set. This compares them.
 *
 * FOUR CHECKS, AND THE LAST THREE ARE THE INTERESTING ONES.
 *
 *   1. Every port produced an answer for every entry OF THE CORPUS - the list
 *      comes from spec/cli.json, not from whichever port happened to be
 *      listed first, so a port that emitted eight of thirty-eight entries is
 *      thirty missing answers and not "two ports agree on 8 entries".
 *
 *   2. Every port's stdout is the CANONICAL rendering of what it carries:
 *      sorted keys, one line, exactly one trailing newline. Indented JSON or
 *      a CRLF ending carries the right values in the wrong bytes, and the
 *      contract is bytes.
 *
 *   3. With the declared non-parity fields removed BY PATH - the envelope's
 *      own `port`, `meta.elapsed_ms`, and the `port` that `version` repeats
 *      inside an object-valued `data`; nothing deeper, so a `port` inside a
 *      `which` row is compared like any other value - the bytes are
 *      IDENTICAL. That is the parity claim.
 *
 *   4. With nothing removed, the bytes DIFFER, and each port's envelope names
 *      itself. Every envelope carries its own `port`, so five raw outputs can
 *      never be identical - and a run where they were would mean one port was
 *      reporting another's name, which check 3 alone would applaud.
 *
 * Both ports also check themselves against the committed expectations in their
 * own suites. This is not a duplicate of that: it compares the ports to EACH
 * OTHER, so it still holds if an expectation file is wrong.
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.argv[2]
const selftest = process.argv.includes('--selftest')

if (undefined === dir || !existsSync(dir)) {
  console.error('usage: node tools/parity.mjs <dir> [--selftest]')
  console.error('  <dir> holds one subdirectory per port, written by each port\'s suite')
  process.exit(2)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function strip (v) {
  if (null === v || 'object' !== typeof v || Array.isArray(v)) return v
  const out = {}
  for (const k of Object.keys(v)) {
    const e = v[k]
    if ('port' === k) continue
    if (('meta' === k || 'data' === k) && null !== e && 'object' === typeof e && !Array.isArray(e)) {
      const drop = 'meta' === k ? 'elapsed_ms' : 'port'
      const inner = {}
      for (const ik of Object.keys(e)) if (drop !== ik) inner[ik] = e[ik]
      out[k] = inner
      continue
    }
    out[k] = e
  }
  return out
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

// stdout with the declared exceptions removed, for check 3, plus whether the
// raw bytes were canonical, for check 2. Human output has no envelope and so
// is compared verbatim and is canonical by definition.
function comparable (stdout) {
  const t = stdout.trimEnd()
  if (!t.startsWith('{')) return { text: stdout, canonical: true }
  let parsed
  try { parsed = JSON.parse(t) }
  catch { return { text: stdout, canonical: false } }
  return {
    text: render(strip(parsed)) + '\n',
    canonical: stdout === render(parsed) + '\n',
  }
}

// The entries every port must answer: the corpus, not a port's output.
function corpusIds () {
  const doc = JSON.parse(readFileSync(join(ROOT, 'spec', 'cli.json'), 'utf8'))
  const groups = doc.primary.cli
  const ids = []
  for (const g of Object.keys(groups).sort()) for (const e of groups[g].set) ids.push(e.id)
  return ids
}

const ports = readdirSync(dir).filter(p => statSync(join(dir, p)).isDirectory()).sort()
if (ports.length < 2) {
  console.error(`parity: found ${ports.length} port(s) under ${dir}; at least two are needed`)
  process.exit(2)
}

const ids = corpusIds()
const reference = ports[0]
let bad = 0
let noncanon = 0

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
    // And the right values in the wrong bytes, which check 2 exists to catch.
    if (id === ids[0] && got[ports[1]].stdout.trimEnd().startsWith('{')) {
      got[ports[1]].stdout = JSON.stringify(JSON.parse(got[ports[1]].stdout), null, 2) + '\n'
    }
  }

  // Check 2: canonical bytes, every port.
  for (const p of ports) {
    if (!comparable(got[p].stdout).canonical) {
      console.error(`  NONCANON ${id}: ${p} stdout is not in canonical form`)
      bad++
      noncanon++
    }
  }

  for (const p of ports.slice(1)) {
    // Check 3: the parity claim.
    const a = comparable(got[reference].stdout).text
    const b = comparable(got[p].stdout).text
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

  // Check 4: each envelope names its own port, and the raw bytes differ. Only
  // for entries whose stdout is an envelope - human output carries no `port`
  // and is expected to be identical.
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
  if (0 === noncanon) {
    console.error('\nparity --selftest: deliberately indented stdout was NOT reported as non-canonical.' +
      ' The byte check is not checking bytes.')
    process.exit(1)
  }
  console.log(`\nparity --selftest: ok - the deliberate differences were reported (${bad} finding(s),` +
    ` ${noncanon} non-canonical)`)
  process.exit(0)
}

if (0 < bad) {
  console.error(`\nparity: ${bad} difference(s) between ports.`)
  process.exit(1)
}
console.log(`\nparity: ok - ${ports.length} ports agree on ${ids.length} entries,` +
  ' and each names itself')
