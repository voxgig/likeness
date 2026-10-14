#!/usr/bin/env node
/* Put the voxgig libraries a port loads from checkouts at their pinned revisions.
 *
 *   node tools/fetch-lib.mjs ruby/libs.json                     # clone or move each to its pin
 *   node tools/fetch-lib.mjs ruby/libs.json --check --link DIR  # verify, then link each into DIR
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = process.cwd()
const LIB_ROOT = resolve(process.env.LIKENESS_LIB_ROOT ?? join(ROOT, '..', 'voxgig'))

const args = process.argv.slice(2)
let registry
let linkDir
let check = false
for (let i = 0; i < args.length; i++) {
  if ('--check' === args[i]) check = true
  else if ('--link' === args[i]) linkDir = args[++i]
  else registry ??= args[i]
}

if (undefined === registry || !existsSync(registry) || (args.includes('--link') && undefined === linkDir)) {
  console.error('usage: node tools/fetch-lib.mjs <registry.json> [--check] [--link <dir>]')
  process.exit(2)
}
if (undefined !== linkDir) linkDir = resolve(linkDir)

const libs = JSON.parse(readFileSync(registry, 'utf8')).lib

function git (gitArgs, cwd) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function link (name, dir) {
  mkdirSync(linkDir, { recursive: true })
  const at = join(linkDir, name)
  let stat
  try { stat = lstatSync(at) }
  catch { stat = undefined }
  if (undefined !== stat && !stat.isSymbolicLink()) {
    console.error(`  ${name.padEnd(9)} NOT A LINK  ${at} is a real file or directory - this tool will not remove it`)
    return false
  }
  if (undefined !== stat) unlinkSync(at)
  symlinkSync(dir, at)
  return true
}

let failed = 0

for (const name of Object.keys(libs).sort()) {
  const lib = libs[name]
  // A checkout named by its variable is someone's own: verified, never cloned or moved.
  const named = process.env[lib.home]
  const own = undefined !== named && '' !== named
  const dir = own ? resolve(named) : join(LIB_ROOT, basename(lib.repo))
  const label = `  ${name.padEnd(9)} ${lib.rev.slice(0, 12)}`
  const where = own ? `${dir} ($${lib.home})` : dir

  if (!existsSync(join(dir, '.git'))) {
    if (check || own) { console.error(`${label}  MISSING  ${where}`); failed++; continue }
    console.log(`${label}  cloning into ${dir}`)
    execFileSync('git', ['clone', '--quiet', `https://github.com/${lib.repo}`, dir], { stdio: 'inherit' })
  }

  let head
  try { head = git(['rev-parse', 'HEAD'], dir) }
  catch { console.error(`${label}  NOT A GIT CHECKOUT  ${where}`); failed++; continue }

  // The port loads the working tree, so a dirty checkout at the pin is refused too.
  let dirty = ''
  try { dirty = git(['status', '--porcelain'], dir) }
  catch { /* reported as a wrong revision below if HEAD also failed */ }

  if (head === lib.rev && '' !== dirty) {
    const lines = dirty.split('\n').filter(Boolean)
    console.error(`${label}  DIRTY  ${where} is at the pin with ${lines.length} modified/untracked file(s):`)
    for (const l of lines.slice(0, 5)) console.error(`             ${l}`)
    console.error('             commit, stash or discard them - this tool will not.')
    failed++
    continue
  }

  if (head !== lib.rev) {
    if (check || own) {
      console.error(`${label}  WRONG REVISION  ${where} is at ${head.slice(0, 12)}`)
      failed++
      continue
    }
    console.log(`${label}  was ${head.slice(0, 12)}, checking out the pin`)
    try { git(['fetch', '--quiet', 'origin', lib.rev], dir) }
    catch { /* the revision may already be local; the checkout below decides */ }
    git(['checkout', '--quiet', lib.rev], dir)
  }

  if (undefined !== linkDir && !link(name, dir)) { failed++; continue }
  console.log(`${label}  ok  ${where}`)
}

if (0 < failed) {
  console.error(`\nfetch-lib: ${failed} librar${1 === failed ? 'y is' : 'ies are'} missing, off the pin, dirty or unlinkable.`)
  console.error(`Run without --check to clone and pin them under ${LIB_ROOT} (or set LIKENESS_LIB_ROOT),` +
    ' or point each named variable at a clean checkout of its pin.')
  process.exit(1)
}
