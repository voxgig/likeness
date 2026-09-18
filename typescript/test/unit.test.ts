/* The unit corpus runner.
 *
 * spec/unit.aon compiles to spec/unit.json; this runs every entry in it
 * through the TypeScript port's own exports. THE UNIT CORPUS IS THE ANCHOR OF
 * THE WHOLE PARITY SCHEME: the transcript corpus strips and re-renders output
 * through the port's own writer, so only this file holds `serialise` to bytes
 * that no port produced.
 *
 * Every function under test is registered explicitly rather than looked up
 * dynamically. A registry is one more thing to keep in step, and that is the
 * point: adding a corpus entry for an unregistered function fails loudly here
 * instead of being silently skipped.
 */

import { test } from 'node:test'
import assert from 'node:assert'

import { serialise } from '../src/envelope.js'
import { parseSelector, SelectorError } from '../src/selector.js'
import { compareCodePoints } from '../src/note.js'
import { lid, rfc3339, CROCKFORD } from '../src/identity.js'
import { partialCodes } from '../src/errors.js'
import { entries, type UnitEntry } from './harness.js'

type Fn = (input: any) => unknown

const REGISTRY: Record<string, Fn> = {
  serialise: (v) => serialise(v),
  parseSelector: (s) => parseSelector(s as string),

  /* The error itself is the answer. An entry asserts the BYTE OFFSET it
   * reports and the token it blames, because an error without them sends the
   * reader to count characters by hand - and because the offset is in bytes,
   * not characters, which is the one part five languages will not agree on
   * unless it is written down. */
  parseSelectorError: (s) => {
    try {
      parseSelector(s as string)
    }
    catch (err) {
      if (err instanceof SelectorError) return { offset: err.offset, token: err.token }
      throw err
    }
    throw new Error('expected a SelectorError and the selector parsed cleanly')
  },

  compareCodePoints: (v) => {
    const [a, b] = v as [string, string]
    // Normalised to -1/0/1: the sign is the contract, the magnitude is not,
    // and a port returning a character difference would otherwise pass here
    // and sort identically anyway.
    const n = compareCodePoints(a, b)
    return 0 === n ? 0 : (0 < n ? 1 : -1)
  },

  lid: (v) => {
    const [source, account, entity, id] = v as [string, string, string, string]
    return lid(source, account, entity, id)
  },

  rfc3339: (ms) => rfc3339(ms as number),
  crockfordAlphabet: () => CROCKFORD,
  partialCodes: () => partialCodes(),
}

const all = entries<UnitEntry>('unit')

test('the unit corpus is not empty', () => {
  assert.ok(0 < all.length, 'spec/unit.json has no entries - did `make spec-build` run?')
})

test('every corpus id is unique', () => {
  const seen = new Set<string>()
  for (const e of all) {
    assert.ok(!seen.has(e.id), 'duplicate corpus id: ' + e.id)
    seen.add(e.id)
  }
})

for (const e of all) {
  test('unit ' + e.id, () => {
    const fn = REGISTRY[e.fn]
    assert.ok(undefined !== fn, 'no such function in the registry: ' + e.fn)

    if (undefined !== e.err) {
      // `err` INSTEAD OF `out`, never alongside it: the shape refuses an entry
      // carrying both, so there is no case where a throw could also be quietly
      // matched against a value.
      assert.throws(() => fn(e.in), (thrown: unknown) => {
        const msg = String((thrown as Error)?.message ?? thrown)
        assert.ok(msg.includes(e.err as string),
          'threw "' + msg + '", expected a message containing "' + e.err + '"')
        return true
      })
      return
    }

    assert.deepStrictEqual(fn(e.in), e.out)
  })
}
