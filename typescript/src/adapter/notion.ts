import type { Station } from '@voxgig/station'

import { lid, parseRfc3339, rfc3339 } from '../identity.js'
import { compareCodePoints, type Note } from '../note.js'
import { LikenessError } from '../errors.js'
import { renderRaw } from '../envelope.js'
import type { Check, Conn, Given } from '../adapters.js'

// eslint-disable-next-line
import pkg from '@voxgig-sdk/notion-sdk'

export const SOURCE = 'notion'

// A page is read without its blocks, so it brings no body and no tags.
export const SUPPLIES: string[] = [
  'source', 'instance', 'space', 'title', 'created', 'updated',
]

export const SDK: any = (pkg as any).NotionSDK ?? (pkg as any).default ?? pkg

const BUG = 'this is a bug in the source or its SDK; run with --raw to capture the payload'

// A page id no workspace holds: answered as not found once the token and the version are accepted.
export const NO_PAGE = '00000000-0000-0000-0000-000000000000'

const VERSION = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

function text (v: unknown): string {
  return 'string' === typeof v ? v : renderRaw(v)
}

function has (v: unknown): boolean { return undefined !== v && null !== v }

function isMap (v: unknown): v is Record<string, unknown> {
  return null !== v && 'object' === typeof v && !Array.isArray(v)
}

export type Config = { version: string }


/* The API version every request carries, pinned in the connection's block in
 * station.json as its one header. Notion refuses a request without it, so a
 * connection that does not pin one is refused before any call. */
export function configure (instance: string, block: Record<string, unknown>): Config {
  const named = SOURCE + ' connection "' + instance + '"'
  const pin = 'pin the API version under sdk.' + instance + ' in station.json: ' +
    '"options": { "headers": { "notion-version": "2022-06-28" } }'
  const refuse = (what: string, remedy: string = pin): LikenessError =>
    new LikenessError('invalid-project', named + ' ' + what, remedy)

  const options = has(block.options) ? block.options : {}
  if (!isMap(options)) throw refuse('has options that are not a map', 'its options take headers alone')
  const extra = Object.keys(options).filter(k => 'headers' !== k).sort(compareCodePoints)
  if (0 < extra.length) throw refuse('has an option likeness does not read: "' + extra[0] + '"', 'its options take headers alone')

  const headers = has(options.headers) ? options.headers : {}
  if (!isMap(headers)) throw refuse('has headers that are not a map')
  const names = Object.keys(headers).sort(compareCodePoints)
  const other = names.filter(k => 'notion-version' !== k.toLowerCase())
  if (0 < other.length) {
    throw refuse('has a header likeness does not send: "' + other[0] + '"', 'its headers take notion-version alone')
  }
  if (0 === names.length) throw refuse('pins no Notion-Version, which every request to Notion carries')
  if (1 < names.length) throw refuse('pins Notion-Version more than once')
  const version = headers[names[0]]
  if ('string' !== typeof version || !VERSION.test(version)) {
    throw refuse('pins a Notion-Version that is not a date such as 2022-06-28')
  }
  return { version }
}

// The block `sources add` writes: the pinned version, and the base when one is given.
export async function setup (_instance: string, given: Given): Promise<Record<string, unknown>> {
  const version = given['notion-version']
  if ('string' !== typeof version || !VERSION.test(version)) {
    throw new LikenessError('invalid-argument', '--notion-version is not a date such as 2022-06-28',
      'give the API version as YYYY-MM-DD, as Notion publishes it')
  }
  const block: Record<string, unknown> = {}
  if (undefined !== given.base) block.base = given.base
  block.options = { headers: { 'notion-version': version } }
  return block
}

// The ref goes in the station feature's options: the SDK refuses a top-level instance option.
export function connect (station: Station, conn: Conn, config: unknown, seed?: unknown): any {
  const feature: Record<string, unknown> = { station: { instance: conn.instance } }
  if (undefined !== seed) feature.test = { ...(seed as Record<string, unknown>), active: true }
  return station.connect(SDK, { headers: { 'notion-version': (config as Config).version }, feature })
}

/* A page's title is its property of type `title`, rich text whose parts' plain
 * text is joined. A page with more than one takes the first by name, in
 * code-point order. */
export function titleOf (properties: unknown): string {
  if (!isMap(properties)) return ''
  const name = Object.keys(properties).sort(compareCodePoints)
    .find(k => { const p = properties[k]; return isMap(p) && 'title' === p.type })
  if (undefined === name) return ''
  const value = (properties[name] as Record<string, unknown>).title
  if (!Array.isArray(value)) return has(value) ? text(value) : ''
  return value.map((part: unknown) => {
    const plain = isMap(part) ? part.plain_text : part
    return has(plain) ? text(plain) : ''
  }).join('')
}

// A page's space is its parent database, or its parent page; a workspace or a block is none.
export function spaceOf (parent: unknown): string | undefined {
  if (!isMap(parent)) return undefined
  const kind = 'string' === typeof parent.type ? parent.type
    : has(parent.database_id) ? 'database_id' : 'page_id'
  const id = 'data_source_id' === kind ? parent.database_id
    : 'database_id' === kind || 'page_id' === kind ? parent[kind] : undefined
  const space = has(id) ? text(id) : ''
  return '' === space ? undefined : space
}

// Text that is not an RFC 3339 date-time, or a value that is not text, is the epoch.
export function stamp (v: unknown, field: string): string {
  const ms = 'string' === typeof v ? parseRfc3339(v) ?? 0 : 0
  try {
    return rfc3339(ms)
  }
  catch {
    throw new LikenessError('source-unavailable',
      SOURCE + ' returned a page whose ' + field + ' is outside the years 0000 to 9999', BUG)
  }
}

export function project (raw: unknown, instance: string, account: string, withRaw: boolean): Note {
  if (!isMap(raw)) {
    throw new LikenessError('source-unavailable', SOURCE + ' returned a page that is not a record', BUG)
  }
  const id = has(raw.id) ? text(raw.id) : ''
  if ('' === id) throw new LikenessError('source-unavailable', SOURCE + ' returned a page with no id', BUG)
  // Refused, not made up: a page's link is the one thing about it no id can stand in for.
  if ('string' !== typeof raw.url || !/^https?:\/\//.test(raw.url)) {
    throw new LikenessError('source-unavailable', SOURCE + ' returned a page with no http or https url', BUG)
  }
  const note: Note = {
    lid: lid(SOURCE, account, 'note', id),
    source: SOURCE,
    instance,
    id,
    title: titleOf(raw.properties),
    url: raw.url,
    created: stamp(raw.created_time, 'created_time'),
    updated: stamp(raw.last_edited_time, 'last_edited_time'),
  }
  const space = spaceOf(raw.parent)
  if (undefined !== space) note.space = space
  if (withRaw) note.raw = renderRaw(raw)
  return note
}

function data (ent: any): unknown {
  return 'function' === typeof ent?.data ? ent.data() : ent
}

function notFound (err: any): boolean {
  return true === err?.notFound || 404 === err?.status
}

export async function loadNote (client: any, conn: Conn, id: string, withRaw: boolean): Promise<Note | null> {
  let raw: unknown
  try {
    raw = data(await client.Page().load({ id }))
  }
  catch (err) {
    if (notFound(err)) return null
    throw err
  }
  return project(raw, conn.instance, conn.account, withRaw)
}

export async function check (client: any): Promise<Check> {
  try {
    await client.Page().load({ id: NO_PAGE })
    return { ok: true, detail: 'ok' }
  }
  catch (err: any) {
    if (notFound(err)) return { ok: true, detail: 'ok' }
    if (401 === err?.status || 403 === err?.status) {
      return { ok: false, code: 'auth-failed', detail: 'the token was rejected' }
    }
    if (429 === err?.status) {
      return { ok: false, code: 'rate-limited', detail: 'the source is rate limiting this client' }
    }
    // The one request the check sends that a pinned version can spoil.
    if (400 === err?.status) {
      return {
        ok: false,
        code: 'source-unavailable',
        detail: 'the service refused the request',
        remedy: 'pin a Notion-Version that Notion publishes, such as 2022-06-28, under its connection in station.json',
      }
    }
    return { ok: false, code: 'source-unavailable', detail: 'the service did not answer' }
  }
}
