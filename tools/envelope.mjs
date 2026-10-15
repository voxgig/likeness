/* The envelope's rules, for the tools that compare what the ports print:
 * tools/parity.mjs over the transcript corpus and tools/matrix.mjs over the
 * live path.
 */

// The declared non-parity fields, removed BY PATH - the envelope's own `port`,
// `meta.elapsed_ms`, and the `port` that `version` repeats inside an
// object-valued `data`; nothing deeper, so a `port` inside a `which` row is
// compared like any other value.
export function strip (v) {
  if (null === v || 'object' !== typeof v || Array.isArray(v)) return v
  const out = {}
  for (const k of Object.keys(v)) {
    const e = v[k]
    if ('port' === k) continue
    if (('meta' === k || 'data' === k) && null !== e && 'object' === typeof e && !Array.isArray(e)) {
      const drop = 'meta' === k ? 'elapsed_ms' : 'port'
      const inner = {}
      for (const ik of Object.keys(e)) if (drop !== ik) inner[ik] = e[ik]
      out[k] = inner
      continue
    }
    out[k] = e
  }
  return out
}

// Control characters as four lowercase hex digits, never a short escape, and
// keys sorted by code point rather than UTF-16 unit. A control character in a
// string was the first corpus value to tell the two apart.
export function escapeString (s) {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if ('"' === ch) out += '\\"'
    else if ('\\' === ch) out += '\\\\'
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

export function compareCodePoints (a, b) {
  const ai = Array.from(a); const bi = Array.from(b)
  const n = Math.min(ai.length, bi.length)
  for (let i = 0; i < n; i++) {
    const x = ai[i].codePointAt(0); const y = bi[i].codePointAt(0)
    if (x !== y) return x < y ? -1 : 1
  }
  return ai.length === bi.length ? 0 : (ai.length < bi.length ? -1 : 1)
}

export function render (v) {
  if (null === v) return 'null'
  if ('boolean' === typeof v) return v ? 'true' : 'false'
  if ('number' === typeof v) return String(v)
  if ('string' === typeof v) return escapeString(v)
  if (Array.isArray(v)) return '[' + v.map(render).join(',') + ']'
  const keys = Object.keys(v).sort(compareCodePoints)
  return '{' + keys.map(k => escapeString(k) + ':' + render(v[k])).join(',') + '}'
}
