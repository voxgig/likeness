#!/usr/bin/env node
/* Check the capability matrix against the source registry, and both against the
 * SDKs when they are available on disk.
 *
 * WHAT THIS CAN AND CANNOT PROVE. `aontu vet` proves each file satisfies its own
 * shape. It cannot prove the two files AGREE, and it cannot notice that a file
 * is EMPTY or that its root key is misspelled - `{&: $.Source}` is satisfied by
 * an empty map, and a data file whose root says `sources:` instead of `source:`
 * vets valid while declaring nothing at all. Both are checked here.
 *
 * An earlier version of this script was called check-caps-vs-sdk and its help
 * text said it checked "the capability matrix against the SDKs". It did not:
 * it read two hand-written files in this repository and compared them to each
 * other. That is worth doing - it is the link between a declared capability and
 * the operation a refusal rests on - but it is a self-consistency check, and
 * calling it a check against the SDKs is how five wrong capability claims
 * survived it while it printed "4 sources agree with their SDKs".
 *
 * So: the registry checks always run, and so do the SDK checks, against the
 * clones `make sdk` puts beside this checkout (or under LIKENESS_SDK_ROOT). A
 * missing clone is a failure, not a skipped check: a cross-check that quietly
 * did not run reads exactly like one that passed.
 *
 *   node tools/check-registry.mjs
 *   LIKENESS_SDK_ROOT=/path/to/voxgig-sdk node tools/check-registry.mjs
 *   node tools/check-registry.mjs --selftest   # a falsified capability must fail
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

// AONTU may be a command line ("npx --yes aontu@0.76.0"), not just a binary
// path. execFileSync does not split one, so a default-configured `make
// spec-agree` failed with ENOENT every time - the script only ever ran for
// someone who overrode AONTU with a single path.
const AONTU_RAW = process.env.AONTU || 'aontu'
const AONTU_PARTS = AONTU_RAW.trim().split(/\s+/)
const AONTU_BIN = AONTU_PARTS[0]
const AONTU_ARGS = AONTU_PARTS.slice(1)

const PORTS = ['ts', 'go', 'py', 'rb', 'c']
const DIRECT = { list: 'list', get: 'load', create: 'create', update: 'update', delete: 'remove' }
const COMPOSED = ['search', 'move', 'tag', 'link', 'archive']

const fail = []
const warn = []
const note = []

function load (file) {
  if (!existsSync(file)) { fail.push(`missing file ${file}`); return null }
  try {
    return JSON.parse(execFileSync(AONTU_BIN, [...AONTU_ARGS, file], { encoding: 'utf8' }))
  }
  catch (err) {
    fail.push(`${file} did not evaluate: ${String(err.stderr || err.message).split('\n')[0]}`)
    return null
  }
}

const sourcesDoc = load('spec/sources.aontu')
const capsDoc = load('spec/caps.aontu')
if (0 < fail.length) { report(); process.exit(2) }

const sources = sourcesDoc.source
const caps = capsDoc.capability

// -- presence: an empty registry, or a misspelled root key, vets valid -------
if (null == sources || 0 === Object.keys(sources).length) {
  fail.push('spec/sources.aontu declares no sources under `source:` - an empty ' +
            'or misspelled root key vets valid, so it is checked here')
}
if (null == caps || 0 === Object.keys(caps).length) {
  fail.push('spec/caps.aontu declares no capabilities under `capability:` - same reason')
}
if (0 < fail.length) { report(); process.exit(1) }

// -- each entry's key matches the name it declares ---------------------------
for (const [key, src] of Object.entries(sources)) {
  if (key !== src.name) fail.push(`source "${key}" declares name "${src.name}"`)
}
for (const [key, sc] of Object.entries(caps)) {
  if (key !== sc.name) fail.push(`capability "${key}" declares name "${sc.name}"`)
}

// -- every capability has a source, and every source has capabilities --------
for (const key of Object.keys(caps)) {
  if (null == sources[key]) fail.push(`capability "${key}" names no source in spec/sources.aontu`)
}
for (const key of Object.keys(sources)) {
  if (null == caps[key]) fail.push(`source "${key}" has no capability row in spec/caps.aontu`)
}

// -- every likeness port can reach every source ------------------------------
// Not an assumption: notion-sdk ships no `rb` target, so this FAILS today, and
// it should, because likeness claims five ports over four sources.
for (const [name, src] of Object.entries(sources)) {
  for (const port of PORTS) {
    if (null == src.target[port]) {
      warn.push(`${name}: no "${port}" target in ${src.repo} - the ${port} port cannot reach this source`)
    }
  }
}

// -- capability rows against the declared SDK surface ------------------------
for (const [sname, scaps] of Object.entries(caps)) {
  const src = sources[sname]
  if (null == src) continue
  if (null == scaps.entity) { fail.push(`${sname}: no entity rows`); continue }

  for (const [ename, ent] of Object.entries(scaps.entity)) {
    const sdkent = src.entity[ent.sdk]
    if (null == sdkent) {
      fail.push(`${sname}.${ename}: sdk entity "${ent.sdk}" is not declared for source "${sname}"`)
      continue
    }
    for (const [lop, sdkop] of Object.entries(DIRECT)) {
      const declared = ent.op[lop]
      const present = null != sdkent.op[sdkop]
      if (false !== declared && !present) {
        fail.push(`${sname}.${ename}.${lop}: declared ${JSON.stringify(declared)} but ` +
                  `${src.repo} entity "${ent.sdk}" has no "${sdkop}" operation`)
      }
      if (false === declared && present) {
        fail.push(`${sname}.${ename}.${lop}: declared false but ${src.repo} entity ` +
                  `"${ent.sdk}" DOES have "${sdkop}" - a capability withheld needs a reason`)
      }
    }
    for (const lop of COMPOSED) {
      const d = ent.op[lop]
      if ('string' === typeof d) note.push(`${sname}.${ename}.${lop}: composed via "${d}"`)
    }
  }

  // Reverse: an SDK entity with no capability row is unmapped, and silence
  // about it is how a source quietly offers less than it can.
  const mapped = new Set(Object.values(scaps.entity).map(e => e.sdk))
  for (const sdkname of Object.keys(src.entity)) {
    if (!mapped.has(sdkname)) warn.push(`${sname}: sdk entity "${sdkname}" has no capability row`)
  }
}

// -- against the real SDKs ----------------------------------------------------
// The same default as tools/fetch-sdk.mjs, so one `make sdk` serves both.
const SDK_ROOT = resolve(process.env.LIKENESS_SDK_ROOT ?? join(process.cwd(), '..', 'voxgig-sdk'))

// The operations a generated model declares: the keys of its `op: {` block
// and nothing else. A model also declares every FIELD as `<name>: {` at the
// same indent, so a scan of the whole file would count `title` and `body`
// as operations and pass a registry that declared them.
function opsOf (text, file) {
  const lines = text.split('\n')
  const open = lines.findIndex(l => /^ {2}op: \{$/.test(l))
  if (open < 0) return null
  const ops = new Set()
  for (let i = open + 1; i < lines.length; i++) {
    if (/^ {2}\}$/.test(lines[i])) return ops
    const m = /^ {4}(\w+): \{$/.exec(lines[i])
    if (null !== m) ops.add(m[1])
  }
  return null
}

const MODEL_FILE = /\.(aontu|aon)$/

function crossCheck (sources, root, fail, warn) {
  if (!existsSync(root)) {
    fail.push(`SDK root ${root} not found - run \`make sdk\`, or set LIKENESS_SDK_ROOT`)
    return
  }
  for (const [sname, src] of Object.entries(sources)) {
    const entDir = join(root, basename(src.repo), '.sdk', 'model', 'entity')
    if (!existsSync(entDir)) {
      fail.push(`${sname}: ${entDir} not found - run \`make sdk\` to clone ${src.repo} at its pin`)
      continue
    }

    const files = readdirSync(entDir).filter(f => MODEL_FILE.test(f) && !f.startsWith('entity-index.'))
    const realEntities = new Map(files.map(f => [f.replace(MODEL_FILE, ''), f]))

    for (const declared of Object.keys(src.entity)) {
      if (!realEntities.has(declared)) {
        fail.push(`${sname}: registry declares entity "${declared}" which ${src.repo} does not have`)
      }
    }
    for (const real of realEntities.keys()) {
      if (null == src.entity[real]) {
        warn.push(`${sname}: ${src.repo} has entity "${real}" and the registry does not declare it`)
      }
    }

    for (const [ename, ent] of Object.entries(src.entity)) {
      const file = realEntities.get(ename)
      if (undefined === file) continue
      const realOps = opsOf(readFileSync(join(entDir, file), 'utf8'), file)
      if (null === realOps) {
        fail.push(`${sname}.${ename}: no \`op: {\` block found in ${join(entDir, file)}`)
        continue
      }
      for (const opname of Object.keys(ent.op)) {
        if (!realOps.has(opname)) {
          fail.push(`${sname}.${ename}: registry declares op "${opname}" which ${src.repo} does not have`)
        }
      }
      for (const real of realOps) {
        if (null == ent.op[real]) {
          warn.push(`${sname}.${ename}: ${src.repo} has op "${real}" and the registry does not declare it`)
        }
      }
    }
  }
}

crossCheck(sources, SDK_ROOT, fail, warn)

// A check nobody has seen go red might be checking nothing: falsify one
// entity and one operation, and require both to be reported.
if (process.argv.includes('--selftest')) {
  const forged = JSON.parse(JSON.stringify(sources))
  const [sname, src] = Object.entries(forged)[0]
  const [ename, ent] = Object.entries(src.entity)[0]
  ent.op.bogusop = { name: 'bogusop', method: 'GET', route: [], pages: false }
  src.entity.bogusentity = { ...ent, name: 'bogusentity', op: {} }
  const found = []
  crossCheck(forged, SDK_ROOT, found, [])
  const sawOp = found.some(f => f.includes(`${sname}.${ename}: registry declares op "bogusop"`))
  const sawEnt = found.some(f => f.includes(`${sname}: registry declares entity "bogusentity"`))
  if (!sawOp || !sawEnt) {
    fail.push(`selftest: a falsified ${sawOp ? 'entity' : 'op'} was not reported - the cross-check is not checking`)
  }
  else note.push('selftest: a falsified entity and a falsified op are both reported')
}

report()
process.exit(0 < fail.length ? 1 : 0)

function report () {
  for (const n of note) console.log(`  note  ${n}`)
  for (const w of warn) console.log(`  WARN  ${w}`)
  if (0 < fail.length) {
    console.error('')
    for (const f of fail) console.error(`  FAIL  ${f}`)
    console.error(`\ncheck-registry: ${fail.length} problem(s)`)
    return
  }
  const n = null == sourcesDoc ? 0 : Object.keys(sourcesDoc.source || {}).length
  console.log(`\ncheck-registry: ok - ${n} sources, capability rows agree with the declared SDK surface` +
              (0 < warn.length ? `, ${warn.length} warning(s)` : ''))
}
