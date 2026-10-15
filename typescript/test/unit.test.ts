
import { test } from 'node:test'
import assert from 'node:assert'

import { serialise } from '../src/envelope.js'
import { parseSelector, SelectorError } from '../src/selector.js'
import { compareCodePoints } from '../src/note.js'
import { lid, rfc3339, CROCKFORD } from '../src/identity.js'
import { partialCodes } from '../src/errors.js'
import { foldCase } from '../src/evaluate.js'
import { project } from '../src/adapter/joplin.js'
import * as notion from '../src/adapter/notion.js'
import * as obsidian from '../src/adapter/obsidian.js'
import { parsePin, fingerprintOf } from '../src/pin.js'
import { takeConfigOption } from '../src/cli.js'
import { parseStation, parseAccounts } from '../src/config.js'
import { openStation, connectionsOf, profileOf } from '../src/core.js'
import { parseArgv } from '../src/args.js'
import { vaultEntry } from '../src/vault.js'
import { secretName, refFor } from '../src/sources.js'
import { entries, type UnitEntry } from './harness.js'

type Fn = (input: any) => unknown

const REGISTRY: Record<string, Fn> = {
  serialise: (v) => serialise(v),
  parseSelector: (s) => parseSelector(s as string),

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
  foldCase: (s) => foldCase(s as string),
  takeConfigOption: (argv) => takeConfigOption(argv as string[]),
  parseArgv: (argv) => parseArgv(argv as string[]),
  connections: (v) => {
    const { station, likeness, profile } = v as { station: string, likeness: string, profile?: string }
    const env = undefined === profile ? undefined : { VOXGIG_STATION_PROFILE: profile }
    return connectionsOf(openStation(parseStation(station, 'station.json'), env),
      parseAccounts(likeness, 'likeness.json', profileOf(env)), profileOf(env))
  },
  projectJoplin: (v) => {
    const { raw, instance, account } = v as { raw: Record<string, unknown>, instance: string, account: string }
    return project(raw, instance, account, false)
  },
  partialCodes: () => partialCodes(),
  obsidianUrl: (v) => {
    const { vault, path } = v as { vault: string, path: string }
    return obsidian.noteUrl(vault, path)
  },
  vaultEntries: (listed) => obsidian.entries(listed as unknown[]),
  vaultWalk: (v) => {
    const { listings } = v as { listings: Record<string, unknown[]> }
    const out: obsidian.Step[] = []
    const steps = obsidian.walkSteps()
    for (let step = steps.next(); !step.done;) {
      const at = step.value
      out.push(at)
      step = steps.next('list' in at ? obsidian.entries(listings[at.list] ?? []) : undefined)
    }
    return out
  },
  obsidianTransport: (v) => {
    const { instance, block } = v as { instance: string, block: Record<string, unknown> }
    return obsidian.transport(instance, block)
  },
  projectObsidian: (v) => {
    const { raw, path, instance, account } = v as { raw: unknown, path: string, instance: string, account: string }
    return obsidian.project(raw, path, instance, account, false)
  },
  notionVersion: (v) => {
    const { instance, block } = v as { instance: string, block: Record<string, unknown> }
    return notion.configure(instance, block)
  },
  notionTitle: (properties) => notion.titleOf(properties),
  // Absent is `{}`: the corpus has no way to say "no value" but an empty record.
  notionSpace: (parent) => {
    const space = notion.spaceOf(parent)
    return undefined === space ? {} : { space }
  },
  notionTime: (v) => notion.stamp(v, 'created_time'),
  projectNotion: (v) => {
    const { raw, instance, account } = v as { raw: unknown, instance: string, account: string }
    return notion.project(raw, instance, account, false)
  },
  parsePin: (s) => parsePin(s),
  fingerprintOf: (hex) => fingerprintOf(Buffer.from(hex as string, 'hex')),
  secretName: (ref) => secretName(ref as string),
  refFor: (v) => {
    const { source, instance } = v as { source: string, instance?: string }
    return refFor(source, instance)
  },
  vaultEntry: (v) => {
    const { station, profile, key } = v as { station: unknown, profile?: string, key?: string }
    return vaultEntry(station, {
      profile: profile ?? 'default', home: '/home/u', dir: '/home/u/.config/likeness', key,
    })
  },
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
