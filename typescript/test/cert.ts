
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto'

// DER, by hand: node:crypto signs but writes no certificate, and a test may
// not depend on an openssl being installed.
function len (n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const out: number[] = []
  for (let v = n; 0 < v; v >>= 8) out.unshift(v & 0xff)
  return Buffer.from([0x80 | out.length, ...out])
}

function tlv (tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}

const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p)

function oid (dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a + b]
  for (const n of rest) {
    const bytes = [n & 0x7f]
    for (let v = n >> 7; 0 < v; v >>= 7) bytes.unshift(0x80 | (v & 0x7f))
    out.push(...bytes)
  }
  return tlv(0x06, Buffer.from(out))
}

function utc (d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0')
  return tlv(0x17, Buffer.from(p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'))
}

const TRUE = tlv(0x01, Buffer.from([0xff]))
const DAY = 86400000

let serial = 1

export type Throwaway = { key: string, cert: string, der: Buffer }

/* A self-signed certificate for 127.0.0.1, as the Obsidian plugin makes one:
 * its own authority, naming the address it serves. `days` places its validity
 * around now: [-1, 2] is current, [-3, -1] has expired. */
export function selfSigned (days: [number, number] = [-1, 2]): Throwaway {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('127.0.0.1')))))
  const alg = seq(oid('1.2.840.10045.4.3.2'))
  const now = Date.now()
  const extensions = tlv(0xa3, seq(
    seq(oid('2.5.29.19'), TRUE, tlv(0x04, seq(TRUE))),
    seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x87, Buffer.from([127, 0, 0, 1]))))),
  ))
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([1 + (serial++ % 127)])),
    alg,
    name,
    seq(utc(new Date(now + days[0] * DAY)), utc(new Date(now + days[1] * DAY))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  )
  const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])))
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: new X509Certificate(der).toString(),
    der,
  }
}
