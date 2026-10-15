
import { test, before, after } from 'node:test'
import assert from 'node:assert'

import { live, mock, rows } from './live.js'
import * as notion from '../src/adapter/notion.js'

// The integration token, as the mock reads it from its seed.
const TOKEN = 'secret_TOKEN'
const ACCOUNT = 'wireworkspace01'
const VERSION = '2022-06-28'
const PAGE = '2a9e0000-0000-4000-8000-000000000002'

let server: { app: any, base: string }

before(async () => {
  server = await mock({ sources: ['notion'] })
})

after(async () => {
  await server?.app.close()
})

function block (version: string = VERSION): Record<string, unknown> {
  return { base: server.base + '/notion/v1', options: { headers: { 'notion-version': version } } }
}

// A client bound through station, its token resolved from the vault.
function bound (token: string = TOKEN) {
  const l = live({ notion: block() }, { 'notion.apikey': token }, { notion: ACCOUNT })
  const conn = l.conns[0]
  return { ...l, conn, h: notion.connect(l.station, conn, notion.configure(conn.instance, block())) }
}

test('a page is read with the pinned Notion-Version and the vault\'s token', async () => {
  server.app.store.requests.length = 0
  const b = bound()
  const note = await notion.loadNote(b.h, b.conn, PAGE, false)
  assert.deepStrictEqual(
    [note?.id, note?.title, note?.space, note?.url],
    [PAGE, 'Ship the SDK', '7b3d0000-0000-4000-8000-000000000001',
      'https://www.notion.so/Ship-the-SDK-2a9e0000000040008000000000000002'])
  const seen = rows(server.app, 'notion')
  assert.deepStrictEqual(seen.map(r => [r.method, r.url, r.status, r.auth, r.headers['notion-version']]),
    [['GET', '/notion/v1/pages/' + PAGE, 200, 'ok', VERSION]])
  assert.deepStrictEqual(b.calls.all().map(c => c.method + ' ' + c.path), seen.map(r => r.method + ' ' + r.url))
  assert.ok(!JSON.stringify(b.station.events()).includes(TOKEN), 'the token reached an event')
})

test('doctor\'s check reaches a page no workspace holds, which only an accepted request finds missing', async () => {
  server.app.store.requests.length = 0
  const b = bound()
  assert.deepStrictEqual(await notion.check(b.h), { ok: true, detail: 'ok' })
  assert.deepStrictEqual(rows(server.app, 'notion').map(r => [r.url, r.status, r.auth, r.headers['notion-version']]),
    [['/notion/v1/pages/' + notion.NO_PAGE, 404, 'ok', VERSION]])
})

test('a client that sends no Notion-Version is refused, as Notion refuses it', async () => {
  server.app.store.requests.length = 0
  const l = live({ notion: block() }, { 'notion.apikey': TOKEN }, { notion: ACCOUNT })
  const bare = l.station.connect(notion.SDK, { feature: { station: { instance: 'notion' } } })
  await assert.rejects(bare.Page().load({ id: PAGE }), (err: any) => 400 === err?.status)
  const [row] = rows(server.app, 'notion')
  assert.deepStrictEqual([row.status, row.auth, row.headers['notion-version']], [400, 'ok', undefined])
})

test('a wrong token is auth-failed', async () => {
  const b = bound('not-the-token')
  assert.equal((await notion.check(b.h)).code, 'auth-failed')
})

test('a connection that pins no version is refused before a client exists', () => {
  assert.throws(() => notion.configure('notion', { base: server.base + '/notion/v1' }),
    (err: any) => 'invalid-project' === err?.code && /pins no Notion-Version/.test(err.message))
})
