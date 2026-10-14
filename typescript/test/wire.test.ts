
import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT } from './harness.js'
import { Calls } from '../src/calls.js'
import { listNotes, loadNote, check, project, FIELDS } from '../src/adapter/joplin.js'

// eslint-disable-next-line
import pkg from '@voxgig-sdk/joplin'

const SDK: any = (pkg as any).JoplinSDK ?? (pkg as any).default ?? pkg
const APIKEY = 'joplin-mock-token'
const EPOCH = '1970-01-01T00:00:00Z'

let app: any
let base = ''

before(async () => {
  const { buildServer } = await import(pathToFileURL(join(ROOT, 'mock', 'server.js')).href)
  app = await buildServer({ sources: ['joplin'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = 'http://127.0.0.1:' + app.server.address().port + '/joplin'
})

after(async () => { if (undefined !== app) await app.close() })

function opts () { return { instance: 'jot', account: 'local', apikey: APIKEY, base } }

// The `fields` each request to the mock carried, in order, from its request ring.
function fieldsSent (): (string | null)[] {
  return app.store.requests
    .filter((r: any) => 'joplin' === r.source)
    .map((r: any) => new URL(r.url, 'http://x').searchParams.get('fields'))
}

function rows (found: unknown): any[] {
  return ((found ?? []) as any[]).map(e => 'function' === typeof e?.data ? e.data() : e)
}

test('list asks for the fields the shape needs, and gets real timestamps back', async () => {
  app.store.requests.length = 0
  const { notes } = await listNotes(opts(), new Calls(), false)
  assert.deepStrictEqual(fieldsSent(), [FIELDS])
  assert.ok(0 < notes.length)
  for (const n of notes) {
    assert.notEqual(n.created, EPOCH, n.id + ' created')
    assert.notEqual(n.updated, EPOCH, n.id + ' updated')
    assert.equal(typeof n.body, 'string', n.id + ' body')
  }
})

test('without fields the mock answers the three Joplin defaults, which project to the epoch', async () => {
  const client = new SDK({ apikey: APIKEY, base })
  const got = rows(await client.Note().list({}))
  assert.ok(0 < got.length)
  for (const r of got) {
    assert.deepStrictEqual(Object.keys(r).sort(), ['id', 'parent_id', 'title'])
    const n = project(r, 'jot', 'local', false)
    assert.equal(n.created, EPOCH)
    assert.equal(n.body, undefined)
  }
})

test('load and check ask for the fields too', async () => {
  app.store.requests.length = 0
  const n = await loadNote(opts(), new Calls(), 'a0e50000000000000000000000000001', false)
  assert.ok(null !== n)
  assert.equal(typeof n.body, 'string')
  assert.notEqual(n.created, EPOCH)
  const r = await check(opts(), new Calls())
  assert.equal(r.ok, true, r.detail)
  assert.deepStrictEqual(fieldsSent(), [FIELDS, FIELDS])
})
