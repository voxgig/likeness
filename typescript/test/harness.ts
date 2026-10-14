
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { serialise, stripParityExceptions } from '../src/envelope.js'
import { run, PORT, type Ctx } from '../src/core.js'
import type { Call } from '../src/calls.js'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..', '..')

export type CorpusConn = {
  instance: string
  account: string
  net?: Record<string, unknown>
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
  }
  out: {
    exit: number
    stdout: string
    stderr?: string
    calls: Call[]
  }
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

// Each connection becomes a declared station instance, its account the
// likeness.json entry beside it, and its seed the SDK's offline transport.
export function buildCtx (e: CliEntry): Ctx {
  const seed = JSON.parse(
    readFileSync(join(ROOT, 'fixtures', 'sources', e.ctx.fixture, 'seed.json'), 'utf8'))
  delete seed._doc

  const sdk: Record<string, unknown> = {}
  const accounts: Record<string, string> = {}
  const fixture: Record<string, unknown> = {}
  for (const c of e.ctx.connections) {
    sdk[c.instance] = {}
    accounts[c.instance] = c.account
    const own = JSON.parse(JSON.stringify(seed))
    if (undefined !== c.net) own.net = c.net
    fixture[c.instance] = own
  }

  return {
    argv: e.args,
    env: e.ctx.env,
    clock: e.ctx.clock,
    seed: e.ctx.seed,
    station: { station: 1, profiles: { default: { sdk } } },
    accounts,
    fixture,
    // Absent stays absent: an entry that declares no PATH is asserting what
    // `which` does when it was told about nothing, which is a different case
    // from being told about an empty list.
    path: e.ctx.path,
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

  const r = await run(buildCtx(e))

  if (r.exit !== e.out.exit) fail('exit ' + r.exit + ', expected ' + e.out.exit)
  checkStdout(e, r.stdout, fail)

  const wantErr = e.out.stderr ?? ''
  if (r.stderr !== wantErr) {
    fail('stderr ' + JSON.stringify(r.stderr) + ', expected ' + JSON.stringify(wantErr))
  }

  if (!sameCalls(e.out.calls, r.calls)) {
    fail('calls ' + JSON.stringify(r.calls) + ', expected ' + JSON.stringify(e.out.calls))
  }

  return failures
}
