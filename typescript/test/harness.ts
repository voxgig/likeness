/* The corpus harness: the one place a corpus entry becomes a verdict.
 *
 * THE HARNESS IS ITSELF TESTED. `meta.test.ts` mutates a passing entry -
 * wrong exit code, one byte of stdout, a missing call, an extra call - and
 * requires each mutation to be reported. A harness nobody has seen go red is a
 * harness that might be reporting nothing at all, and every port needs the
 * equivalent before its results mean anything.
 *
 * `check` RETURNS failures rather than throwing them, which is what makes that
 * possible: the meta-tests assert on the returned list, and the real runner
 * turns a non-empty list into a failed assertion.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { serialise, stripParityExceptions } from '../src/envelope.js'
import { run, PORT, type Ctx, type Connection } from '../src/core.js'
import type { Call } from '../src/calls.js'

// dist/test/harness.js -> the repository root. Three levels, not two: the
// compiled tree is typescript/dist/test/, laid out so that a test's
// `../src/x.js` resolves to the compiled source and not to the TypeScript
// sitting next to it.
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
  // Sorted group names so two runs of the same corpus report in the same
  // order; the JSON is key-sorted already, but a reader should not have to
  // know that to trust the ordering.
  for (const g of Object.keys(groups).sort()) out.push(...(groups[g].set as T[]))
  return out
}

/* Build the runtime context from the entry's declared, impure inputs.
 *
 * The seed handed to each connection is the fixture file, plus that
 * connection's own `net` conditions. That is how "one source answered and the
 * other is down" is expressed without a network, a sleep or a second fixture
 * that has to be kept in step with the first.
 */
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
  }
}

function expected (path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/* Compare stdout.
 *
 * A `.json` expectation is an ENVELOPE: parsed, stripped of the declared
 * non-parity fields by name and recursively, and re-rendered before the byte
 * comparison, so that one committed file serves five ports. A `.txt`
 * expectation is human output, which carries no envelope and so is compared
 * with no transformation at all.
 *
 * The stripping is not a hole in the serialiser's coverage: the unit corpus
 * pins `serialise` against bytes no port produced. This compares content,
 * given a writer already proved correct.
 */
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

/* Run one transcript entry and return every way it failed. An empty list is a
 * pass; the list is not short-circuited, because seeing all four failures at
 * once is the difference between one fix and four rounds.
 */
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

  // ASSERTING CALLS IS THE POINT: without it an entry passes for a command
  // that produced the right answer by making forty requests, and "a refusal
  // never reaches the network" could not be written down at all.
  if (!sameCalls(e.out.calls, r.calls)) {
    fail('calls ' + JSON.stringify(r.calls) + ', expected ' + JSON.stringify(e.out.calls))
  }

  return failures
}
