
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createvault, minivaultprovider } from '@voxgig/sekreto/plugins/minivault'
import type { Station } from '@voxgig/station'

import { ROOT } from './harness.js'
import { openStation, connectionsOf, type Connection } from '../src/core.js'
import { Calls } from '../src/calls.js'

const PASSPHRASE = 'wire suite passphrase'
const dirs: string[] = []
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

export type Live = { station: Station, calls: Calls, conns: Connection[] }

/* A station over the given instance blocks, its tokens in a throwaway vault.
 * The published station's sekreto has no minivault kind, so its chain is the
 * vault's own provider, built here, where likeness hands it the declared entry. */
export function live (sdk: Record<string, unknown>, tokens: Record<string, string>,
  accounts: Record<string, string>): Live {
  const dir = mkdtempSync(join(tmpdir(), 'likeness-wire-'))
  dirs.push(dir)
  const file = join(dir, 'likeness.skmv')
  const vault = createvault({ file, passphrase: PASSPHRASE, iterations: 1000 })
  for (const [name, value] of Object.entries(tokens)) vault.set(name, value)
  vault.close()
  const station = openStation({
    station: 1,
    profiles: { default: { secrets: { providers: [minivaultprovider({ file, passphrase: PASSPHRASE })] }, sdk } },
  })
  return { station, calls: new Calls(station), conns: connectionsOf(station, accounts, 'default') }
}

export async function mock (opts: Record<string, unknown>): Promise<{ app: any, base: string }> {
  const { buildServer } = await import(pathToFileURL(join(ROOT, 'mock', 'server.js')).href)
  const app = await buildServer(opts)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const scheme = undefined === opts.https ? 'http' : 'https'
  return { app, base: scheme + '://127.0.0.1:' + app.server.address().port }
}

// The rows of the mock's request ring for one source, in the order they came.
export function rows (app: any, source: string): any[] {
  return app.store.requests.filter((r: any) => source === r.source)
}
