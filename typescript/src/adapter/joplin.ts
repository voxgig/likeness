
import { lid, rfc3339 } from '../identity.js'
import type { Note } from '../note.js'
import type { Calls } from '../calls.js'
import { LikenessError } from '../errors.js'
import { pageMax } from '../caps.js'

// eslint-disable-next-line
import pkg from '@voxgig-sdk/joplin'

const SOURCE = 'joplin'

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

export function project (raw: JoplinNote, instance: string, account: string, withRaw: boolean): Note {
  const id = String(raw.id ?? '')
  // REFUSED, not fabricated. An empty id derives a valid-LOOKING lid from the
  // empty string, so every such row shares one identity and the note violates
  // the schema's non-empty SourceId invariant. A source that returned a record
  // with no id has returned nothing usable, and the adapter says so.
  if ('' === id) {
    throw new LikenessError('source-unavailable',
      'the source returned a ' + SOURCE + ' record with no id',
      'this is a bug in the source or its SDK; run with --raw to capture the payload')
  }
  const note: Note = {
    lid: lid(SOURCE, account, 'note', id),
    source: SOURCE,
    instance,
    id,
    title: String(raw.title ?? ''),
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

export async function listNotes (opts: JoplinOpts, calls: Calls, withRaw: boolean):
Promise<{ notes: Note[], more: boolean }> {
  const client = sdkFor(opts)
  calls.record(opts.instance, 'GET', '/notes')
  const found = await client.Note().list({})
  const rows: JoplinNote[] = (found ?? []).map(data)
  const limit = pageMax(SOURCE)
  return {
    notes: rows.map(r => project(r, opts.instance, opts.account, withRaw)),
    more: 0 < limit && rows.length >= limit,
  }
}

export async function loadNote (opts: JoplinOpts, calls: Calls, id: string, withRaw: boolean): Promise<Note | null> {
  const client = sdkFor(opts)
  calls.record(opts.instance, 'GET', '/notes/' + id)
  try {
    const ent = await client.Note().load({ id })
    const row = data(ent)
    if (null === row || undefined === row || undefined === row.id) return null
    return project(row, opts.instance, opts.account, withRaw)
  }
  catch (err: any) {
    if (true === err?.notFound || 404 === err?.status) return null
    throw err
  }
}

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
    // 429 is a DIFFERENT condition with a different remedy, and the registry
    // has a code for it that is marked retryable. Folding it into
    // "the application did not answer" tells someone whose requests are being
    // throttled to go and start a program that is already running.
    if (429 === err?.status) {
      return { ok: false, code: 'rate-limited', detail: 'the source is rate limiting this client' }
    }
    return { ok: false, code: 'source-unavailable', detail: 'the application did not answer' }
  }
}
