
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { serialise, stripParityExceptions } from '../src/envelope.js'
import { run, PORT, type Ctx, type Connection } from '../src/core.js'
import type { Call } from '../src/calls.js'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..', '..')

export type CorpusConn = {
  instance: string
  source: string
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

export function buildCtx (e: CliEntry): Ctx {
  const seed = JSON.parse(
    readFileSync(join(ROOT, 'fixtures', 'sources', e.ctx.fixture, 'seed.json'), 'utf8'))
  delete seed._doc

  const fixture: Record<string, unknown> = {}
  const connections: Connection[] = []
  for (const c of e.ctx.connections) {
    connections.push({ instance: c.instance, source: c.source, account: c.account })
    const own = JSON.parse(JSON.stringify(seed))
    if (undefined !== c.net) own.net = c.net
    fixture[c.instance] = own
  }

  return {
    argv: e.args,
    env: e.ctx.env,
    clock: e.ctx.clock,
    seed: e.ctx.seed,
    connections,
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

  // Removed from the comparison, so asserted here instead - otherwise a port
  // could report someone else's name and no check would notice.
  if (PORT !== parsed.port) {
    fail('envelope port is "' + parsed.port + '", expected "' + PORT + '"')
  }

  const got = serialise(stripParityExceptions(parsed))
  if (got !== want) fail('stdout differs from ' + e.out.stdout + '\n  want ' + want.trimEnd() +
    '\n  got  ' + got.trimEnd())
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
