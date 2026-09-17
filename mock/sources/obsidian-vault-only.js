// likeness mock source: Obsidian Local REST API (vault + tags), as the generated
// Univec/voxgig SDK actually speaks it.
//
// Source contract (the definition this mock was written against):
//   Definition: .../obsidian-sdk/.sdk/def/obsidian-vault-only.json
//   (OpenAPI 3.2.0, "Obsidian Local REST API" v1.0)
//   Model: .sdk/model/entity/vault.aon + tag.aon + entity-index.aon
//   Generated client: ts/src/**  (Config.ts carries the resolved points;
//   MakeUrl/PreparePath/PrepareQuery/PrepareAuth/PrepareBody/ResultBody/
//   TransformResponse utilities decide the wire form).
//
// Fastify 5 plugin, ESM, no dependencies beyond fastify (node: builtins only).
// ALL state lives on `opts.store` - no module-level mutable state, because one
// process hosts every source and tests reset between runs.
// Determinism: ids come from a counter on the store, time comes from opts.clock().
//
// Registration:
//   app.register(obsidianVaultOnly, { store, clock, seed, apikey })
//
//   store   (required) shared per-run state bag; this plugin owns store.obsidian
//   clock   (required) () => epoch-ms number (or Date). Never Date.now().
//   seed    (optional) parsed fixtures/sources/<source>/seed.json. When absent the
//           plugin loads the co-located seed.json itself; failing that it starts
//           with an empty vault.
//   apikey  (optional) overrides seed.auth.apikey.
//   bare404 (optional) honour the definition's *bare* 404 (no body) for
//           GET /vault/{filename}. Default false - see MOCK DECISIONS below.
//
// ---------------------------------------------------------------------------
// MOCK DECISIONS (things the definition does NOT state - recorded, not invented
// silently):
//
//  1. AUTH FAILURE STATUS/BODY. The definition declares NO 401 and NO 403 on any
//     route (declared statuses are only 200/204/400/404/405/409/412/422). This
//     mock answers 401 + the definition's own `Error` envelope
//     {errorCode, message} with reason phrase "Unauthorized". That is a mock
//     invention, not a contract fact.
//  2. NON-BARE 404 FOR A FILE READ. The definition declares GET /vault/{filename}
//     404 with NO body. But the SDK's ResultBodyUtility calls response.json() on
//     any response that has a body and does not guard it, and an empty body is a
//     coin-flip between "no body" and "Unexpected end of JSON input". So by
//     default this mock returns the `Error` envelope on that 404 too, which keeps
//     err.status === 404 / err.notFound === true intact. Pass { bare404: true }
//     to honour the definition literally.
//  3. AN OUT-OF-ENUM `permanent` VALUE on DELETE is treated as the declared
//     default "false" (the definition declares no error for it).
//  4. COPY / MOVE (OpenAPI 3.2 additionalOperations) are NOT implemented. They
//     never reached the model, no generated client can call them, and
//     options.allow.method excludes them even for direct(). Out of contract.
//  5. `x-total-count` is set on both list routes. It is truthful and harmless:
//     the paging feature is inactive, and without x-next-page / Link / body
//     `next` no client can conclude there is a second page.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const source =
  'Definition: /tmp/claude-501/-Users-richard-Projects-voxgig-sdk-univec-sdk/' +
  '2add9a16-da95-4678-b615-c71b996816d9/scratchpad/srcsdk/obsidian-sdk/.sdk/def/' +
  'obsidian-vault-only.json (OpenAPI 3.2.0, "Obsidian Local REST API" v1.0)'

export const slug = 'obsidian-vault-only'

// servers[0].url from the definition, baked into ts/src/Config.ts as options.base.
// prefix and suffix are both "" and are dropped by join(), so we mount at root.
export const baseUrl = 'http://127.0.0.1:27123'

const NS = 'obsidian'
const FALLBACK_APIKEY = 'obsidian-local-rest-api-key-0001'
const NUL = String.fromCharCode(0)

// ===========================================================================
// small utilities
// ===========================================================================

// Byte-order compare: locale-independent, therefore deterministic.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function nowMs (clock) {
  const t = clock()
  if (t instanceof Date) return t.getTime()
  const n = Number(t)
  if (!Number.isFinite(n)) {
    throw new Error('obsidian mock: opts.clock() must return epoch-ms or a Date')
  }
  return n
}

// The `Error` schema: a FLAT object with exactly two optional properties.
// No wrapper key, no `error` object, no `errors` array, no `status`, no `code`.
function envelope (errorCode, message) {
  return { errorCode, message }
}

function sendErr (reply, status, errorCode, message) {
  // QUIRK: every response body must be valid JSON on EVERY status, because
  // ResultBodyUtility parses the body regardless of status. A malformed error
  // body would REPLACE the status message with a JSON parse error.
  return reply.code(status).type('application/json; charset=utf-8')
    .send(envelope(errorCode, message))
}

// The SDK leaks the definition's declared *request headers* into the wrong place:
// into the query string for load/remove, into the JSON body for create/update.
// Nothing here may require them, and everything here must tolerate them turning
// up in either place, in any spelling.
function leaked (bag, name) {
  if (bag == null || typeof bag !== 'object') return undefined
  const want = name.replace(/[-_]/g, '').toLowerCase()
  for (const k of Object.keys(bag)) {
    if (k.replace(/[-_]/g, '').toLowerCase() === want) return bag[k]
  }
  return undefined
}

// `permanent` is a STRING enum ("true"/"false"), not a boolean; other leaked
// flags arrive as strings too. Presence is never truth.
function truthy (v) {
  if (Array.isArray(v)) v = v[v.length - 1]
  return v === true || v === 'true' || v === 1 || v === '1'
}

function lastOf (v) {
  return Array.isArray(v) ? v[v.length - 1] : v
}

// ===========================================================================
// vault model
// ===========================================================================

// A tag occurrence list for one note: frontmatter tags first, then inline #tags
// found in the body. NOT de-duplicated - /tags reports usage counts.
function tagOccurrences (note) {
  const out = []
  const fm = note.frontmatter || {}
  const fmTags = Array.isArray(fm.tags)
    ? fm.tags
    : (typeof fm.tags === 'string' ? [fm.tags] : [])
  for (const t of fmTags) {
    const s = String(t).replace(/^#/, '').trim()
    if (s) out.push(s)
  }
  // An inline tag is #word; a markdown heading ("# Title", "## Section") is not,
  // because the character after # must start an identifier.
  const re = /(^|[\s(])#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g
  let m
  while ((m = re.exec(note.content || '')) !== null) out.push(m[2])
  return out
}

function dedupe (list) {
  const seen = new Set()
  const out = []
  for (const v of list) if (!seen.has(v)) { seen.add(v); out.push(v) }
  return out
}

function sizeOf (content) {
  return Buffer.byteLength(String(content == null ? '' : content), 'utf8')
}

// The 200 representation for GET /vault/{filename}. All eight keys are
// `required` in the definition, so all eight are always present.
function noteJson (path, note) {
  return {
    tags: dedupe(tagOccurrences(note)),
    frontmatter: note.frontmatter || {},
    stat: {
      ctime: note.ctime,
      mtime: note.mtime,
      size: sizeOf(note.content)
    },
    path,
    content: note.content,
    links: [...(note.links || [])],
    backlinks: [...(note.backlinks || [])],
    unresolvedLinks: [...(note.unresolvedLinks || [])]
  }
}

function recomputeBacklinks (st) {
  for (const note of st.files.values()) note.backlinks = []
  const paths = [...st.files.keys()].sort(cmp)
  for (const from of paths) {
    for (const to of st.files.get(from).links || []) {
      const target = st.files.get(to)
      if (target && !target.backlinks.includes(from)) target.backlinks.push(from)
    }
  }
  for (const note of st.files.values()) note.backlinks.sort(cmp)
}

// Directory listing. `dir` is '' (vault root) or ends with '/'.
// Returns null when the directory does not exist.
function listDir (st, dir) {
  const names = new Set()
  let exists = dir === ''
  for (const p of st.files.keys()) {
    if (dir !== '') {
      if (!p.startsWith(dir)) continue
      exists = true
    }
    const rest = p.slice(dir.length)
    const slash = rest.indexOf('/')
    names.add(slash === -1 ? rest : rest.slice(0, slash + 1))
  }
  if (!exists) return null
  return [...names].sort(cmp)
}

function tagList (st) {
  const counts = new Map()
  for (const p of [...st.files.keys()].sort(cmp)) {
    for (const t of tagOccurrences(st.files.get(p))) {
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([name, count]) => ({ name, count }))
}

// ===========================================================================
// store bootstrap
// ===========================================================================

// The seed lives at fixtures/sources/<source>/seed.json, where <source> is the
// same (long) source name this plugin file is called after. Derive it from this
// module's own location rather than a fixed number of '..' hops, because the
// source name contains '/' and therefore nests arbitrarily deep.
function loadColocatedSeed () {
  let here
  try {
    here = fileURLToPath(import.meta.url)
  } catch {
    return null
  }
  const marker = '/mock/sources/'
  const at = here.lastIndexOf(marker)
  const candidates = []
  if (at !== -1) {
    const root = here.slice(0, at)
    const rel = here.slice(at + marker.length).replace(/\.js$/, '')
    candidates.push(root + '/fixtures/sources/' + rel + '/seed.json')
    candidates.push(root + '/fixtures/sources/' + slug + '/seed.json')
  }
  for (const c of candidates) {
    try {
      return JSON.parse(readFileSync(c, 'utf8'))
    } catch { /* try the next candidate */ }
  }
  return null
}

function initStore (opts) {
  const seed = opts.seed || loadColocatedSeed() || {}
  const st = {
    files: new Map(),
    trash: [],
    counter: 0,
    apikey: opts.apikey != null
      ? opts.apikey
      : (seed.auth && seed.auth.apikey) || FALLBACK_APIKEY,
    authPrefix: (seed.auth && seed.auth.prefix) || 'Bearer',
    bare404: opts.bare404 === true
  }
  st.nextId = () => ++st.counter

  const files = (seed.vault && seed.vault.files) || []
  for (const f of files) {
    st.files.set(f.path, {
      content: f.content == null ? '' : String(f.content),
      frontmatter: f.frontmatter || {},
      links: [...(f.links || [])],
      unresolvedLinks: [...(f.unresolvedLinks || [])],
      backlinks: [],
      ctime: Number(f.ctime) || 0,
      mtime: Number(f.mtime) || 0,
      etag: 'v' + st.nextId()
    })
  }
  recomputeBacklinks(st)
  return st
}

// ===========================================================================
// request parsing
// ===========================================================================

// QUIRK: path parameters are encodeURIComponent-encoded, slashes included, so
// `load({id:'folder/note.md'})` arrives as /vault/folder%2Fnote.md. A faithful
// mock must percent-DECODE the {id} segment before resolving it, or nested notes
// are unreachable through the SDK. Reading the id straight off the raw URL also
// makes this immune to router-level decoding differences and lets the real,
// un-encoded form (/vault/folder/note.md) work too.
//
// MOUNT PREFIX: one process hosts every likeness source, so this plugin is
// registered under a prefix (/obsidian) and req.raw.url is the FULL path,
// `/obsidian/vault/a.md`. Anchoring on `^/vault` therefore matched nothing and
// every load silently became the vault-root listing (a 200 with {files:[...]}
// for a note read, and a 200 where a 404 was due). The mount prefix is passed
// in, and stripped, so the id is read from the same place at every mount point.
function vaultId (req, mount) {
  const raw = String(req.raw.url || '')
  const qm = raw.indexOf('?')
  let pathOnly = qm === -1 ? raw : raw.slice(0, qm)

  if (mount && mount !== '/' && pathOnly.startsWith(mount)) {
    pathOnly = pathOnly.slice(mount.length)
    if (pathOnly === '') pathOnly = '/'
  }

  const m = /^\/vault(?:\/(.*))?$/.exec(pathOnly)
  const encoded = m && m[1] != null ? m[1] : ''
  try {
    return { id: decodeURIComponent(encoded), encoded, ok: true }
  } catch {
    return { id: encoded, encoded, ok: false }
  }
}

// '..' traversal and NUL are the only things rejected; everything else is a
// legal Obsidian vault path.
function badId (id) {
  if (id.includes(NUL)) return true
  return id.split('/').some((seg) => seg === '..')
}

// ===========================================================================
// the plugin
// ===========================================================================

export default async function routes (app, opts) {
  const store = opts.store
  if (store == null || typeof store !== 'object') {
    throw new Error('obsidian mock: opts.store is required (no module-level state)')
  }
  if (typeof opts.clock !== 'function') {
    throw new Error('obsidian mock: opts.clock() is required (deterministic time source)')
  }
  const clock = opts.clock

  // The prefix this plugin was registered under ('' when mounted at the root).
  // Fastify resolves it onto the encapsulated instance as `app.prefix`.
  const mount = String((opts && opts.prefix) || app.prefix || '').replace(/\/$/, '')

  // One process hosts every source, so namespace this source's state and keep
  // whatever a previous registration on the same store already built.
  if (store[NS] == null) store[NS] = initStore(opts)
  const st = store[NS]

  // -- body parsing ---------------------------------------------------------
  // The SDK hardcodes `content-type: application/json` on EVERY request,
  // including GET and DELETE, which send no body at all. Tolerate an empty body
  // under that content-type instead of answering FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body == null) return done(null, undefined)
    try {
      done(null, JSON.parse(body))
    } catch (e) {
      e.statusCode = 400
      done(e)
    }
  })
  // The definition's PUT/POST requestBody declares text/markdown and */* with a
  // plain string schema. The SDK never sends either, but direct() or a hand
  // written client might, so accept them as a raw string.
  app.addContentTypeParser(
    ['text/markdown', 'text/plain', 'application/octet-stream', '*/*'],
    { parseAs: 'string' },
    (req, body, done) => done(null, body === '' ? undefined : body)
  )

  // -- errors ---------------------------------------------------------------
  // Scoped to this plugin, so sibling sources keep their own handler.
  // NOTE: deliberately NO setNotFoundHandler - Fastify allows only one per
  // prefix and every source here mounts at '/', so registering one would make
  // the second source fail to boot.
  app.setErrorHandler((err, req, reply) => {
    const status = Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500
    return sendErr(reply, status, status * 100 + 99, err.message)
  })

  // -- auth -----------------------------------------------------------------
  // HEADER, not a query parameter. The SDK emits the key LOWERCASE
  // (`authorization`) with value options.auth.prefix + ' ' + options.apikey,
  // i.e. `authorization: Bearer <apikey>`. There is no query-parameter
  // alternative and no second credential (auth.basic is false).
  // When apikey is absent or '', PrepareAuthUtility DELETES the header entirely
  // and the request arrives completely unauthenticated - handle that, do not
  // merely handle a wrong key.
  app.addHook('onRequest', async (req, reply) => {
    const raw = req.headers.authorization
    if (raw == null || String(raw).trim() === '') {
      // MOCK DECISION 1: the definition declares no auth-failure response.
      return sendErr(reply, 401, 40101, 'Authorization required')
    }
    const m = /^(\S+)\s+(.*)$/.exec(String(raw))
    if (m == null || m[1].toLowerCase() !== st.authPrefix.toLowerCase()) {
      return sendErr(reply, 401, 40102,
        'Unsupported authorization scheme; expected ' + st.authPrefix)
    }
    if (m[2] !== st.apikey) {
      return sendErr(reply, 401, 40103, 'Invalid API key')
    }
  })

  // =========================================================================
  // tag.list  -  GET /tags
  // =========================================================================
  // QUIRK: the definition's path is `/tags/`, but join(parts,'/',true) strips the
  // trailing separator, so the SDK sends GET /tags. Both spellings are served:
  // `/tags` statically and `/tags/` through the wildcard. (Registering '/tags/'
  // as a second static route would collide under ignoreTrailingSlash.)
  const handleTagList = async (req, reply) => {
    const tags = tagList(st)
    // No pagination: the definition declares none anywhere and the SDK's
    // PagingFeature is inactive, so the whole collection ships in one response.
    // Any page/cursor/limit that a consumer enabling the feature might send is
    // deliberately IGNORED rather than honoured - a partial first page would
    // silently truncate the caller's list.
    reply.header('x-total-count', String(tags.length))
    // The transform is `body.tags`: a bare top-level array yields an EMPTY list
    // with ok:true and no error. The wrapper key is load-bearing.
    return reply.code(200).type('application/json; charset=utf-8').send({ tags })
  }

  app.get('/tags', handleTagList)
  app.get('/tags/*', async (req, reply) => {
    const rest = req.params['*'] || ''
    if (rest === '') return handleTagList(req, reply)
    return sendErr(reply, 404, 40401, 'Unknown tags route: /tags/' + rest)
  })

  // =========================================================================
  // vault.list  -  GET /vault          (definition path /vault/)
  // vault.load  -  GET /vault/{id}?id={id}
  // =========================================================================
  const handleVaultGet = async (req, reply) => {
    const { id, ok } = vaultId(req, mount)
    if (!ok) return sendErr(reply, 400, 40001, 'Malformed percent-encoding in path')
    if (badId(id)) return sendErr(reply, 400, 40002, 'Invalid vault path: ' + id)

    // QUIRK: the path parameter is ECHOED into the query string
    // (GET /vault/a.md?id=a.md) because PrepareQueryUtility copies every reqmatch
    // key not listed in point.params, and point.params is undefined on every
    // generated point. Never reject the duplicate, and never reject the leaked
    // header args (markdown_patch_version, target_scope) that land here too.
    // The path is authoritative; the echo is ignored.

    // vault.list - the whole collection, wrapped in `files`.
    if (id === '') {
      const files = listDir(st, '')
      reply.header('x-total-count', String(files.length))
      return reply.code(200).type('application/json; charset=utf-8').send({ files })
    }

    // QUIRK: the model's second `load` point (GET /vault/{pathToDirectory}/) and
    // the file point (GET /vault/{filename}) both resolve to parts
    // ["vault","{id}"], and the trailing slash is stripped, so both emit exactly
    // GET /vault/{id}?id={id}. The mock cannot tell them apart by method+path -
    // it must discriminate on the decoded {id} alone. A value ending in '/'
    // (arriving as %2F) is the directory-listing point.
    if (id.endsWith('/')) {
      const files = listDir(st, id)
      if (files == null) {
        return sendErr(reply, 404, 40402, 'Directory does not exist: ' + id)
      }
      reply.header('x-total-count', String(files.length))
      return reply.code(200).type('application/json; charset=utf-8').send({ files })
    }

    const note = st.files.get(id)
    if (note == null) {
      // MOCK DECISION 2: the definition declares this 404 with NO body.
      if (st.bare404) return reply.code(404).send()
      return sendErr(reply, 404, 40403, 'File does not exist: ' + id)
    }

    // QUIRK: no Accept header is ever sent (prepareHeaders clones
    // options.headers only), so the definition's content-negotiated variants
    // (application/vnd.olrapi.note+json, .document-map+json, text/html) are
    // unreachable. One default representation must be chosen and it MUST be
    // JSON: the definition's declared text/markdown default throws
    // "Unexpected token '#' ... is not valid JSON" inside the SDK.
    reply.header('etag', note.etag)
    return reply.code(200).type('application/json; charset=utf-8').send(noteJson(id, note))
  }

  app.get('/vault', handleVaultGet)
  app.get('/vault/*', handleVaultGet)

  // =========================================================================
  // write helpers
  // =========================================================================
  // QUIRK: transform.req is the identity `reqdata`, so PUT/POST bodies are the
  // WHOLE argument object serialised as JSON, with `id` inside:
  //   create({id:'a.md', content:'# hi'}) -> {"content":"# hi","id":"a.md"}
  // The real API expects the raw file bytes as the body and keeps the filename
  // in the URL only. So: read the note text from the JSON field `content`, and
  // IGNORE the redundant `id` - do not treat the body as file content.
  function bodyContent (body) {
    if (typeof body === 'string') return body            // direct()/text-markdown
    if (body == null || typeof body !== 'object') return undefined
    if (typeof body.content === 'string') return body.content
    return undefined
  }

  function writeNote (id, content, ctimeExisting) {
    const t = nowMs(clock)
    const prev = st.files.get(id)
    const note = prev || {
      frontmatter: {}, links: [], unresolvedLinks: [], backlinks: [], ctime: t
    }
    note.content = content
    note.mtime = t
    if (prev == null) note.ctime = ctimeExisting == null ? t : ctimeExisting
    note.etag = 'v' + st.nextId()
    note.frontmatter = parseFrontmatter(content, note.frontmatter)
    st.files.set(id, note)
    recomputeBacklinks(st)
    return note
  }

  function guardWriteTarget (reply, id, ok) {
    if (!ok) return sendErr(reply, 400, 40001, 'Malformed percent-encoding in path')
    if (id === '' || id.endsWith('/')) {
      // The definition declares 405 on these routes; a directory target is the
      // realistic reason for one.
      return sendErr(reply, 405, 40501,
        'Your path references a directory instead of a file: ' + (id || '/'))
    }
    if (badId(id)) return sendErr(reply, 400, 40002, 'Invalid vault path: ' + id)
    return null
  }

  // =========================================================================
  // vault.create  -  POST /vault/{id}   (append; creates when missing)
  // =========================================================================
  app.post('/vault/*', async (req, reply) => {
    const { id, ok } = vaultId(req, mount)
    const bad = guardWriteTarget(reply, id, ok)
    if (bad) return bad

    const content = bodyContent(req.body)
    if (content == null) {
      return sendErr(reply, 400, 40003,
        'Request body must be a JSON object carrying a content string')
    }

    // QUIRK: the definition's declared request headers never travel as headers.
    // Create-Target-If-Missing / Reject-If-Content-Preexists /
    // Markdown-Patch-Version land as extra keys in this JSON body instead. Read
    // them from there, and never require them.
    const reject = truthy(leaked(req.body, 'reject_if_content_preexists'))
    const prev = st.files.get(id)
    if (reject && prev != null && prev.content.includes(content)) {
      return sendErr(reply, 409, 40901,
        'Content already present in ' + id + ' and Reject-If-Content-Preexists was set')
    }

    if (prev == null) {
      writeNote(id, content)
    } else {
      const sep = prev.content.length === 0 || prev.content.endsWith('\n') ? '' : '\n'
      writeNote(id, prev.content + sep + content)
    }
    // 204 with a genuinely empty body is the only safe no-body answer: an
    // empty-string 200 body throws "Unexpected end of JSON input" in the SDK.
    return reply.code(204).send()
  })

  // =========================================================================
  // vault.update  -  PUT /vault/{id}    (replace whole file)
  // =========================================================================
  app.put('/vault/*', async (req, reply) => {
    const { id, ok } = vaultId(req, mount)
    const bad = guardWriteTarget(reply, id, ok)
    if (bad) return bad

    const content = bodyContent(req.body)
    if (content == null) {
      return sendErr(reply, 400, 40003,
        'Request body must be a JSON object carrying a content string')
    }

    const reject = truthy(leaked(req.body, 'reject_if_content_preexists'))
    const prev = st.files.get(id)
    if (reject && prev != null && prev.content.includes(content)) {
      return sendErr(reply, 409, 40902,
        'Content already present in ' + id + ' and Reject-If-Content-Preexists was set')
    }

    writeNote(id, content, prev ? prev.ctime : null)
    return reply.code(204).send()
  })

  // =========================================================================
  // vault.remove  -  DELETE /vault/{id}?id={id}&permanent={true|false}
  // =========================================================================
  app.delete('/vault/*', async (req, reply) => {
    const { id, ok } = vaultId(req, mount)
    if (!ok) return sendErr(reply, 400, 40001, 'Malformed percent-encoding in path')
    if (id === '' || id.endsWith('/')) {
      return sendErr(reply, 405, 40502,
        'Your path references a directory instead of a file: ' + (id || '/'))
    }
    if (badId(id)) return sendErr(reply, 400, 40002, 'Invalid vault path: ' + id)

    const note = st.files.get(id)
    if (note == null) return sendErr(reply, 404, 40404, 'File does not exist: ' + id)

    // QUIRK: `permanent` is a STRING enum "true"/"false" with default "false",
    // not a boolean, and the SDK passes it through verbatim. Presence is not
    // truth: ?permanent=false must NOT delete permanently.
    // MOCK DECISION 3: an out-of-enum value falls back to the declared default.
    const permanent = lastOf(req.query.permanent) === 'true'
    st.files.delete(id)
    if (!permanent) {
      st.trash.push({
        id: 'trash-' + st.nextId(),
        path: id,
        deletedAt: nowMs(clock),
        note
      })
    }
    recomputeBacklinks(st)
    return reply.code(204).send()
  })

  // =========================================================================
  // vault.patch  -  PATCH /vault/{id}
  // =========================================================================
  // NOT on the generated entity: VaultEntity.ts emits only load/list/create/
  // update/remove, so sdk.Vault().patch is undefined. Reachable ONLY through the
  // escape hatch client.direct({path:'vault/{id}', method:'PATCH', ...}), which
  // sends the PatchInstruction body verbatim as JSON. Implemented here so that
  // escape hatch has something real to talk to.
  app.patch('/vault/*', async (req, reply) => {
    const { id, ok } = vaultId(req, mount)
    const bad = guardWriteTarget(reply, id, ok)
    if (bad) return bad

    const ins = req.body
    if (ins == null || typeof ins !== 'object' || Array.isArray(ins)) {
      return sendErr(reply, 400, 40004, 'PATCH body must be a PatchInstruction object')
    }

    const targetType = ins.targetType
    const operation = ins.operation
    if (!['heading', 'block', 'frontmatter'].includes(targetType)) {
      return sendErr(reply, 400, 40005,
        'targetType must be one of heading, block, frontmatter')
    }
    if (!['replace', 'prepend', 'append', 'delete'].includes(operation)) {
      return sendErr(reply, 400, 40006,
        'operation must be one of replace, prepend, append, delete')
    }
    if (ins.destination != null) {
      const d = ins.destination
      if (typeof d !== 'object' || !('parent' in d) || !('place' in d)) {
        return sendErr(reply, 400, 40007,
          'destination requires both parent and place')
      }
      if (typeof d.place === 'object' && d.place !== null) {
        return sendErr(reply, 422, 42201,
          'destination.place before/after is not supported by this mock')
      }
    }

    const note = st.files.get(id)
    if (note == null) return sendErr(reply, 404, 40405, 'File does not exist: ' + id)

    // If-Match is declared as a PATCH request header; the SDK cannot send
    // headers, but direct() can. The etag comes from the store counter, so it is
    // deterministic.
    const ifMatch = ins.ifMatch == null ? leaked(ins, 'if_match') : ins.ifMatch
    if (ifMatch != null && ifMatch !== note.etag) {
      return sendErr(reply, 412, 41201,
        'If-Match ' + ifMatch + ' does not match current ' + note.etag)
    }

    const target = Array.isArray(ins.target)
      ? ins.target.map(String)
      : (ins.target == null ? [] : [String(ins.target)])
    const text = typeof ins.content === 'string' ? ins.content : undefined
    const warnings = []

    let next
    if (targetType === 'frontmatter') {
      const key = target[0]
      if (key == null) return sendErr(reply, 400, 40008, 'frontmatter patch needs a target key')
      const fm = { ...(note.frontmatter || {}) }
      if (operation === 'delete') {
        if (!(key in fm)) return sendErr(reply, 404, 40406, 'No such frontmatter key: ' + key)
        delete fm[key]
      } else {
        const value = 'value' in ins ? ins.value : text
        if (value === undefined) {
          return sendErr(reply, 400, 40009, 'frontmatter patch needs value or content')
        }
        if (operation === 'replace' || !(key in fm)) {
          if (!(key in fm) && !truthy(ins.createTargetIfMissing) && operation !== 'replace') {
            return sendErr(reply, 404, 40407, 'No such frontmatter key: ' + key)
          }
          if (!(key in fm)) warnings.push({ code: 'target-created', message: 'created ' + key })
          fm[key] = value
        } else {
          const cur = Array.isArray(fm[key]) ? fm[key] : [fm[key]]
          fm[key] = operation === 'append' ? [...cur, value] : [value, ...cur]
        }
      }
      note.frontmatter = fm
      next = renderFrontmatter(fm) + stripFrontmatter(note.content)
    } else if (targetType === 'heading') {
      const heading = target[target.length - 1]
      if (heading == null) return sendErr(reply, 400, 40010, 'heading patch needs a target')
      const lines = stripFrontmatterKeepAll(note.content)
      const idx = lines.findIndex((l) =>
        /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, '').trim() === heading)
      if (idx === -1) {
        if (!truthy(ins.createTargetIfMissing)) {
          return sendErr(reply, 404, 40408, 'No such heading: ' + heading)
        }
        warnings.push({ code: 'target-created', message: 'created heading ' + heading })
        lines.push('', '## ' + heading, text == null ? '' : text)
        next = lines.join('\n')
      } else {
        let end = idx + 1
        while (end < lines.length && !/^#{1,6}\s+/.test(lines[end])) end++
        const within = ins.within
        if (within != null && (!Number.isInteger(within) || within < 0 || within > end - idx - 1)) {
          return sendErr(reply, 422, 42202, 'within is out of range for this heading')
        }
        const section = lines.slice(idx + 1, end)
        if (truthy(ins.rejectIfContentPreexists) && text != null &&
            section.join('\n').includes(text)) {
          return sendErr(reply, 409, 40903, 'Content already present under ' + heading)
        }
        let body
        if (operation === 'delete') body = []
        else if (operation === 'replace') body = [text == null ? '' : text]
        else if (operation === 'append') body = [...section, text == null ? '' : text]
        else body = [text == null ? '' : text, ...section]
        const head = operation === 'delete' && ins.scope === 'markerAndContent'
          ? lines.slice(0, idx)
          : lines.slice(0, idx + 1)
        next = [...head, ...body, ...lines.slice(end)].join('\n')
      }
      next = keepFrontmatter(note.content) + next
    } else {
      // block
      const lines = stripFrontmatterKeepAll(note.content)
      const blockId = String(target[0] || '').replace(/^\^/, '')
      const idx = lines.findIndex((l) => l.trimEnd().endsWith('^' + blockId))
      if (idx === -1) {
        if (truthy(ins.createTargetIfMissing)) {
          return sendErr(reply, 422, 42203,
            'createTargetIfMissing is not supported for block targets')
        }
        return sendErr(reply, 404, 40409, 'No such block: ^' + blockId)
      }
      if (operation === 'delete') lines.splice(idx, 1)
      else if (operation === 'replace') lines[idx] = (text == null ? '' : text) + ' ^' + blockId
      else if (operation === 'append') lines.splice(idx + 1, 0, text == null ? '' : text)
      else lines.splice(idx, 0, text == null ? '' : text)
      next = keepFrontmatter(note.content) + lines.join('\n')
    }

    note.content = next
    note.mtime = nowMs(clock)
    note.etag = 'v' + st.nextId()
    st.files.set(id, note)
    recomputeBacklinks(st)

    if (warnings.length > 0) {
      // The definition's Markdown-Patch-Warnings response header: a
      // percent-encoded JSON array of {code, message}. The SDK stores it in
      // result.headers and never decodes it.
      reply.header('markdown-patch-warnings', encodeURIComponent(JSON.stringify(warnings)))
    }
    reply.header('etag', note.etag)
    // The definition says the 200 body IS the patched document. Served as a
    // JSON-encoded string so it stays valid JSON for anything that parses it.
    return reply.code(200).type('application/json; charset=utf-8').send(JSON.stringify(next))
  })

  // COPY / MOVE (OpenAPI 3.2 additionalOperations on /vault/{filename}) are
  // deliberately absent - see MOCK DECISION 4.
}

// ---------------------------------------------------------------------------
// front-matter text helpers (module-level: pure functions, no state)
// ---------------------------------------------------------------------------

const FM_RE = /^---\n[\s\S]*?\n---\n?/

// Minimal YAML front-matter reader: enough for `tags:` lists and scalars, which
// is all this API's NoteJson.frontmatter needs to be realistic.
function parseFrontmatter (content, fallback) {
  const m = FM_RE.exec(String(content || ''))
  if (m == null) return {}
  const inner = m[0].replace(/^---\n/, '').replace(/\n---\n?$/, '')
  const out = {}
  let key = null
  for (const line of inner.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = []
      out[key].push(item[1].trim().replace(/^["']|["']$/g, ''))
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]
      const v = kv[2].trim()
      if (v === '') {
        out[key] = []
      } else if (v.startsWith('[') && v.endsWith(']')) {
        out[key] = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      } else {
        out[key] = v.replace(/^["']|["']$/g, '')
      }
    }
  }
  // An empty `key:` that never got list items is a scalar null, not a list.
  for (const k of Object.keys(out)) {
    if (Array.isArray(out[k]) && out[k].length === 0) out[k] = null
  }
  return Object.keys(out).length === 0 ? (fallback || {}) : out
}

function keepFrontmatter (content) {
  const m = FM_RE.exec(String(content || ''))
  return m ? m[0] : ''
}

function stripFrontmatter (content) {
  return String(content || '').replace(FM_RE, '')
}

function stripFrontmatterKeepAll (content) {
  return stripFrontmatter(content).split('\n')
}

function renderFrontmatter (fm) {
  const keys = Object.keys(fm).sort(cmp)
  if (keys.length === 0) return ''
  const out = ['---']
  for (const k of keys) {
    const v = fm[k]
    if (Array.isArray(v)) {
      out.push(k + ':')
      for (const item of v) out.push('  - ' + item)
    } else if (v == null) {
      out.push(k + ':')
    } else {
      out.push(k + ': ' + v)
    }
  }
  out.push('---', '')
  return out.join('\n')
}
