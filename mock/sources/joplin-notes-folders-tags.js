/* Joplin Data API - local mock.
 *
 * Fastify 5 plugin, ESM, no dependencies beyond fastify (node: builtins only).
 *
 *   import routes from '<this file>'
 *   app.register(routes, { store, clock, apikey?, seed?, seedPath? })
 *
 * ALL mutable state lives on `opts.store` (namespaced under store[NS]); this
 * module holds nothing mutable of its own, because one process hosts several
 * sources at once and tests hand in a fresh store between runs.
 *
 * DETERMINISM: ids come from a counter on the store, timestamps from
 * `opts.clock()` supplied by the server. No Date.now(), no Math.random().
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MOCK IS FAITHFUL TO
 *
 * The OpenAPI definition (openapi 3.0.3, "Joplin Data API" 1.0.0) and the
 * GENERATED client disagree in places. Where they disagree the mock satisfies
 * the CODE, because the code is what talks to it. Specifically:
 *
 *  1. AUTH IS A HEADER. The definition declares `apiKey in:query name:token`,
 *     but PrepareAuthUtility hardcodes `Authorization: <raw apikey>` (no
 *     scheme prefix) and the generator drops the in/name facts from Config.
 *     The SDK never adds a `token` query parameter by itself. So: the mock
 *     authenticates on the Authorization header (raw value; a "Bearer "/
 *     "Token " prefix is stripped if the caller configured auth.prefix), and
 *     ALSO accepts `?token=` because a caller can smuggle it through the match
 *     object or direct({query}).
 *
 *  2. THE PATH PARAM IS DUPLICATED INTO THE QUERY. load/remove send
 *     `GET /notes/n1?id=n1`; the sub-resource lists send `&id=n1` too
 *     (PrepareQueryUtility reads point.params, which is undefined, so nothing
 *     is excluded). Nothing here rejects unknown or duplicate query keys.
 *
 *  3. `$action` LEAKS AS %24action on the three sub-resource list routes.
 *     Tolerated (and stripped from bodies if it ever shows up there).
 *
 *  4. `field` vs `fields`. The API parameter is `fields`; the model and the
 *     generated types say `field`. BOTH are honoured, neither is rejected.
 *
 *  5. UPDATE SENDS NO QUERY STRING and carries id in the BODY. Targeting is
 *     therefore done from the PATH param, never from `?id=`.
 *
 *  6. EVERY RESPONSE CARRIES A PARSEABLE JSON BODY, INCLUDING ERRORS AND
 *     DELETE. ResultBodyUtility calls response.json() whenever a body stream
 *     is present; an empty 200 (what real Joplin returns from DELETE) or a
 *     bodyless 404 throws a raw SyntaxError that REPLACES the clean
 *     `request_status` error. So DELETE answers 200 + the deleted record, and
 *     404 answers `{"error":"Not Found"}`.
 *
 *  7. STATUS IS EXACTLY 200 on success (never 201/204) - the generated
 *     live-contract harness throws `Undeclared response status` otherwise.
 *
 *  8. LIST RESPONSES ARE `{items:[...], has_more:bool}`. A bare array would
 *     silently yield an empty list (the transform is `body.items`).
 *
 *  9. FIELD TYPES MATTER: *_time / is_* / markup_language / todo_* are
 *     INTEGERS, latitude/longitude/altitude are NUMBERS, the rest are STRINGS,
 *     has_more is a real BOOLEAN. validateContract checks these.
 *
 * 10. PAGINATION. `has_more` is DEAD ON ARRIVAL - no generated target reads
 *     it; the paging feature reads camelCase `hasMore`, `X-Next-Page`,
 *     `X-Page`, `X-Total-Count` and `Link: rel="next"`. The mock emits the
 *     truthful `has_more` in the body (definition-faithful) AND the headers
 *     (so the paging feature sees more pages). Body-level camelCase `hasMore`
 *     is opt-in via config.camelHasMore, to keep the body exactly as declared
 *     by default.
 *
 * Failure statuses: the definition declares NO error envelope at all (its only
 * non-2xx is a contentless 404). Auth failure follows the real Joplin Clipper
 * Server: 403 + {"error":"Invalid \"token\" parameter"}.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, sep } from 'node:path'

// The full source string this mock was derived from. It is also the name of
// this file and of the fixtures/sources/<name>/ directory, so it is carried
// here (and in seed.json's "source") for registries that want it as data.
export const SOURCE =
  'Definition: /tmp/claude-501/-Users-richard-Projects-voxgig-sdk-univec-sdk/' +
  '2add9a16-da95-4678-b615-c71b996816d9/scratchpad/srcsdk/joplin-sdk/.sdk/def/' +
  'joplin-notes-folders-tags.json (openapi 3.0.3, "Joplin Data API" 1.0.0). ' +
  'Model: .sdk/model/entity/{note,folder,tag}.aon (+ .sdk/model/api/api-info.aon, ' +
  '.sdk/model/sdk.json). Generated client verified: ts/src/** and, empirically, ' +
  'ts/dist/JoplinSDK.js driven against a local HTTP server capturing every request ' +
  '(probe scripts in scratchpad/joplinprobe/probe{,2,3,4,5}.js). Cross-checked ' +
  'py/joplin_sdk/utility/prepare_auth.py and prepare_query.py — same behaviour ' +
  'in every target. NOTE: this is an HTTP/REST SDK, not GraphQL; no point has kind ' +
  '"graphql" and no `doc` strings exist.'

// Namespace for this source's slice of the shared store.
export const NAMESPACE = 'joplin-notes-folders-tags'
const NS = NAMESPACE

const AUTH_HEADER = 'authorization'
const AUTH_FAIL_STATUS = 403
const AUTH_FAIL_BODY = { error: 'Invalid "token" parameter' }
const NOT_FOUND_BODY = { error: 'Not Found' }
const DEFAULT_APIKEY = 'joplin-mock-token'

// Only used when the server forgets to supply opts.clock - still deterministic.
const FALLBACK_EPOCH = 1735689600000 // 2025-01-01T00:00:00.000Z
const FALLBACK_TICK = 1000

const DEFAULT_CONFIG = {
  pageSize: 100,     // real Joplin's default page size
  maxPageSize: 1000,
  camelHasMore: false, // emit body `hasMore` (what the paging feature reads)
  logLimit: 500
}

// kind: 'string' | 'int' | 'number'. Order here is the order in the response.
const NOTE_SPEC = {
  id: 'string',
  parent_id: 'string',
  title: 'string',
  body: 'string',
  created_time: 'int',
  updated_time: 'int',
  is_conflict: 'int',
  latitude: 'number',
  longitude: 'number',
  altitude: 'number',
  author: 'string',
  source_url: 'string',
  is_todo: 'int',
  todo_due: 'int',
  todo_completed: 'int',
  markup_language: 'int',
  user_created_time: 'int',
  user_updated_time: 'int'
}

const FOLDER_SPEC = {
  id: 'string',
  title: 'string',
  parent_id: 'string',
  created_time: 'int',
  updated_time: 'int',
  user_created_time: 'int',
  user_updated_time: 'int',
  is_shared: 'int'
}

const TAG_SPEC = {
  id: 'string',
  title: 'string',
  created_time: 'int',
  updated_time: 'int',
  user_created_time: 'int',
  user_updated_time: 'int'
}

// Joplin: 1 = Markdown, 2 = HTML.
const SPECIAL_DEFAULT = { markup_language: 1 }

// id prefixes: 32 lowercase hex chars, like real Joplin ids.
const ID_PREFIX = { note: 'e9a0', folder: 'e9f0', tag: 'e9b0' }

const ENTITY = {
  note: { spec: NOTE_SPEC, plural: 'notes' },
  folder: { spec: FOLDER_SPEC, plural: 'folders' },
  tag: { spec: TAG_SPEC, plural: 'tags' }
}


export default async function routes (app, opts) {
  const S = ensure(opts)

  // The SDK sends `content-type: application/json` on EVERY request, GET and
  // DELETE included, with no body. Fastify's stock JSON parser would reject
  // that with FST_ERR_CTP_EMPTY_JSON_BODY, so tolerate an empty payload.
  // Encapsulated: this parser applies to this plugin's scope only.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      if (null == body || '' === body) return done(null, undefined)
      try {
        done(null, JSON.parse(body))
      }
      catch (err) {
        err.statusCode = 400
        done(err, undefined)
      }
    })

  // Guarantee a parseable JSON body on every failure too - a bodyless or
  // HTML error response replaces the SDK's clean `request_status` error with
  // a raw `SyntaxError: Unexpected end of JSON input`.
  app.setErrorHandler((err, req, reply) => {
    const status = 400 <= err.statusCode ? err.statusCode : 500
    reply.code(status).type('application/json')
      .send({ error: err.message || 'Error' })
  })

  app.addHook('onRequest', async (req, reply) => {
    log(S, req)
    if (!authorized(S, req)) {
      return reply.code(AUTH_FAIL_STATUS).type('application/json')
        .send(AUTH_FAIL_BODY)
    }
  })

  mountEntity(app, opts, S, 'note')
  mountEntity(app, opts, S, 'folder')
  mountEntity(app, opts, S, 'tag')

  // listNoteTags: GET /notes/{id}/tags
  // Wire shape: /notes/n1/tags?%24action=tag&field=id%2Ctitle&id=n1
  app.get('/notes/:id/tags', async (req, reply) => {
    const note = S.note.get(String(req.params.id))
    if (null == note) return notFound(reply)
    const ids = S.note_tag.filter(l => l.note_id === note.id).map(l => l.tag_id)
    const items = ids.map(id => S.tag.get(id)).filter(t => null != t)
    return sendSubList(reply, req, S, items, TAG_SPEC)
  })

  // listFolderNotes: GET /folders/{id}/notes
  app.get('/folders/:id/notes', async (req, reply) => {
    const folder = S.folder.get(String(req.params.id))
    if (null == folder) return notFound(reply)
    const items = [...S.note.values()].filter(n => n.parent_id === folder.id)
    return sendSubList(reply, req, S, items, NOTE_SPEC)
  })

  // listTagNotes: GET /tags/{id}/notes
  app.get('/tags/:id/notes', async (req, reply) => {
    const tag = S.tag.get(String(req.params.id))
    if (null == tag) return notFound(reply)
    const ids = S.note_tag.filter(l => l.tag_id === tag.id).map(l => l.note_id)
    const items = ids.map(id => S.note.get(id)).filter(n => null != n)
    return sendSubList(reply, req, S, items, NOTE_SPEC)
  })
}


function mountEntity (app, opts, S, name) {
  const { spec, plural } = ENTITY[name]
  const coll = S[name]

  // list: GET /notes | /folders | /tags
  app.get('/' + plural, async (req, reply) => {
    const q = req.query || {}
    let items = [...coll.values()]
    items = sortItems(items, q, spec)
    const page = paginate(items, q, S)
    setPagingHeaders(reply, req, page)
    const fields = pickFields(q)
    const body = {
      items: page.items.map(it => project(it, fields, spec)),
      has_more: page.has_more
    }
    // `has_more` is what the definition declares and what real Joplin sends -
    // but NO generated target reads it. The paging feature reads camelCase.
    if (S.cfg.camelHasMore) body.hasMore = page.has_more
    return reply.send(body)
  })

  // create: POST /notes | /folders | /tags  -> 200 (NOT 201) + whole object
  app.post('/' + plural, async (req, reply) => {
    const data = inbound(req.body)
    const t = now(opts, S)
    const rec = shape(spec, {}, t)
    rec.id = '' !== String(data.id ?? '') ? String(data.id) : nextId(S, name)
    apply(rec, spec, data)
    rec.created_time = intOr(data.created_time, t)
    rec.updated_time = intOr(data.updated_time, t)
    rec.user_created_time = intOr(data.user_created_time, rec.created_time)
    rec.user_updated_time = intOr(data.user_updated_time, rec.updated_time)
    coll.set(rec.id, rec)
    return reply.send(rec)
  })

  // load: GET /notes/{id}  - arrives as /notes/n1?id=n1 (duplicated param)
  app.get('/' + plural + '/:id', async (req, reply) => {
    const rec = coll.get(String(req.params.id))
    if (null == rec) return notFound(reply)
    return reply.send(project(rec, pickFields(req.query || {}), spec))
  })

  // update: PUT /notes/{id} - NO query string; id is in the body too.
  // Target from the PATH; body id is never used for lookup and never changes.
  app.put('/' + plural + '/:id', async (req, reply) => {
    const rec = coll.get(String(req.params.id))
    if (null == rec) return notFound(reply)
    const data = inbound(req.body)
    const t = now(opts, S)
    apply(rec, spec, data, true)
    rec.updated_time = intOr(data.updated_time, t)
    rec.user_updated_time = intOr(data.user_updated_time, rec.updated_time)
    return reply.send(rec)
  })

  // remove: DELETE /notes/{id} - arrives as /notes/n1?id=n1.
  // MUST answer 200 with a JSON body: an empty 200 crashes the SDK's parse.
  app.delete('/' + plural + '/:id', async (req, reply) => {
    const id = String(req.params.id)
    const rec = coll.get(id)
    if (null == rec) return notFound(reply)
    coll.delete(id)
    if ('note' === name) {
      S.note_tag = S.note_tag.filter(l => l.note_id !== id)
    }
    else if ('tag' === name) {
      S.note_tag = S.note_tag.filter(l => l.tag_id !== id)
    }
    // Notes in a removed folder are left alone (no cascade) so a test can
    // still see them; their parent_id simply dangles.
    return reply.send(rec)
  })
}


// The definition declares `page` on the three TOP-LEVEL lists only, so the
// sub-resource lists return everything, with a truthful has_more:false.
function sendSubList (reply, req, S, items, spec) {
  const fields = pickFields(req.query || {})
  const body = {
    items: items.map(it => project(it, fields, spec)),
    has_more: false
  }
  if (S.cfg.camelHasMore) body.hasMore = false
  reply.header('x-total-count', String(items.length))
  return reply.send(body)
}


function notFound (reply) {
  // A bodyless 404 is fatal: response.json() throws and the SDK loses its
  // clean `request_status` / notFound error. Always send JSON.
  return reply.code(404).type('application/json').send(NOT_FOUND_BODY)
}


// --- auth ------------------------------------------------------------------

function authorized (S, req) {
  const presented = credential(req)
  return null != presented && presented === S.apikey
}

function credential (req) {
  const raw = req.headers[AUTH_HEADER]
  if ('string' === typeof raw && '' !== raw.trim()) {
    const val = raw.trim()
    // The SDK sends the RAW credential with no scheme. A prefix only appears
    // when the user configures auth: { prefix: 'Bearer' }.
    const m = /^(?:bearer|token)\s+(.+)$/i.exec(val)
    return m ? m[1].trim() : val
  }
  // Secondary path: `?token=` can only arrive because the SDK copies every
  // un-consumed match key into the query string. Nothing sends it by itself.
  const tok = qv(req.query || {}, 'token')
  return null == tok ? null : String(tok)
}


// --- query helpers ---------------------------------------------------------

function qv (q, k) {
  const v = q[k]
  return Array.isArray(v) ? v[v.length - 1] : v
}

// Quirk: the API parameter is `fields` (plural); the model and the generated
// TypeScript types say `field` (singular) and the SDK does not rename. Honour
// both, reject neither.
function pickFields (q) {
  const raw = qv(q, 'field') ?? qv(q, 'fields')
  if (null == raw) return null
  const list = String(raw).split(',').map(s => s.trim()).filter(s => '' !== s)
  return 0 === list.length ? null : list
}

function project (item, fields, spec) {
  if (null == fields) return item
  const valid = fields.filter(f => f in spec)
  if (0 === valid.length) return item
  // `id` is always included so callers can still correlate records - the
  // three sub-resource routes are forced to send a dummy `field` by the SDK.
  const out = { id: item.id }
  for (const f of valid) out[f] = item[f]
  return out
}

function sortItems (items, q, spec) {
  const by = qv(q, 'order_by')
  if (null == by || !(by in spec)) return items // insertion order: deterministic
  const dir = 'DESC' === String(qv(q, 'order_dir') || 'ASC').toUpperCase() ? -1 : 1
  return items.slice().sort((a, b) => {
    const av = a[by]; const bv = b[by]
    if (av === bv) return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
    return (av < bv ? -1 : 1) * dir
  })
}

function paginate (items, q, S) {
  let page = parseInt(qv(q, 'page'), 10)
  if (!Number.isFinite(page) || page < 1) page = 1
  // `limit` is NOT in the definition; the paging feature sends it when
  // feature.paging.limit is configured, so honour it when it turns up.
  let limit = parseInt(qv(q, 'limit'), 10)
  if (!Number.isFinite(limit) || limit < 1) limit = S.cfg.pageSize
  limit = Math.min(limit, S.cfg.maxPageSize)
  const start = (page - 1) * limit
  const slice = items.slice(start, start + limit)
  return {
    page,
    limit,
    items: slice,
    total: items.length,
    has_more: start + slice.length < items.length
  }
}

function setPagingHeaders (reply, req, page) {
  reply.header('x-page', String(page.page))
  reply.header('x-total-count', String(page.total))
  if (page.has_more) {
    // The paging feature reads these; it does NOT read `has_more`.
    reply.header('x-next-page', String(page.page + 1))
    reply.header('link', '<' + nextUrl(req, page.page + 1) + '>; rel="next"')
  }
}

function nextUrl (req, page) {
  const host = req.host || req.headers.host || 'localhost'
  const proto = req.protocol || 'http'
  const url = new URL(req.url, proto + '://' + host)
  url.searchParams.set('page', String(page))
  return url.toString()
}


// --- records ---------------------------------------------------------------

// `$action` is the SDK's internal point discriminator. It is stripped from
// bodies by TransformRequestUtility, but strip it here too just in case.
function inbound (body) {
  const data = (null != body && 'object' === typeof body && !Array.isArray(body))
    ? { ...body } : {}
  delete data.$action
  return data
}

function coerce (kind, val, dflt) {
  if (null == val) return dflt
  if ('string' === kind) return String(val)
  const n = Number(val)
  if (!Number.isFinite(n)) return dflt
  return 'int' === kind ? Math.trunc(n) : n
}

function intOr (val, dflt) {
  const n = Number(val)
  return Number.isFinite(n) ? Math.trunc(n) : Math.trunc(dflt)
}

function shape (spec, src, t) {
  const out = {}
  for (const k of Object.keys(spec)) {
    const dflt = 'string' === spec[k] ? '' : (SPECIAL_DEFAULT[k] ?? 0)
    out[k] = coerce(spec[k], src[k], dflt)
  }
  out.created_time = intOr(src.created_time, t)
  out.updated_time = intOr(src.updated_time, t)
  out.user_created_time = intOr(src.user_created_time, out.created_time)
  out.user_updated_time = intOr(src.user_updated_time, out.updated_time)
  return out
}

// Only the supplied properties change (that is what update promises).
function apply (rec, spec, data, skipId) {
  for (const k of Object.keys(spec)) {
    if ('id' === k && skipId) continue
    if (!(k in data)) continue
    if (null == data[k]) continue
    const dflt = 'string' === spec[k] ? '' : (SPECIAL_DEFAULT[k] ?? 0)
    rec[k] = coerce(spec[k], data[k], dflt)
  }
  return rec
}

function nextId (S, name) {
  S.counter += 1
  const prefix = ID_PREFIX[name]
  return prefix + S.counter.toString(16).padStart(32 - prefix.length, '0')
}

// Joplin timestamps are epoch millisecond INTEGERS. opts.clock() may hand back
// millis, a Date, or an ISO string; all three are normalised. Never Date.now().
function now (opts, S) {
  if ('function' === typeof opts.clock) {
    const ms = millis(opts.clock())
    if (null != ms) return ms
  }
  S.tick += FALLBACK_TICK
  return FALLBACK_EPOCH + S.tick
}

function millis (val) {
  if ('number' === typeof val) {
    return Number.isFinite(val) ? Math.trunc(val) : null
  }
  if (val instanceof Date) {
    const t = val.getTime()
    return Number.isFinite(t) ? t : null
  }
  if ('string' === typeof val) {
    const n = Number(val)
    if ('' !== val.trim() && Number.isFinite(n)) return Math.trunc(n)
    const p = Date.parse(val)
    if (Number.isFinite(p)) return p
  }
  return null
}

function log (S, req) {
  if (S.requests.length >= S.cfg.logLimit) S.requests.shift()
  S.requests.push({
    method: req.method,
    url: req.url,
    query: { ...(req.query || {}) },
    auth: req.headers[AUTH_HEADER] ?? null,
    contentType: req.headers['content-type'] ?? null
  })
}


// --- store -----------------------------------------------------------------

function ensure (opts) {
  const store = opts.store
  if (null == store || 'object' !== typeof store) {
    throw new Error('joplin mock: opts.store (an object) is required')
  }
  if (null != store[NS]) return store[NS]

  const seed = loadSeed(opts)
  const S = {
    apikey: String(opts.apikey ?? seed.apikey ?? DEFAULT_APIKEY),
    cfg: { ...DEFAULT_CONFIG, ...(seed.config || {}), ...(opts.config || {}) },
    counter: 0,
    tick: 0,
    note: new Map(),
    folder: new Map(),
    tag: new Map(),
    note_tag: [],
    requests: []
  }

  for (const name of ['folder', 'note', 'tag']) {
    const { spec, plural } = ENTITY[name]
    for (const raw of (seed[plural] || [])) {
      const t = now(opts, S)
      const rec = shape(spec, raw, t)
      rec.id = '' !== String(raw.id ?? '') ? String(raw.id) : nextId(S, name)
      S[name].set(rec.id, rec)
    }
  }

  for (const link of (seed.note_tags || [])) {
    if (null == link) continue
    S.note_tag.push({
      note_id: String(link.note_id),
      tag_id: String(link.tag_id)
    })
  }

  store[NS] = S
  return S
}

function loadSeed (opts) {
  if (null != opts.seed && 'object' === typeof opts.seed) return opts.seed
  const carried = opts.store && opts.store.seed
  if (null != carried && 'object' === typeof carried) return carried
  const path = opts.seedPath || defaultSeedPath()
  if (null == path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (err) {
    if ('ENOENT' === err.code) return {}
    throw err
  }
}

// <root>/mock/sources/<name>.js  ->  <root>/fixtures/sources/<name>/seed.json
// <name> may itself contain path separators, so split on the marker.
function defaultSeedPath () {
  const self = fileURLToPath(import.meta.url)
  const marker = sep + 'mock' + sep + 'sources' + sep
  const at = self.lastIndexOf(marker)
  if (0 > at) return null
  const root = self.slice(0, at)
  const name = self.slice(at + marker.length).replace(/\.js$/, '')
  return join(root, 'fixtures', 'sources', name, 'seed.json')
}
