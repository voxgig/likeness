/* The core: a likeness command as a pure function.
 *
 *   (argv, env, config, fixture-state, clock) -> (exit, stdout, stderr, calls)
 *
 * Everything impure is a parameter. The clock is injected, the network is the
 * SDK's offline test transport, identifiers come from a seeded source, and
 * concurrency is unobservable because results are sorted. Given that, a whole
 * command is a corpus entry - which is the reason the argv shell is thin and
 * this is a library.
 */

import { serialise, render, type Envelope } from './envelope.js'
import { parseSelector, fieldsOf, SelectorError } from './selector.js'
import { evaluate } from './evaluate.js'
import { sortNotes, type Note } from './note.js'
import { Calls, type Call } from './calls.js'
import { exitFor, LikenessError } from './errors.js'
import * as joplin from './adapter/joplin.js'

export const VERSION = '0.1.0'
export const PORT = 'ts'

export type Connection = {
  instance: string
  source: string
  account: string
  apikey?: string
  base?: string
}

export type Ctx = {
  argv: string[]
  env?: Record<string, string>
  /* RFC 3339. Injected always: a command that read the wall clock could not be
   * a corpus entry. */
  clock: string
  seed?: number
  connections: Connection[]
  /* Seed maps for the SDKs' offline test mode, by instance. Present in every
   * test and absent in production. */
  fixture?: Record<string, unknown>
  /* Every likeness on PATH, for `which`. Injected rather than probed so the
   * command is testable. */
  path?: { path: string, port: string, version: string }[]
}

export type Result = {
  exit: number
  stdout: string
  stderr: string
  calls: Call[]
}

type Flags = {
  json: boolean
  raw: boolean
  limit?: number
  sort?: string
  strict: boolean
  deterministic: boolean
  instance: string[]
  source: string[]
}

function parseFlags (args: string[]): { flags: Flags, rest: string[] } {
  const flags: Flags = {
    json: false, raw: false, strict: false, deterministic: false,
    instance: [], source: [],
  }
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') { flags.json = true; continue }
    if (a === '--raw') { flags.raw = true; continue }
    if (a === '--strict') { flags.strict = true; continue }
    if (a === '--deterministic') { flags.deterministic = true; continue }
    if (a === '--limit') { flags.limit = Number(args[++i]); continue }
    if (a === '--sort') { flags.sort = args[++i]; continue }
    if (a === '--instance') { flags.instance.push(args[++i]); continue }
    if (a === '--source') { flags.source.push(args[++i]); continue }
    rest.push(a)
  }
  return { flags, rest }
}

function envelope (
  cmd: string[], code: string, data: unknown, meta: Partial<Envelope['meta']>,
  error?: Envelope['error'],
): Envelope {
  const env: Envelope = {
    // `ok` IS FALSE EXACTLY WHEN THE ENVELOPE CARRIES AN `error`. One sentence,
    // no second copy of the registry, and it is the question a caller is
    // actually asking: is there something to read in `error`?
    //
    // Two earlier definitions were both wrong. `code === 'ok' || code ===
    // 'partial'` made `no-match` an error, when the registry's own first line
    // says exit 1 is not one. `exitFor(code) <= 2` then made `not-found` a
    // SUCCESS whose `data` was null - a caller that branched on `ok` and read
    // `data` got null and no explanation.
    //
    // This definition gets every case right: `no-match` carries `[]` and no
    // error, so it is ok despite exit 1; `not-found` and `fanout-halted` carry
    // an error, so they are not, whatever their data and exit status.
    ok: undefined === error,
    code,
    cmd,
    data,
    meta: {
      count: meta.count ?? 0,
      truncated: meta.truncated ?? false,
      sources: meta.sources ?? [],
      incomplete: meta.incomplete ?? [],
      calls: meta.calls ?? 0,
      // A declared non-parity field, removed by name before the byte diff.
      // Zero under --deterministic so the two legitimate exceptions do not
      // defeat the comparison.
      elapsed_ms: meta.elapsed_ms ?? 0,
    },
    port: PORT,
    version: VERSION,
  }
  if (undefined !== error) env.error = error
  return env
}

/* Attach an error to an already-built envelope, keeping `ok` in step.
 *
 * Two commands decide their error only after assembling their data - a halted
 * fan-out and a doctor run - and setting `env.error` directly would leave `ok`
 * saying the opposite. There is no route to an error that does not pass
 * through here or through `envelope`'s own parameter.
 */
function fails (env: Envelope, message: string, remedy: string): Envelope {
  env.error = { message, remedy }
  env.ok = false
  return env
}

function selected (ctx: Ctx, flags: Flags): Connection[] {
  let conns = ctx.connections
  if (0 < flags.instance.length) conns = conns.filter(c => flags.instance.includes(c.instance))
  if (0 < flags.source.length) conns = conns.filter(c => flags.source.includes(c.source))
  return conns
}

function optsFor (ctx: Ctx, c: Connection): joplin.JoplinOpts {
  return {
    instance: c.instance,
    account: c.account,
    seed: ctx.fixture?.[c.instance],
    apikey: c.apikey,
    base: c.base,
  }
}

/* Fetch from every selected connection, carrying a failure the whole length of
 * the pipeline rather than dropping it. Silently dropping a source gives a
 * confident, smaller, wrong answer, which is much worse than a partial one
 * that says so.
 */
async function gather (ctx: Ctx, conns: Connection[], calls: Calls, withRaw: boolean):
Promise<{ notes: Note[], ok: string[], failed: string[] }> {
  const notes: Note[] = []
  const ok: string[] = []
  const failed: string[] = []
  for (const c of conns) {
    try {
      const rows = await joplin.listNotes(optsFor(ctx, c), calls, withRaw)
      notes.push(...rows)
      ok.push(c.instance)
    }
    catch {
      failed.push(c.instance)
    }
  }
  return { notes, ok: ok.sort(), failed: failed.sort() }
}

/* The Note fields every adapter populates whatever the source is: an identity,
 * a title, a URL and the two timestamps. An adapter adds to this; none may
 * subtract from it, which is why `title` is here and `tag` is not.
 */
const UNIVERSAL = ['lid', 'id', 'title', 'url', 'created', 'updated', 'source', 'instance']

function supplies (c: Connection): Set<string> {
  // ONE adapter in Stage 1. The lookup is by the connection's declared source
  // rather than by a conditional on its name, so adding the second adapter
  // adds a row here and changes nothing else.
  const bySource: Record<string, string[]> = { joplin: joplin.SUPPLIES }
  return new Set([...UNIVERSAL, ...(bySource[c.source] ?? [])])
}

/* Which of the asked-about fields no selected source can answer. */
function unanswerable (conns: Connection[], fields: string[]): string[] {
  if (0 === conns.length) return []
  const sets = conns.map(supplies)
  return fields.filter(f => !sets.every(s => s.has(f))).sort()
}

// -- commands ---------------------------------------------------------------

async function cmdList (ctx: Ctx, flags: Flags, rest: string[], calls: Calls): Promise<Envelope> {
  const conns = selected(ctx, flags)
  const clockMs = Date.parse(ctx.clock)

  let filter = null
  if (0 < rest.length && '' !== rest[0]) {
    filter = parseSelector(rest[0])
    // BEFORE THE NETWORK, and before anything is fetched that would then be
    // filtered against a field nobody populated. An adapter declares what it
    // supplies; a question about anything else is refused rather than answered
    // with a confident, wrong "no matches".
    //
    // Every selected source must supply the field, not just one of them: an
    // answer assembled from the sources that could answer and silently missing
    // the ones that could not is the same wrong answer in a longer form.
    const unsupported = unanswerable(conns, fieldsOf(filter))
    if (0 < unsupported.length) {
      throw new LikenessError('unsupported-capability',
        'no source can answer a question about ' + unsupported.join(', '),
        'drop that term, or narrow to a source that supplies it with --source')
    }
  }

  const got = await gather(ctx, conns, calls, flags.raw)
  let notes = got.notes
  if (null !== filter) notes = notes.filter(n => evaluate(filter, n, clockMs))
  notes = sortNotes(notes, flags.sort)

  let truncated = false
  if (undefined !== flags.limit && notes.length > flags.limit) {
    notes = notes.slice(0, flags.limit)
    truncated = true
  }

  const incomplete = got.failed

  // `--strict` refuses to call a partial answer a success. It still PRINTS the
  // rows it has: `fanout-halted` is one of the two codes the registry marks as
  // permitted to carry data, because the work was already done and paid for,
  // and a caller branching on `ok` alone discards it correctly anyway.
  const code =
    0 < incomplete.length && flags.strict ? 'fanout-halted' :
    0 < incomplete.length ? 'partial' :
    // EXIT 1 IS NOT AN ERROR - it is the answer "none", and it has its own code
    // so that a script can tell "nothing matched" from "the query was wrong"
    // without reading English. A `list` that matched nothing returned an
    // answer, so `ok` stays true; only the exit status differs.
    0 === notes.length ? 'no-match' :
    'ok'

  const env = envelope(['list'], code, notes, {
    count: notes.length, truncated, sources: got.ok, incomplete, calls: calls.count(),
  })
  if ('fanout-halted' === code) {
    return fails(env,
      incomplete.join(', ') + ' did not answer and --strict was given',
      'drop --strict to accept a partial answer, or fix the named connection')
  }
  return env
}

async function cmdGet (ctx: Ctx, flags: Flags, rest: string[], calls: Calls): Promise<Envelope> {
  if (0 === rest.length) {
    throw new LikenessError('invalid-ref', 'get needs a ref', 'try `likeness get plan:CORE-412`')
  }
  const out: Note[] = []
  for (const ref of rest) {
    const idx = ref.indexOf(':')
    if (idx < 1) {
      throw new LikenessError('invalid-ref', 'not a ref: ' + ref,
        'a ref is <instance>:<id>, a lid, #n or @alias')
    }
    const instance = ref.slice(0, idx)
    const id = ref.slice(idx + 1)
    const c = ctx.connections.find(x => x.instance === instance)
    if (undefined === c) {
      throw new LikenessError('no-such-source', 'no connection named "' + instance + '"',
        'run `likeness sources list` to see the configured connections')
    }
    const note = await joplin.loadNote(optsFor(ctx, c), calls, id, flags.raw)
    if (null === note) {
      throw new LikenessError('not-found', ref + ' does not exist',
        'check the ref, or run `likeness list` to see what is there')
    }
    out.push(note)
  }
  return envelope(['get'], 'ok', out, {
    count: out.length, sources: [...new Set(out.map(n => n.instance))].sort(), calls: calls.count(),
  })
}

async function cmdDoctor (ctx: Ctx, flags: Flags, calls: Calls): Promise<Envelope> {
  const conns = selected(ctx, flags)
  const rows: Record<string, unknown>[] = []
  const failures: string[] = []
  let bad = 0
  for (const c of conns) {
    const r = await joplin.check(optsFor(ctx, c), calls)
    const row: Record<string, unknown> = {
      instance: c.instance, source: c.source, check: r.ok ? 'ok' : 'FAIL', detail: r.detail,
    }
    if (!r.ok) { row.code = r.code as string; failures.push(r.code as string); bad++ }
    rows.push(row)
  }
  // THE WORST ROW WINS, and "worst" is defined rather than felt: highest exit
  // status first, then code name ascending to break a tie. Reporting a fixed
  // `source-unavailable` for every kind of failure - as an earlier version did
  // - told a user whose token had expired to go and start an application that
  // was already running.
  const codes = [...new Set(failures)].sort((a, b) => {
    const d = exitFor(b) - exitFor(a)
    return 0 !== d ? d : (a < b ? -1 : a > b ? 1 : 0)
  })
  const code = 0 === bad ? 'ok' : codes[0]
  const env = envelope(['doctor'], code, rows, {
    count: rows.length, sources: conns.map(c => c.instance).sort(), calls: calls.count(),
  })
  if (0 < bad) {
    return fails(env,
      bad + (1 === bad ? ' connection needs' : ' connections need') + ' attention',
      'start the application, or check the connection with `likeness sources test`')
  }
  return env
}

function cmdVersion (): Envelope {
  return envelope(['version'], 'ok', { port: PORT, version: VERSION }, { count: 1 })
}

function cmdWhich (ctx: Ctx): Envelope {
  // Injected rather than probed: `which` is a corpus entry like everything
  // else, and a command that read the real PATH could not be one.
  const rows = (ctx.path ?? [{ path: '(this port)', port: PORT, version: VERSION }])
  return envelope(['which'], 'ok', rows, { count: rows.length })
}

const STUBS: Record<string, string> = {
  describe: 'the machine-readable surface document',
  mcp: 'the tool-protocol server',
  project: 'project files and composition',
  search: 'cross-source search',
  caps: 'the capability matrix, printed',
  sources: 'connection management',
}

// -- the entry point --------------------------------------------------------

export async function run (ctx: Ctx): Promise<Result> {
  const calls = new Calls()
  const [name, ...args] = ctx.argv
  const { flags, rest } = parseFlags(args)

  const render = (env: Envelope): Result => ({
    exit: exitFor(env.code),
    // --json puts NOTHING else on stdout. Narration, progress and warnings go
    // to stderr, always.
    stdout: flags.json ? serialise(env) : human(env),
    stderr: flags.json ? '' : narrate(env),
    calls: calls.all(),
  })

  try {
    if (undefined === name || '' === name) {
      throw new LikenessError('invalid-selector', 'no command given',
        'try `likeness list` or `likeness --help`')
    }
    if (name === 'list') return render(await cmdList(ctx, flags, rest, calls))
    if (name === 'get') return render(await cmdGet(ctx, flags, rest, calls))
    if (name === 'doctor') return render(await cmdDoctor(ctx, flags, calls))
    if (name === 'version') return render(cmdVersion())
    if (name === 'which') return render(cmdWhich(ctx))

    if (undefined !== STUBS[name]) {
      // A stub that exists and says it does not work yet, so that neither this
      // nor packaging is a surprise at the stage that needs it.
      throw new LikenessError('unsupported-capability',
        '`' + name + '` is not implemented yet - ' + STUBS[name],
        'it arrives in a later stage; `likeness list`, `get`, `doctor`, `version` and `which` work now')
    }
    throw new LikenessError('invalid-selector', 'no such command: ' + name,
      'run `likeness --help` for the command list')
  }
  catch (err) {
    if (err instanceof SelectorError) {
      const env = envelope([name ?? ''], 'invalid-selector', null,
        { calls: calls.count() },
        {
          message: err.message + ' at byte ' + err.offset,
          remedy: 'check the selector grammar with `likeness describe`',
        })
      return render(env)
    }
    if (err instanceof LikenessError) {
      const env = envelope([name ?? ''], err.code, null, { calls: calls.count() },
        { message: err.message, remedy: err.remedy, ...err.detail })
      return render(env)
    }
    throw err
  }
}

// -- human output -----------------------------------------------------------

function human (env: Envelope): string {
  if (null === env.data) return ''
  const d = env.data
  // Nothing matched: print nothing. `[].join('\n') + '\n'` is a blank line,
  // which reads as one unnamed result and breaks `wc -l`.
  if (Array.isArray(d) && 0 === d.length) return ''
  if (Array.isArray(d) && 0 < d.length && 'object' === typeof d[0] && null !== d[0] &&
      'lid' in (d[0] as object)) {
    const notes = d as unknown as Note[]
    const lines = notes.map((n, i) =>
      String(i + 1).padStart(3) + '  ' + n.instance.padEnd(8) + '  ' + n.title)
    return lines.join('\n') + '\n'
  }
  // `render`, never the host's JSON writer: key order there is insertion order,
  // which differs per port and would put the parity gap straight onto stdout.
  if (Array.isArray(d)) {
    return d.map(r => render(r)).join('\n') + '\n'
  }
  return render(d) + '\n'
}

function narrate (env: Envelope): string {
  const out: string[] = []
  if (0 < env.meta.incomplete.length) {
    out.push(env.meta.incomplete.join(', ') + ' unavailable - results are incomplete')
  }
  if (undefined !== env.error) {
    out.push('error: ' + env.code)
    out.push('  ' + env.error.message)
    out.push('  remedy  ' + env.error.remedy)
  }
  return 0 === out.length ? '' : out.join('\n') + '\n'
}
