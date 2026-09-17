/* likeness mock server: ONE Fastify app, ONE port, every source mounted.
 *
 *   node mock/server.js                    # port 7777
 *   LIKENESS_MOCK_PORT=8123 node mock/server.js
 *
 *   import { buildServer } from './mock/server.js'
 *   const app = await buildServer()
 *   await app.listen({ port: 0, host: '127.0.0.1' })
 *
 * MOUNTS
 *   /joplin     joplin-notes-folders-tags     HTTP/REST
 *   /obsidian   obsidian-vault-only           HTTP/REST
 *   /notion     notion-pages-databases-only   HTTP/REST  (also serves /notion/v1)
 *   /linear     linear-issues-only.graphql    GraphQL, POST only
 *
 * CONTROL PLANE (outside every prefix, never authenticated)
 *   GET  /__health    -> { ok, sources: [...] }
 *   POST /__reset     -> reseed every source, { ok, namespaces }
 *   GET  /__requests  -> [{ source, method, url, auth, status }]
 *
 * WHY ONE PROCESS. Every source plugin was written to namespace its state on a
 * shared `store` and to take time from a shared `clock`, precisely so they can
 * be co-hosted. Two things that co-hosting forbids, and that each plugin
 * therefore avoids, are worth naming because they are easy to reintroduce:
 * `setNotFoundHandler` is one-per-prefix, and a root-level content type parser
 * would leak across sources. Both stay inside each plugin's own scope.
 */

import Fastify from 'fastify'

import { makeStore, resetStore, snapshotStore, SOURCES } from './store.js'

import joplin from './sources/joplin-notes-folders-tags.js'
import obsidian from './sources/obsidian-vault-only.js'
import notion from './sources/notion-pages-databases-only.js'
import linear from './sources/linear-issues-only.graphql.js'


const PLUGIN = { joplin, obsidian, notion, linear }

export const DEFAULT_PORT = 7777


/* Decide, per source, whether the credential on this request is the one the
 * source accepts. This MIRRORS each plugin's own check - it does not perform
 * it; the plugin is still the authority and still answers 401 itself. The ring
 * records the verdict so a test can assert "the SDK authenticated" without
 * having to infer it from a status code that might be 404 for other reasons.
 */
const AUTHCHECK = {
  // PrepareAuthUtility sends the RAW apikey with NO scheme. A Bearer/Token
  // prefix only appears if the caller configured auth.prefix, so strip one if
  // present. `?token=` is the smuggled-through-match alternative.
  joplin: (req, cred) => {
    const raw = req.headers.authorization
    if ('string' === typeof raw && '' !== raw.trim()) {
      const m = /^(?:bearer|token)\s+(.+)$/i.exec(raw.trim())
      return (m ? m[1].trim() : raw.trim()) === cred
    }
    const q = req.query && req.query.token
    const tok = Array.isArray(q) ? q[q.length - 1] : q
    return null != tok && String(tok) === cred
  },

  // `authorization: Bearer <apikey>`, and the header is DELETED (not blanked)
  // when the apikey is empty, so absent is a distinct, real case.
  obsidian: (req, cred) => bearer(req) === cred,
  notion: (req, cred) => bearer(req) === cred,
  linear: (req, cred) => bearer(req) === cred
}


function bearer (req) {
  const raw = req.headers.authorization
  if ('string' !== typeof raw) return null
  const m = /^(\S+)\s+(.*)$/.exec(raw.trim())
  if (null == m || 'bearer' !== m[1].toLowerCase()) return null
  return m[2]
}


function sourceOf (url) {
  const path = String(url || '').split('?')[0]
  for (const src of SOURCES) {
    if (path === src.prefix || path.startsWith(src.prefix + '/')) return src
  }
  return null
}


/* Build the app.
 *
 *   buildServer()                 // fresh store, seeds from fixtures/
 *   buildServer({ store })        // supply your own (makeStore()) store
 *   buildServer({ logger: true }) // Fastify logging
 *   buildServer({ sources: ['joplin'] })  // mount a subset
 *
 * The returned app carries `app.store` so an in-process test can read state
 * and `app.likeness` with the mounted source descriptors.
 */
export async function buildServer (opts = {}) {
  const store = opts.store || makeStore(opts)

  const app = Fastify({
    logger: opts.logger || false,
    // The obsidian definition's paths carry a trailing '/' that the SDK's
    // join() strips, so /tags and /tags/ must both route.
    routerOptions: { ignoreTrailingSlash: true },
    // GraphQL documents are large-ish and the obsidian PUT carries a whole
    // note; the default 1MB is plenty but be explicit.
    bodyLimit: 4 * 1024 * 1024
  })

  const want = opts.sources || SOURCES.map(s => s.name)
  const mounted = SOURCES.filter(s => want.includes(s.name))

  // -- the request ring -----------------------------------------------------
  // Registered on the ROOT instance before any source, so it applies to every
  // child scope. onResponse fires even when a plugin's own onRequest auth hook
  // short-circuits with a 401, which is exactly the case worth recording.
  app.addHook('onResponse', async (req, reply) => {
    const src = sourceOf(req.url)
    if (null == src) return

    let auth = 'bad'
    try {
      auth = AUTHCHECK[src.name](req, src.credential) ? 'ok' : 'bad'
    }
    catch (err) {
      auth = 'bad'
    }

    store.requests.push({
      source: src.name,
      method: req.method,
      url: req.url,
      auth,
      status: reply.statusCode
    })

    // A ring, not a log: a long soak must not grow without bound.
    while (store.requestMax < store.requests.length) store.requests.shift()
  })

  // -- control plane --------------------------------------------------------
  // Mounted at the root, outside every source prefix, and never authenticated:
  // a test harness has to be able to reset a mock it cannot log in to.
  app.get('/__health', async () => ({
    ok: true,
    port: app.server && app.server.address() ? app.server.address().port : null,
    clock: {
      start: store.clockStart,
      startISO: new Date(store.clockStart).toISOString(),
      step: store.clockStep,
      tick: store.clockTick
    },
    seedsMissing: store.seedsMissing,
    sources: mounted.map(s => ({
      name: s.name,
      prefix: s.prefix,
      slug: s.slug,
      namespace: s.namespace,
      protocol: s.protocol,
      auth: s.authHeader,
      seeded: null != store.seeds[s.name]
    }))
  }))

  app.post('/__reset', async () => {
    const out = resetStore(store)
    return { ok: true, ...out }
  })

  // The ring answers the question a status code cannot: WHICH calls the SDK
  // actually made, in order, and whether each one carried a good credential.
  app.get('/__requests', async (req) => {
    const q = req.query || {}
    let out = store.requests
    if (null != q.source) out = out.filter(r => r.source === q.source)
    return out
  })

  app.delete('/__requests', async () => {
    store.requests.length = 0
    return { ok: true }
  })

  // -- the sources ----------------------------------------------------------
  // Each plugin gets the SHARED store and the SHARED clock, and its OWN seed.
  // The seed is passed explicitly rather than left to each plugin's co-located
  // fallback, so what /__health reports and what the routes serve cannot drift.
  for (const src of mounted) {
    await app.register(PLUGIN[src.name], {
      prefix: src.prefix,
      store,
      clock: store.clock,
      seed: store.seeds[src.name] || undefined
    })
  }

  // Decorators must be added before ready().
  app.decorate('store', store)
  app.decorate('likeness', { sources: mounted })

  // Seeding happens during registration, so the snapshot the reset route
  // restores from can only be taken once every plugin is in place.
  await app.ready()
  snapshotStore(store)

  return app
}


// -- runnable ---------------------------------------------------------------

const RUN_DIRECTLY = import.meta.url === `file://${process.argv[1]}`

if (RUN_DIRECTLY) {
  const port = Number(process.env.LIKENESS_MOCK_PORT || DEFAULT_PORT)
  const host = process.env.LIKENESS_MOCK_HOST || '127.0.0.1'

  const app = await buildServer({ logger: !!process.env.LIKENESS_MOCK_LOG })

  try {
    await app.listen({ port, host })
    const at = `http://${host}:${port}`
    process.stdout.write(`likeness mock listening on ${at}\n`)
    for (const src of app.likeness.sources) {
      process.stdout.write(`  ${at}${src.prefix.padEnd(10)} ${src.slug}\n`)
    }
    process.stdout.write(`  ${at}/__health  ${at}/__reset  ${at}/__requests\n`)
  }
  catch (err) {
    process.stderr.write(String(err && err.stack || err) + '\n')
    process.exit(1)
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { app.close().then(() => process.exit(0)) })
  }
}
