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
    // Identity is bound to the SOURCE'S OWN account key, never to the
    // user-chosen instance name, so renaming a connection does not silently
    // change the identity of every note in it.
    //
    // REFUSED rather than defaulted. An earlier version fell back to the
    // instance name, which contradicted the invariant in the sentence above
    // it: renaming such a connection changed every lid it had ever produced,
    // and nothing said so. A connection that cannot name its account is
    // incomplete, and saying so once at startup is cheaper than discovering it
    // when stored references stop resolving.
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

/* Every `likeness` and `likeness-<port>` on PATH.
 *
 * Probed HERE and injected, never in the core: `which` is a corpus entry like
 * everything else, and a command that read the real PATH could not be one.
 * The core used to carry a placeholder row for production, which meant `which`
 * could never answer the question it exists to answer.
 */
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

/* Remove an option and its value from argv.
 *
 * `--config` is read here and must NOT reach the core: left in place it is
 * parsed as a selector term, so `likeness list --config x.json` matched
 * nothing, and `likeness --config x.json list` took `--config` as the command.
 */
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
