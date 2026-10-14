
import type { Station } from '@voxgig/station'

import { lid, rfc3339 } from '../identity.js'
import type { Note } from '../note.js'
import { LikenessError } from '../errors.js'
import { pageMax } from '../caps.js'
import { renderRaw } from '../envelope.js'

// eslint-disable-next-line
import pkg from '@voxgig-sdk/joplin-sdk'

const SOURCE = 'joplin'

export const SUPPLIES: string[] = [
  'source', 'instance', 'space', 'title', 'body', 'created', 'updated',
]

type JoplinNote = Record<string, unknown>

// A non-string value projects as its canonical JSON text.
function text (v: unknown): string {
  return 'string' === typeof v ? v : renderRaw(v)
}

function has (v: unknown): boolean { return undefined !== v && null !== v }

function ms (v: unknown): number {
  return 'number' === typeof v && Number.isInteger(v) ? v : 0
}

export type Conn = {
  instance: string
  account: string
}

export const SDK: any = (pkg as any).JoplinSDK ?? (pkg as any).default ?? pkg

// The ref goes in the station feature's options: the SDK refuses a top-level instance option.
export function connect (station: Station, instance: string, seed?: unknown): any {
  const feature: Record<string, unknown> = { station: { instance } }
  if (undefined !== seed) feature.test = { ...(seed as Record<string, unknown>), active: true }
  return station.connect(SDK, { feature })
}

function stamp (v: unknown, field: string): string {
  try {
    return rfc3339(ms(v))
  }
  catch {
    throw new LikenessError('source-unavailable',
      'the source returned a ' + SOURCE + ' record whose ' + field + ' is outside the years 0000 to 9999',
      'this is a bug in the source or its SDK; run with --raw to capture the payload')
  }
}

export function project (raw: JoplinNote, instance: string, account: string, withRaw: boolean): Note {
  const id = has(raw.id) ? text(raw.id) : ''
  // Refused, not fabricated: an empty id gives every such row one valid-looking
  // lid, and breaks the schema's non-empty SourceId.
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
    title: has(raw.title) ? text(raw.title) : '',
    url: 'joplin://x-callback-url/openNote?id=' + id,
    created: stamp(raw.created_time, 'created_time'),
    updated: stamp(raw.updated_time, 'updated_time'),
  }
  if (has(raw.parent_id)) {
    const space = text(raw.parent_id)
    if ('' !== space) note.space = space
  }
  if (has(raw.body)) note.body = text(raw.body)
  if (withRaw) {
    // A STRING, never nested structure: the envelope forbids floating point and
    // a real payload has it. The client keeps no bytes (sdkgen#407): re-rendered.
    note.raw = renderRaw(raw)
  }
  return note
}

function data (ent: any): JoplinNote {
  return 'function' === typeof ent?.data ? ent.data() : ent
}

// Joplin answers id, parent_id and title unless asked. The wire name is
// `fields`; the client declares `field`, which Joplin ignores (sdkgen#406).
export const FIELDS = 'id,parent_id,title,body,created_time,updated_time'

export async function listNotes (client: any, conn: Conn, withRaw: boolean):
Promise<{ notes: Note[], more: boolean }> {
  const found = await client.Note().list({ fields: FIELDS })
  const rows: JoplinNote[] = (found ?? []).map(data)
  const limit = pageMax(SOURCE)
  return {
    notes: rows.map(r => project(r, conn.instance, conn.account, withRaw)),
    more: 0 < limit && rows.length >= limit,
  }
}

export async function loadNote (client: any, conn: Conn, id: string, withRaw: boolean): Promise<Note | null> {
  try {
    const ent = await client.Note().load({ id, fields: FIELDS })
    const row = data(ent)
    if (null === row || undefined === row || undefined === row.id) return null
    return project(row, conn.instance, conn.account, withRaw)
  }
  catch (err: any) {
    if (true === err?.notFound || 404 === err?.status) return null
    throw err
  }
}

export async function check (client: any): Promise<{ ok: boolean, code?: string, detail: string }> {
  try {
    await client.Note().list({ fields: FIELDS })
    return { ok: true, detail: 'ok' }
  }
  catch (err: any) {
    if (401 === err?.status || 403 === err?.status) {
      return { ok: false, code: 'auth-failed', detail: 'the token was rejected' }
    }
    // Throttling has its own retryable code: "did not answer" sends the user to start a running app.
    if (429 === err?.status) {
      return { ok: false, code: 'rate-limited', detail: 'the source is rate limiting this client' }
    }
    return { ok: false, code: 'source-unavailable', detail: 'the application did not answer' }
  }
}
