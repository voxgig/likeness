/* likeness mock: the shared, deterministic store.
 *
 * ONE process hosts every likeness source. Each source plugin is a Fastify
 * plugin that namespaces its own mutable state under `store[<namespace>]` and
 * takes every timestamp from `store.clock()`. Nothing in a source plugin calls
 * Date.now() or Math.random(), so a run is byte-reproducible.
 *
 *   import { makeStore, resetStore, SOURCES } from './store.js'
 *
 *   const store = makeStore()          // seeds loaded, clock at the epoch
 *   ... register the source plugins with { store, clock: store.clock, seed } ...
 *   snapshotStore(store)               // once, after registration
 *   resetStore(store)                  // back to the seeded state, any time
 *
 * WHY THE SNAPSHOT DANCE
 * Three of the four source plugins resolve their state ONCE, at registration
 * time, and hold it in a closure:
 *
 *   joplin    const S = ensure(opts)            // routes() body
 *   obsidian  if (store[NS] == null) ...; const st = store[NS]
 *   notion    const state = initState(opts)
 *   linear    ensureState(store, ...) per request, but gated on state.ready
 *
 * So `delete store[ns]` does NOT reset anything - the routes keep serving the
 * object they captured, and a rebuilt namespace is simply ignored. The only
 * reset that actually works on a running app is to MUTATE THE CAPTURED OBJECT
 * IN PLACE. snapshotStore() deep-copies each namespace right after seeding;
 * resetStore() empties the live object and refills it from that copy, so every
 * closure - and every arrow function the plugin hung off its own state, such
 * as obsidian's `st.nextId` - keeps working and sees seeded values again.
 */

import Fs from 'node:fs'
import Path from 'node:path'
import { fileURLToPath } from 'node:url'


const HERE = Path.dirname(fileURLToPath(import.meta.url))
const ROOT = Path.dirname(HERE)
const FIXTURES = Path.join(ROOT, 'fixtures', 'sources')


// The fixed epoch the fake clock starts from, and the step it advances by on
// every call. 2026-01-01T00:00:00.000Z. Deliberately NOT "now".
export const CLOCK_START = Date.parse('2026-01-01T00:00:00.000Z')
export const CLOCK_STEP = 1000


// The four sources this process hosts. `prefix` is the URL mount point,
// `slug` names both mock/sources/<slug>.js and fixtures/sources/<slug>/seed.json,
// `namespace` is the key the plugin owns on the store, and `credential` is the
// value its auth check accepts - all four read it out of their own seed, these
// are recorded here so /__health and the SDK drivers agree with the seed.
export const SOURCES = [
  {
    name: 'joplin',
    prefix: '/joplin',
    slug: 'joplin-notes-folders-tags',
    namespace: 'joplin-notes-folders-tags',
    protocol: 'http',
    // PrepareAuthUtility sends the RAW credential, with no scheme prefix.
    credential: 'joplin-mock-token',
    authHeader: 'Authorization: <apikey>'
  },
  {
    name: 'obsidian',
    prefix: '/obsidian',
    slug: 'obsidian-vault-only',
    namespace: 'obsidian',
    protocol: 'http',
    credential: 'obsidian-local-rest-api-key-0001',
    authHeader: 'authorization: Bearer <apikey>'
  },
  {
    name: 'notion',
    prefix: '/notion',
    slug: 'notion-pages-databases-only',
    namespace: 'notion',
    protocol: 'http',
    credential: 'secret_TOKEN',
    authHeader: 'authorization: Bearer <apikey>'
  },
  {
    name: 'linear',
    prefix: '/linear',
    slug: 'linear-issues-only.graphql',
    namespace: 'linear-issues-only.graphql',
    protocol: 'graphql',
    credential: 'lin_api_LiKeNeSs0MockKey0000000000000000',
    authHeader: 'authorization: Bearer <apikey>'
  }
]


export function seedPath (slug) {
  return Path.join(FIXTURES, slug, 'seed.json')
}


// Load every fixtures/sources/<slug>/seed.json. A missing seed is not fatal -
// each plugin carries a built-in fallback - but it IS reported, because a
// silently unseeded source is the kind of thing that makes a test lie.
export function loadSeeds () {
  const seeds = {}
  const missing = []
  for (const src of SOURCES) {
    const path = seedPath(src.slug)
    try {
      seeds[src.name] = JSON.parse(Fs.readFileSync(path, 'utf8'))
    }
    catch (err) {
      seeds[src.name] = null
      missing.push({ source: src.name, path, error: err.message })
    }
  }
  return { seeds, missing }
}


/* Create the shared store.
 *
 *   makeStore()                      // seeds from fixtures/, clock at CLOCK_START
 *   makeStore({ clockStart, clockStep })
 *   makeStore({ seeds: {...} })      // override one or more seeds outright
 *
 * The returned object is handed to every plugin as `opts.store`, and its
 * `clock` as `opts.clock`. clock() returns EPOCH MILLISECONDS - the one form
 * all four plugins accept (obsidian REQUIRES ms or a Date and throws on a
 * string; linear and notion additionally accept a Date or an ISO string).
 */
export function makeStore (opts = {}) {
  const loaded = loadSeeds()

  const store = {}

  // Non-enumerable bookkeeping: the plugins iterate nothing on the store, but
  // keeping our own fields off the namespace roll makes snapshot/reset exact.
  Object.defineProperties(store, {
    seeds: {
      value: { ...loaded.seeds, ...(opts.seeds || {}) },
      enumerable: false, writable: true
    },
    seedsMissing: { value: loaded.missing, enumerable: false, writable: true },
    clockStart: {
      value: null == opts.clockStart ? CLOCK_START : opts.clockStart,
      enumerable: false, writable: true
    },
    clockStep: {
      value: null == opts.clockStep ? CLOCK_STEP : opts.clockStep,
      enumerable: false, writable: true
    },
    clockTick: { value: 0, enumerable: false, writable: true },
    snapshots: { value: null, enumerable: false, writable: true },
    requests: { value: [], enumerable: false, writable: true },
    requestMax: {
      value: null == opts.requestMax ? 500 : opts.requestMax,
      enumerable: false, writable: true
    },
    clock: {
      // A fixed, ADVANCING fake time: every call returns the next tick, so two
      // records created in one request still get distinguishable timestamps,
      // and the Nth call of a run always returns the same instant.
      value: () => {
        const at = store.clockStart + (store.clockTick * store.clockStep)
        store.clockTick++
        return at
      },
      enumerable: false, writable: false
    }
  })

  return store
}


// Record the seeded state of every namespace the plugins created. Call ONCE,
// after all plugins are registered (they seed at registration time) and before
// any request is served.
export function snapshotStore (store) {
  const snapshots = {}
  for (const key of Object.keys(store)) {
    snapshots[key] = deepcopy(store[key])
  }
  store.snapshots = snapshots
  return store
}


/* Put every namespace back to its seeded state, and rewind the clock.
 *
 * Mutates each namespace object IN PLACE (see the header note) so the route
 * closures that captured it keep serving, and returns the list of namespaces
 * restored. Without a prior snapshotStore() this is a no-op and says so.
 */
export function resetStore (store) {
  store.clockTick = 0
  store.requests.length = 0

  if (null == store.snapshots) {
    return { ok: false, reason: 'no snapshot taken', namespaces: [] }
  }

  const namespaces = []

  for (const key of Object.keys(store.snapshots)) {
    const live = store[key]
    const seeded = deepcopy(store.snapshots[key])

    if (null == live || 'object' !== typeof live) {
      store[key] = seeded
    }
    else {
      restoreInPlace(live, seeded)
    }
    namespaces.push(key)
  }

  // A namespace created after the snapshot has no seeded form to go back to;
  // drop it rather than leave a half-reset source behind.
  for (const key of Object.keys(store)) {
    if (!(key in store.snapshots)) delete store[key]
  }

  return { ok: true, namespaces }
}


// Replace the contents of `live` with the contents of `seeded`, keeping the
// identity of `live`. Functions already on `live` (obsidian hangs `nextId`
// off its own state) are kept: they close over `live`, so they stay correct.
function restoreInPlace (live, seeded) {
  if (live instanceof Map) {
    live.clear()
    if (seeded instanceof Map) for (const [k, v] of seeded) live.set(k, v)
    return live
  }
  if (live instanceof Set) {
    live.clear()
    if (seeded instanceof Set) for (const v of seeded) live.add(v)
    return live
  }
  if (Array.isArray(live)) {
    live.length = 0
    if (Array.isArray(seeded)) for (const v of seeded) live.push(v)
    return live
  }

  for (const k of Object.keys(live)) {
    if ('function' === typeof live[k] && !(k in seeded)) continue
    delete live[k]
  }
  for (const k of Object.keys(seeded)) {
    const was = live[k]
    const now = seeded[k]
    // Nested containers are also restored in place where both sides are the
    // same kind, so a plugin that captured `state.note` directly still works.
    if (sameKind(was, now)) restoreInPlace(was, now)
    else live[k] = now
  }
  return live
}


function sameKind (a, b) {
  if (null == a || null == b) return false
  if ('object' !== typeof a || 'object' !== typeof b) return false
  if (a instanceof Map) return b instanceof Map
  if (a instanceof Set) return b instanceof Set
  if (Array.isArray(a)) return Array.isArray(b)
  if (a instanceof Date || b instanceof Date) return false
  return !(b instanceof Map) && !(b instanceof Set) && !Array.isArray(b)
}


// structuredClone throws on a function, and the source plugins do keep
// functions on their state, so clone by hand: containers are copied, functions
// are carried by reference, everything else is a value.
export function deepcopy (val) {
  if (null == val) return val
  if ('function' === typeof val) return val
  if ('object' !== typeof val) return val
  if (val instanceof Date) return new Date(val.getTime())
  if (val instanceof Map) {
    const out = new Map()
    for (const [k, v] of val) out.set(k, deepcopy(v))
    return out
  }
  if (val instanceof Set) {
    const out = new Set()
    for (const v of val) out.add(deepcopy(v))
    return out
  }
  if (Array.isArray(val)) return val.map(deepcopy)

  const out = {}
  for (const k of Object.keys(val)) out[k] = deepcopy(val[k])
  return out
}
