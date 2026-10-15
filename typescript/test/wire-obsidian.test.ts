
import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import type { Socket } from 'node:net'
import tls from 'node:tls'

import { ROOT } from './harness.js'
import { selfSigned, type Throwaway } from './cert.js'
import { live, mock, rows } from './live.js'
import * as obsidian from '../src/adapter/obsidian.js'
import { fingerprintOf, pinnedFetcher, CertificateError } from '../src/pin.js'
import { LikenessError } from '../src/errors.js'

// The plugin's credential, as the mock reads it from its seed.
const TOKEN = 'obsidian-local-rest-api-key-0001'
const ACCOUNT = 'wirevault000001'

const cert = selfSigned()
const other = selfSigned()

let secure: { app: any, base: string }
let plain: { app: any, base: string }

before(async () => {
  secure = await mock({ sources: ['obsidian'], https: { key: cert.key, cert: cert.cert } })
  plain = await mock({ sources: ['obsidian'] })
})

after(async () => {
  await secure?.app.close()
  await plain?.app.close()
})

function pinned (to: Throwaway): Record<string, unknown> {
  return { base: secure.base + '/obsidian', options: { tls: { fingerprint: fingerprintOf(to.der) } } }
}

// A client bound through station, its token resolved from the vault.
function bound (block: Record<string, unknown>) {
  const l = live({ obsidian: block }, { 'obsidian.apikey': TOKEN }, { obsidian: ACCOUNT })
  const conn = l.conns[0]
  return { ...l, conn, h: obsidian.connect(l.station, conn, obsidian.configure(conn.instance, block)) }
}

test('a pinned connection walks the vault, reading each note as note JSON with the vault\'s token', async () => {
  secure.app.store.requests.length = 0
  const b = bound(pinned(cert))
  const { notes, more } = await obsidian.listNotes(b.h, b.conn, false)
  assert.equal(more, false)
  assert.deepStrictEqual(notes.map(n => n.id).sort(), [
    'mydocument.md', 'projects/nested/deep-note.md', 'somedirectory/meeting-notes.md',
    'somedirectory/roadmap.md', 'welcome.md',
  ])
  const seen = rows(secure.app, 'obsidian')
  const reads = seen.filter(r => r.url.endsWith('.md'))
  assert.equal(reads.length, notes.length)
  for (const r of reads) assert.equal(r.headers.accept, obsidian.NOTE_JSON, r.url)
  for (const r of seen) assert.equal(r.auth, 'ok', r.url)
  // What station observed is what the mock received, in order.
  assert.deepStrictEqual(b.calls.all().map(c => c.method + ' ' + c.path), seen.map(r => r.method + ' ' + r.url))
  assert.ok(!JSON.stringify(b.station.events()).includes(TOKEN), 'the token reached an event')
})

test('a note read without the note JSON accept is Markdown, which the client cannot read', async () => {
  secure.app.store.requests.length = 0
  const l = live({ obsidian: pinned(cert) }, { 'obsidian.apikey': TOKEN }, { obsidian: ACCOUNT })
  const bare = l.station.connect(obsidian.SDK, {
    utility: { fetcher: pinnedFetcher(fingerprintOf(cert.der)) },
    feature: { station: { instance: 'obsidian' } },
  })
  await assert.rejects(bare.Vault().load({ id: 'welcome.md' }))
  const [row] = rows(secure.app, 'obsidian')
  assert.deepStrictEqual([row.status, row.auth, row.headers.accept], [200, 'ok', 'application/json'])

  const b = bound(pinned(cert))
  assert.equal((await obsidian.loadNote(b.h, b.conn, 'welcome.md', false))?.title, 'welcome')
})

test('a changed certificate is refused before any request reaches the plugin', async () => {
  secure.app.store.requests.length = 0
  const b = bound(pinned(other))
  await assert.rejects(obsidian.listNotes(b.h, b.conn, false),
    (err: unknown) => err instanceof LikenessError && 'certificate-rejected' === err.code)
  await assert.rejects(obsidian.loadNote(b.h, b.conn, 'welcome.md', false),
    (err: unknown) => err instanceof LikenessError && 'certificate-rejected' === err.code)
  const r = await obsidian.check(b.h)
  assert.equal(r.code, 'certificate-rejected')
  assert.deepStrictEqual(rows(secure.app, 'obsidian'), [])
})

test('plain HTTP is used where the connection declares it, and doctor says so', async () => {
  plain.app.store.requests.length = 0
  const b = bound({ base: plain.base + '/obsidian', options: { tls: false } })
  assert.deepStrictEqual(await obsidian.check(b.h), { ok: true, detail: 'ok, over plain HTTP as the connection declares' })
  assert.deepStrictEqual(rows(plain.app, 'obsidian').map(r => r.auth), ['ok'])
})

test('a wrong token is auth-failed, and an absent plugin is source-unavailable with its remedy', async () => {
  const l = live({ obsidian: pinned(cert) }, { 'obsidian.apikey': 'not-the-token' }, { obsidian: ACCOUNT })
  const h = obsidian.connect(l.station, l.conns[0], obsidian.configure('obsidian', pinned(cert)))
  assert.equal((await obsidian.check(h)).code, 'auth-failed')

  const gone = { base: 'https://127.0.0.1:1/obsidian', options: { tls: { fingerprint: fingerprintOf(cert.der) } } }
  const r = await obsidian.check(bound(gone).h)
  assert.equal(r.code, 'source-unavailable')
  assert.match(String(r.remedy), /start Obsidian with the Local REST API/)
})

// A TLS server that counts the application bytes each connection receives,
// optionally presenting another certificate from its second connection on.
async function counting (first: Throwaway, then?: Throwaway):
Promise<{ url: string, bytes: number[], close: () => void }> {
  const bytes: number[] = []
  const open = new Set<Socket>()
  const server = tls.createServer({ key: first.key, cert: first.cert }, (socket) => {
    const at = bytes.length - 1
    socket.on('data', (d: Buffer) => {
      bytes[at] += d.length
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}')
    })
    socket.on('error', () => {})
  })
  server.on('connection', (raw: Socket) => {
    open.add(raw)
    raw.on('close', () => { open.delete(raw) })
    bytes.push(0)
    if (undefined !== then) server.setSecureContext({ key: then.key, cert: then.cert })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  return {
    url: 'https://127.0.0.1:' + port + '/vault/',
    bytes,
    close: () => { for (const raw of open) raw.destroy(); server.close() },
  }
}

const GET = { method: 'GET', headers: { authorization: 'Bearer ' + TOKEN } }

async function served (first: Throwaway, then: Throwaway | undefined, pin: string):
Promise<{ bytes: number[], status?: number, refusal?: string }> {
  const server = await counting(first, then)
  try {
    const r = await pinnedFetcher(pin)({}, server.url, GET)
    return { bytes: server.bytes, status: r.status }
  }
  catch (err) {
    if (!(err instanceof CertificateError)) throw err
    return { bytes: server.bytes, refusal: err.refusal }
  }
  finally {
    server.close()
  }
}

test('no request byte is written before the certificate has matched the pin', async () => {
  // The probe that learns the certificate writes nothing; the request goes on
  // the connection that verified it.
  const right = await served(cert, undefined, fingerprintOf(cert.der))
  assert.equal(right.status, 200)
  assert.equal(right.bytes.length, 2)
  assert.equal(right.bytes[0], 0)
  assert.ok(0 < right.bytes[1])

  assert.deepStrictEqual(await served(cert, undefined, fingerprintOf(other.der)), { bytes: [0], refusal: 'changed' })

  // A certificate swapped after the probe is caught by the verified connection.
  assert.deepStrictEqual(await served(cert, other, fingerprintOf(cert.der)), { bytes: [0, 0], refusal: 'changed' })

  const old = selfSigned([-3, -1])
  assert.deepStrictEqual(await served(old, undefined, fingerprintOf(old.der)), { bytes: [0, 0], refusal: 'expired' })
})

// Bounded, so a connection left open fails the test rather than hanging it.
function within (p: Promise<unknown>, ms: number, what: string): Promise<unknown> {
  return Promise.race([p, new Promise((_resolve, reject) => { setTimeout(() => reject(new Error(what)), ms).unref() })])
}

test('a pinned request closes its connection once the response is read', async () => {
  const closed: Promise<void>[] = []
  const server = https.createServer({ key: cert.key, cert: cert.cert, keepAliveTimeout: 60000 }, (_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{}')
  })
  server.on('connection', (raw: Socket) => { closed.push(new Promise(resolve => { raw.on('close', () => resolve()) })) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const port = (server.address() as { port: number }).port
    const url = 'https://127.0.0.1:' + port + '/vault/'
    const r = await pinnedFetcher(fingerprintOf(cert.der))({}, url, { method: 'GET', headers: { connection: 'keep-alive' } })
    assert.equal(await r.text(), '{}')
    await within(Promise.all(closed), 5000, 'a connection was left open')
  }
  finally {
    server.closeAllConnections()
    server.close()
  }
})

test('the adapter reaches a vault through the plugin alone, never its files', () => {
  for (const file of ['typescript/src/adapter/obsidian.ts', 'typescript/src/pin.ts']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.doesNotMatch(text, /from 'node:(fs|fs\/promises)'|require\('(node:)?fs'\)/, file)
  }
})
