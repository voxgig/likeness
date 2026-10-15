#!/usr/bin/env node
/* Write a sekreto minivault: the fixture vault the secrets corpus runs against,
 * or, imported, one a tool makes for a run of its own.
 *
 *   node tools/make-vault.mjs           # refuses to replace the committed one
 *   node tools/make-vault.mjs --force
 *
 *   import { writeVault } from './make-vault.mjs'
 *   writeVault(file, passphrase, { 'joplin.apikey': token })
 *
 * Every port reads this one file: minivault's format is the same in each of
 * sekreto's ports. The bytes change on every run (fresh salts and nonces);
 * what it holds does not, and fixtures/vault/README.md says what that is.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'typescript', 'package.json'))
const { createvault } = require('@voxgig/sekreto/plugins/minivault')

const FILE = join(ROOT, 'fixtures', 'vault', 'likeness.skmv')

// Low on purpose: the stretch costs every command that opens the vault, and a
// vault created by `secrets init` still gets sekreto's default.
const ITERATIONS = 1000

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

function fixture () {
  if (existsSync(FILE)) {
    if (!process.argv.includes('--force')) {
      console.error(`  EXISTS  ${FILE} - pass --force to replace it`)
      process.exit(2)
    }
    rmSync(FILE)
  }
  mkdirSync(dirname(FILE), { recursive: true })

  writeVault(FILE, 'fixture master passphrase', {
    'joplin.apikey': 'joplin-mock-token',
    'notion.apikey': 'notion-fixture-token',
  }, [
    { key: 'ci', passphrase: 'fixture ci passphrase', names: ['joplin.apikey'] },
    { key: 'deploy', passphrase: 'fixture deploy passphrase', names: ['joplin.apikey', 'linear.apikey'], write: true },
  ])

  console.log(`  wrote   ${FILE}`)
}

if (undefined !== process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) fixture()
