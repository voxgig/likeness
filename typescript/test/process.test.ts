
import { test } from 'node:test'
import assert from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT } from './harness.js'

const BIN = join(ROOT, 'typescript', 'bin', 'likeness.js')

function badStderr (path: string): string {
  return 'error: invalid-project\n  ' + path + ' is not valid JSON\n' +
    '  remedy  fix the file, or point --config at another\n'
}

function env (home: string): Record<string, string> {
  return { HOME: home, PATH: process.env.PATH ?? '' }
}

test('a malformed configuration is refused the same way through both flag forms', () => {
  const home = mkdtempSync(join(tmpdir(), 'likeness-'))
  const bad = join(home, 'bad.json')
  writeFileSync(bad, '{not json')
  for (const args of [['list', '--json', '--config=' + bad], ['list', '--json', '--config', bad]]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: home, env: env(home), encoding: 'utf8' })
    assert.equal(r.status, 3, args.join(' ') + '\n' + r.stderr)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, badStderr(bad))
  }
})

test('a broken pipe exits quietly with 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'likeness-'))
  const child = spawn(process.execPath, [BIN, 'version', '--json'],
    { cwd: home, env: env(home), stdio: ['ignore', 'pipe', 'pipe'] })
  // The reader goes away before the port has written anything.
  child.stdout.destroy()
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += String(d) })
  const code = await new Promise<number | null>((resolve) => { child.on('close', resolve) })
  assert.equal(stderr, '')
  assert.equal(code, 0)
})
