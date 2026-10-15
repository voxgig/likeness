
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openvault } from '@voxgig/sekreto/plugins/minivault'

import { serialise, stripParityExceptions } from '../src/envelope.js'
import { run, PORT, type Ctx } from '../src/core.js'
import type { Call } from '../src/calls.js'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..', '..')

export type CorpusConn = {
  instance: string
  account: string
  net?: Record<string, unknown>
  block?: Record<string, unknown>
}

export type CliEntry = {
  id: string
  args: string[]
  ctx: {
    fixture: string
    connections: CorpusConn[]
    clock: string
    seed: number
    env?: Record<string, string>
    path?: { path: string, port: string, version: string }[]
    files?: Record<string, string>
    secrets?: unknown
    stdin?: string
    tty?: string[]
  }
  out: {
    exit: number
    stdout: string
    stderr?: string
    calls: Call[]
    prompts?: string[]
    vault?: VaultState
  }
}

export type VaultState = {
  file?: string
  key?: string
  passphrase: string
  names: string[]
  keys?: { key: string, master: boolean, write: boolean, grants: string[] }[]
  values?: Record<string, string>
}

export type UnitEntry = {
  id: string
  fn: string
  in: unknown
  out?: unknown
  err?: string
}

export function corpus (name: string): Record<string, { set: unknown[] }> {
  const raw = readFileSync(join(ROOT, 'spec', name + '.json'), 'utf8')
  return JSON.parse(raw).primary[name]
}

export function entries<T> (name: string): T[] {
  const groups = corpus(name)
  const out: T[] = []
  for (const g of Object.keys(groups).sort()) out.push(...(groups[g].set as T[]))
  return out
}

const homes: string[] = []
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })

// The prompts each run showed, for the entry to compare.
export const PROMPTS = new WeakMap<Ctx, string[]>()

// Each connection becomes a declared station instance, its block the one the
// entry gives, its account the likeness.json entry beside it, and its seed
// the SDK's offline transport. Every run gets a home of its own, holding the
// entry's files.
export function buildCtx (e: CliEntry): Ctx {
  const seed = JSON.parse(
    readFileSync(join(ROOT, 'fixtures', 'sources', e.ctx.fixture, 'seed.json'), 'utf8'))
  delete seed._doc

  const sdk: Record<string, unknown> = {}
  const accounts: Record<string, string> = {}
  const fixture: Record<string, unknown> = {}
  for (const c of e.ctx.connections) {
    sdk[c.instance] = JSON.parse(JSON.stringify(c.block ?? {}))
    accounts[c.instance] = c.account
    const own = JSON.parse(JSON.stringify(seed))
    if (undefined !== c.net) own.net = c.net
    fixture[c.instance] = own
  }

  const home = mkdtempSync(join(tmpdir(), 'likeness-'))
  homes.push(home)
  const dir = join(home, '.config', 'likeness')
  mkdirSync(dir, { recursive: true })
  for (const [name, src] of Object.entries(e.ctx.files ?? {})) {
    const dst = name.startsWith('~/') ? join(home, name.slice(2)) : join(dir, name)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(join(ROOT, src), dst)
  }

  const profile: Record<string, unknown> = { sdk }
  if (undefined !== e.ctx.secrets) profile.secrets = e.ctx.secrets

  const ctx: Ctx = {
    argv: e.args,
    env: e.ctx.env,
    clock: e.ctx.clock,
    seed: e.ctx.seed,
    station: { station: 1, profiles: { default: profile } },
    accounts,
    fixture,
    // Absent stays absent: an entry that declares no PATH is asserting what
    // `which` does when it was told about nothing, which is a different case
    // from being told about an empty list.
    path: e.ctx.path,
    home,
    dir,
    stdin: async () => e.ctx.stdin ?? '',
  }

  if (undefined !== e.ctx.tty) {
    const typed = [...e.ctx.tty]
    const shown: string[] = []
    ctx.tty = true
    ctx.prompt = async (label: string) => { shown.push(label); return typed.shift() }
    PROMPTS.set(ctx, shown)
  }
  return ctx
}

function vaultFailures (e: CliEntry, ctx: Ctx, fail: (s: string) => void): void {
  const want = e.out.vault
  if (undefined === want) return
  const named = want.file ?? 'likeness.skmv'
  const file = named.startsWith('~/') ? join(ctx.home as string, named.slice(2)) : join(ctx.dir as string, named)
  const vault = openvault({ file, key: want.key ?? 'master', passphrase: want.passphrase })
  let names: string[]
  try {
    names = vault.list()
  }
  catch (err) {
    fail('the vault does not open afterwards: ' + String((err as Error).message))
    return
  }
  if (JSON.stringify(names) !== JSON.stringify(want.names)) {
    fail('vault names ' + JSON.stringify(names) + ', expected ' + JSON.stringify(want.names))
  }
  if (undefined !== want.keys) {
    const keys = vault.keys().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    if (JSON.stringify(keys) !== JSON.stringify(want.keys.map(k =>
      ({ key: k.key, master: k.master, write: k.write, grants: k.grants })))) {
      fail('vault keys ' + JSON.stringify(keys) + ', expected ' + JSON.stringify(want.keys))
    }
  }
  for (const [name, value] of Object.entries(want.values ?? {})) {
    if (vault.get(name) !== value) fail('vault value of ' + name + ' is not the one expected')
  }
}

function expected (path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function checkStdout (e: CliEntry, actual: string, fail: (s: string) => void): void {
  const want = expected(e.out.stdout)

  if (!e.out.stdout.endsWith('.json')) {
    if (actual !== want) fail('stdout bytes differ from ' + e.out.stdout)
    return
  }

  let parsed: any
  try {
    parsed = JSON.parse(actual)
  }
  catch {
    fail('stdout is not JSON, and ' + e.out.stdout + ' says it should be')
    return
  }

  // Raw bytes first: indented or CRLF output carries the right values in the
  // wrong bytes, and a value comparison alone let that through.
  const canonical = serialise(parsed)
  if (actual !== canonical) {
    fail('stdout is not in canonical form (sorted keys, one line, one trailing newline): ' +
      JSON.stringify(actual.slice(0, 80)))
  }

  // Removed from the comparison, so asserted here instead - otherwise a port
  // could report someone else's name and no check would notice.
  if (PORT !== parsed.port) {
    fail('envelope port is "' + parsed.port + '", expected "' + PORT + '"')
  }
  if (null !== parsed.data && 'object' === typeof parsed.data && !Array.isArray(parsed.data) &&
      'port' in parsed.data && PORT !== parsed.data.port) {
    fail('data.port is "' + parsed.data.port + '", expected "' + PORT + '"')
  }
  const elapsed = parsed.meta?.elapsed_ms
  if (!Number.isInteger(elapsed) || elapsed < 0) {
    fail('meta.elapsed_ms is ' + JSON.stringify(elapsed) + ', expected a non-negative integer')
  }

  const got = serialise(stripParityExceptions(parsed))
  if (got !== want) fail('stdout differs from ' + e.out.stdout + '\n  want ' + want.trimEnd() +
    '\n  got  ' + got.trimEnd())
}

// The stdout checks alone, over bytes the caller supplies. For the meta-tests,
// which must be able to hand the harness output no port produced.
export function stdoutFailures (e: CliEntry, actual: string): string[] {
  const out: string[] = []
  checkStdout(e, actual, (s) => { out.push(s) })
  return out
}

function sameCalls (want: Call[], got: Call[]): boolean {
  if (want.length !== got.length) return false
  for (let i = 0; i < want.length; i++) {
    if (want[i].instance !== got[i].instance) return false
    if (want[i].method !== got[i].method) return false
    if (want[i].path !== got[i].path) return false
  }
  return true
}

export async function check (e: CliEntry): Promise<string[]> {
  const failures: string[] = []
  const fail = (s: string): void => { failures.push(s) }

  const ctx = buildCtx(e)
  const r = await run(ctx)

  if (r.exit !== e.out.exit) fail('exit ' + r.exit + ', expected ' + e.out.exit)
  checkStdout(e, r.stdout, fail)

  const wantErr = e.out.stderr ?? ''
  if (r.stderr !== wantErr) {
    fail('stderr ' + JSON.stringify(r.stderr) + ', expected ' + JSON.stringify(wantErr))
  }

  if (!sameCalls(e.out.calls, r.calls)) {
    fail('calls ' + JSON.stringify(r.calls) + ', expected ' + JSON.stringify(e.out.calls))
  }

  const prompts = PROMPTS.get(ctx) ?? []
  if (JSON.stringify(prompts) !== JSON.stringify(e.out.prompts ?? [])) {
    fail('prompts ' + JSON.stringify(prompts) + ', expected ' + JSON.stringify(e.out.prompts ?? []))
  }

  vaultFailures(e, ctx, fail)
  return failures
}
