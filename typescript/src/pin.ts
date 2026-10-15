
import { createHash, type X509Certificate } from 'node:crypto'
import http from 'node:http'
import { isIP } from 'node:net'
import tls from 'node:tls'

const PIN = /^sha256:(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31})$/

export class PinError extends Error {}

// `sha256:` and the hex digest, bare or as colon-joined pairs, either case.
export function parsePin (text: unknown): string {
  if ('string' !== typeof text || !PIN.test(text)) throw new PinError('not a sha256 certificate fingerprint')
  return 'sha256:' + text.slice('sha256:'.length).replace(/:/g, '').toLowerCase()
}

export function fingerprintOf (der: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(der).digest('hex')
}

export type Refusal = 'changed' | 'expired' | 'not-yet-valid' | 'wrong-host' | 'invalid'

export class CertificateError extends Error {
  refusal: Refusal
  constructor (refusal: Refusal) {
    super('the certificate was refused: ' + refusal)
    this.name = 'CertificateError'
    this.refusal = refusal
  }
}

function refusalOf (code: string): Refusal {
  if ('CERT_HAS_EXPIRED' === code) return 'expired'
  if ('CERT_NOT_YET_VALID' === code) return 'not-yet-valid'
  if ('ERR_TLS_CERT_ALTNAME_INVALID' === code || 'HOSTNAME_MISMATCH' === code) return 'wrong-host'
  // Any other chain failure means the anchor is not what was presented.
  return /SELF_SIGNED|ISSUER|LEAF_SIGNATURE|UNTRUSTED/.test(code) ? 'changed' : 'invalid'
}

type Endpoint = { host: string, port: number, servername?: string }

function endpointOf (url: URL): Endpoint {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  return { host, port: '' === url.port ? 443 : Number(url.port), servername: 0 === isIP(host) ? host : undefined }
}

/* The certificate a server presents, from a handshake that Node's own
 * verification then ends, so nothing is written on it. Node raises its
 * internal `secure` event before that verification, and it is the one moment
 * the certificate of a refused handshake can still be read. */
function presented (at: Endpoint): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    let cert: X509Certificate | undefined
    const socket = tls.connect({ host: at.host, port: at.port, servername: at.servername })
    socket.prependListener('secure', () => { cert = socket.getPeerX509Certificate() })
    const done = (err?: Error): void => {
      socket.destroy()
      if (undefined !== cert) resolve(cert)
      else reject(err ?? new CertificateError('invalid'))
    }
    socket.once('secureConnect', () => done())
    socket.on('error', done)
  })
}

// The fingerprint of the certificate an https base presents, by the same
// probe, so pinning it writes nothing to the server either.
export async function presentedFingerprint (base: string): Promise<string> {
  const url = new URL(base)
  if ('https:' !== url.protocol) throw new CertificateError('invalid')
  return fingerprintOf((await presented(endpointOf(url))).raw)
}

// Verified by Node against the pinned certificate as the only trust anchor,
// with its own host check, and then against the pin itself.
function verified (at: Endpoint, anchor: string, pin: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: at.host,
      port: at.port,
      servername: at.servername,
      ca: [anchor],
      checkServerIdentity: (host, cert) => tls.checkServerIdentity(host, cert) ??
        (pin === fingerprintOf(cert.raw) ? undefined : new CertificateError('changed')),
    })
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', (err: Error) => {
      socket.destroy()
      if (err instanceof CertificateError) reject(err)
      else if (null != socket.authorizationError) reject(new CertificateError(refusalOf(String(socket.authorizationError))))
      else reject(err)
    })
  })
}

const NO_BODY = [204, 205, 304]

type FetchDef = { method?: string, headers?: Record<string, string>, body?: string | Uint8Array, signal?: AbortSignal }

function exchange (socket: tls.TLSSocket, url: URL, def: FetchDef): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method: def.method ?? 'GET',
      path: url.pathname + url.search,
      headers: def.headers,
      signal: def.signal,
      createConnection: (() => socket) as unknown as http.RequestOptions['createConnection'],
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('error', reject)
      // One connection per request: a socket left open would hold the process
      // until the plugin times it out.
      res.on('end', () => {
        socket.destroy()
        const headers = new Headers()
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
        const status = res.statusCode ?? 0
        try {
          resolve(new Response(NO_BODY.includes(status) ? null : Buffer.concat(chunks),
            { status, statusText: res.statusMessage, headers }))
        }
        catch (err) { reject(err) }
      })
    })
    req.on('error', (err) => { socket.destroy(); reject(err) })
    req.end(def.body)
  })
}

/* A transport for the SDK's `utility.fetcher` seam that trusts exactly the
 * certificate whose SHA-256 fingerprint is `pin`. No request byte is written
 * before the presented certificate has matched it. */
export function pinnedFetcher (pin: string): (ctx: unknown, fullurl: string, fetchdef: FetchDef) => Promise<Response> {
  let anchor: string | undefined
  return async (_ctx, fullurl, fetchdef) => {
    const url = new URL(fullurl)
    if ('https:' !== url.protocol) throw new CertificateError('invalid')
    const at = endpointOf(url)
    if (undefined === anchor) {
      const cert = await presented(at)
      if (pin !== fingerprintOf(cert.raw)) throw new CertificateError('changed')
      anchor = cert.toString()
    }
    let socket: tls.TLSSocket
    try {
      socket = await verified(at, anchor, pin)
    }
    catch (err) {
      if (err instanceof CertificateError) anchor = undefined
      throw err
    }
    return exchange(socket, url, fetchdef)
  }
}
