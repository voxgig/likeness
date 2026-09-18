/* The parity emitter.
 *
 * Writes each transcript entry's RAW stdout - unstripped, exactly the bytes
 * the port produced - into a directory, for `make parity` to compare against
 * another port's. It emits nothing unless LIKENESS_PARITY_OUT names a
 * directory, so an ordinary test run leaves no files behind.
 *
 * RAW, not stripped, on purpose. The comparison needs both forms: the stripped
 * bytes must MATCH between ports, and the raw bytes must DIFFER, because every
 * envelope carries its own `port`. Two ports whose raw output was identical
 * would mean one was reporting the other's name.
 */

import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { run, PORT } from '../src/core.js'
import { buildCtx, entries, type CliEntry } from './harness.js'

const OUT = process.env.LIKENESS_PARITY_OUT

test('emit parity outputs', { skip: undefined === OUT ? 'LIKENESS_PARITY_OUT is not set' : false },
  async () => {
    const base = join(OUT as string, PORT)
    for (const e of entries<CliEntry>('cli')) {
      const r = await run(buildCtx(e))
      const dst = join(base, e.id + '.out')
      mkdirSync(dirname(dst), { recursive: true })
      // exit, stdout and stderr in one file, so a difference in any of the
      // three is one comparison rather than three.
      writeFileSync(dst, 'exit ' + r.exit + '\n--stdout--\n' + r.stdout + '--stderr--\n' + r.stderr)
    }
  })
