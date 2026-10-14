
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

function renderNumber (v: number | bigint, path: string, loose: boolean): string {
  if ('bigint' === typeof v) {
    if (v > INT64_MAX || v < INT64_MIN) {
      throw new SerialiseError('integer out of int64 range', path)
    }
    return v.toString()
  }
  if (!Number.isFinite(v)) {
    throw new SerialiseError('non-finite number', path)
  }
  if (loose) return String(v)
  if (!Number.isInteger(v)) {
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
export function render (v: unknown, path: string = '', loose: boolean = false): string {
  if (null === v) return 'null'
  if (undefined === v) {
    // Absent is absent: a caller must delete the key rather than set it to
    // undefined, so that "null" and "missing" stay distinguishable.
    throw new SerialiseError('undefined is not a value - omit the key instead', path)
  }
  if ('boolean' === typeof v) return v ? 'true' : 'false'
  if ('number' === typeof v || 'bigint' === typeof v) return renderNumber(v, path, loose)
  if ('string' === typeof v) return escapeString(v)

  if (Array.isArray(v)) {
    if (0 === v.length) return '[]'
    const parts = v.map((e, i) => render(e, path + '[' + i + ']', loose))
    return '[' + parts.join(',') + ']'
  }

  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort(compareCodePoints)
    if (0 === keys.length) return '{}'
    const parts = keys.map(k =>
      escapeString(k) + ':' + render(v[k], path + '.' + k, loose))
    return '{' + parts.join(',') + '}'
  }

  throw new SerialiseError('value of unsupported type ' + typeof v, path)
}

// A source payload: the same writer with floating point permitted, numbers in
// ECMAScript `Number::toString` form, which every port reproduces.
export function renderRaw (v: unknown): string {
  return render(v, '', true)
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

export const PARITY_EXCEPTIONS = ['port', 'meta.elapsed_ms', 'data.port']

// By PATH, never by name: stripping every key called `port` hid what `which`
// reported. Shared by the corpus runner and `make parity` so they cannot drift.
export function stripParityExceptions (v: unknown): unknown {
  if (!isPlainObject(v)) return v
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) {
    const e = v[k]
    if ('port' === k) continue
    if (('meta' === k || 'data' === k) && isPlainObject(e)) {
      const drop = 'meta' === k ? 'elapsed_ms' : 'port'
      const inner: Record<string, unknown> = {}
      for (const ik of Object.keys(e)) if (drop !== ik) inner[ik] = e[ik]
      out[k] = inner
      continue
    }
    out[k] = e
  }
  return out
}
