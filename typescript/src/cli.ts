
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { run, type Ctx, type Connection, PORT, VERSION } from './core.js'
import { rfc3339 } from './identity.js'
import { renderRaw } from './envelope.js'
import { compareCodePoints } from './note.js'

export class ConfigError extends Error {}

const REMEDY = 'fix the file, or point --config at another'

function has (v: unknown): boolean { return undefined !== v && null !== v }
function text (v: unknown): string { return 'string' === typeof v ? v : renderRaw(v) }

// The connections a station file declares, in instance order. Pure, so the
// unit corpus holds both ports to it.
export function parseStation (source: string, path: string): Connection[] {
  let doc: any
  try { doc = JSON.parse(source) }
  catch { throw new ConfigError(path + ' is not valid JSON') }
  const sdk = doc?.sdk ?? {}
  return Object.keys(sdk).sort(compareCodePoints).map(instance => {
    const e = sdk[instance] ?? {}
    let account = has(e.account) ? text(e.account) : ''
    if ('' === account && has(e.org)) account = text(e.org)
    if ('' === account) {
      throw new ConfigError(
        'connection "' + instance + '" has no `account` or `org`, and identity ' +
        'may not be derived from the instance name - see ' + path)
    }
    const c: Connection = { instance, source: has(e.api) ? text(e.api) : '', account }
    if (has(e.apikey)) c.apikey = text(e.apikey)
    if (has(e.base)) c.base = text(e.base)
    return c
  })
}

function loadConnections (configPath?: string): Connection[] {
  const path = configPath ?? join(homedir(), '.config', 'likeness', 'station.json')
  if (!existsSync(path)) return []
  return parseStation(readFileSync(path, 'utf8'), path)
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

// `--config PATH` and `--config=PATH` are one flag, taken out before the
// command's own argv is parsed.
export function takeConfigOption (argv: string[]): { rest: string[], value?: string } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { value = argv[++i]; continue }
    if (argv[i].startsWith('--config=')) { value = argv[i].slice('--config='.length); continue }
    rest.push(argv[i])
  }
  return undefined === value ? { rest } : { rest, value }
}

export async function main (argv: string[]): Promise<number> {
  // A reader that went away is not the port's failure: exit quietly with 0.
  const quiet = (err: NodeJS.ErrnoException): void => {
    if ('EPIPE' === err.code) process.exit(0)
    throw err
  }
  process.stdout.on('error', quiet)
  process.stderr.on('error', quiet)

  const { rest, value: configPath } = takeConfigOption(argv)
  const env = process.env as Record<string, string>

  let connections: Connection[]
  try {
    connections = loadConnections(configPath)
  }
  catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write('error: invalid-project\n  ' + err.message + '\n  remedy  ' + REMEDY + '\n')
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
