
import { readdirSync, statSync } from 'node:fs'
import { join, delimiter, dirname } from 'node:path'
import { homedir } from 'node:os'
import { run, profileOf, type Ctx, PORT, VERSION } from './core.js'
import { rfc3339 } from './identity.js'
import { ConfigError, loadConfig } from './config.js'
import { presentedFingerprint } from './pin.js'

const REMEDY = 'fix the file, or point --config at another'

// What was typed past a line end, kept for the prompt that follows. A line
// typed ahead arrives ending in \n; Enter in raw mode is \r, so \r\n is one end.
let ahead = ''
let afterCr = false

// One line from the terminal with echo off; undefined at end of input.
function prompt (label: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = process.stdin
    let typed = ''
    const done = (value: string | undefined): void => {
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stderr.write('\n')
      resolve(value)
    }
    const take = (text: string): void => {
      const chars = Array.from(text)
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]
        const lf = afterCr && '\n' === ch
        afterCr = false
        if (lf) continue
        if ('\r' === ch || '\n' === ch) {
          afterCr = '\r' === ch
          ahead = chars.slice(i + 1).join('')
          return done(typed)
        }
        if ('\u0004' === ch) {
          ahead = chars.slice(i + 1).join('')
          return done('' === typed ? undefined : typed)
        }
        if ('\u0003' === ch) {
          input.setRawMode(false)
          process.stderr.write('\n')
          process.exit(130)
        }
        if ('\u007f' === ch || '\b' === ch) typed = Array.from(typed).slice(0, -1).join('')
        else typed += ch
      }
    }
    const onData = (chunk: Buffer): void => { take(chunk.toString('utf8')) }
    // Echo goes off before the label shows, or an answer typed the moment it
    // appears is echoed.
    input.setRawMode(true)
    process.stderr.write(label + ': ')
    input.resume()
    input.on('data', onData)
    const pending = ahead
    ahead = ''
    if ('' !== pending) take(pending)
  })
}

async function readStdin (): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
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

// `--config PATH` or `--config=PATH`, taken out before the command runs. Only a
// single well-formed one after the command and before `--` is taken; anything
// else is left in place for the grammar to refuse.
export function takeConfigOption (argv: string[]): { rest: string[], value?: string } {
  const found: { at: number, width: number, value: string }[] = []
  let bad = false
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if ('--' === a) break
    if ('--config' === a) {
      const next = argv[i + 1]
      if (undefined === next || (next.startsWith('-') && '-' !== next)) bad = true
      else found.push({ at: i, width: 2, value: next })
      i++
    }
    else if (a.startsWith('--config=')) {
      const value = a.slice('--config='.length)
      if ('' === value) bad = true
      else found.push({ at: i, width: 1, value })
    }
  }
  if (bad || 1 !== found.length) return { rest: argv.slice() }
  const { at, width, value } = found[0]
  return { rest: [...argv.slice(0, at), ...argv.slice(at + width)], value }
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
  const home = homedir()
  const path = configPath ?? join(home, '.config', 'likeness', 'station.json')

  let config: { station: unknown, accounts: Record<string, string> }
  try {
    config = loadConfig(path, profileOf(env))
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
    station: config.station,
    accounts: config.accounts,
    path: probePath(env),
    home,
    dir: dirname(path),
    config: path,
    stdin: readStdin,
    tty: true === process.stdin.isTTY,
    prompt,
    presented: presentedFingerprint,
  }

  const res = await run(ctx)
  if ('' !== res.stdout) process.stdout.write(res.stdout)
  if ('' !== res.stderr) process.stderr.write(res.stderr)
  return res.exit
}

export { PORT, VERSION }
