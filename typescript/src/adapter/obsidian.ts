
import type { Station } from '@voxgig/station'

import { lid, rfc3339 } from '../identity.js'
import { compareCodePoints, type Note } from '../note.js'
import { LikenessError } from '../errors.js'
import { pageMax } from '../caps.js'
import { renderRaw } from '../envelope.js'
import { CertificateError, parsePin, pinnedFetcher, PinError, type Refusal } from '../pin.js'
import type { Ask, Check, Conn, Given } from '../adapters.js'

// eslint-disable-next-line
import pkg from '@voxgig-sdk/obsidian-sdk'

export const SOURCE = 'obsidian'

export const SUPPLIES: string[] = [
  'source', 'instance', 'space', 'title', 'body', 'tag', 'created', 'updated',
]

export const SDK: any = (pkg as any).ObsidianSDK ?? (pkg as any).default ?? pkg

// The one representation of a note that carries its frontmatter, tags and stat.
export const NOTE_JSON = 'application/vnd.olrapi.note+json'

const BUG = 'this is a bug in the source or its SDK; run with --raw to capture the payload'

function text (v: unknown): string {
  return 'string' === typeof v ? v : renderRaw(v)
}

function has (v: unknown): boolean { return undefined !== v && null !== v }

function isMap (v: unknown): v is Record<string, unknown> {
  return null !== v && 'object' === typeof v && !Array.isArray(v)
}

function ms (v: unknown): number {
  return 'number' === typeof v && Number.isInteger(v) ? v : 0
}

export type Transport = { tls: 'pinned', pin: string } | { tls: 'off' }


/* How a connection reaches the plugin, from its block in station.json. HTTPS,
 * the plugin's default, is trusted only with a pinned certificate; plain HTTP
 * only where the block says so. Anything else is refused before any call. */
export function transport (instance: string, block: Record<string, unknown>): Transport {
  const named = SOURCE + ' connection "' + instance + '"'
  const pin = 'pin its certificate under sdk.' + instance + ' in station.json: ' +
    '"options": { "tls": { "fingerprint": "sha256:<hex>" } }'
  const refuse = (what: string, remedy: string = pin): LikenessError =>
    new LikenessError('invalid-project', named + ' ' + what, remedy)

  const options = has(block.options) ? block.options : {}
  if (!isMap(options)) throw refuse('has options that are not a map', 'its options take tls alone')
  const extra = Object.keys(options).filter(k => 'tls' !== k).sort(compareCodePoints)
  if (0 < extra.length) throw refuse('has an option likeness does not read: "' + extra[0] + '"', 'its options take tls alone')

  const base = has(block.base) ? text(block.base).toLowerCase() : 'https://'
  const secure = base.startsWith('https://')
  if (!secure && !base.startsWith('http://')) {
    throw refuse('has a base that is neither https nor http', 'name the plugin\'s address, as https://127.0.0.1:27124')
  }

  const tls = options.tls
  if (false === tls) {
    if (secure) throw refuse('turns TLS off on an https base, and verification is never turned off')
    return { tls: 'off' }
  }
  if (!secure) {
    throw refuse(undefined === tls ? 'is plain HTTP and does not declare it' : 'pins a certificate on a plain HTTP base',
      'declare plain HTTP with "options": { "tls": false }, or use the plugin\'s HTTPS base with a pinned certificate')
  }
  if (undefined === tls) throw refuse('pins no certificate, and the plugin\'s certificate is self-signed')
  if (!isMap(tls) || 1 !== Object.keys(tls).length || !Object.hasOwn(tls, 'fingerprint')) {
    throw refuse('has a tls option that is neither a pinned fingerprint nor false')
  }
  try {
    return { tls: 'pinned', pin: parsePin(tls.fingerprint) }
  }
  catch (err) {
    if (err instanceof PinError) throw refuse('pins a fingerprint that is not sha256 and 64 hex digits')
    throw err
  }
}

export function configure (instance: string, block: Record<string, unknown>): Transport {
  return transport(instance, block)
}

const PLAIN = 'http://127.0.0.1:27123'

function bad (message: string, remedy: string): LikenessError {
  return new LikenessError('invalid-argument', message, remedy)
}

/* The block `sources add` writes. An https base is pinned to the certificate
 * it presents, which --fingerprint names or a terminal confirms: never one
 * taken on trust because it answered first. */
export async function setup (instance: string, given: Given, ask: Ask): Promise<Record<string, unknown>> {
  const base = String(given.base)
  const fingerprint = given.fingerprint
  if (true === given['plain-http']) {
    if (undefined !== fingerprint) {
      throw bad('--plain-http and --fingerprint contradict each other: plain HTTP pins no certificate', 'give one of them')
    }
    if (!base.startsWith('http://')) {
      throw bad('--plain-http needs an http base', 'give the plugin\'s HTTP address with --base, such as ' + PLAIN)
    }
    return { base, options: { tls: false } }
  }
  if (!base.startsWith('https://')) {
    throw bad('an http base is plain HTTP, which only --plain-http declares',
      'add --plain-http, or give the plugin\'s HTTPS address with --base')
  }

  let pin: string | undefined
  if (undefined !== fingerprint) {
    try { pin = parsePin(fingerprint) }
    catch (err) {
      if (err instanceof PinError) throw bad('--fingerprint is not sha256: and 64 hex digits', 'give the certificate\'s SHA-256, as sha256:<hex>')
      throw err
    }
  }
  else if (!ask.tty) {
    throw bad('pinning the plugin\'s certificate needs --fingerprint, or a terminal to confirm it on',
      'pass --fingerprint sha256:<hex>; `openssl x509 -noout -fingerprint -sha256 -in obsidian-local-rest-api.crt` prints it')
  }

  const named = SOURCE + ' at ' + base
  const detail = { source: SOURCE, instance }
  let presented: string
  try { presented = await ask.presented(base) }
  catch {
    throw new LikenessError('source-unavailable', 'nothing at ' + base + ' presented a certificate',
      'start Obsidian with the Local REST API community plugin enabled, or give its address with --base', detail)
  }
  if (undefined !== pin && pin !== presented) {
    throw new LikenessError('certificate-rejected', named + ' presents ' + presented + ', not the certificate --fingerprint names',
      'check the fingerprint against the plugin\'s certificate; if it was regenerated, pass the new one', detail)
  }
  if (undefined === pin && !await ask.confirm(named + ' presents ' + presented + '; type yes to pin it')) {
    throw new LikenessError('certificate-rejected', 'the certificate ' + named + ' presents was not confirmed',
      'check it against the plugin\'s certificate, and run it again to pin it', detail)
  }
  return { base, options: { tls: { fingerprint: presented } } }
}

export type Handle = { sdk: any, plain: boolean, instance: string }

export function connect (station: Station, conn: Conn, config: unknown, seed?: unknown): Handle {
  const feature: Record<string, unknown> = { station: { instance: conn.instance } }
  const options: Record<string, unknown> = { headers: { accept: NOTE_JSON }, feature }
  const how = config as Transport
  if (undefined !== seed) feature.test = { ...(seed as Record<string, unknown>), active: true }
  else if ('pinned' === how.tls) options.utility = { fetcher: pinnedFetcher(how.pin) }
  return { sdk: station.connect(SDK, options), plain: 'off' === how.tls, instance: conn.instance }
}

// Every byte but the unreserved characters of RFC 3986 percent-encoded, hex in capitals.
export function percentEncode (s: string): string {
  let out = ''
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b)
    out += /[A-Za-z0-9._~-]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

// Obsidian's own URI: the vault by its id, which is the connection's account.
export function noteUrl (vault: string, path: string): string {
  return 'obsidian://open?vault=' + percentEncode(vault) + '&file=' + percentEncode(path)
}

/* A listing's entries, as the plugin lists one directory: by first segment, a
 * directory with its slash, each once, in code-point order. The plugin names
 * one level as text; the SDK's offline transport lists every record of the
 * entity by id, and the same rule walks both to the same tree. */
export function entries (listed: unknown[]): string[] {
  const out = new Set<string>()
  for (const e of listed) {
    const name = 'string' === typeof e ? e : isMap(e) && 'string' === typeof e.id ? e.id : undefined
    const segs = undefined === name ? [] : name.split('/')
    const last = segs.length - 1
    if (undefined === name || '' === name || segs.some((g, i) => '.' === g || '..' === g || ('' === g && i !== last))) {
      throw new LikenessError('source-unavailable',
        SOURCE + ' returned a vault listing with an entry that names no path below it', BUG)
    }
    out.add(1 === segs.length ? segs[0] : segs[0] + '/')
  }
  return [...out].sort(compareCodePoints)
}

function stamp (v: unknown, field: string): string {
  try {
    return rfc3339(ms(v))
  }
  catch {
    throw new LikenessError('source-unavailable',
      SOURCE + ' returned a note whose ' + field + ' is outside the years 0000 to 9999', BUG)
  }
}

// Absent is fetched and empty; a null entry is dropped, any other is its text.
function tagsOf (v: unknown): string[] {
  if (!has(v)) return []
  return (Array.isArray(v) ? v : [v]).filter(has).map(text)
}

export function project (raw: unknown, path: string, instance: string, account: string, withRaw: boolean): Note {
  if (!isMap(raw)) {
    throw new LikenessError('source-unavailable', SOURCE + ' returned a note that is not a record', BUG)
  }
  const at = path.lastIndexOf('/')
  const stat = isMap(raw.stat) ? raw.stat : {}
  const note: Note = {
    lid: lid(SOURCE, account, 'note', path),
    source: SOURCE,
    instance,
    id: path,
    title: path.slice(at + 1, path.length - '.md'.length),
    url: noteUrl(account, path),
    created: stamp(stat.ctime, 'stat.ctime'),
    updated: stamp(stat.mtime, 'stat.mtime'),
    tags: tagsOf(raw.tags),
  }
  if (0 < at) note.space = path.slice(0, at)
  if (has(raw.content)) note.body = text(raw.content)
  if (withRaw) note.raw = renderRaw(raw)
  return note
}

function data (ent: any): unknown {
  return 'function' === typeof ent?.data ? ent.data() : ent
}

function notFound (err: any): boolean {
  return true === err?.notFound || 404 === err?.status
}

const REFUSED: Record<Refusal, string> = {
  changed: 'presented a certificate whose fingerprint is not the one its connection pins',
  expired: 'presented its pinned certificate, which has expired',
  'not-yet-valid': 'presented its pinned certificate, which is not valid yet',
  'wrong-host': 'presented its pinned certificate, which does not name the host connected to',
  invalid: 'presented a certificate that failed verification',
}

function rejected (instance: string, err: CertificateError): LikenessError {
  return new LikenessError('certificate-rejected', SOURCE + ' connection "' + instance + '" ' + REFUSED[err.refusal],
    'if the plugin\'s certificate was regenerated, pin its new fingerprint in station.json; if not, do not connect',
    { source: SOURCE, instance })
}

// A note is a `.md` file, by its path from the vault root.
function isNote (path: string): boolean {
  return path.endsWith('.md')
}

async function listing (h: Handle, dir: string): Promise<string[]> {
  try {
    if ('' === dir) return entries(((await h.sdk.Vault().list()) ?? []).map(data))
    const got = data(await h.sdk.Vault().load({ id: dir }))
    if (!isMap(got) || !Array.isArray(got.files)) {
      throw new LikenessError('source-unavailable',
        SOURCE + ' returned a directory with no list of files', BUG)
    }
    return entries(got.files)
  }
  catch (err) {
    if (notFound(err)) return []
    throw err instanceof CertificateError ? rejected(h.instance, err) : err
  }
}

async function read (h: Handle, conn: Conn, path: string, withRaw: boolean): Promise<Note | null> {
  try {
    return project(data(await h.sdk.Vault().load({ id: path })), path, conn.instance, conn.account, withRaw)
  }
  catch (err) {
    if (notFound(err)) return null
    throw err instanceof CertificateError ? rejected(h.instance, err) : err
  }
}

export type Step = { list: string } | { read: string }

/* The walk, as the plugin lets a vault be walked: one directory at a time,
 * depth first, each directory's entries in code-point order, and each note
 * read as it is met. A list step is answered with that directory's entries. */
export function * walkSteps (dir: string = ''): Generator<Step, void, string[] | undefined> {
  for (const name of (yield { list: dir }) ?? []) {
    const path = dir + name
    if (name.endsWith('/')) yield * walkSteps(path)
    else if (isNote(path)) yield { read: path }
  }
}

// A directory or a note gone since its parent was listed is skipped.
export async function walkNotes (h: Handle, conn: Conn, withRaw: boolean, limit: number):
Promise<{ notes: Note[], more: boolean }> {
  const notes: Note[] = []
  const steps = walkSteps()
  for (let step = steps.next(); !step.done;) {
    const at = step.value
    if ('list' in at) {
      step = steps.next(await listing(h, at.list))
      continue
    }
    if (0 < limit && notes.length >= limit) return { notes, more: true }
    const note = await read(h, conn, at.read, withRaw)
    if (null !== note) notes.push(note)
    step = steps.next()
  }
  return { notes, more: false }
}

export async function listNotes (h: Handle, conn: Conn, withRaw: boolean):
Promise<{ notes: Note[], more: boolean }> {
  return walkNotes(h, conn, withRaw, pageMax(SOURCE))
}

export async function loadNote (h: Handle, conn: Conn, id: string, withRaw: boolean): Promise<Note | null> {
  const segs = id.split('/')
  if (segs.some((g, i) => '.' === g || '..' === g || ('' === g && i !== segs.length - 1))) {
    throw new LikenessError('invalid-ref',
      'not a ref: ' + conn.instance + ':' + id + ' (a vault path has no empty, . or .. segment)',
      'a ref is <instance>:<id>, a lid, #n or @alias')
  }
  if (!isNote(id)) {
    throw new LikenessError('not-found', conn.instance + ':' + id + ' is not a note, which is a .md file',
      'check the ref, or run `likeness list` to see what is there')
  }
  return read(h, conn, id, withRaw)
}

export async function check (h: Handle): Promise<Check> {
  const how = h.plain ? ', over plain HTTP as the connection declares' : ''
  try {
    await h.sdk.Vault().list()
    return { ok: true, detail: 'ok' + how }
  }
  catch (err: any) {
    if (err instanceof CertificateError) {
      const r = rejected(h.instance, err)
      return { ok: false, code: r.code, detail: REFUSED[err.refusal], remedy: r.remedy }
    }
    // An empty vault lists as not found, which only a token the plugin accepted can reach.
    if (notFound(err)) return { ok: true, detail: 'ok' + how }
    if (401 === err?.status || 403 === err?.status) {
      return { ok: false, code: 'auth-failed', detail: 'the token was rejected' + how }
    }
    if (429 === err?.status) {
      return { ok: false, code: 'rate-limited', detail: 'the source is rate limiting this client' + how }
    }
    return {
      ok: false,
      code: 'source-unavailable',
      detail: 'the application did not answer' + how,
      remedy: 'start Obsidian with the Local REST API community plugin enabled',
    }
  }
}
