#!/usr/bin/env node
/* Write the fixture vault the secrets corpus runs against.
 *
 *   node tools/make-vault.mjs           # refuses to replace the committed one
 *   node tools/make-vault.mjs --force
 *
 * Every port reads this one file: minivault's format is the same in each of
 * sekreto's ports. The bytes change on every run (fresh salts and nonces);
 * what it holds does not, and fixtures/vault/README.md says what that is.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const require = createRequire(join(ROOT, 'typescript', 'package.json'))
const { createvault } = require('@voxgig/sekreto/plugins/minivault')

const FILE = join(ROOT, 'fixtures', 'vault', 'likeness.skmv')

// Low on purpose: the stretch costs every corpus entry that opens the vault,
// and a vault created by `secrets init` still gets sekreto's default.
const ITERATIONS = 1000

if (existsSync(FILE)) {
  if (!process.argv.includes('--force')) {
    console.error(`  EXISTS  ${FILE} - pass --force to replace it`)
    process.exit(2)
  }
  rmSync(FILE)
}
mkdirSync(join(ROOT, 'fixtures', 'vault'), { recursive: true })

const vault = createvault({
  file: FILE, passphrase: 'fixture master passphrase', iterations: ITERATIONS,
})
vault.set('joplin.apikey', 'joplin-mock-token')
vault.set('notion.apikey', 'notion-fixture-token')
vault.grant({
  key: 'ci', passphrase: 'fixture ci passphrase', iterations: ITERATIONS,
  names: ['joplin.apikey'],
})
vault.grant({
  key: 'deploy', passphrase: 'fixture deploy passphrase', iterations: ITERATIONS,
  names: ['joplin.apikey', 'linear.apikey'], write: true,
})

console.log(`  wrote   ${FILE}`)
