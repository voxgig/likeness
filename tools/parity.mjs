#!/usr/bin/env node
/* The cross-port byte comparison.
 *
 *   node tools/parity.mjs <dir> --ports go,py,ts              # compare the ports named
 *   node tools/parity.mjs <dir> --ports go,py,ts --selftest   # prove it goes red
 *
 * Each port's test suite writes its RAW transcript output under <dir>/<port>/
 * when LIKENESS_PARITY_OUT is set. This compares them.
 *
 * FOUR CHECKS, AND THE LAST THREE ARE THE INTERESTING ONES.
 *
 *   1. Every port produced an answer for every entry OF THE CORPUS - the list
 *      comes from spec/cli.json, not from whichever port happened to be
 *      listed first, so a port that emitted eight of thirty-eight entries is
 *      thirty missing answers and not "two ports agree on 8 entries". And the
 *      ports are the ones `--ports` NAMES, not the directories that happen to
 *      exist: a port whose suite skipped its emit would otherwise leave the
 *      comparison quietly, and the rest would agree without it.
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
 * Every port also checks itself against the committed expectations in its own
 * suite. This is not a duplicate of that: it compares the ports to EACH OTHER,
 * so it still holds if an expectation file is wrong.
 *
 * An answer tools/parity-waiting.json declares, by port and entry, with the
 * upstream issue its port waits on, is set aside from check 3's stdout
 * comparison and from nothing else. One that agrees again fails, until its
 * declaration is taken out, so the file cannot outlive what it excuses.
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, strip } from './envelope.mjs'

const dir = process.argv[2]
const selftest = process.argv.includes('--selftest')
const portsAt = process.argv.indexOf('--ports')
const named = -1 === portsAt ? undefined : process.argv[portsAt + 1]

if (undefined === dir || !existsSync(dir) || undefined === named || '' === named) {
  console.error('usage: node tools/parity.mjs <dir> --ports <port>,<port>[,...] [--selftest]')
  console.error('  <dir> holds one subdirectory per port, written by each port\'s suite')
  process.exit(2)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const ports = [...new Set(named.split(','))].sort()
if (ports.length < 2) {
  console.error(`parity: ${ports.length} port(s) named; at least two are needed`)
  process.exit(2)
}

const ids = corpusIds()
const reference = ports[0]
let bad = 0
let noncanon = 0
let missing = 0

// Answers set aside because their port waits on an upstream fix.
const declared = JSON.parse(readFileSync(join(ROOT, 'tools', 'parity-waiting.json'), 'utf8')).waiting
for (const w of declared) {
  if (!ids.includes(w.entry)) {
    console.error(`  WAITING  ${w.port} is declared waiting on ${w.entry}, which is not in the corpus`)
    bad++
  }
  if (!/[\w.-]+\/[\w.-]+#[0-9]+/.test(String(w.reason))) {
    console.error(`  WAITING  ${w.port} is declared waiting on ${w.entry} for a reason that names no issue`)
    bad++
  }
}
const waited = []
const stale = []
const differs = []
const planted = {}

for (const p of readdirSync(dir).filter(p => statSync(join(dir, p)).isDirectory()).sort()) {
  if (!ports.includes(p)) {
    // Output from a port nobody named would otherwise be compared by no one.
    console.error(`  UNNAMED  ${p} wrote output under ${dir} and is not in --ports`)
    bad++
  }
}

console.log(`  comparing ${ports.join(', ')} over ${ids.length} entries`)

for (const id of ids) {
  const got = {}
  let complete = true
  for (const p of ports) {
    const f = join(dir, p, id + '.out')
    // The self-test withholds the last port's answer to the last entry.
    const withheld = selftest && id === ids[ids.length - 1] && p === ports[ports.length - 1]
    if (!existsSync(f) || withheld) {
      // Check 1.
      console.error(`  MISSING  ${p} produced nothing for ${id}`)
      bad++
      missing++
      complete = false
      continue
    }
    got[p] = parse(readFileSync(f, 'utf8'))
  }
  if (!complete) continue

  const waits = new Map(declared.filter(w => id === w.entry && ports.includes(w.port)).map(w => [w.port, w.reason]))

  if (selftest) {
    const before = got[ports[1]].stdout
    // Introduce a single-port difference and require it to be reported. A
    // comparison nobody has seen go red might be comparing nothing at all.
    got[ports[1]].stdout = got[ports[1]].stdout.replace(/"count":(\d+)/, '"count":999')
    // And the right values in the wrong bytes, which check 2 exists to catch.
    if (id === ids[0] && got[ports[1]].stdout.trimEnd().startsWith('{')) {
      got[ports[1]].stdout = JSON.stringify(JSON.parse(got[ports[1]].stdout), null, 2) + '\n'
    }
    // A declared difference must be set aside, and a declared one that has
    // gone must be reported stale.
    const free = !waits.has(ports[0]) && !waits.has(ports[1])
    const altered = before !== got[ports[1]].stdout
    if (free && undefined === planted.excused && altered && id !== ids[0]) {
      planted.excused = id
      waits.set(ports[1], 'selftest: a declared difference')
    }
    else if (free && undefined === planted.stale && !altered &&
      comparable(got[ports[0]].stdout).text === comparable(got[ports[1]].stdout).text) {
      planted.stale = id
      waits.set(ports[1], 'selftest: a declared difference that has gone')
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

  // The answers are judged against the first port that is not waiting.
  const base = ports.find(p => !waits.has(p))
  if (undefined === base) {
    console.error(`  WAITING  ${id}: every port named is declared waiting, so none is judged`)
    bad++
  }
  for (const p of ports) {
    if (undefined === base || base === p) continue
    // Check 3: the parity claim.
    const a = comparable(got[base].stdout).text
    const b = comparable(got[p].stdout).text
    if (waits.has(p)) {
      if (a === b) {
        console.error(`  STALE    ${id}: ${p} agrees with ${base} again; take it out of tools/parity-waiting.json`)
        stale.push(id)
        bad++
      }
      else {
        console.log(`  WAITING  ${id}: ${p} stdout set aside - ${waits.get(p)}`)
        waited.push(id)
      }
    }
    else if (a !== b) {
      console.error(`  DIFFERS  ${id}: ${base} and ${p} disagree on stdout`)
      console.error(`           ${base}: ${a.trimEnd().slice(0, 160)}`)
      console.error(`           ${p}: ${b.trimEnd().slice(0, 160)}`)
      differs.push(id)
      bad++
    }
    if (got[base].exit !== got[p].exit) {
      console.error(`  DIFFERS  ${id}: exit ${got[base].exit} vs ${got[p].exit}`)
      bad++
    }
    if (got[base].stderr !== got[p].stderr) {
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
  if (0 === missing) {
    console.error('\nparity --selftest: a deliberately withheld answer was NOT reported as missing.' +
      ' The comparison is not counting answers.')
    process.exit(1)
  }
  if (undefined === planted.excused || !waited.includes(planted.excused) || differs.includes(planted.excused)) {
    console.error('\nparity --selftest: a difference declared waiting was NOT set aside.' +
      ' The waiting declarations are not read.')
    process.exit(1)
  }
  if (undefined === planted.stale || !stale.includes(planted.stale)) {
    console.error('\nparity --selftest: a waiting answer that agrees again was NOT reported stale.' +
      ' A declaration could outlive what it excuses.')
    process.exit(1)
  }
  console.log(`\nparity --selftest: ok - the deliberate differences were reported (${bad} finding(s),` +
    ` ${noncanon} non-canonical, ${missing} missing, ${stale.length} stale), and a declared one set aside`)
  process.exit(0)
}

if (0 < bad) {
  console.error(`\nparity: ${bad} difference(s) between ports.`)
  process.exit(1)
}
console.log(`\nparity: ok - ${ports.length} ports agree on ${ids.length} entries,` +
  ` but for ${waited.length} answer(s) declared waiting, and each names itself`)
