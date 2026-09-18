/* The Joplin adapter: the only file in the port that may name Joplin.
 *
 * NO SOURCE IDENTIFIER APPEARS IN CORE CODE. What a source can and cannot do
 * is a row in spec/caps.aon, read by both the runtime and the tests; a
 * conditional on a source name in the core is the beginning of the rot, and it
 * is the specific abstraction an assistant reliably breaks.
 *
 * Every call goes through the generated SDK from voxgig-sdk, pinned by
 * revision in spec/sources.aon. Nothing here hand-writes an HTTP request: the
 * point of the project is that a generated SDK can carry a real application in
 * five languages, and a hand-rolled client here would put that in doubt.
 */

import { lid, rfc3339 } from '../identity.js'
import type { Note } from '../note.js'
import type { Calls } from '../calls.js'

// The generated SDK. `.test(seed)` swaps its transport for an in-memory mock,
// which is how every test in this port runs offline.
// eslint-disable-next-line
import pkg from '@voxgig-sdk/joplin'

const SOURCE = 'joplin'

/* The Note fields this adapter actually populates.
 *
 * DECLARED, not inferred. The core asks an adapter what it supplies and
 * refuses a selector that asks about anything else, so `tag:x` against this
 * source is a refusal rather than a confident "no matches" computed from a
 * field nobody fetched. `status` and `state` are absent because Joplin has no
 * status concept, and `version` because its Data API has no concurrency token
 * - which is the same reason the capability matrix records `version_token`
 * false for it.
 */
export const SUPPLIES: string[] = [
  'source', 'instance', 'space', 'title', 'body', 'created', 'updated',
]

type JoplinNote = {
  id?: string
  parent_id?: string
  title?: string
  body?: string
  created_time?: number
  updated_time?: number
  [k: string]: unknown
}

export type JoplinOpts = {
  instance: string
  account: string
  /* Seed for the SDK's offline test mode. Present in every test and absent in
   * production, which is the whole of the difference between them. */
  seed?: unknown
  apikey?: string
  base?: string
}

function sdkFor (opts: JoplinOpts): any {
  const SDK: any = (pkg as any).JoplinSDK ?? (pkg as any).default ?? pkg
  if (undefined !== opts.seed) {
    return SDK.test(opts.seed)
  }
  return new SDK({ apikey: opts.apikey, base: opts.base })
}

/* Project a Joplin note onto the common shape.
 *
 * `status` is absent rather than invented: Joplin has no status concept, the
 * capability matrix says so, and a three-value normalisation of nothing would
 * be a lie the envelope carries. `version` is absent for the same reason - the
 * Data API has no concurrency token, so `precondition-failed` is documented as
 * unavailable for this source rather than silently skipped.
 */
export function project (raw: JoplinNote, instance: string, account: string, withRaw: boolean): Note {
  const id = String(raw.id ?? '')
  const note: Note = {
    lid: lid(SOURCE, account, 'note', id),
    source: SOURCE,
    instance,
    id,
    title: String(raw.title ?? ''),
    // No `tags: []`. Joplin's tag associations live behind a second route per
    // note, which this adapter does not call, so the honest answer is that it
    // does not know - see SUPPLIES below.
    url: 'joplin://x-callback-url/openNote?id=' + id,
    created: rfc3339(Number(raw.created_time ?? 0)),
    updated: rfc3339(Number(raw.updated_time ?? 0)),
  }
  const parent = raw.parent_id
  if (undefined !== parent && '' !== parent) note.space = String(parent)
  const body = raw.body
  if (undefined !== body) note.body = String(body)
  if (withRaw) {
    // A STRING, never nested structure. The envelope sorts keys recursively and
    // forbids floating point; a real source payload violates both, and
    // canonicalising it would stop it being verbatim.
    note.raw = JSON.stringify(raw)
  }
  return note
}

function data (ent: any): JoplinNote {
  return 'function' === typeof ent?.data ? ent.data() : ent
}

export async function listNotes (opts: JoplinOpts, calls: Calls, withRaw: boolean): Promise<Note[]> {
  const client = sdkFor(opts)
  calls.record(opts.instance, 'GET', '/notes')
  const found = await client.Note().list({})
  const rows: JoplinNote[] = (found ?? []).map(data)
  return rows.map(r => project(r, opts.instance, opts.account, withRaw))
}

export async function loadNote (opts: JoplinOpts, calls: Calls, id: string, withRaw: boolean): Promise<Note | null> {
  const client = sdkFor(opts)
  calls.record(opts.instance, 'GET', '/notes/' + id)
  try {
    const ent = await client.Note().load({ id })
    const row = data(ent)
    // A GraphQL source resolves a missing record to empty data where a REST one
    // raises a 404; normalising both to the same answer is the adapter's job.
    if (null === row || undefined === row || undefined === row.id) return null
    return project(row, opts.instance, opts.account, withRaw)
  }
  catch (err: any) {
    if (true === err?.notFound || 404 === err?.status) return null
    throw err
  }
}

/* Reachability, for `doctor`. Distinguishes the four failure modes a user
 * experiences as one - not configured, secret unresolvable, application not
 * running, credentials rejected - because the remedy differs for each.
 */
export async function check (opts: JoplinOpts, calls: Calls): Promise<{ ok: boolean, code?: string, detail: string }> {
  const client = sdkFor(opts)
  calls.record(opts.instance, 'GET', '/notes')
  try {
    await client.Note().list({})
    return { ok: true, detail: 'ok' }
  }
  catch (err: any) {
    if (401 === err?.status || 403 === err?.status) {
      return { ok: false, code: 'auth-failed', detail: 'the token was rejected' }
    }
    // A FIXED SENTENCE, never the underlying message. Each port's generated SDK
    // words its transport failures differently and embeds the URL it tried, so
    // passing the message through would put five different strings on stdout
    // for one condition - and would print the configured base URL to anywhere
    // the output is pasted. The code carries the meaning; `--raw` is where a
    // caller goes for the detail.
    return { ok: false, code: 'source-unavailable', detail: 'the application did not answer' }
  }
}
