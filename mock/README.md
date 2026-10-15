# likeness mock server

One Fastify process, one port, every likeness source mounted behind its own
prefix. Each source is emulated **as the generated SDK actually speaks it**, not
as its OpenAPI/SDL definition or the upstream vendor would like it spoken —
where the two disagree, the mock satisfies the code, because the code is what
talks to it. The per-source plugins in `sources/` record every such divergence
in their own header comments.

## Run

```sh
cd mock
npm install
npm start                          # http://127.0.0.1:7777
LIKENESS_MOCK_PORT=8123 npm start  # somewhere else
LIKENESS_MOCK_PORT=0 npm start     # any free port; the bound one is printed
LIKENESS_MOCK_LOG=1 npm run dev    # with Fastify request logging
```

In-process, which is what a test suite should do (port `0` picks a free one, so
parallel suites never collide):

```js
import { buildServer } from './mock/server.js'

const app = await buildServer()
await app.listen({ port: 0, host: '127.0.0.1' })
const port = app.server.address().port

// ... drive the SDKs at http://127.0.0.1:${port}/<prefix> ...

await app.close()
```

`buildServer(opts)` takes `{ store, logger, sources, clockStart, clockStep, https, credentials }`.
`sources` mounts a subset (`{ sources: ['joplin'] }`). `https` (`{ key, cert }`)
serves TLS with that certificate instead of plain HTTP, which is how a suite
reaches the Obsidian plugin's HTTPS port with a certificate it pins.
`credentials` (`{ joplin: 'tok' }`) makes a source accept that token in place of
its seed's, and the request ring judges `auth` against it: that is how
`make matrix` sends tokens it made for the run, Joplin's holding characters a
query must percent-encode. The app is decorated with `app.store` and
`app.likeness.sources`.

## Sources

| prefix | source | protocol | credential | wire auth |
|---|---|---|---|---|
| `/joplin` | `joplin-notes-folders-tags` | HTTP/REST | `joplin-mock-token` | `Authorization: <apikey>` — **no scheme prefix** |
| `/obsidian` | `obsidian-vault-only` | HTTP/REST | `obsidian-local-rest-api-key-0001` | `authorization: Bearer <apikey>` |
| `/notion` | `notion-pages-databases-only` | HTTP/REST | `secret_TOKEN` | `authorization: Bearer <apikey>` |
| `/linear` | `linear-issues-only.graphql` | GraphQL, POST only | `lin_api_LiKeNeSs0MockKey0000000000000000` | `authorization: Bearer <apikey>` |

Point an SDK at `http://127.0.0.1:7777/<prefix>` as its `base`:

```js
const client = new JoplinSDK({ apikey: 'joplin-mock-token', base: 'http://127.0.0.1:7777/joplin' })
```

Two prefix notes worth knowing:

- **notion** serves every route bare *and* under `/v1`, because the definition's
  server is `https://api.notion.com/v1` and the SDK's `base` may or may not
  carry the `/v1` itself. Both `/notion` and `/notion/v1` work.
- **linear** answers on `/linear` and `/linear/graphql`, and answers `405` with a
  GraphQL error envelope to any method but POST.

Credentials are not invented here — each one is read out of that source's
`fixtures/sources/<slug>/seed.json` and is restated in `store.js` only so that
`/__health` and a test harness agree with the seed. A caller's `credentials`
replace them for the server it builds.

## Control plane

Mounted at the root, outside every source prefix, and **never authenticated** —
a harness has to be able to reset a mock it cannot log in to.

### `GET /__health`

```json
{ "ok": true, "port": 7777,
  "clock": { "start": 1767225600000, "startISO": "2026-01-01T00:00:00.000Z", "step": 1000, "tick": 11 },
  "seedsMissing": [],
  "sources": [ { "name": "joplin", "prefix": "/joplin", "slug": "...", "namespace": "...",
                 "protocol": "http", "auth": "...", "seeded": true } ] }
```

`seedsMissing` is non-empty when a `fixtures/sources/<slug>/seed.json` failed to
load. Each plugin carries a built-in fallback seed, so the mock still serves —
which is exactly why the failure is reported rather than left to be discovered
as a mysteriously empty list.

### `POST /__reset`

Puts every source back to its seeded state, rewinds the fake clock to tick 0,
and clears the request ring.

```json
{ "ok": true, "namespaces": ["joplin-notes-folders-tags", "obsidian", "notion", "linear-issues-only.graphql"] }
```

Three of the four plugins resolve their state **once, at registration time**, and
hold it in a route closure. `delete store[ns]` therefore resets nothing: the
routes keep serving the object they captured. So `resetStore()` mutates each
captured object **in place**, refilling it from a deep copy taken right after
seeding. See the header of `store.js`.

### `GET /__requests`

The request ring — what a test asserts against when it needs to know *which*
calls were made, in order, not merely that the end state looks right.

```json
[ { "source": "obsidian", "method": "GET", "url": "/obsidian/vault/welcome.md",
    "auth": "ok", "status": 200,
    "headers": { "accept": "application/vnd.olrapi.note+json", "accept-encoding": "gzip, deflate",
                 "accept-language": "*", "connection": "keep-alive", "content-type": "application/json",
                 "host": "127.0.0.1:7777", "sec-fetch-mode": "cors",
                 "user-agent": "Mozilla/5.0 (compatible; ObsidianSDK/1.0)" } } ]
```

- `?source=joplin` filters to one source.
- `DELETE /__requests` clears it without reseeding.
- It is a **ring**, capped at 500 rows (`makeStore({ requestMax })`); a long soak
  cannot grow it without bound.
- `headers` are the request's own, lowercased and sorted, **without
  `authorization` and `cookie`**: whether the credential was right is `auth`,
  and its value is never recorded.
- `auth` is `'ok' | 'bad'`, computed by mirroring each source's own credential
  rule. It is *not* redundant with `status`: **Linear answers HTTP 200 to a bad
  credential**, with the failure in the GraphQL `errors` array, so `status` alone
  cannot tell an authenticated call from a rejected one.
- `graphql`, on a Linear row, is `{ operation, root }`: the operation the
  document names, and the root fields it selects. The mock dispatches on the
  name, so a document named `IssueLoad` that selects `attachmentIssue` is answered
  as a load; only `root` shows which field the client asked for. A body with no
  document records `null`.

## Determinism

There is no `Date.now()` and no `Math.random()` anywhere in the mock. Ids come
from per-source counters on the shared store; time comes from a single
`store.clock()` shared by all four plugins, which returns epoch milliseconds
starting at **2026-01-01T00:00:00.000Z** and advancing 1000 ms per call. The Nth
clock call of a run always returns the same instant, so two runs of the same
sequence produce byte-identical records. `clock()` returns a number because that
is the one form all four plugins accept — obsidian *requires* ms or a `Date` and
throws on a string.

The clock is shared, so its tick reflects every source's calls, and it is already
past 0 when the first request arrives (the plugins draw timestamps while seeding).
Assert on *relative* ordering of timestamps, not on absolute values.

## Operations

### `/joplin` — joplin-notes-folders-tags (18 ops)

| SDK call | method | path |
|---|---|---|
| `Note().list()` | GET | `/notes` |
| `Note().create()` | POST | `/notes` |
| `Note().load()` | GET | `/notes/{id}` |
| `Note().update()` | PUT | `/notes/{id}` |
| `Note().remove()` | DELETE | `/notes/{id}` |
| — (`listNoteTags`) | GET | `/notes/{id}/tags` |
| `Folder().list()` | GET | `/folders` |
| `Folder().create()` | POST | `/folders` |
| `Folder().load()` | GET | `/folders/{id}` |
| `Folder().update()` | PUT | `/folders/{id}` |
| `Folder().remove()` | DELETE | `/folders/{id}` |
| — (`listFolderNotes`) | GET | `/folders/{id}/notes` |
| `Tag().list()` | GET | `/tags` |
| `Tag().create()` | POST | `/tags` |
| `Tag().load()` | GET | `/tags/{id}` |
| `Tag().update()` | PUT | `/tags/{id}` |
| `Tag().remove()` | DELETE | `/tags/{id}` |
| — (`listTagNotes`) | GET | `/tags/{id}/notes` |

Quirks the mock deliberately tolerates: the path param is duplicated into the
query (`GET /notes/n1?id=n1`); `$action` leaks as `%24action`; both `field` and
`fields` are honoured, and with neither present a list or a load answers Joplin's
own default of `id`, `parent_id` and `title` only. Every response carries a parseable JSON body — **including
DELETE and every error** — because `ResultBodyUtility` calls `response.json()`
whenever a body stream is present, and an empty body turns a clean
`request_status` error into a raw `SyntaxError`. Success is always `200`, never
`201`/`204`. Lists are `{items:[...], has_more:bool}`; a bare array would
silently yield an empty list.

**Seeded page size is 2** (`seed.config.pageSize`), and the generated client does
not follow the `x-next-page` / `Link: rel="next"` headers the mock emits. One
`list()` is one request, so `Note().list({})` returns **2 of the 5 seeded notes**.
Assert on the page, or raise `pageSize` in the seed.

### `/obsidian` — obsidian-vault-only

| SDK call | method | path | notes |
|---|---|---|---|
| `Tag().list()` | GET | `/tags` | `{"tags":[{name,count}]}`, counts from frontmatter + inline `#tags` |
| `Vault().list()` | GET | `/vault/` | `{"files":[...]}`, directories suffixed `/` |
| `Vault().load()` | GET | `/vault/{id}` | file point: NoteJson with all 8 required keys when `Accept` is exactly `application/vnd.olrapi.note+json`, else the file's Markdown, as the plugin negotiates |
| `Vault().load()` | GET | `/vault/{id}` | directory point: **discriminated only on the decoded id ending in `/`** |
| `Vault().create()` | POST | `/vault/{id}` | appends to an existing note, creates a missing one; `204`, empty body |
| `Vault().update()` | PUT | `/vault/{id}` | replaces the file, reparses frontmatter; `204`, empty body |
| `Vault().remove()` | DELETE | `/vault/{id}?permanent={true\|false}` | anything but `"true"` trashes rather than deletes |
| `client.direct()` | PATCH | `/vault/{id}` | full `PatchInstruction` support; not on the entity surface |

Path ids are `encodeURIComponent`-encoded **including slashes**, so
`load({id:'a/b.md'})` arrives as `/vault/a%2Fb.md`; the mock percent-decodes off
the raw URL, which also lets the un-encoded form work. `400` on `..` traversal or
malformed percent-encoding; `405` for a directory id on create/update/remove.

`copy` / `move` are **deliberately not implemented** — they are OpenAPI 3.2
`additionalOperations`, absent from the model and every generated client, and
outside `options.allow.method` even for `direct()`. Out of contract, not missing.

Auth failure (`401` + `{errorCode, message}`) is a recorded **mock decision**: the
definition declares no `401` or `403` anywhere.

### `/notion` — notion-pages-databases-only (6 ops)

| SDK call | method | path |
|---|---|---|
| `Page().create()` | POST | `/pages` (also `/v1/pages`) |
| `Page().load()` | GET | `/pages/{id}` |
| `Page().update()` | PATCH | `/pages/{id}` |
| `Database().create()` | POST | `/databases` |
| `Database().load()` | GET | `/databases/{id}` |
| `Database().update()` | PATCH | `/databases/{id}` |

Every request must carry a `Notion-Version` header, as the real API demands:
without one the mock answers `400` with code `missing_version`, and with a value
that is not a `YYYY-MM-DD` date, `400` with `validation_error`. The definition
declares no such header, so the generated client sends one only when its
options' `headers` name it — likeness pins it per connection in `station.json`.
The credential is checked first. The seeded pages carry the `url` every real
page object has.

Bodies arrive **pretty-printed** (`JSON.stringify(v, null, 2)`) and `PATCH`
carries `id` in the body even though the schema forbids it — the path id wins.
`update` echoes `created_time` **verbatim** when the caller sends it, because the
generated flows use it as a mutation marker. No route schemas are attached
anywhere, deliberately: `additionalProperties:false` would reject every PATCH and
a querystring schema would reject every GET.

The real API's ~3 req/sec rate limit is **off** by default — the SDK neither
rate-limits nor retries, so reproducing it would hard-fail the first caller.
A harness opts in via `state.ratelimit` / `state.force`.

### `/linear` — linear-issues-only.graphql (6 ops)

One endpoint, always `POST`, body exactly `{ query, variables }`.

| SDK call | GraphQL | variables | response shape |
|---|---|---|---|
| `Issue().load()` | `issue` | `{id}` | unwraps `data.issue` |
| `Issue().list()` | `issues` | `{first, after}` | `data.issues.edges`, Issue fields **at the edge top level** (never `.node`) |
| `Issue().create()` | `issueCreate` | `{input}` | `data.issueCreate.issue` |
| `Issue().update()` | `issueUpdate` | `{id, input}` | `id` is sent twice; every written key is echoed back |
| `Team().load()` | `team` | `{id}` | unwraps `data.team` |
| `Team().list()` | `teams` | `{first, after}` | `data.teams` as a **bare array** |

`PagingFeature` has no `connpath`, so it reads `pageInfo.*` from the **body root**;
the connection's `pageInfo` is mirrored there. `create`/`update` accept the
caller's whole entity payload as `$input` — unknown keys are fine and `teamId` is
not required.

Errors ride on **HTTP 200** with a non-empty top-level `errors` array; the machine
code lives in `extensions.code` / `extensions.type`, which `GraphqlUtility`
uppercases and substring-matches (`AUTH|FORBIDDEN|UNAUTHENTICATED` →
`request_auth`, `RATELIMIT|RATE_LIMIT|TOO_MANY` → `request_ratelimit`,
`BAD_USER_INPUT|VALIDATION|INVALID` → `request_invalid`, else `request_graphql`).
`seed.config.triggers` mints these on demand.

**`load()` of a missing entity does not throw.** `Query.issue` is nullable in the
SDL, so the mock correctly answers `{"data":{"issue":null}}` with no `errors`, and
the SDK resolves an entity whose `data()` is `{}`. The three REST sources throw a
`404` with `err.notFound === true`; the GraphQL one does not. Test for empty data,
not for a rejection.

## Layout

```
mock/
  server.js                 one Fastify app, the control plane, the request ring
  store.js                  seeds, the fake clock, snapshot/reset
  sources/<slug>.js         one Fastify plugin per source
fixtures/sources/<slug>/seed.json
```

A source plugin is a plain Fastify plugin, `routes(app, opts)`, taking
`{ store, clock, seed, apikey }`. Two things co-hosting forbids, which every
plugin therefore avoids and which are easy to reintroduce: `setNotFoundHandler`
is one-per-prefix, and a root-level content-type parser would leak across
sources. Both stay inside each plugin's own encapsulated scope.
