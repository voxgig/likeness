import { test } from 'node:test'
import assert from 'node:assert'
import { run } from '../src/core.js'

test('version', async () => {
  const r = await run({ argv: ['version', '--json'], clock: '2026-01-01T00:00:00Z', connections: [] })
  assert.equal(r.exit, 0)
  assert.ok(r.stdout.endsWith('\n'))
})
