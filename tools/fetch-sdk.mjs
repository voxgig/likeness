#!/usr/bin/env node
/* Put the generated SDKs on disk at the revisions spec/sources.aon pins.
 *
 *   node tools/fetch-sdk.mjs          # clone or move each clone to its pin
 *   node tools/fetch-sdk.mjs --check  # report, change nothing
 *
 * THE PIN IS ENFORCED, NOT ASPIRATIONAL. A revision written down in a registry
 * that nothing verifies is a comment: the clone on a developer's machine
 * drifts, the port builds against whatever is there, and the corpus records
 * the behaviour of an SDK nobody else has. `--check` is what makes the pinned
 * revision a fact about the build.
 *
 * The revisions are read from spec/sources.json and never restated here. The
 * packages are not published to any language registry yet, which is why this
 * exists at all rather than a lockfile doing the job.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = process.cwd()
const SDK_ROOT = resolve(process.env.LIKENESS_SDK_ROOT ?? join(ROOT, '..', 'voxgig-sdk'))
const check = process.argv.includes('--check')

const sources = JSON.parse(readFileSync(join(ROOT, 'spec', 'sources.json'), 'utf8')).source

function git (args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

let wrong = 0
let dirtyCount = 0
let missing = 0

for (const name of Object.keys(sources).sort()) {
  const s = sources[name]
  const dir = join(SDK_ROOT, basename(s.repo))
  const label = `  ${name.padEnd(9)} ${s.rev.slice(0, 12)}`

  if (!existsSync(join(dir, '.git'))) {
    if (check) { console.error(`${label}  MISSING  ${dir}`); missing++; continue }
    console.log(`${label}  cloning into ${dir}`)
    execFileSync('git', ['clone', '--quiet', `https://github.com/${s.repo}`, dir], { stdio: 'inherit' })
  }

  let head
  try { head = git(['rev-parse', 'HEAD'], dir) }
  catch { console.error(`${label}  NOT A GIT CHECKOUT  ${dir}`); missing++; continue }

  // AT THE PIN IS NOT ENOUGH. The TypeScript port depends on the checkout by
  // `file:` path and the Go port by a `replace` directive, so both build the
  // WORKING TREE, not the commit. A modified or untracked generated file there
  // means the corpus recorded the behaviour of an SDK nobody else has, while
  // this check said the revision was enforced.
  let dirty = ''
  try { dirty = git(['status', '--porcelain'], dir) }
  catch { /* reported as a wrong revision below if HEAD also failed */ }

  if (head === s.rev && '' === dirty) { console.log(`${label}  ok`); continue }

  if (head === s.rev) {
    const lines = dirty.split('\n').filter(Boolean)
    console.error(`${label}  DIRTY  ${dir} is at the pin with ${lines.length} modified/untracked file(s):`)
    for (const l of lines.slice(0, 5)) console.error(`             ${l}`)
    if (5 < lines.length) console.error(`             ... and ${lines.length - 5} more`)
    // Never cleaned automatically, in either mode: the changes may be someone's
    // work in progress on the SDK, and this tool does not own that checkout.
    console.error('             commit, stash or discard them - this tool will not.')
    dirtyCount++
    continue
  }

  if (check) {
    console.error(`${label}  WRONG REVISION  ${dir} is at ${head.slice(0, 12)}`)
    wrong++
    continue
  }

  console.log(`${label}  was ${head.slice(0, 12)}, checking out the pin`)
  try { git(['fetch', '--quiet', 'origin', s.rev], dir) }
  catch { /* the revision may already be local; the checkout below decides */ }
  git(['checkout', '--quiet', s.rev], dir)
}

if (0 < missing + wrong + dirtyCount) {
  console.error(
    `\nfetch-sdk: ${missing} missing, ${wrong} at the wrong revision,` +
    ` ${dirtyCount} at the pin but dirty.`)
  if (0 < dirtyCount) {
    // Never cleaned automatically, in either mode: the changes may be someone's
    // work in progress on the SDK, and this tool does not own that checkout.
    console.error('A dirty checkout is not cleaned automatically; resolve it and re-run.')
  }
  if (0 < missing + wrong) {
    console.error(
      `Run \`make sdk\` to clone and pin them, or set LIKENESS_SDK_ROOT (currently ${SDK_ROOT}).`)
  }
  process.exit(1)
}
