/* Proof that the SDK's offline test mode carries a whole CRUD cycle, and that
 * the run touches NO NETWORK.
 *
 * This is the claim the entire testing strategy rests on: if the generated
 * SDK's `test` feature could not seed, list, load, create and update without a
 * server, the transcript corpus would have to run against a live source or a
 * hand-written mock, and both would stop the corpus being about the SDK at all.
 *
 * THE NETWORK IS BLOCKED AT THE PROCESS LEVEL, not assumed absent. `fetch`,
 * `http.request` and `https.request` are replaced with throwing stubs for the
 * duration. A run that reached the network fails loudly here instead of
 * quietly succeeding on a machine where something happened to be listening.
 *
 * The create supplies an EXPLICIT identifier. The SDKs mint a random one
 * otherwise, and the minted form differs between ports - see
 * upstream/issue/01 - so a corpus entry that let the SDK choose could never be
 * byte-compared.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import https from 'node:https'

import pkg from '@voxgig-sdk/joplin'

const SDK: any = (pkg as any).JoplinSDK ?? (pkg as any).default ?? pkg

const real = {
  fetch: globalThis.fetch,
  http: http.request,
  https: https.request,
}
let reached = 0

before(() => {
  const refuse = (what: string) => (...args: unknown[]): never => {
    reached++
    throw new Error('the offline test blocked a real ' + what + ' call: ' + String(args[0]))
  }
  globalThis.fetch = refuse('fetch') as unknown as typeof fetch
  ;(http as any).request = refuse('http.request')
  ;(https as any).request = refuse('https.request')
})

after(() => {
  globalThis.fetch = real.fetch
  ;(http as any).request = real.http
  ;(https as any).request = real.https
})

const SEED = {
  entity: {
    note: {
      n1: { id: 'n1', title: 'seeded', body: 'one', parent_id: 'f1', updated_time: 1 },
      n2: { id: 'n2', title: 'also seeded', body: 'two', parent_id: 'f1', updated_time: 2 },
    },
  },
}

function data (ent: any): any {
  return 'function' === typeof ent?.data ? ent.data() : ent
}

test('the offline cycle: seed, list, load, create, update - with no network', async () => {
  const sdk = SDK.test(JSON.parse(JSON.stringify(SEED)))

  const listed = (await sdk.Note().list({})).map(data)
  assert.equal(listed.length, 2, 'the seeded notes are listed')
  assert.deepEqual(listed.map((n: any) => n.id).sort(), ['n1', 'n2'])

  const loaded = data(await sdk.Note().load({ id: 'n1' }))
  assert.equal(loaded.title, 'seeded')

  // EXPLICIT id. Letting the SDK mint one makes the result unassertable and
  // differently shaped in every port.
  const made = data(await sdk.Note().create({ id: 'n3', title: 'made here', parent_id: 'f1' }))
  assert.equal(made.id, 'n3', 'the explicit identifier is the one that is kept')

  const after1 = (await sdk.Note().list({})).map(data)
  assert.equal(after1.length, 3, 'the created note is visible to a subsequent list')

  const updated = data(await sdk.Note().update({ id: 'n3', title: 'renamed' }))
  assert.equal(updated.title, 'renamed')

  const reloaded = data(await sdk.Note().load({ id: 'n3' }))
  assert.equal(reloaded.title, 'renamed', 'the update is visible to a subsequent load')

  assert.equal(reached, 0, 'no real network call was attempted')
})

test('the blocker itself works', () => {
  // A guard on the guard. If the stubs were not installed, the test above
  // would prove nothing about the network.
  assert.throws(() => (globalThis.fetch as any)('http://127.0.0.1:1/'), /blocked a real fetch/)
  assert.throws(() => http.request('http://127.0.0.1:1/'), /blocked a real http.request/)
  // The throw increments the counter, so put it back for any later file.
  reached = 0
})
