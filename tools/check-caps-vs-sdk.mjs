#!/usr/bin/env node
/* Check the capability matrix against the SDKs it claims to be reachable through.
 *
 * WHY THIS EXISTS. `aontu vet` proves each file satisfies its own shape. It
 * cannot prove that the two files AGREE: caps.aon may claim `delete: true` for
 * a source whose generated SDK has no remove operation at all, and both files
 * would still be individually valid. That disagreement is the one that turns a
 * refusal into a lie, so it gets its own gate.
 *
 * THE RULE. For the operations that map one-to-one onto an SDK operation:
 *
 *     likeness   SDK
 *     list    -> list
 *     get     -> load
 *     create  -> create
 *     update  -> update
 *     delete  -> remove
 *
 * a capability that is not `false` REQUIRES that SDK operation to exist, and a
 * capability that is `false` requires that it does not - because a capability
 * declared false while the SDK can do it is a feature silently withheld, and
 * that is worth a failing build too.
 *
 * The remaining likeness operations - search, move, tag, link, archive - have
 * no single SDK equivalent. They are composed (an archive is an update setting
 * a flag; a move is an update of a parent id), so they are reported but not
 * enforced. A string value names the mechanism and is the place to look.
 *
 *   node tools/check-caps-vs-sdk.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const AONTU = process.env.AONTU || 'aontu'

const DIRECT = { list: 'list', get: 'load', create: 'create', update: 'update', delete: 'remove' }
const COMPOSED = ['search', 'move', 'tag', 'link', 'archive']

function load (file) {
  if (!existsSync(file)) {
    console.error(`check-caps-vs-sdk: missing ${file}`)
    process.exit(2)
  }
  try {
    return JSON.parse(execFileSync(AONTU, [file], { encoding: 'utf8' }))
  }
  catch (err) {
    console.error(`check-caps-vs-sdk: ${file} did not evaluate`)
    console.error(String(err.stdout || err.message))
    process.exit(2)
  }
}

const caps = load('spec/caps.aon').capability
const sources = load('spec/sources.aon').source

const fail = []
const note = []

for (const [sname, scaps] of Object.entries(caps)) {
  const src = sources[sname]
  if (null == src) {
    fail.push(`capability "${sname}" names no source in spec/sources.aon`)
    continue
  }

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
        fail.push(
          `${sname}.${ename}.${lop}: declared ${JSON.stringify(declared)} but ` +
          `${src.repo} entity "${ent.sdk}" has no "${sdkop}" operation`)
      }
      if (false === declared && present) {
        fail.push(
          `${sname}.${ename}.${lop}: declared false but ` +
          `${src.repo} entity "${ent.sdk}" DOES have "${sdkop}" ` +
          `- a capability withheld from users needs a reason, not a default`)
      }
    }

    for (const lop of COMPOSED) {
      const declared = ent.op[lop]
      if ('string' === typeof declared) {
        note.push(`${sname}.${ename}.${lop}: composed via "${declared}"`)
      }
    }
  }
}

for (const n of note) console.log(`  note  ${n}`)

if (0 < fail.length) {
  console.error('')
  for (const f of fail) console.error(`  FAIL  ${f}`)
  console.error(`\ncheck-caps-vs-sdk: ${fail.length} disagreement(s) between spec/caps.aon and spec/sources.aon`)
  process.exit(1)
}

console.log(`\ncheck-caps-vs-sdk: ok - ${Object.keys(caps).length} sources agree with their SDKs`)
