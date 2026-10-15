
import { test } from 'node:test'
import assert from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT } from './harness.js'

const BIN = join(ROOT, 'typescript', 'bin', 'likeness.js')

function refusal (path: string, why: string): string {
  return 'error: invalid-project\n  ' + path + ' ' + why + '\n' +
    '  remedy  fix the file, or point --config at another\n'
}

function badStderr (path: string): string {
  return refusal(path, 'is not valid JSON')
}

function env (home: string): Record<string, string> {
  return { HOME: home, PATH: process.env.PATH ?? '' }
}

function version (home: string, config: string): { status: number | null, stdout: string, stderr: string } {
  return spawnSync(process.execPath, [BIN, 'version', '--json', '--config', config],
    { cwd: home, env: env(home), encoding: 'utf8' })
}

const STATION = '{"station":1,"profiles":{"default":{"sdk":{}}}}'

test('a configuration that cannot be read as a file is refused, not taken for absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'likeness-'))
  const dir = join(home, 'cfg')
  mkdirSync(join(dir, 'likeness.json'), { recursive: true })
  writeFileSync(join(dir, 'station.json'), STATION)
  for (const [config, named] of [[dir, dir], [join(dir, 'station.json'), join(dir, 'likeness.json')]]) {
    const r = version(home, config)
    assert.equal(r.status, 3, config + '\n' + r.stderr)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, refusal(named, 'cannot be read'))
  }
})

test('a configuration this process has no permission to read is refused', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'likeness-'))
  const config = join(home, 'station.json')
  writeFileSync(config, STATION)
  chmodSync(config, 0o000)
  try {
    readFileSync(config)
    t.skip('this process reads a file without permission to, so the refusal cannot be shown here')
    return
  }
  catch { /* the case under test */ }
  const r = version(home, config)
  assert.equal(r.status, 3, r.stderr)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, refusal(config, 'cannot be read'))
})

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
