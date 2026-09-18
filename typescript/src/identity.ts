
import { createHash } from 'node:crypto'

export const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

/* Encode bytes as Crockford base32, lowercase, big-endian bit order, no
 * padding. Only the first `chars` symbols are produced, which is all the
 * caller needs and keeps the port-to-port surface small.
 */
export function crockford32 (bytes: Uint8Array, chars: number): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(acc >>> bits) & 31]
      if (out.length === chars) return out
    }
  }
  if (bits > 0 && out.length < chars) {
    out += CROCKFORD[(acc << (5 - bits)) & 31]
  }
  return out.slice(0, chars)
}

const NUL = Uint8Array.from([0])

export function lid (source: string, account: string, entity: string, id: string): string {
  const enc = new TextEncoder()
  const h = createHash('sha256')
  h.update(enc.encode(source)); h.update(NUL)
  h.update(enc.encode(account)); h.update(NUL)
  h.update(enc.encode(entity)); h.update(NUL)
  h.update(enc.encode(id))
  return 'lk_' + crockford32(new Uint8Array(h.digest()), 12)
}

/* RFC 3339, UTC, second precision, Z. The ONLY timestamp form likeness emits,
 * and the reason the ports do not each reach for their own formatter.
 */
export function rfc3339 (ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return p(d.getUTCFullYear(), 4) + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + 'Z'
}
