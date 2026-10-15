#!/usr/bin/env node
/* Write a sekreto minivault: the fixture vaults the corpus runs against, or,
 * imported, one a tool makes for a run of its own.
 *
 *   node tools/make-vault.mjs           # writes a missing one, refuses to replace one committed
 *   node tools/make-vault.mjs --force   # replaces both
 *
 *   import { writeVault } from './make-vault.mjs'
 *   writeVault(file, passphrase, { 'joplin.apikey': token })
 *
 * Every port reads these files: minivault's format is the same in each of
 * sekreto's ports. The bytes change on every run (fresh salts and nonces);
 * what each holds does not, and fixtures/vault/README.md says what that is.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'typescript', 'package.json'))
const { createvault } = require('@voxgig/sekreto/plugins/minivault')

const DIR = join(ROOT, 'fixtures', 'vault')

// Low on purpose: the stretch costs every command that opens the vault, and a
// vault created by `secrets init` still gets sekreto's default.
const ITERATIONS = 1000
const MASTER = 'fixture master passphrase'

// A vault holding `secrets` under its master key, and each grant as a key of its own.
export function writeVault (file, passphrase, secrets, grants = []) {
  const vault = createvault({ file, passphrase, iterations: ITERATIONS })
  try {
    for (const [name, value] of Object.entries(secrets)) vault.set(name, value)
    for (const grant of grants) vault.grant({ iterations: ITERATIONS, ...grant })
  }
  finally {
    vault.close()
  }
}

const FIXTURES = {
  'likeness.skmv': [{
    'joplin.apikey': 'joplin-mock-token',
    'notion.apikey': 'notion-fixture-token',
  }, [
    { key: 'ci', passphrase: 'fixture ci passphrase', names: ['joplin.apikey'] },
    { key: 'deploy', passphrase: 'fixture deploy passphrase', names: ['joplin.apikey', 'linear.apikey'], write: true },
  ]],
  // A master key and no secret: a vault as `secrets init` leaves it.
  'empty.skmv': [{}, []],
}

function fixtures () {
  const force = process.argv.includes('--force')
  let refused = 0
  mkdirSync(DIR, { recursive: true })

  for (const [name, [secrets, grants]] of Object.entries(FIXTURES)) {
    const file = join(DIR, name)
    if (existsSync(file)) {
      if (!force) {
        console.error(`  EXISTS  ${file} - pass --force to replace it`)
        refused++
        continue
      }
      rmSync(file)
    }
    writeVault(file, MASTER, secrets, grants)
    console.log(`  wrote   ${file}`)
  }

  if (refused === Object.keys(FIXTURES).length) process.exit(2)
}

if (undefined !== process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) fixtures()
