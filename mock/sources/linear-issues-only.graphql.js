/* Local mock for the Linear "issues only" GraphQL SDK source.
 *
 * SOURCE (verbatim key, see SOURCE below):
 *   GraphQL SDL at .../srcsdk/linear-sdk/.sdk/def/linear-issues-only.graphql
 *   (types Issue/Team/User/WorkflowState/PageInfo/IssueEdge/IssueConnection/IssuePayload,
 *    inputs IssueCreateInput/IssueUpdateInput, Query issue/issues/team/teams,
 *    Mutation issueCreate/issueUpdate)
 *
 * Everything below is derived from the resolved model
 * (.sdk/model/entity/issue.aon, team.aon: graphql.doc / method / transform.res / graphql.page)
 * and from the generated TypeScript client under ts/src/ - NOT from the public Linear API.
 *
 * Wire contract emulated here:
 *   - ONE endpoint, always POST, for all six operations (load/list/create/update).
 *     options.base already contains the path; MakeSpecUtility forces spec.path = ''
 *     and spec.query = {}, so the URL is the base verbatim and no query string exists.
 *   - Body is exactly { query, variables }, pretty printed (JSON.stringify(body, null, 2)).
 *     No operationName, no extensions, no batching, no GET, no multipart.
 *   - Auth: header `authorization: Bearer <apikey>`; header is simply absent when the
 *     apikey is empty (PrepareAuthUtility deletes it) - so "missing" is a real case.
 *   - Errors: HTTP 200 + non-empty top level `errors` array; the machine code lives in
 *     extensions.code or extensions.type (GraphqlUtility.graphqlErrorCode uppercases and
 *     substring matches: AUTH|FORBIDDEN|UNAUTHENTICATED -> request_auth,
 *     RATELIMIT|RATE_LIMIT|TOO_MANY -> request_ratelimit,
 *     BAD_USER_INPUT|VALIDATION|INVALID -> request_invalid, else request_graphql).
 *   - issue.list unwraps body.data.issues.edges and uses each EDGE verbatim as entity data
 *     (it never reads .node), so edges carry the Issue fields at their own top level.
 *   - team.list unwraps body.data.teams and needs a BARE ARRAY (Query.teams is [Team!]!).
 *   - PagingFeature has no connpath, so it reads body.pageInfo.* from the BODY ROOT;
 *     the connection pageInfo is therefore mirrored at the root of the JSON body.
 *   - create/update send the caller's whole ENTITY payload as $input, not an
 *     IssueCreateInput/IssueUpdateInput: unknown keys are accepted and teamId is not
 *     required; update sends `id` twice ($id and input.id) and must echo written fields.
 *
 * All state lives on opts.store (one process hosts several sources, tests reset between
 * runs). Ids come from counters on the store, timestamps from opts.clock(). No Date.now,
 * no Math.random anywhere.
 */

import Fs from 'node:fs'
import Path from 'node:path'
import { fileURLToPath } from 'node:url'


// The full source string this mock stands in for. The real source name contains '/'
// characters and is 1228 bytes long, so it cannot be a filesystem path on darwin
// (PATH_MAX 1024); it is carried here instead, and in seed.json's "source" field.
export const SOURCE =
  "GraphQL SDL at /tmp/claude-501/-Users-richard-Projects-voxgig-sdk-univec-sdk/" +
  "2add9a16-da95-4678-b615-c71b996816d9/scratchpad/srcsdk/linear-sdk/.sdk/def/" +
  "linear-issues-only.graphql (types Issue/Team/User/WorkflowState/PageInfo/IssueEdge/" +
  "IssueConnection/IssuePayload, inputs IssueCreateInput/IssueUpdateInput, " +
  "Query issue/issues/team/teams, Mutation issueCreate/issueUpdate); resolved " +
  "per-operation truth in .sdk/model/entity/issue.aon and .sdk/model/entity/team.aon " +
  "(graphql.doc / method / transform.res / graphql.page); wire behaviour verified in the " +
  "generated TypeScript client under ts/src/"

export const NAMESPACE = 'linear-issues-only.graphql'


// The byte exact documents the generated client sends (Config.ts per-op graphql docs).
// The fragment is inline in the same string - there is no separate fragment document.
const ISSUE_FIELDS =
  'fragment IssueFields on Issue { archivedAt assignee { id } branchName canceledAt ' +
  'completedAt createdAt creator { id } description dueDate estimate id identifier ' +
  'number priority state { id } team { id } title updatedAt url }'

const TEAM_FIELDS = 'fragment TeamFields on Team { description id key name }'

export const DOCS = {
  IssueLoad:
    'query IssueLoad($id: String!) { issue(id: $id) { ...IssueFields } } ' + ISSUE_FIELDS,
  IssueList:
    'query IssueList($first: Int, $after: String) { issues(first: $first, after: $after) ' +
    '{ edges { node { ...IssueFields } } pageInfo { endCursor hasNextPage } } } ' +
    ISSUE_FIELDS,
  IssueCreate:
    'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) ' +
    '{ issue { ...IssueFields } success } } ' + ISSUE_FIELDS,
  IssueUpdate:
    'mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) ' +
    '{ issueUpdate(id: $id, input: $input) { issue { ...IssueFields } success } } ' +
    ISSUE_FIELDS,
  TeamLoad:
    'query TeamLoad($id: String!) { team(id: $id) { ...TeamFields } } ' + TEAM_FIELDS,
  TeamList:
    'query TeamList($first: Int, $after: String) { teams(first: $first, after: $after) ' +
    '{ ...TeamFields } } ' + TEAM_FIELDS,
}


const DEFAULT_CONFIG = {
  // Accepted bearer tokens. Empty array => any non-empty bearer token is accepted.
  apikeys: [],
  appBase: 'https://linear.app/likeness-mock',
  defaultPageSize: 50,
  maxPageSize: 250,
  // The model emits no page.connpath, so PagingFeature reads body.pageInfo.* from the
  // body ROOT. Mirroring the connection pageInfo there is what makes paging advance.
  mirrorRootPageInfo: true,
  // id -> forced graphql error, for exercising the error code mapping.
  triggers: {},
}


export default async function routes (app, opts) {
  const store = (opts && opts.store) || {}
  const clock = makeClock(opts && opts.clock)

  // Build eagerly so a mounted-but-unused mock still has inspectable state.
  ensureState(store, opts, clock)

  const handler = async function (req, reply) {
    const state = ensureState(store, opts, clock)
    return handleGraphql(state, req, reply)
  }

  // options.base carries the path, so the mock is addressed as
  // base: 'http://127.0.0.1:PORT/graphql'. '/' is registered too so the plugin also
  // works when the harness mounts it under a per-source prefix.
  app.post('/graphql', handler)
  app.post('/', handler)

  // The client never uses GET (no query-string GraphQL); answer honestly if something does.
  const reject = async function (req, reply) {
    return reply.code(405).type('application/json').send({
      data: null,
      errors: [{
        message: 'GraphQL over ' + req.method + ' is not supported; POST { query, variables }',
        locations: [{ line: 1, column: 1 }],
        extensions: { code: 'METHOD_NOT_SUPPORTED', type: 'METHOD_NOT_SUPPORTED' },
      }],
    })
  }
  app.get('/graphql', reject)
  app.get('/', reject)
}


// ---------------------------------------------------------------- state

function ensureState (store, opts, clock) {
  let state = store[NAMESPACE]
  if (null != state && state.ready) {
    return state
  }

  const seed = loadSeed(opts)
  const config = Object.assign({}, DEFAULT_CONFIG, seed.config || {})

  state = {
    ready: true,
    source: SOURCE,
    config,
    clock,
    seq: 0,
    counter: { issue: 0, team: 0 },
    users: (seed.users || []).map(clone),
    workflowStates: (seed.workflowStates || []).map(clone),
    teams: (seed.teams || []).map(clone),
    issues: (seed.issues || []).map(clone),
    // Every request is recorded so tests can assert on the exact wire bytes.
    requests: [],
  }

  // Per-team issue number sequences continue past the seeded issues.
  for (const team of state.teams) {
    const used = state.issues
      .filter((iss) => refid(iss.team) === team.id)
      .map((iss) => Number(iss.number) || 0)
    team.nextNumber = (used.length ? Math.max(...used) : 0) + 1
  }

  store[NAMESPACE] = state
  return state
}


function loadSeed (opts) {
  if (opts && opts.seed && 'object' === typeof opts.seed) {
    return opts.seed
  }

  const paths = []
  if (opts && 'string' === typeof opts.seedPath) {
    paths.push(opts.seedPath)
  }

  // mock/sources/<name>.js  ->  fixtures/sources/<name>/seed.json
  try {
    const self = fileURLToPath(import.meta.url)
    const dir = Path.dirname(self)
    const name = Path.basename(self).replace(/\.js$/, '')
    const root = dir.replace(/[/\\]mock[/\\]sources$/, '')
    paths.push(Path.join(root, 'fixtures', 'sources', name, 'seed.json'))
  }
  catch (err) {
    // fall through to the built in seed
  }

  for (const path of paths) {
    try {
      if (Fs.existsSync(path)) {
        return JSON.parse(Fs.readFileSync(path, 'utf8'))
      }
    }
    catch (err) {
      // ignore an unreadable or malformed seed; the built in seed keeps the mock usable
    }
  }

  return BUILTIN_SEED
}


// A minimal fallback so the plugin still serves if seed.json is missing.
const BUILTIN_SEED = {
  config: { apikeys: [] },
  users: [{ id: 'usr-0000-mock', name: 'Mock User' }],
  workflowStates: [{ id: 'sta-0000-todo', name: 'Todo' }],
  teams: [{ id: 'tea-0000-eng', key: 'ENG', name: 'Engineering', description: null }],
  issues: [],
}


// ---------------------------------------------------------------- request

async function handleGraphql (state, req, reply) {
  const seq = ++state.seq
  const body = req.body
  const log = {
    seq,
    method: req.method,
    url: req.url,
    contentType: req.headers['content-type'] || null,
    hasAuth: null != req.headers['authorization'],
    op: null,
    docExact: null,
    variables: null,
    outcome: null,
  }
  state.requests.push(log)

  // --- auth: `authorization: Bearer <apikey>`; the header is absent, never empty,
  // when the SDK has no apikey (PrepareAuthUtility deletes it).
  const authz = req.headers['authorization']
  if (null == authz || '' === String(authz).trim()) {
    log.outcome = 'no-credential'
    return fail(reply, 'Authentication required, not authenticated',
      'UNAUTHENTICATED', 'AUTHENTICATION_ERROR')
  }
  const bearer = /^bearer\s+(\S+)$/i.exec(String(authz).trim())
  if (null == bearer) {
    // A bare token (no `Bearer ` prefix) is NOT accepted: the generator's default
    // prefix is 'Bearer' and that is what goes on the wire.
    log.outcome = 'bad-scheme'
    return fail(reply, 'Authentication required, not authenticated',
      'UNAUTHENTICATED', 'AUTHENTICATION_ERROR')
  }
  const apikey = bearer[1]
  const known = state.config.apikeys || []
  if (0 < known.length && !known.includes(apikey)) {
    log.outcome = 'bad-credential'
    return fail(reply, 'Authentication required, not authenticated',
      'UNAUTHENTICATED', 'AUTHENTICATION_ERROR')
  }

  // --- body: only { query, variables } is ever sent; never an array (no batching).
  if (Array.isArray(body)) {
    log.outcome = 'batched'
    return fail(reply, 'Batched GraphQL requests are not supported',
      'GRAPHQL_PARSE_FAILED', 'PARSE_ERROR')
  }
  if (null == body || 'object' !== typeof body || 'string' !== typeof body.query) {
    log.outcome = 'no-query'
    return fail(reply, 'Must provide query string', 'GRAPHQL_PARSE_FAILED', 'PARSE_ERROR')
  }

  const doc = body.query
  const vars = (null != body.variables && 'object' === typeof body.variables &&
    !Array.isArray(body.variables)) ? body.variables : {}
  log.variables = clone(vars)

  const op = operationOf(doc)
  log.op = op
  log.docExact = (null != op && DOCS[op] === doc)

  if (null == op) {
    log.outcome = 'unknown-operation'
    return fail(reply, 'Cannot query field on type "Query"',
      'GRAPHQL_VALIDATION_FAILED', 'VALIDATION')
  }

  switch (op) {
    case 'IssueLoad': return opIssueLoad(state, log, vars, reply)
    case 'IssueList': return opIssueList(state, log, vars, reply)
    case 'IssueCreate': return opIssueCreate(state, log, vars, reply)
    case 'IssueUpdate': return opIssueUpdate(state, log, vars, reply)
    case 'TeamLoad': return opTeamLoad(state, log, vars, reply)
    case 'TeamList': return opTeamList(state, log, vars, reply)
  }
}


// Dispatch is on the GraphQL operation name (the documents are byte exact, but a mock
// must not depend on that); the root field is a fallback for hand written probes.
function operationOf (doc) {
  const named = /(?:^|\s)(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(doc)
  if (null != named && null != DOCS[named[1]]) {
    return named[1]
  }

  const mutation = /(?:^|\s)mutation\b/.test(doc)
  if (mutation) {
    if (/\bissueCreate\s*\(/.test(doc)) return 'IssueCreate'
    if (/\bissueUpdate\s*\(/.test(doc)) return 'IssueUpdate'
    return null
  }
  if (/\bissues\s*\(/.test(doc)) return 'IssueList'
  if (/\bissue\s*\(/.test(doc)) return 'IssueLoad'
  if (/\bteams\s*\(/.test(doc)) return 'TeamList'
  if (/\bteam\s*\(/.test(doc)) return 'TeamLoad'

  return null
}


// ---------------------------------------------------------------- operations

// issue.load: transform.res = body.data.issue. A missing $id is a real validation
// failure (the SDK sends variables {} when the caller passes no id); an unknown id is
// NOT an error - Query.issue is nullable and the SDK treats null as ok.
function opIssueLoad (state, log, vars, reply) {
  const id = vars.id
  if (null == id || '' === id) {
    log.outcome = 'missing-variable'
    return fail(reply, 'Variable "$id" of required type "String!" was not provided.',
      'BAD_USER_INPUT', 'VALIDATION', ['issue'])
  }

  const forced = state.config.triggers[id]
  if (null != forced) {
    log.outcome = 'trigger'
    return fail(reply, forced.message || 'forced error', forced.code, forced.type,
      ['issue'], forced.status)
  }

  const rec = state.issues.find((iss) => iss.id === id)
  log.outcome = null == rec ? 'null-result' : 'ok'
  return ok(reply, { issue: null == rec ? null : issueOut(rec) })
}


// issue.list: transform.res = body.data.issues.edges, and each EDGE is used verbatim as
// one entity's data - the SDK never reads .node. So the edges carry the Issue fields at
// their own top level, with node (schema faithful) and cursor alongside.
function opIssueList (state, log, vars, reply) {
  const all = state.issues
  let start = 0

  if (null != vars.after && '' !== vars.after) {
    const afterId = decodeCursor(String(vars.after))
    const at = all.findIndex((iss) => iss.id === afterId)
    if (-1 === at) {
      log.outcome = 'bad-cursor'
      return fail(reply, 'Invalid cursor: ' + vars.after, 'BAD_USER_INPUT', 'VALIDATION',
        ['issues'])
    }
    start = at + 1
  }

  // Variable types are NOT coerced by the SDK: `first` arrives as a string from the
  // generated direct-call tests, so coerce leniently instead of rejecting.
  const first = pageSize(vars.first, state.config)
  const page = all.slice(start, start + first)
  const hasNextPage = start + first < all.length
  const endCursor = 0 < page.length ? encodeCursor(page[page.length - 1].id) : null
  const pageInfo = { endCursor, hasNextPage }

  const edges = page.map((rec) => {
    const fields = issueOut(rec)
    // Issue fields at the top level (what the SDK actually keeps), plus the schema
    // faithful node, plus the relay cursor.
    return Object.assign({}, fields, { node: issueOut(rec), cursor: encodeCursor(rec.id) })
  })

  const data = { issues: { edges, pageInfo } }
  const body = { data }

  // PagingFeature resolves cursor/more against the BODY ROOT (no connpath in the model).
  if (state.config.mirrorRootPageInfo) {
    body.pageInfo = { endCursor, hasNextPage }
  }

  log.outcome = 'ok'
  log.page = { start, first, count: edges.length, hasNextPage }
  return reply.code(200).type('application/json').send(body)
}


// issue.create: op.input = 'data', so $input is the caller's WHOLE entity payload
// (IssueCreateData is the entity shape). Unknown keys are accepted and teamId is not
// required - validating against IssueCreateInput would reject every generated create.
function opIssueCreate (state, log, vars, reply) {
  const input = inputOf(vars.input)
  if (null == input) {
    log.outcome = 'missing-variable'
    return fail(reply, 'Variable "$input" of required type "IssueCreateInput!" was not provided.',
      'BAD_USER_INPUT', 'VALIDATION', ['issueCreate'])
  }

  const n = ++state.counter.issue
  const teamId = refid(input.team) || input.teamId || defaultTeamId(state)
  const team = state.teams.find((t) => t.id === teamId)
  const key = null != team ? team.key : 'MOCK'
  const number = null != input.number ? input.number :
    (null != team ? team.nextNumber++ : n)
  const identifier = null != input.identifier ? input.identifier : (key + '-' + number)
  const title = null != input.title ? input.title : 'Untitled issue'
  const now = state.clock()

  const rec = {
    archivedAt: null,
    assignee: null,
    branchName: identifier.toLowerCase() + '-' + slug(title),
    canceledAt: null,
    completedAt: null,
    createdAt: now,
    creator: ref(state.config.viewerId || defaultUserId(state)),
    description: null,
    dueDate: null,
    estimate: null,
    id: mockid('iss', n),
    identifier,
    number,
    priority: 0,
    state: ref(input.stateId || refid(input.state) || defaultStateId(state)),
    team: ref(teamId),
    title,
    updatedAt: now,
    url: state.config.appBase + '/issue/' + identifier + '/' + slug(title),
  }

  // The caller's payload wins over every default, so whatever was written is echoed back.
  applyInput(rec, input)
  normaliseRefs(rec, input)

  state.issues.push(rec)
  log.outcome = 'ok'
  log.created = rec.id

  // IssuePayload.lastSyncId is not selected by the document, so it is not returned.
  return ok(reply, { issueCreate: { issue: issueOut(rec), success: true } })
}


// issue.update: $id AND input.id are both sent (the id goes on the wire twice). The
// record is addressed by $id; input.id is tolerated and ignored. Every input key is
// applied - including fields IssueUpdateInput does not declare (branchName, url, ...) -
// because the generated flow test asserts the written marker comes back.
function opIssueUpdate (state, log, vars, reply) {
  const id = vars.id
  if (null == id || '' === id) {
    log.outcome = 'missing-variable'
    return fail(reply, 'Variable "$id" of required type "String!" was not provided.',
      'BAD_USER_INPUT', 'VALIDATION', ['issueUpdate'])
  }

  const forced = state.config.triggers[id]
  if (null != forced) {
    log.outcome = 'trigger'
    return fail(reply, forced.message || 'forced error', forced.code, forced.type,
      ['issueUpdate'], forced.status)
  }

  const input = inputOf(vars.input)
  if (null == input) {
    log.outcome = 'missing-variable'
    return fail(reply, 'Variable "$input" of required type "IssueUpdateInput!" was not provided.',
      'BAD_USER_INPUT', 'VALIDATION', ['issueUpdate'])
  }

  const rec = state.issues.find((iss) => iss.id === id)
  if (null == rec) {
    // A mutation on a missing record is a real error (unlike a null query result).
    log.outcome = 'not-found'
    return fail(reply, 'Entity not found: Issue - ' + id, 'NOT_FOUND', 'ENTITY_NOT_FOUND',
      ['issueUpdate'])
  }

  applyInput(rec, input)
  normaliseRefs(rec, input)
  rec.id = id
  if (null == input.updatedAt) {
    rec.updatedAt = state.clock()
  }

  log.outcome = 'ok'
  log.updated = rec.id
  return ok(reply, { issueUpdate: { issue: issueOut(rec), success: true } })
}


// team.load: transform.res = body.data.team; Query.team is nullable.
function opTeamLoad (state, log, vars, reply) {
  const id = vars.id
  if (null == id || '' === id) {
    log.outcome = 'missing-variable'
    return fail(reply, 'Variable "$id" of required type "String!" was not provided.',
      'BAD_USER_INPUT', 'VALIDATION', ['team'])
  }

  const forced = state.config.triggers[id]
  if (null != forced) {
    log.outcome = 'trigger'
    return fail(reply, forced.message || 'forced error', forced.code, forced.type,
      ['team'], forced.status)
  }

  const rec = state.teams.find((t) => t.id === id)
  log.outcome = null == rec ? 'null-result' : 'ok'
  return ok(reply, { team: null == rec ? null : teamOut(rec) })
}


// team.list: transform.res = body.data.teams and Query.teams is [Team!]! - a BARE ARRAY.
// Returning a connection here would silently yield zero entities. There is no page block
// on this point and no PageInfo in the schema, so no cursor signal is produced.
function opTeamList (state, log, vars, reply) {
  const all = state.teams
  let start = 0

  // `after` has no cursor source for teams (no PageInfo anywhere), so it is tolerated
  // and only honoured when it happens to name a known team.
  if (null != vars.after && '' !== vars.after) {
    const afterId = decodeCursor(String(vars.after))
    const at = all.findIndex((t) => t.id === afterId)
    start = -1 === at ? 0 : at + 1
  }

  const first = pageSize(vars.first, state.config)
  const page = all.slice(start, start + first)

  log.outcome = 'ok'
  return ok(reply, { teams: page.map(teamOut) })
}


// ---------------------------------------------------------------- shapes

// Exactly the fields the IssueFields fragment selects, in fragment order. Nested
// objects are selected as { id } only.
function issueOut (rec) {
  return {
    archivedAt: undef(rec.archivedAt),
    assignee: ref(refid(rec.assignee)),
    branchName: undef(rec.branchName),
    canceledAt: undef(rec.canceledAt),
    completedAt: undef(rec.completedAt),
    createdAt: undef(rec.createdAt),
    creator: ref(refid(rec.creator)),
    description: undef(rec.description),
    dueDate: undef(rec.dueDate),
    estimate: undef(rec.estimate),
    id: rec.id,
    identifier: undef(rec.identifier),
    number: undef(rec.number),
    priority: undef(rec.priority),
    state: ref(refid(rec.state)),
    team: ref(refid(rec.team)),
    title: undef(rec.title),
    updatedAt: undef(rec.updatedAt),
    url: undef(rec.url),
  }
}


// Exactly the fields the TeamFields fragment selects, in fragment order.
function teamOut (rec) {
  return {
    description: undef(rec.description),
    id: rec.id,
    key: undef(rec.key),
    name: undef(rec.name),
  }
}


function ok (reply, data) {
  return reply.code(200).type('application/json').send({ data })
}


// The only error shape the SDK can read: HTTP 200 (unless a status is forced) with a
// non-empty top level errors array carrying extensions.code / extensions.type.
function fail (reply, message, code, type, path, status) {
  const extensions = {}
  if (null != code) extensions.code = code
  if (null != type) extensions.type = type

  const error = {
    message,
    locations: [{ line: 1, column: 1 }],
    extensions,
  }
  if (null != path) error.path = path

  return reply.code(status || 200).type('application/json').send({ data: null, errors: [error] })
}


// ---------------------------------------------------------------- helpers

function applyInput (rec, input) {
  for (const key of Object.keys(input)) {
    // $action and any other SDK-internal marker never belongs on the record.
    if ('$' === key[0]) continue
    if ('id' === key) continue
    if (undefined === input[key]) continue
    rec[key] = clone(input[key])
  }
}


// IssueCreateInput/IssueUpdateInput style scalars (teamId/stateId/assigneeId) are
// accepted alongside the entity style objects the SDK actually sends.
function normaliseRefs (rec, input) {
  if (null != input.teamId) rec.team = ref(input.teamId)
  if (null != input.stateId) rec.state = ref(input.stateId)
  if (null != input.assigneeId) rec.assignee = ref(input.assigneeId)
  rec.team = ref(refid(rec.team))
  rec.state = ref(refid(rec.state))
  rec.assignee = ref(refid(rec.assignee))
  rec.creator = ref(refid(rec.creator))
}


function inputOf (input) {
  if (null == input || 'object' !== typeof input || Array.isArray(input)) {
    return null
  }
  return input
}


function pageSize (first, config) {
  const num = Number(first)
  if (null == first || '' === first || !Number.isFinite(num) || num <= 0) {
    return config.defaultPageSize
  }
  return Math.min(Math.floor(num), config.maxPageSize)
}


function encodeCursor (id) {
  return Buffer.from('cursor:' + id, 'utf8').toString('base64')
}


function decodeCursor (cursor) {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8')
    if (raw.startsWith('cursor:')) {
      return raw.slice(7)
    }
  }
  catch (err) {
    // fall through: a raw id is accepted as a cursor too
  }
  return cursor
}


function ref (id) {
  return null == id ? null : { id }
}


function refid (val) {
  if (null == val) return null
  if ('string' === typeof val) return val
  if ('object' === typeof val) return null == val.id ? null : val.id
  return null
}


function undef (val) {
  return undefined === val ? null : val
}


function slug (text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'issue'
}


function mockid (kind, n) {
  return kind + '-' + String(n).padStart(4, '0') + '-mock'
}


function defaultTeamId (state) {
  return state.config.defaultTeamId ||
    (0 < state.teams.length ? state.teams[0].id : null)
}


function defaultStateId (state) {
  return state.config.defaultStateId ||
    (0 < state.workflowStates.length ? state.workflowStates[0].id : null)
}


function defaultUserId (state) {
  return 0 < state.users.length ? state.users[0].id : null
}


// Deterministic clock. opts.clock() may return ms, a Date, or an ISO string. With no
// clock supplied, a fixed epoch advances one second per call - never Date.now().
function makeClock (clockopt) {
  if ('function' === typeof clockopt) {
    return () => isotime(clockopt())
  }
  let tick = Date.parse('2026-01-01T00:00:00.000Z')
  return () => {
    const at = tick
    tick += 1000
    return new Date(at).toISOString()
  }
}


function isotime (val) {
  if ('number' === typeof val) return new Date(val).toISOString()
  if (val instanceof Date) return val.toISOString()
  return String(val)
}


function clone (val) {
  return null == val ? val : JSON.parse(JSON.stringify(val))
}
