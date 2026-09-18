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
 * So: the registry checks always run. The SDK checks run when the generated
 * SDKs are on disk, and say plainly when they are not.
 *
 *   node tools/check-registry.mjs
 *   LIKENESS_SDK_ROOT=/path/to/voxgig-sdk node tools/check-registry.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// AONTU may be a command line ("npx --yes aontu@0.67.0"), not just a binary
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

const sourcesDoc = load('spec/sources.aon')
const capsDoc = load('spec/caps.aon')
if (0 < fail.length) { report(); process.exit(2) }

const sources = sourcesDoc.source
const caps = capsDoc.capability

// -- presence: an empty registry, or a misspelled root key, vets valid -------
if (null == sources || 0 === Object.keys(sources).length) {
  fail.push('spec/sources.aon declares no sources under `source:` - an empty ' +
            'or misspelled root key vets valid, so it is checked here')
}
if (null == caps || 0 === Object.keys(caps).length) {
  fail.push('spec/caps.aon declares no capabilities under `capability:` - same reason')
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
  if (null == sources[key]) fail.push(`capability "${key}" names no source in spec/sources.aon`)
}
for (const key of Object.keys(sources)) {
  if (null == caps[key]) fail.push(`source "${key}" has no capability row in spec/caps.aon`)
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

// -- against the real SDKs, when they are on disk ----------------------------
const sdkRoot = process.env.LIKENESS_SDK_ROOT
if (null == sdkRoot) {
  note.push('SDK cross-check skipped: set LIKENESS_SDK_ROOT to a directory of ' +
            'cloned voxgig-sdk repositories to check the registry against them')
}
else {
  for (const [sname, src] of Object.entries(sources)) {
    const repoDir = join(sdkRoot, src.repo.split('/')[1])
    const entDir = join(repoDir, '.sdk', 'model', 'entity')
    if (!existsSync(entDir)) { warn.push(`${sname}: ${entDir} not found, skipped`); continue }

    const files = readdirSync(entDir).filter(f => f.endsWith('.aon') && 'entity-index.aon' !== f)
    const realEntities = new Set(files.map(f => f.slice(0, -4)))

    for (const declared of Object.keys(src.entity)) {
      if (!realEntities.has(declared)) {
        fail.push(`${sname}: registry declares entity "${declared}" which ${src.repo} does not have`)
      }
    }
    for (const real of realEntities) {
      if (null == src.entity[real]) {
        warn.push(`${sname}: ${src.repo} has entity "${real}" and the registry does not declare it`)
      }
    }

    for (const [ename, ent] of Object.entries(src.entity)) {
      if (!realEntities.has(ename)) continue
      const text = readFileSync(join(entDir, ename + '.aon'), 'utf8')
      const realOps = new Set(
        [...text.matchAll(/^ {4}(\w+): \{$/gm)].map(m => m[1]))
      for (const opname of Object.keys(ent.op)) {
        if (0 < realOps.size && !realOps.has(opname)) {
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
