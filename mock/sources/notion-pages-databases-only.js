/* likeness mock source: notion-pages-databases-only
 *
 * Fastify 5 plugin (ESM) emulating the six operations of
 *   .sdk/def/notion-pages-databases-only.json (OpenAPI 3.0.3)
 * as the GENERATED client actually speaks them - not as the definition
 * or the real api.notion.com would like them spoken.
 *
 *   POST   /pages            createPage
 *   GET    /pages/{id}       getPage
 *   PATCH  /pages/{id}       updatePage
 *   POST   /databases        createDatabase
 *   GET    /databases/{id}   getDatabase
 *   PATCH  /databases/{id}   updateDatabase
 *
 * The definition's server is https://api.notion.com/v1, so the SDK's
 * options.base carries the /v1 itself. A mock is pointed at it with
 * `base: 'http://127.0.0.1:PORT'` (no /v1) or '.../v1'. Both are served:
 * every route is registered bare AND under /v1.
 *
 * STATE: everything lives on `opts.store` (namespaced under `store.notion`).
 * No module-level mutable state - one process hosts every likeness source
 * and tests reset between runs by handing in a fresh store.
 *
 * DETERMINISM: ids come from a counter on the store; timestamps come from
 * `opts.clock()`. Date.now() and Math.random() are never called.
 */

import { STATUS_CODES } from 'node:http'


const SOURCE = 'notion-pages-databases-only'

// Captured literal from the generated client: `authorization: Bearer secret_TOKEN`.
const DEFAULT_TOKEN = 'secret_TOKEN'

// Fallback clock, used only when the host supplies no opts.clock().
const DEFAULT_CLOCK_START = '2024-05-01T09:00:00.000Z'
const DEFAULT_CLOCK_STEP = 1000

// Recognised only so the call log can PROVE the SDK never sends them.
// This API has no list/query/search op, so there is nothing to paginate.
const PAGING_PARAMS = [
  'page', 'limit', 'offset', 'per_page',
  'cursor', 'next_cursor', 'start_cursor', 'page_size'
]

const KIND = {
  page: {
    kind: 'page',
    coll: 'pages',
    idtag: '2a9e0000',
    // Page schema fields, in the order the real API emits them.
    blank: (id, now) => ({
      object: 'page',
      id,
      created_time: now,
      last_edited_time: now,
      archived: false,
      properties: {},
      parent: {}
    })
  },
  database: {
    kind: 'database',
    coll: 'databases',
    idtag: '7b3d0000',
    blank: (id, now) => ({
      object: 'database',
      id,
      created_time: now,
      last_edited_time: now,
      title: [],
      properties: {},
      parent: {}
    })
  }
}


export default async function routes (app, opts) {
  const state = initState(opts)

  // QUIRK: request bodies are PRETTY-PRINTED - struct.jsonify is
  // JSON.stringify(val, null, 2), so bodies arrive with newlines and
  // 2-space indent. Irrelevant to a parser; fatal only to byte matching.
  // The stock Fastify parser is replaced anyway because it rejects a
  // zero-length body on PATCH with FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, raw, done) => {
      if (null == raw || '' === raw) return done(null, {})
      try {
        done(null, JSON.parse(raw))
      }
      catch (parse) {
        const err = new Error('body failed validation: body should be valid JSON.')
        err.statusCode = 400
        err.notion = { code: 'validation_error' }
        done(err)
      }
    }
  )

  // Fastify's own error shape ({statusCode,error,message}) is not Notion's.
  // Nothing in the SDK reads the body of an error - only the status - but a
  // mock that lies about the envelope teaches callers the wrong shape.
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && 400 <= err.statusCode ? err.statusCode : 500
    const code = (err.notion && err.notion.code) ||
      (404 === status ? 'object_not_found' : 500 <= status ? 'internal_server_error' : 'validation_error')
    return send(reply, status, envelope(status, code, err.message || STATUS_CODES[status]))
  })

  // Both mount points: base 'http://host' and base 'http://host/v1' work.
  for (const prefix of ['', '/v1']) {
    app.post(prefix + '/pages', (req, reply) => opCreate(state, opts, req, reply, 'page'))
    app.get(prefix + '/pages/:id', (req, reply) => opLoad(state, opts, req, reply, 'page'))
    app.patch(prefix + '/pages/:id', (req, reply) => opUpdate(state, opts, req, reply, 'page'))

    app.post(prefix + '/databases', (req, reply) => opCreate(state, opts, req, reply, 'database'))
    app.get(prefix + '/databases/:id', (req, reply) => opLoad(state, opts, req, reply, 'database'))
    app.patch(prefix + '/databases/:id', (req, reply) => opUpdate(state, opts, req, reply, 'database'))
  }

  // NOTE: no route schemas are attached anywhere, deliberately.
  // A body schema with additionalProperties:false rejects every PATCH (the
  // SDK sends `id` in the body, which PageUpdateInput/DatabaseUpdateInput do
  // not declare), and a querystring schema rejects every GET (the SDK leaks
  // the path param into the query string). See the quirk notes below.
  //
  // NOTE: setNotFoundHandler is NOT called. It is keyed by prefix, so the
  // second likeness source mounted at the same prefix in this process would
  // throw "Not found handler already declared". Unknown ids are 404'd by the
  // handlers themselves, with the real Notion envelope.
}


/* ----------------------------------------------------------------- state */

function initState (opts) {
  const store = opts && opts.store
  if (null == store) {
    throw new Error(SOURCE + ': opts.store is required (all state lives on the store)')
  }
  if (null == store.notion) {
    store.notion = makeState(opts)
  }
  return store.notion
}


function makeState (opts) {
  const state = {
    source: SOURCE,

    // null => accept ANY non-empty bearer token (open mode).
    token: DEFAULT_TOKEN,

    clock: { startISO: DEFAULT_CLOCK_START, stepMs: DEFAULT_CLOCK_STEP, tick: 0 },
    counter: { page: 0, database: 0, request: 0 },

    page: {},
    database: {},

    // Queue of forced responses, shifted one per request. Set directly by a
    // harness: state.force.push({status:429, code:'rate_limited', retryAfter:1}).
    force: [],

    // QUIRK: the SDK does NOT rate-limit and does NOT retry by default, so a
    // mock reproducing Notion's ~3 req/sec cap hard-fails the first caller.
    // Off unless a harness opts in: {burst:N, used:0, retryAfter:1}.
    ratelimit: null,

    calls: [],
    callmax: 500
  }

  const seed = (opts && opts.seed) || (opts.store && opts.store.seed) || null
  if (null != seed) applySeed(state, seed)

  return state
}


function applySeed (state, seed) {
  if ('token' in seed) state.token = seed.token

  if (null != seed.clock) {
    if (null != seed.clock.startISO) state.clock.startISO = seed.clock.startISO
    if (null != seed.clock.stepMs) state.clock.stepMs = seed.clock.stepMs
  }

  for (const kind of ['page', 'database']) {
    const recs = seed[kind]
    if (null == recs) continue
    for (const id of Object.keys(recs)) {
      // Leading-underscore keys are fixture annotations, not API fields -
      // stripped so they can never leak onto the wire.
      state[kind][id] = { ...strip(clone(recs[id])), id }
    }
    if (null != seed.counter && null != seed.counter[kind]) {
      state.counter[kind] = seed.counter[kind]
    }
  }

  if (null != seed.ratelimit) {
    state.ratelimit = { burst: seed.ratelimit.burst, used: 0, retryAfter: seed.ratelimit.retryAfter ?? 1 }
  }
  if (Array.isArray(seed.force)) {
    state.force = clone(seed.force)
  }
}


/* ------------------------------------------------------- determinism */

// Timestamps come from the host clock. Never Date.now().
function nowISO (state, opts) {
  const raw = 'function' === typeof opts.clock ? opts.clock() : null

  if (null == raw) {
    // Deterministic fallback: fixed epoch + a fixed step per tick.
    const base = Date.parse(state.clock.startISO)
    return new Date(base + (state.clock.tick++ * state.clock.stepMs)).toISOString()
  }
  if ('number' === typeof raw) return new Date(raw).toISOString()
  if (raw instanceof Date) return raw.toISOString()

  const text = String(raw)
  return /^\d+$/.test(text) ? new Date(Number(text)).toISOString() : text
}


// Ids come from a counter on the store. Never Math.random().
function nextId (state, kind) {
  const n = ++state.counter[kind]
  return KIND[kind].idtag + '-0000-4000-8000-' + String(n).padStart(12, '0')
}


function clone (val) {
  return null == val ? val : JSON.parse(JSON.stringify(val))
}


function strip (rec) {
  for (const key of Object.keys(rec)) {
    if ('_' === key[0]) delete rec[key]
  }
  return rec
}


/* --------------------------------------------------------------- replies */

function envelope (status, code, message) {
  // The definition declares NO error response and no error schema, and
  // nothing in the SDK reads `object`/`code`/`message` - only the status.
  // This is the real API's shape, supplied by the mock, not the definition.
  return { object: 'error', status, code, message }
}


function send (reply, status, body, headers) {
  // Node fills in the reason phrase from the status code ("Unauthorized",
  // "Not Found", "Too Many Requests"), and the SDK splices that phrase into
  // its error message: "NotionSDK: load: request: 401: Unauthorized".
  if (null != headers) {
    for (const key of Object.keys(headers)) reply.header(key, headers[key])
  }
  reply.code(status)
  return body
}


/* ------------------------------------------------------------- pipeline */

// Returns an error body (already sent) or null to continue.
function gate (state, req, reply) {
  state.counter.request++
  record(state, req)

  // 1. AUTH - header `authorization`, value exactly `Bearer <apikey>`.
  //
  // QUIRK: a missing credential means the header is ABSENT, not empty.
  // PrepareAuthUtility delprop's `authorization` when apikey is missing,
  // empty or null, so the unauthenticated case never arrives as
  // `Bearer ` with an empty token.
  const raw = req.headers.authorization
  if (null == raw || '' === String(raw).trim()) {
    return send(reply, 401, envelope(401, 'unauthorized', 'API token is invalid.'))
  }

  const match = /^bearer[ ]+(\S.*)$/i.exec(String(raw).trim())
  if (null == match) {
    return send(reply, 401, envelope(401, 'unauthorized', 'API token is invalid.'))
  }

  const token = match[1].trim()
  if (null != state.token && token !== state.token) {
    return send(reply, 401, envelope(401, 'unauthorized', 'API token is invalid.'))
  }

  // 2. FORCED status - a deterministic test affordance, checked after auth
  // so that forcing a failure still requires a valid credential.
  const forced = takeForced(state, req)
  if (null != forced) {
    const status = forced.status

    if (400 <= status) {
      const headers = null == forced.retryAfter ? null : { 'retry-after': String(forced.retryAfter) }
      return send(reply, status, envelope(
        status,
        forced.code || codeForStatus(status),
        forced.message || STATUS_CODES[status] || 'error'
      ), headers)
    }

    // QUIRK: success is any status < 400, and a 2xx with NO body leaves
    // result.body undefined and the entity's data() returning {} - no error
    // raised, the record silently comes back empty. 204 reproduces that.
    if (204 === status || 304 === status) {
      reply.code(status)
      return ''
    }
    // Any other <400 (201, say) falls through and is applied to the success.
    req.forcedOk = status
  }

  // 3. RATE LIMIT - opt-in only. See state.ratelimit.
  const rl = state.ratelimit
  if (null != rl && null != rl.burst) {
    rl.used++
    if (rl.burst < rl.used) {
      // RetryFeature reads `retry-after` IN SECONDS - but it is inactive by
      // default, so a caller that has not opted into retry just hard-fails.
      return send(reply, 429, envelope(429, 'rate_limited',
        'You have been rate limited. Please try again in a few minutes.'),
      { 'retry-after': String(rl.retryAfter) })
    }
  }

  return null
}


function takeForced (state, req) {
  const header = req.headers['x-mock-status']
  if (null != header) return { status: Number(header) }

  const q = req.query && req.query._mock_status
  if (null != q) return { status: Number(q) }

  if (0 < state.force.length) return state.force.shift()

  return null
}


function codeForStatus (status) {
  if (401 === status || 403 === status) return 'unauthorized'
  if (404 === status) return 'object_not_found'
  if (409 === status) return 'conflict_error'
  if (429 === status) return 'rate_limited'
  if (400 === status) return 'validation_error'
  return 500 <= status ? 'internal_server_error' : 'validation_error'
}


function record (state, req) {
  const query = { ...(req.query || {}) }
  const call = {
    n: state.counter.request,
    method: req.method,
    url: req.url,
    params: { ...(req.params || {}) },
    query,

    // QUIRK PROOF: PrepareQueryUtility reads point.params but the generated
    // point stores them at point.args.params, so the params list is always
    // empty and every reqmatch key is copied into the query string. Every
    // load therefore arrives as /pages/<id>?id=<id>.
    queryLeak: Object.keys(query).filter((k) => '_mock_status' !== k),

    // QUIRK PROOF: pagination is NONE. No list/query/search op exists, so
    // this must stay empty for every request the SDK makes.
    paging: Object.keys(query).filter((k) => PAGING_PARAMS.includes(k)),

    auth: null == req.headers.authorization ? null : String(req.headers.authorization),
    contentType: req.headers['content-type'] ?? null,

    // QUIRK PROOF: no Notion-Version header is EVER sent - the string does
    // not appear anywhere in the definition, model or any generated target.
    notionVersion: req.headers['notion-version'] ?? null,

    body: undefined === req.body ? null : clone(req.body)
  }

  state.calls.push(call)
  if (state.callmax < state.calls.length) state.calls.shift()

  return call
}


/* ------------------------------------------------------------ operations */

function opCreate (state, opts, req, reply, kind) {
  const stop = gate(state, req, reply)
  if (null != stop) return stop

  const data = req.body
  if (null == data || 'object' !== typeof data || Array.isArray(data)) {
    return send(reply, 400, envelope(400, 'validation_error',
      'body failed validation: body should be an object.'))
  }

  // NOT enforced: PageInput.required ["parent","properties"] and
  // DatabaseInput.required ["parent","title","properties"].
  // QUIRK: the SDK's OWN generated test data violates them - PageTestData
  // new.page_ref01 sends `parent: {}` with no database_id (and read-only
  // created_time/last_edited_time/object besides). A mock that enforces
  // parent.database_id / parent.page_id fails the SDK's own suite.

  const now = nowISO(state, opts)
  const body = clone(data)
  delete body.$action // TransformRequestUtility strips it; belt and braces.
  delete body.id      // id is server-owned.

  const id = nextId(state, kind)

  // Caller fields win verbatim over the blanks - `properties` rich_text and
  // database `title` are opaque to the SDK (the definition types them as
  // bare object / array-of-object), so whatever arrives is stored and
  // echoed byte-identically.
  const rec = { ...KIND[kind].blank(id, now), ...body, id }
  state[kind][id] = rec

  // The response IS the entity, un-enveloped: point.transform.res is `body`,
  // so result.resdata is the whole parsed body. No {data:...}, no
  // {results:[...]}, no {page:...} - any envelope becomes the entity itself
  // and the generated `null != data.id` assertion fails.
  return send(reply, req.forcedOk || 200, clone(rec))
}


function opLoad (state, opts, req, reply, kind) {
  const stop = gate(state, req, reply)
  if (null != stop) return stop

  // QUIRK: `content-type: application/json` IS sent on this bodyless GET -
  // PrepareHeadersUtility copies options.headers unconditionally with no
  // method-aware suppression. Tolerated: never inspected here.
  //
  // QUIRK: the URL is /pages/<id>?id=<id>. The query string is IGNORED; the
  // path segment is authoritative. Unknown query params are never rejected.
  const id = req.params.id

  const rec = state[kind][id]
  if (null == rec) return notFound(reply, kind, id)

  return send(reply, req.forcedOk || 200, clone(rec))
}


function opUpdate (state, opts, req, reply, kind) {
  const stop = gate(state, req, reply)
  if (null != stop) return stop

  const id = req.params.id
  const cur = state[kind][id]
  if (null == cur) return notFound(reply, kind, id)

  const data = req.body
  if (null == data || 'object' !== typeof data || Array.isArray(data)) {
    return send(reply, 400, envelope(400, 'validation_error',
      'body failed validation: body should be an object.'))
  }

  // QUIRK: the PATCH body carries `id`, which the schema forbids -
  // updatePage sends {"archived":true,"id":"page-abc","properties":{...}}
  // while PageUpdateInput declares only properties/archived. The path id and
  // the body id are always the same value; the path wins regardless.
  const patch = clone(data)
  delete patch.$action
  delete patch.id

  // QUIRK: update MUST echo created_time VERBATIM. Both BasicPageFlow and
  // BasicDatabaseFlow use created_time as the mutation marker: they PATCH
  // {id, created_time:'Mark01-<ref>_<ts>'} and then assert the response
  // carries that exact string back - even though created_time is read-only
  // on the real API. A mock that treats it as server-owned fails the suite.
  const next = { ...cur, ...patch, id }

  if (!('last_edited_time' in patch)) {
    next.last_edited_time = nowISO(state, opts)
  }

  state[kind][id] = next

  return send(reply, req.forcedOk || 200, clone(next))
}


function notFound (reply, kind, id) {
  return send(reply, 404, envelope(404, 'object_not_found',
    'Could not find ' + kind + ' with ID: ' + id + '.'))
}
