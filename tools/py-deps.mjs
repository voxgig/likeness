#!/usr/bin/env node
/* Put the Python port's dependencies in place: the checkouts python/deps.json
 * pins, and the virtual environment python/.venv that imports them.
 *
 *   node tools/py-deps.mjs          # clone or move each checkout, rebuild a stale venv
 *   node tools/py-deps.mjs --check  # report, change nothing
 *
 * station, sekreto and plugin are on no package index, and station's Python
 * port reads spec/config-shape.json from its own checkout at run time, so a
 * pip install from git cannot stand in for a checkout. Each is cloned at its
 * pin under LIKENESS_PY_DEPS_ROOT (python/.deps by default) and enforced the
 * way tools/fetch-sdk.mjs enforces the SDK clones: at the pin AND clean, and
 * never cleaned automatically.
 *
 * The venv takes the PyPI pins in python/requirements.txt, a .pth file naming
 * each checkout's package directory and each SDK's `py` directory (the clones
 * `make sdk` owns), and the port itself, installed editable so that pip writes
 * its `likeness` and `likeness-py` console scripts. Nothing is installed INTO a
 * checkout: pip would write egg-info there and the pin check would then call it
 * dirty. The same .pth points bytecode at the venv, so running the port writes
 * nothing into a checkout either.
 *
 * The venv is rebuilt only when what it was built from changes: the pin files,
 * the paths, or the interpreter (PYTHON, default python3).
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT_DIR = join(ROOT, 'python')
const VENV = join(PORT_DIR, '.venv')
const DEPS_ROOT = resolve(process.env.LIKENESS_PY_DEPS_ROOT ?? join(PORT_DIR, '.deps'))
const SDK_ROOT = resolve(process.env.LIKENESS_SDK_ROOT ?? join(ROOT, '..', 'voxgig-sdk'))
const PYTHON = process.env.PYTHON || 'python3'
const STAMP = join(VENV, 'likeness-deps.json')

const check = process.argv.includes('--check')

const deps = JSON.parse(readFileSync(join(PORT_DIR, 'deps.json'), 'utf8'))
const sources = JSON.parse(readFileSync(join(ROOT, 'spec', 'sources.json'), 'utf8')).source

function git (args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function run (cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
}

let bad = 0

for (const name of Object.keys(deps.checkout).sort()) {
  const d = deps.checkout[name]
  const dir = join(DEPS_ROOT, name)
  const label = `  ${name.padEnd(9)} ${d.rev.slice(0, 12)}`

  if (!existsSync(join(dir, '.git'))) {
    if (check) { console.error(`${label}  MISSING  ${dir}`); bad++; continue }
    console.log(`${label}  cloning into ${dir}`)
    execFileSync('git', ['clone', '--quiet', `https://github.com/${d.repo}`, dir], { stdio: 'inherit' })
  }

  const head = git(['rev-parse', 'HEAD'], dir)
  const dirty = git(['status', '--porcelain'], dir)

  if (head === d.rev && '' === dirty) { console.log(`${label}  ok`); continue }

  if (head === d.rev) {
    console.error(`${label}  DIRTY  ${dir} is at the pin with modified or untracked files;`)
    console.error('             commit, stash or discard them - this tool will not.')
    bad++
    continue
  }

  if (check) {
    console.error(`${label}  WRONG REVISION  ${dir} is at ${head.slice(0, 12)}`)
    bad++
    continue
  }

  console.log(`${label}  was ${head.slice(0, 12)}, checking out the pin`)
  try { git(['fetch', '--quiet', 'origin', d.rev], dir) }
  catch { /* the revision may already be local; the checkout below decides */ }
  git(['checkout', '--quiet', d.rev], dir)
}

if (0 < bad) {
  console.error(`\npy-deps: ${bad} checkout(s) missing, dirty or off the pin under ${DEPS_ROOT}.`)
  process.exit(1)
}

const paths = [
  ...Object.keys(deps.checkout).sort().map(name => join(DEPS_ROOT, name, deps.checkout[name].dir)),
  ...deps.sdk.map(name => join(SDK_ROOT, basename(sources[name].repo), sources[name].target.py.dir)),
]
for (const p of paths) {
  if (!existsSync(p)) {
    console.error(`  MISSING ${p}` + (p.startsWith(SDK_ROOT) ? ' - run `make sdk`' : ''))
    process.exit(1)
  }
}

const interpreter = execFileSync(PYTHON,
  ['-c', 'import os, sys; print(os.path.realpath(sys.executable), sys.version)'],
  { encoding: 'utf8' }).trim()

const fingerprint = createHash('sha256')
for (const f of ['deps.json', 'requirements.txt', 'pyproject.toml']) {
  fingerprint.update(readFileSync(join(PORT_DIR, f)))
}
fingerprint.update(JSON.stringify({ paths, interpreter }))
const want = fingerprint.digest('hex')

const have = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')).fingerprint : null
if (want === have) {
  console.log(`  venv      ${VENV}  ok`)
  process.exit(0)
}
if (check) {
  console.error(`  venv      ${VENV}  ${null === have ? 'MISSING' : 'STALE'} - run \`make py-deps\``)
  process.exit(1)
}

console.log(`  venv      building ${VENV} with ${interpreter.split(' ')[0]}`)
rmSync(VENV, { recursive: true, force: true })
run(PYTHON, ['-m', 'venv', VENV])
const vpython = join(VENV, 'bin', 'python')
const pip = [vpython, '-m', 'pip', '--disable-pip-version-check', '--no-input', '--quiet']
run(pip[0], [...pip.slice(1), 'install', '--require-virtualenv',
  '-r', join(PORT_DIR, 'requirements.txt')])

const purelib = execFileSync(vpython,
  ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).trim()
// The import line keeps bytecode inside the venv, so no checkout - the SDK
// clone included - is written to by running the port.
const prefix = 'import sys; sys.pycache_prefix = sys.pycache_prefix or ' +
  JSON.stringify(join(VENV, 'pycache'))
writeFileSync(join(purelib, 'likeness-deps.pth'), [...paths, prefix].join('\n') + '\n')

run(pip[0], [...pip.slice(1), 'install', '--no-deps', '--no-build-isolation',
  '--config-settings', 'editable_mode=compat', '-e', PORT_DIR])
writeFileSync(STAMP, JSON.stringify({ fingerprint: want, paths, interpreter }, null, 2) + '\n')
console.log(`  venv      ${VENV}  built`)
