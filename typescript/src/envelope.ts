/* The envelope writer: the one place a likeness value becomes bytes.
 *
 * Every command's output passes through here. It is the only way five
 * languages emit the same bytes, so each rule below corresponds to a specific
 * way they diverge for free, and each has a unit corpus case that would have
 * caught it.
 *
 *   sorted keys, recursively, by Unicode code point
 *     Go map iteration is randomised, Python dicts are insertion-ordered, C is
 *     whatever you wrote. Sorting is the only order five languages agree on.
 *
 *   no floating point, anywhere
 *     printf("%g"), Float#to_s and JSON.stringify do not agree and never will.
 *     A non-integer number is REFUSED rather than rendered: durations are
 *     integer milliseconds and anything fractional is carried as a string.
 *
 *   integers exact and bounded to int64
 *     A cursor or a row count must not become 1.0e+15.
 *
 *   UTF-8 literal; escape only '"', '\' and U+0000-U+001F, as \u00xx lowercase
 *     JavaScript emits literal non-ASCII, several C JSON writers escape
 *     everything. Pick one, write it down, test it.
 *
 *   LF endings, exactly one trailing newline
 *     Windows ports and here-documents both get this wrong.
 *
 *   null is emitted; absent is absent
 *     A field that is null and a field that is missing mean different things,
 *     and must not be normalised into each other.
 *
 *   empty containers are emitted as [] and {}, never omitted
 */

export const INT64_MAX = 9223372036854775807n
export const INT64_MIN = -9223372036854775808n

export class SerialiseError extends Error {
  path: string
  constructor (message: string, path: string) {
    super(message + ' at ' + (path === '' ? '$' : path))
    this.name = 'SerialiseError'
    this.path = path
  }
}

/* Escape a string for the envelope.
 *
 * Deliberately narrow: two literals and the C0 control range. No \n, \t or \r
 * shorthands - one form for every control character removes a whole class of
 * per-port disagreement, at the cost of slightly longer output for text that
 * contains newlines. The corpus pins it.
 */
export function escapeString (s: string): string {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return null !== v && 'object' === typeof v && !Array.isArray(v)
}

/* Sort keys by Unicode code point, not by locale and not by UTF-16 code unit.
 *
 * JavaScript's default Array#sort compares UTF-16 code units, which disagrees
 * with a code-point sort for astral characters: U+1D400 is one code point above
 * U+FFFD but its surrogate pair sorts below it. Five ports would not agree, so
 * the comparison is written out rather than inherited.
 */
export function compareCodePoints (a: string, b: string): number {
  const ai = Array.from(a)
  const bi = Array.from(b)
  const n = Math.min(ai.length, bi.length)
  for (let i = 0; i < n; i++) {
    const x = ai[i].codePointAt(0) as number
    const y = bi[i].codePointAt(0) as number
    if (x !== y) return x < y ? -1 : 1
  }
  if (ai.length === bi.length) return 0
  return ai.length < bi.length ? -1 : 1
}

function renderNumber (v: number | bigint, path: string): string {
  if ('bigint' === typeof v) {
    if (v > INT64_MAX || v < INT64_MIN) {
      throw new SerialiseError('integer out of int64 range', path)
    }
    return v.toString()
  }
  if (!Number.isFinite(v)) {
    throw new SerialiseError('non-finite number', path)
  }
  if (!Number.isInteger(v)) {
    // Not a formatting choice: there is no rendering of 0.1 that five
    // languages agree on. Carry it as a string, or scale it to an integer.
    throw new SerialiseError('floating point is not representable in the envelope', path)
  }
  if (!Number.isSafeInteger(v)) {
    throw new SerialiseError('integer beyond exact double precision - use a bigint', path)
  }
  return v.toString()
}

/* Exported so that human output can use it too. `JSON.stringify` and its
 * equivalents are NOT interchangeable with this: they emit keys in insertion
 * order, which is a different order in every port, and that difference would
 * reach stdout the moment a command printed a row without `--json`.
 */
export function render (v: unknown, path: string = ''): string {
  if (null === v) return 'null'
  if (undefined === v) {
    // Absent is absent: a caller must delete the key rather than set it to
    // undefined, so that "null" and "missing" stay distinguishable.
    throw new SerialiseError('undefined is not a value - omit the key instead', path)
  }
  if ('boolean' === typeof v) return v ? 'true' : 'false'
  if ('number' === typeof v || 'bigint' === typeof v) return renderNumber(v, path)
  if ('string' === typeof v) return escapeString(v)

  if (Array.isArray(v)) {
    if (0 === v.length) return '[]'
    const parts = v.map((e, i) => render(e, path + '[' + i + ']'))
    return '[' + parts.join(',') + ']'
  }

  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort(compareCodePoints)
    if (0 === keys.length) return '{}'
    const parts = keys.map(k =>
      escapeString(k) + ':' + render(v[k], path + '.' + k))
    return '{' + parts.join(',') + '}'
  }

  throw new SerialiseError('value of unsupported type ' + typeof v, path)
}

/* The whole point of the module: a value in, the envelope's bytes out,
 * terminated by exactly one LF.
 */
export function serialise (v: unknown): string {
  return render(v, '') + '\n'
}

// -- the envelope itself ----------------------------------------------------

export type Envelope = {
  ok: boolean
  code: string
  cmd: string[]
  data: unknown
  error?: {
    message: string
    remedy: string
    source?: string
    instance?: string
    entity?: string
    op?: string
  }
  meta: {
    count: number
    truncated: boolean
    sources: string[]
    incomplete: string[]
    calls: number
    elapsed_ms: number
    idempotent_replay?: boolean
  }
  port: string
  version: string
}

/* The two declared non-parity fields (SPEC 9.3). The byte comparison removes
 * these BY NAME from both sides before comparing, and the list is exhaustive
 * by construction - anything else differing is a failing check rather than a
 * footnote.
 */
export const PARITY_EXCEPTIONS = ['port', 'elapsed_ms']

/* Remove the declared exceptions, wherever they appear. Used by the corpus
 * runner and by `make parity`; exported so that the two cannot drift.
 */
export function stripParityExceptions (v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripParityExceptions)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) {
      if (PARITY_EXCEPTIONS.includes(k)) continue
      out[k] = stripParityExceptions(v[k])
    }
    return out
  }
  return v
}
