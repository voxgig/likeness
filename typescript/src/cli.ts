/* The argv shell. Deliberately thin.
 *
 * Everything it does is turn a process into the core's parameters and turn the
 * core's result back into a process: read argv and the environment, supply a
 * real clock, write the bytes, set the exit code. That thinness is what lets
 * the transcript corpus run WHOLE COMMANDS in-process, with no subprocess, no
 * shell quoting and no five different ways of capturing output.
 *
 * If logic appears here, it is logic the corpus cannot reach.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { run, type Ctx, type Connection, PORT, VERSION } from './core.js'
import { rfc3339 } from './identity.js'

function loadConnections (configPath?: string): Connection[] {
  const path = configPath ?? join(homedir(), '.config', 'likeness', 'station.json')
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const sdk = raw.sdk ?? {}
  return Object.keys(sdk).sort().map(instance => ({
    instance,
    source: String(sdk[instance].api ?? ''),
    // Identity is bound to the source's own account key, never to the
    // user-chosen instance name, so renaming a connection does not silently
    // change the identity of every note in it.
    account: String(sdk[instance].account ?? sdk[instance].org ?? instance),
    apikey: sdk[instance].apikey,
    base: sdk[instance].base,
  }))
}

export async function main (argv: string[]): Promise<number> {
  const idx = argv.indexOf('--config')
  const configPath = idx >= 0 ? argv[idx + 1] : undefined

  const ctx: Ctx = {
    argv,
    env: process.env as Record<string, string>,
    clock: rfc3339(Date.now()),
    connections: loadConnections(configPath),
  }

  const res = await run(ctx)
  if ('' !== res.stdout) process.stdout.write(res.stdout)
  if ('' !== res.stderr) process.stderr.write(res.stderr)
  return res.exit
}

export { PORT, VERSION }
