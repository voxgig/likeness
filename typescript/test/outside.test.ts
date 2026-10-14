
import { test } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT } from './harness.js'

test('the port runs from a directory with no checkout and an empty HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'likeness-'))
  const r = spawnSync(process.execPath,
    [join(ROOT, 'typescript', 'bin', 'likeness.js'), 'version', '--json'],
    { cwd: home, env: { HOME: home, PATH: process.env.PATH ?? '' }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const env = JSON.parse(r.stdout)
  assert.equal(env.ok, true)
  assert.equal(env.port, 'ts')
})
