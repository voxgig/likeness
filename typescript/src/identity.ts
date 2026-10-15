
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
 * and the reason the ports do not each reach for their own formatter. A year
 * outside 0000-9999 is refused, never written some other way.
 */
export const RFC3339_MIN = -62167219200000
export const RFC3339_MAX = 253402300799999

export function rfc3339 (ms: number): string {
  if (!Number.isFinite(ms) || ms < RFC3339_MIN || RFC3339_MAX < ms) {
    throw new RangeError('rfc3339: ' + ms + ' ms is outside the years 0000 to 9999')
  }
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return p(d.getUTCFullYear(), 4) + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + 'Z'
}

const INSTANT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/

function daysFromCivil (year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}

function daysIn (year: number, month: number): number {
  const leap = 0 === year % 4 && (0 !== year % 100 || 0 === year % 400)
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

export function parseRfc3339 (text: string): number | undefined {
  const m = INSTANT.exec(text)
  if (null === m) return undefined
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
  if (month < 1 || 12 < month || day < 1 || daysIn(year, month) < day) return undefined
  if (23 < hour || 59 < minute || 59 < second) return undefined
  let offset = 0
  if (undefined !== m[7]) {
    const [oh, om] = [Number(m[8]), Number(m[9])]
    if (23 < oh || 59 < om) return undefined
    offset = ('-' === m[7] ? -1 : 1) * (oh * 60 + om)
  }
  return ((daysFromCivil(year, month, day) * 24 + hour) * 60 + minute - offset) * 60000 + second * 1000
}
