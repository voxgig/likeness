
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
  clock: string
  seed?: number
  connections: Connection[]
  /* Seed maps for the SDKs' offline test mode, by instance. Present in every
   * test and absent in production. */
  fixture?: Record<string, unknown>
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
    if (a === '--limit') {
      // VALIDATED, not coerced. `Number('nope')` is NaN, and every comparison
      // against NaN is false, so a mistyped limit silently disabled limiting
      // altogether; `--limit -1` sliced off the last row and `--limit 0`
      // turned a non-empty match set into `no-match`.
      const raw = args[++i]
      const n = Number(raw)
      if (undefined === raw || '' === raw || !Number.isInteger(n) || n < 1) {
        throw new LikenessError('invalid-selector',
          '--limit needs a whole number of at least 1, not "' + (raw ?? '') + '"',
          'try `--limit 20`')
      }
      flags.limit = n
      continue
    }
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
      elapsed_ms: meta.elapsed_ms ?? 0,
    },
    port: PORT,
    version: VERSION,
  }
  if (undefined !== error) env.error = error
  return env
}

function fails (env: Envelope, message: string, remedy: string): Envelope {
  env.error = { message, remedy }
  env.ok = false
  return env
}

function selected (ctx: Ctx, flags: Flags): Connection[] {
  const unknownInstance = flags.instance.filter(
    i => !ctx.connections.some(c => c.instance === i))
  if (0 < unknownInstance.length) {
    throw new LikenessError('no-such-source',
      'no connection named ' + unknownInstance.sort().map(q).join(', '),
      'run `likeness doctor` to see the configured connections')
  }
  const unknownSource = flags.source.filter(
    src => !ctx.connections.some(c => c.source === src))
  if (0 < unknownSource.length) {
    throw new LikenessError('no-such-source',
      'no connection uses source ' + unknownSource.sort().map(q).join(', '),
      'run `likeness doctor` to see the configured connections')
  }

  let conns = ctx.connections
  if (0 < flags.instance.length) conns = conns.filter(c => flags.instance.includes(c.instance))
  if (0 < flags.source.length) conns = conns.filter(c => flags.source.includes(c.source))
  return conns
}

function q (s: string): string { return '"' + s + '"' }

const ADAPTERS: Record<string, typeof joplin> = { joplin }

function adapterFor (c: Connection): typeof joplin | undefined {
  return ADAPTERS[c.source]
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
async function gather (ctx: Ctx, conns: Connection[], calls: Calls, withRaw: boolean, strict: boolean):
Promise<{ notes: Note[], ok: string[], failed: string[], short: string[] }> {
  const notes: Note[] = []
  const ok: string[] = []
  const failed: string[] = []
  const short: string[] = []
  for (const c of conns) {
    const adapter = adapterFor(c)
    if (undefined === adapter) {
      // A source with no adapter is refused BEFORE the network, not sent
      // through whichever adapter happened to be imported.
      throw new LikenessError('unsupported-capability',
        'no adapter for source "' + c.source + '" (connection "' + c.instance + '")',
        'drop that connection, or narrow to one that is supported with --source')
    }
    try {
      const got = await adapter.listNotes(optsFor(ctx, c), calls, withRaw)
      notes.push(...got.notes)
      ok.push(c.instance)
      if (got.more) short.push(c.instance)
    }
    catch (err) {
      if (err instanceof LikenessError && 'unsupported-capability' === err.code) throw err
      failed.push(c.instance)
      // `--strict` HALTS. `fanout-halted` means the fan-out stopped after a
      // member failed; continuing through every remaining connection and only
      // then choosing that code made the name a lie and spent requests the
      // caller had asked not to spend.
      if (strict) break
    }
  }
  return { notes, ok: ok.sort(), failed: failed.sort(), short: short.sort() }
}

const UNIVERSAL = ['lid', 'id', 'title', 'url', 'created', 'updated', 'source', 'instance']

function supplies (c: Connection): Set<string> {
  // ONE adapter in Stage 1. The lookup is by the connection's declared source
  // rather than by a conditional on its name, so adding the second adapter
  // adds a row here and changes nothing else.
  const bySource: Record<string, string[]> = { joplin: joplin.SUPPLIES }
  return new Set([...UNIVERSAL, ...(bySource[c.source] ?? [])])
}

function unanswerable (conns: Connection[], fields: string[]): string[] {
  if (0 === conns.length) return []
  const sets = conns.map(supplies)
  return fields.filter(f => !sets.every(s => s.has(f))).sort()
}


async function cmdList (ctx: Ctx, flags: Flags, rest: string[], calls: Calls): Promise<Envelope> {
  const conns = selected(ctx, flags)
  const clockMs = Date.parse(ctx.clock)

  let filter = null
  if (0 < rest.length && '' !== rest[0]) {
    filter = parseSelector(rest[0])
    const unsupported = unanswerable(conns, fieldsOf(filter))
    if (0 < unsupported.length) {
      throw new LikenessError('unsupported-capability',
        'no source can answer a question about ' + unsupported.join(', '),
        'drop that term, or narrow to a source that supplies it with --source')
    }
  }

  const got = await gather(ctx, conns, calls, flags.raw, flags.strict)
  let notes = got.notes
  if (null !== filter) notes = notes.filter(n => evaluate(filter, n, clockMs))
  notes = sortNotes(notes, flags.sort)

  let truncated = false
  if (undefined !== flags.limit && notes.length > flags.limit) {
    notes = notes.slice(0, flags.limit)
    truncated = true
  }

  // A source that filled its page may have more. Marked truncated and NAMED in
  // `meta.incomplete`, because a silently short list makes every selector
  // result computed from it wrong with nothing to say so.
  if (0 < got.short.length) truncated = true

  const incomplete = [...got.failed, ...got.short].sort()

  const noneAnswered = 0 < got.failed.length && 0 === got.ok.length

  const code =
    0 < got.failed.length && flags.strict ? 'fanout-halted' :
    noneAnswered ? 'source-unavailable' :
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
      got.failed.join(', ') + ' did not answer and --strict was given',
      'drop --strict to accept a partial answer, or fix the named connection')
  }
  if ('source-unavailable' === code) {
    // `data` IS NULL, not `[]`. The registry does not mark this code as one
    // permitted to carry results, and the distinction is the honest one: `[]`
    // means the sources were asked and held nothing, null means they could not
    // be asked at all.
    env.data = null
    return fails(env,
      'no source answered: ' + got.failed.join(', '),
      'run `likeness doctor` to see which connection is failing and why')
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
    if ('' === id) {
      throw new LikenessError('invalid-ref', 'not a ref: ' + ref + ' (no id after the colon)',
        'a ref is <instance>:<id>, a lid, #n or @alias')
    }
    const c = ctx.connections.find(x => x.instance === instance)
    if (undefined === c) {
      throw new LikenessError('no-such-source', 'no connection named "' + instance + '"',
        'run `likeness doctor` to see the configured connections')
    }
    const adapter = adapterFor(c)
    if (undefined === adapter) {
      throw new LikenessError('unsupported-capability',
        'no adapter for source "' + c.source + '" (connection "' + c.instance + '")',
        'this source arrives in a later stage')
    }
    const note = await adapter.loadNote(optsFor(ctx, c), calls, id, flags.raw)
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
    const adapter = adapterFor(c)
    if (undefined === adapter) {
      // `doctor` REPORTS rather than refuses: naming the unsupported source is
      // exactly the diagnosis the command exists to give.
      rows.push({
        instance: c.instance, source: c.source, check: 'FAIL',
        detail: 'no adapter for this source yet', code: 'unsupported-capability',
      })
      failures.push('unsupported-capability')
      bad++
      continue
    }
    const r = await adapter.check(optsFor(ctx, c), calls)
    const row: Record<string, unknown> = {
      instance: c.instance, source: c.source, check: r.ok ? 'ok' : 'FAIL', detail: r.detail,
    }
    if (!r.ok) { row.code = r.code as string; failures.push(r.code as string); bad++ }
    rows.push(row)
  }
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
      'start the application, check the token, and re-run `likeness doctor`')
  }
  return env
}

function cmdVersion (): Envelope {
  return envelope(['version'], 'ok', { port: PORT, version: VERSION }, { count: 1 })
}

function cmdWhich (ctx: Ctx): Envelope {
  // Injected rather than probed: `which` is a corpus entry like everything
  // else, and a command that read the real PATH could not be one. The argv
  // shell does the probing; see cli.ts. An absent list means the caller
  // supplied none, which is the empty answer, NOT a placeholder row claiming
  // to be the only installation.
  const rows = ctx.path ?? []
  const code = 0 === rows.length ? 'no-match' : 'ok'
  return envelope(['which'], code, rows, { count: rows.length })
}

function cmdHelp (): Envelope {
  const commands = [
    { command: 'list', takes: '[selector]', does: 'list notes across the configured sources' },
    { command: 'get', takes: '<ref>...', does: 'fetch one note by <instance>:<id>' },
    { command: 'doctor', takes: '', does: 'check every configured connection' },
    { command: 'version', takes: '', does: 'this port and its version' },
    { command: 'which', takes: '', does: 'every likeness on PATH' },
    { command: 'help', takes: '', does: 'this' },
  ]
  for (const name of Object.keys(STUBS).sort()) {
    commands.push({ command: name, takes: '', does: STUBS[name] + ' (not implemented yet)' })
  }
  return envelope(['help'], 'ok', commands, { count: commands.length })
}

const STUBS: Record<string, string> = {
  describe: 'the machine-readable surface document',
  mcp: 'the tool-protocol server',
  project: 'project files and composition',
  search: 'cross-source search',
  caps: 'the capability matrix, printed',
  sources: 'connection management',
}


export async function run (ctx: Ctx): Promise<Result> {
  const calls = new Calls()
  const [name, ...args] = ctx.argv
  const started = Date.now()

  // Parsed before the try, so that a bad flag is still reported through the
  // envelope rather than thrown out of `run`.
  let flags: Flags
  let rest: string[]
  try {
    ({ flags, rest } = parseFlags(args))
  }
  catch (err) {
    return finish(ctx, name ?? '', err, calls, started,
      { json: args.includes('--json'), deterministic: args.includes('--deterministic') })
  }

  const render = (env: Envelope): Result => {
    // Measured here, once, around the whole command. Zeroed under
    // --deterministic so the declared exception cannot defeat the byte diff.
    env.meta.elapsed_ms = flags.deterministic ? 0 : Date.now() - started
    return {
      exit: exitFor(env.code),
      stdout: flags.json ? serialise(env) : human(env),
      stderr: flags.json ? '' : narrate(env),
      calls: calls.all(),
    }
  }

  try {
    if (undefined === name || '' === name) {
      throw new LikenessError('invalid-selector', 'no command given',
        'try `likeness list`, or `likeness help` for the command list')
    }
    if (name === '--help' || name === '-h' || name === 'help') return render(cmdHelp())
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
        'it arrives in a later stage; run `likeness help` for what works now')
    }
    throw new LikenessError('invalid-selector', 'no such command: ' + name,
      'run `likeness help` for the command list')
  }
  catch (err) {
    return render(errorEnvelope(name ?? '', err, calls))
  }
}

function errorEnvelope (name: string, err: unknown, calls: Calls): Envelope {
  if (err instanceof SelectorError) {
    return envelope([name], 'invalid-selector', null, { calls: calls.count() }, {
      message: err.message + ' at byte ' + err.offset,
      remedy: 'check the selector grammar with `likeness describe`',
    })
  }
  if (err instanceof LikenessError) {
    return envelope([name], err.code, null, { calls: calls.count() },
      { message: err.message, remedy: err.remedy, ...err.detail })
  }
  const anyErr = err as { status?: number, message?: string }
  const code =
    401 === anyErr?.status || 403 === anyErr?.status ? 'auth-failed' :
    429 === anyErr?.status ? 'rate-limited' :
    'source-unavailable'
  return envelope([name], code, null, { calls: calls.count() }, {
    // The source's own words are not repeated: they differ per port and embed
    // the URL that was tried. The code carries the meaning.
    message: 'the source did not complete the request',
    remedy: 'run `likeness doctor` to see which connection is failing and why',
  })
}

function finish (
  ctx: Ctx, name: string, err: unknown, calls: Calls, started: number,
  opts: { json: boolean, deterministic: boolean },
): Result {
  const env = errorEnvelope(name, err, calls)
  env.meta.elapsed_ms = opts.deterministic ? 0 : Date.now() - started
  return {
    exit: exitFor(env.code),
    stdout: opts.json ? serialise(env) : human(env),
    stderr: opts.json ? '' : narrate(env),
    calls: calls.all(),
  }
}


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
