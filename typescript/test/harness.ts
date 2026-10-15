
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openvault } from '@voxgig/sekreto/plugins/minivault'
import { makeRunner, OmniError, type RunPack } from '@voxgig/omni'

import { serialise, SerialiseError, stripParityExceptions } from '../src/envelope.js'
import { run, profileOf, PORT, type Ctx } from '../src/core.js'
import { loadConfig } from '../src/config.js'
import type { Call } from '../src/calls.js'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..', '..')

export type CorpusConn = {
  instance: string
  account: string
  net?: Record<string, unknown>
  fixture?: string
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
    presents?: Record<string, string>
  }
  out: {
    exit: number
    stdout: string
    stderr?: string
    calls: Call[]
    prompts?: string[]
    vault?: VaultState
    files?: Record<string, string>
    absent?: string[]
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

function seedOf (name: string): Record<string, unknown> {
  const seed = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'sources', name, 'seed.json'), 'utf8'))
  delete seed._doc
  return seed
}

// A file the entry names: under the home with `~/`, else in the configuration directory.
export function located (ctx: Ctx, name: string): string {
  return name.startsWith('~/') ? join(ctx.home as string, name.slice(2)) : join(ctx.dir as string, name)
}

const CONFIG_FILES = ['station.json', 'likeness.json']

// Each connection becomes a declared station instance, its block the one the
// entry gives, its account the likeness.json entry beside it, and its seed,
// its own or the entry's, the SDK's offline transport. Every run gets a home of
// its own, holding the entry's files; an entry that brings station.json or
// likeness.json is configured by them alone, read as the argv shell reads them.
export function buildCtx (e: Pick<CliEntry, 'id' | 'args' | 'ctx'>): Ctx {
  const sdk: Record<string, unknown> = {}
  const accounts: Record<string, string> = {}
  const fixture: Record<string, unknown> = {}
  for (const c of e.ctx.connections) {
    sdk[c.instance] = JSON.parse(JSON.stringify(c.block ?? {}))
    accounts[c.instance] = c.account
    const own = seedOf(c.fixture ?? e.ctx.fixture)
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
  let station: unknown = { station: 1, profiles: { default: profile } }
  let read = accounts
  if (Object.keys(e.ctx.files ?? {}).some(name => CONFIG_FILES.includes(name))) {
    if (0 < e.ctx.connections.length || undefined !== e.ctx.secrets) {
      throw new Error(e.id + ': an entry that brings its configuration declares no connections or secrets')
    }
    const loaded = loadConfig(join(dir, 'station.json'), profileOf(e.ctx.env))
    station = loaded.station
    read = loaded.accounts
  }

  const presents = e.ctx.presents ?? {}
  const ctx: Ctx = {
    argv: e.args,
    env: e.ctx.env,
    clock: e.ctx.clock,
    seed: e.ctx.seed,
    station,
    accounts: read,
    fixture,
    // Absent stays absent: an entry that declares no PATH is asserting what
    // `which` does when it was told about nothing, which is a different case
    // from being told about an empty list.
    path: e.ctx.path,
    home,
    dir,
    config: join(dir, 'station.json'),
    stdin: async () => e.ctx.stdin ?? '',
    // Keyed by host:port, the port written out even where it is the scheme's.
    presented: async (base: string) => {
      const url = new URL(base)
      const at = url.hostname + ':' + ('' === url.port ? '443' : url.port)
      if (!Object.hasOwn(presents, at)) throw new Error('nothing answers at ' + at)
      return presents[at]
    },
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

type VaultObserved = { file: string, key: string, passphrase: string, keys: boolean, values?: string[] }

// What the subject must look at to answer an entry, beyond running it.
type Observe = {
  id: string
  json: boolean
  vault?: VaultObserved
  files?: string[]
  absent?: string[]
}

export type Seen = {
  exit: number
  stdout: string
  stderr: string
  calls: Call[]
  prompts: string[]
  faults: string[]
  vault?: unknown
  files?: Record<string, string | null>
  absent?: string[]
}

export type Resolved = { id: string, args: string[], ctx: CliEntry['ctx'] & { observe: Observe }, out: Seen }

// Bytes as a string, losslessly: valid UTF-8 as its text, anything else as one
// lone surrogate per byte, which never comes from decoding valid UTF-8.
function text (buf: Buffer): string {
  const s = buf.toString('utf8')
  return Buffer.from(s, 'utf8').equals(buf) ? s : Array.from(buf, b => String.fromCharCode(0xdc00 + b)).join('')
}

function bytesOf (path: string): string {
  return text(readFileSync(join(ROOT, path)))
}

function callOf (c: Call): Call {
  return { instance: c.instance, method: c.method, path: c.path }
}

function vaultSeen (want: VaultObserved, ctx: Ctx, fault: (s: string) => void): unknown {
  let vault: ReturnType<typeof openvault>
  let names: string[]
  try {
    vault = openvault({ file: located(ctx, want.file), key: want.key, passphrase: want.passphrase })
    names = vault.list()
  }
  catch (err) {
    fault('the vault does not open afterwards: ' + String((err as Error).message))
    return null
  }
  const seen: Record<string, unknown> = { names }
  if (want.keys) seen.keys = vault.keys().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (undefined !== want.values) {
    seen.values = Object.fromEntries(want.values.map(name => [name, vault.get(name) ?? null]))
  }
  return seen
}

// The stdout to compare: as printed, or for JSON the canonical bytes less the
// fields that may differ by port, each of those asserted here instead.
function seenStdout (json: boolean, actual: string, fault: (s: string) => void): string {
  if (!json) return actual

  let parsed: any
  try {
    parsed = JSON.parse(actual)
  }
  catch {
    fault('stdout is not JSON, and the entry says it should be')
    return actual
  }

  // Raw bytes first: indented or CRLF output carries the right values in the
  // wrong bytes, and a value comparison alone let that through.
  let canonical: string
  try {
    canonical = serialise(parsed)
  }
  catch (err) {
    if (!(err instanceof SerialiseError)) throw err
    fault('stdout cannot be re-rendered: ' + err.message)
    return actual
  }
  if (actual !== canonical) {
    fault('stdout is not in canonical form (sorted keys, one line, one trailing newline): ' +
      JSON.stringify(actual.slice(0, 80)))
  }

  if (PORT !== parsed.port) {
    fault('envelope port is "' + parsed.port + '", expected "' + PORT + '"')
  }
  if (null !== parsed.data && 'object' === typeof parsed.data && !Array.isArray(parsed.data) &&
      'port' in parsed.data && PORT !== parsed.data.port) {
    fault('data.port is "' + parsed.data.port + '", expected "' + PORT + '"')
  }
  const elapsed = parsed.meta?.elapsed_ms
  if (!Number.isInteger(elapsed) || elapsed < 0) {
    fault('meta.elapsed_ms is ' + JSON.stringify(elapsed) + ', expected a non-negative integer')
  }

  return serialise(stripParityExceptions(parsed))
}

// The stdout checks alone, over bytes the caller supplies. For the meta-tests,
// which must be able to hand the harness output no port produced.
export function stdoutFailures (e: CliEntry, actual: string): string[] {
  const out: string[] = []
  const rel = e.out.stdout
  if (seenStdout(rel.endsWith('.json'), actual, (s) => { out.push(s) }) !== bytesOf(rel)) {
    out.push('stdout differs from ' + rel)
  }
  return out
}

// The entry as omni runs it. What its `out` names by path becomes the bytes,
// and what the subject must look at to answer it rides in `ctx`.
export function resolved (e: CliEntry): Resolved {
  const o = e.out
  const observe: Observe = { id: e.id, json: o.stdout.endsWith('.json') }
  const want: Seen = {
    exit: o.exit,
    stdout: bytesOf(o.stdout),
    stderr: o.stderr ?? '',
    calls: o.calls.map(callOf),
    prompts: o.prompts ?? [],
    faults: [],
  }
  if (undefined !== o.vault) {
    const v = o.vault
    observe.vault = {
      file: v.file ?? 'likeness.skmv', key: v.key ?? 'master', passphrase: v.passphrase, keys: undefined !== v.keys,
    }
    const vault: Record<string, unknown> = { names: v.names }
    if (undefined !== v.keys) {
      vault.keys = v.keys.map(k => ({ key: k.key, master: k.master, write: k.write, grants: k.grants }))
    }
    if (undefined !== v.values) {
      observe.vault.values = Object.keys(v.values).sort()
      vault.values = v.values
    }
    want.vault = vault
  }
  if (undefined !== o.files) {
    observe.files = Object.keys(o.files).sort()
    want.files = Object.fromEntries(Object.entries(o.files).map(([name, path]) => [name, bytesOf(path)]))
  }
  if (undefined !== o.absent) {
    observe.absent = [...o.absent]
    want.absent = [...o.absent]
  }
  return { id: e.id, args: e.args, ctx: { ...e.ctx, observe }, out: want }
}

// omni's subject for the transcript corpus: one command, in-process.
export async function transcript (ctx: Resolved['ctx'] & { client?: unknown }, ...argv: string[]): Promise<Seen> {
  const { observe, client: _client, ...given } = ctx
  const c = buildCtx({ id: observe.id, args: argv, ctx: given })
  const r = await run(c)
  const faults: string[] = []
  const fault = (s: string): void => { faults.push(s) }
  const seen: Seen = {
    exit: r.exit,
    stdout: seenStdout(observe.json, text(Buffer.from(r.stdout, 'utf8')), fault),
    stderr: r.stderr,
    calls: r.calls.map(callOf),
    prompts: PROMPTS.get(c) ?? [],
    faults,
  }
  if (undefined !== observe.vault) seen.vault = vaultSeen(observe.vault, c, fault)
  if (undefined !== observe.files) {
    seen.files = Object.fromEntries(observe.files.map(name => {
      const at = located(c, name)
      return [name, existsSync(at) ? text(readFileSync(at)) : null]
    }))
  }
  if (undefined !== observe.absent) seen.absent = observe.absent.filter(name => !existsSync(located(c, name)))
  return seen
}

export const CLI_OMNI = { version: 1, requires: ['ctxargs'] }

export async function cliRunner (spec: unknown): Promise<RunPack> {
  return (await makeRunner(spec, { subject: (name: string) => ('cli' === name ? transcript : undefined) }))('cli')
}

// One entry through omni: no failures, or the one omni reports.
export async function check (e: CliEntry): Promise<string[]> {
  const spec = { OMNI: CLI_OMNI, cli: { one: { set: [resolved(e)] } } }
  try {
    await (await cliRunner(spec)).runsetflags(spec.cli.one, { null: false })
  }
  catch (err) {
    if (err instanceof OmniError) return [err.message]
    throw err
  }
  return []
}
