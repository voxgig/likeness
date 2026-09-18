
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { run, type Ctx, type Connection, PORT, VERSION } from './core.js'
import { rfc3339 } from './identity.js'

export class ConfigError extends Error {}

function loadConnections (configPath?: string): Connection[] {
  const path = configPath ?? join(homedir(), '.config', 'likeness', 'station.json')
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const sdk = raw.sdk ?? {}
  return Object.keys(sdk).sort().map(instance => {
    const account = sdk[instance].account ?? sdk[instance].org
    if (undefined === account || '' === String(account)) {
      throw new ConfigError(
        'connection "' + instance + '" has no `account` or `org`, and identity ' +
        'may not be derived from the instance name - see ' + path)
    }
    return {
      instance,
      source: String(sdk[instance].api ?? ''),
      account: String(account),
      apikey: sdk[instance].apikey,
      base: sdk[instance].base,
    }
  })
}

function probePath (env: Record<string, string>): { path: string, port: string, version: string }[] {
  const seen = new Set<string>()
  const rows: { path: string, port: string, version: string }[] = []
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if ('' === dir) continue
    let names: string[]
    try { names = readdirSync(dir).sort() }
    catch { continue }
    for (const name of names) {
      const m = /^likeness(?:-([a-z]+))?$/.exec(name)
      if (null === m) continue
      const full = join(dir, name)
      if (seen.has(full)) continue
      try { if (!statSync(full).isFile()) continue }
      catch { continue }
      seen.add(full)
      // The port is read from the file name, not by running it: `which` must
      // not execute whatever happens to be on PATH under a matching name.
      // A bare `likeness` names no port, and says so rather than guessing.
      rows.push({ path: full, port: m[1] ?? '', version: '' })
    }
  }
  if (0 === rows.length) rows.push({ path: '(this port, not on PATH)', port: PORT, version: VERSION })
  return rows
}

function takeOption (argv: string[], name: string): { rest: string[], value?: string } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) { value = argv[++i]; continue }
    if (argv[i].startsWith(name + '=')) { value = argv[i].slice(name.length + 1); continue }
    rest.push(argv[i])
  }
  return { rest, value }
}

export async function main (argv: string[]): Promise<number> {
  const { rest, value: configPath } = takeOption(argv, '--config')
  const env = process.env as Record<string, string>

  let connections: Connection[]
  try {
    connections = loadConnections(configPath)
  }
  catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write('error: invalid-project\n  ' + err.message + '\n')
      return 3
    }
    throw err
  }

  const ctx: Ctx = {
    argv: rest,
    env,
    clock: rfc3339(Date.now()),
    connections,
    path: probePath(env),
  }

  const res = await run(ctx)
  if ('' !== res.stdout) process.stdout.write(res.stdout)
  if ('' !== res.stderr) process.stderr.write(res.stderr)
  return res.exit
}

export { PORT, VERSION }
