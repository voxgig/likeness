#!/usr/bin/env node
/* The source x port matrix: one real request per source per port, made by each
 * port's own CLI through its station-bound SDK, against mock/.
 *
 *   node tools/matrix.mjs                  # run every cell and print the table
 *   node tools/matrix.mjs --selftest       # then plant faults and require each to go red
 *   node tools/matrix.mjs --bin ts=PATH    # run one port from another build
 *
 * tools/matrix.json says what a working port answers in each cell, and
 * tools/matrix-waiting.json which cells wait on upstream, and why. PROCESS.md
 * describes the gate.
 */

import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildServer } from '../mock/server.js'
import { resetStore } from '../mock/store.js'
import { render, strip } from './envelope.mjs'
import { writeVault } from './make-vault.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...path) => JSON.parse(readFileSync(join(ROOT, ...path), 'utf8'))

const MATRIX = read('tools', 'matrix.json')
const DECLARED = read('tools', 'matrix-waiting.json')
const CAPS = read('spec', 'caps.json').capability
const ERRORS = read('spec', 'errors.json').error
const COMMANDS = read('spec', 'commands.json')

const PORTS = MATRIX.ports
const SOURCES = Object.keys(MATRIX.source)
const LIMIT_MS = 60000
const UNRESERVED = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*$/


// What a command answers and the mock receives while a cause stands, from what
// a working port would.
const PREDICT = {
  // Station refuses the vault before it connects anything.
  'vault-unopened': () => ({
    code: 'secret-backend-unavailable',
    message: 'station could not open the vault as its secret store',
    requests: [],
  }),
  // Each request goes as a working port's would, with station's placeholder
  // where the token belongs, and the source refuses each.
  'placeholder-token': (want, { cmd, name }) => ({
    code: { doctor: 'auth-failed', list: 'source-unavailable', get: 'auth-failed' }[cmd],
    requests: want.requests.map(r => ({
      ...r,
      query: { ...r.query, [MATRIX.source[name].token.query]: '[station:' + name + ']' },
      status: 403,
      auth: 'bad',
    })),
  }),
  'no-adapter': () => ({
    code: 'unsupported-capability',
    mentions: ['no adapter for'],
    requests: [],
  }),
  'c-refused': (_want, { cause }) => ({
    code: 'unsupported-capability',
    mentions: cause.issues,
    requests: [],
  }),
  // The root listing comes back naming nothing, so the walk goes no further.
  'walk-stops-at-root': want => ({
    code: 'source-unavailable',
    requests: want.requests.slice(0, 1),
  }),
}


function isMap (v) {
  return null !== v && 'object' === typeof v && !Array.isArray(v)
}

function fill (v, values) {
  if ('string' === typeof v) return v.replace(/\{(base|pin)\}/g, (_m, k) => values[k])
  if (Array.isArray(v)) return v.map(e => fill(e, values))
  if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, fill(e, values)]))
  return v
}

function short (issue) {
  return issue.replace(/^[^/]+\//, '')
}

function issueUrl (issue) {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(issue)
  return null === m ? undefined : 'https://github.com/' + m[1] + '/' + m[2] + '/issues/' + m[3]
}

// The commands each cell of a source runs, by name, with their arguments.
function commandsOf (name, home) {
  const src = MATRIX.source[name]
  const out = [['doctor', ['doctor', '--json']]]
  if (true === CAPS[name]?.entity?.note?.op?.list) out.push(['list', ['list', '--json']])
  out.push(['get', ['get', src.ref, '--json']])
  if ('https' === src.serve) {
    out.push(['mispinned', ['doctor', '--json', '--config', join(home, 'mispinned', 'station.json')]])
  }
  return out
}


// -- arguments --------------------------------------------------------------

function usage (message) {
  console.error('matrix: ' + message)
  console.error('usage: node tools/matrix.mjs [--selftest] [--bin <port>=<path>]...')
  process.exit(2)
}

const BIN = {
  ts: [process.execPath, join(ROOT, 'typescript', 'bin', 'likeness.js')],
  go: [join(ROOT, 'build', 'matrix', 'likeness-go')],
  py: [join(ROOT, 'python', '.venv', 'bin', 'likeness-py')],
  rb: [join(ROOT, 'ruby', 'bin', 'likeness-rb')],
  c: [join(ROOT, 'c', 'bin', 'likeness-c')],
}

const args = process.argv.slice(2)
let selftest = false
for (let i = 0; i < args.length; i++) {
  if ('--selftest' === args[i]) selftest = true
  else if ('--bin' === args[i]) {
    const m = /^([a-z]+)=(.+)$/.exec(args[++i] ?? '')
    if (null === m || !PORTS.includes(m[1])) usage('--bin takes <port>=<path>, for a port the matrix runs')
    BIN[m[1]] = m[2].endsWith('.js') ? [process.execPath, m[2]] : [m[2]]
  }
  else usage('no such argument: ' + args[i])
}


// -- the declarations -------------------------------------------------------

// Each problem with tools/matrix-waiting.json itself, so that the file can
// neither name what does not exist nor keep a cause that holds no cell.
function declarationProblems (declared) {
  const out = []
  const used = new Set()
  const covered = new Set()
  for (const [id, cause] of Object.entries(declared.cause)) {
    if (!Array.isArray(cause.issues) || 0 === cause.issues.length ||
        !cause.issues.every(i => 'string' === typeof i && undefined !== issueUrl(i))) {
      out.push('cause ' + id + ' names no issue as owner/repo#number')
    }
    if (undefined === PREDICT[cause.predict]) out.push('cause ' + id + ' predicts "' + cause.predict + '", which the matrix does not define')
    if ('string' !== typeof cause.reason || '' === cause.reason) out.push('cause ' + id + ' gives no reason')
  }
  for (const w of declared.waiting) {
    const at = w.port + ' x ' + w.source
    if (!PORTS.includes(w.port) || !SOURCES.includes(w.source)) {
      out.push(at + ' is no cell of the matrix')
      continue
    }
    if (undefined === declared.cause[w.cause]) out.push(at + ' waits on cause "' + w.cause + '", which is not declared')
    for (const b of w.behind ?? []) {
      if (undefined === declared.cause[b]) out.push(at + ' has "' + b + '" behind it, which is not declared')
      used.add(b)
    }
    used.add(w.cause)
    const run = commandsOf(w.source, '').map(([c]) => c)
    for (const c of w.commands ?? run) {
      if (!run.includes(c)) out.push(at + ' declares ' + c + ', which the cell does not run')
      if (covered.has(at + ' ' + c)) out.push(at + ' ' + c + ' is declared twice')
      covered.add(at + ' ' + c)
    }
  }
  for (const id of Object.keys(declared.cause)) {
    if (!used.has(id)) out.push('cause ' + id + ' is declared and holds no cell: take it out')
  }
  return out
}

// What tools/matrix.json says a working port answers must cover exactly the
// commands each cell runs, which spec/caps.json decides in part.
function matrixProblems () {
  const out = []
  if (PORTS.join() !== Object.keys(BIN).join()) out.push('names the ports ' + PORTS.join(', ') + ', and the matrix runs ' + Object.keys(BIN).join(', '))
  for (const name of SOURCES) {
    const src = MATRIX.source[name]
    if (!['http', 'https'].includes(src.serve)) out.push(name + ' is served over ' + JSON.stringify(src.serve))
    const want = Object.keys(src.command).sort()
    const run = commandsOf(name, '').map(([c]) => c).sort()
    if (want.join() !== run.join()) out.push('expects ' + name + ' to answer ' + want.join(', ') + ', and its cells run ' + run.join(', '))
  }
  return out
}

function causeOf (declared, id) {
  const cause = declared.cause[id]
  return undefined !== cause && undefined !== PREDICT[cause.predict] ? cause : undefined
}

function declarationFor (declared, port, name, cmd) {
  return declared.waiting.find(w => port === w.port && name === w.source &&
    (undefined === w.commands || w.commands.includes(cmd)))
}


// -- judging ----------------------------------------------------------------

function expectation (name, cmd) {
  const want = MATRIX.source[name].command[cmd]
  return {
    code: want.code,
    message: want.message,
    mentions: want.mentions ?? [],
    calls: want.calls ?? want.requests.length,
    requests: want.requests,
    stderr: '',
  }
}

function predicted (want, cause, ctx) {
  const p = PREDICT[cause.predict](want, { ...ctx, cause })
  return { ...want, mentions: [], message: undefined, ...p, calls: p.calls ?? p.requests.length }
}

function formDecode (s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')) }
  catch { return undefined }
}

function splitUrl (url) {
  const at = url.indexOf('?')
  return -1 === at ? [url, undefined] : [url.slice(0, at), url.slice(at + 1)]
}

// One request the mock received, against the one a command should have sent.
function rowFindings (row, want, ctx) {
  const out = []
  const src = MATRIX.source[ctx.name]
  const [path, raw] = splitUrl(String(row.url))
  if (ctx.name !== row.source) out.push('reached the mock as ' + row.source)
  if (want.method !== row.method || want.path !== path) out.push('was ' + row.method + ' ' + path)
  if (src.serve !== row.serve) out.push('arrived over ' + row.serve + ', not ' + src.serve)
  if ((want.status ?? 200) !== row.status) out.push('was answered ' + row.status + ', not ' + (want.status ?? 200))
  if ((want.auth ?? 'ok') !== row.auth) out.push('carried a credential the mock found ' + row.auth)
  for (const [header, value] of Object.entries(src.headers)) {
    if (value !== row.headers?.[header]) {
      out.push('sent ' + header + ' ' + JSON.stringify(row.headers?.[header] ?? null) + ', not ' + JSON.stringify(value))
    }
  }

  if (undefined !== want.root) {
    const sel = row.graphql
    if (!isMap(sel)) out.push('carried no GraphQL document')
    else if (1 !== sel.root.length || !want.root.includes(sel.root[0])) {
      out.push('selected ' + (0 === sel.root.length ? 'no field' : sel.root.join(', ')) +
        ', where it selects ' + want.root.join(' or '))
    }
  }

  const query = want.query ?? {}
  const got = new Map()
  for (const pair of undefined === raw ? [] : raw.split('&')) {
    const eq = pair.indexOf('=')
    const key = formDecode(-1 === eq ? pair : pair.slice(0, eq))
    const value = -1 === eq ? '' : pair.slice(eq + 1)
    if (undefined === key) { out.push('has a query key that is not percent-encoded'); continue }
    if (got.has(key)) out.push('repeats ' + key + ' in its query')
    got.set(key, value)
  }
  const extra = [...got.keys()].filter(k => !Object.hasOwn(query, k))
  if (0 < extra.length) out.push('carried query parameters it should not: ' + extra.join(', '))
  for (const [key, value] of Object.entries(query)) {
    if (!got.has(key)) { out.push('carried no ' + key + ' in its query'); continue }
    const sent = got.get(key)
    const decoded = formDecode(sent)
    if ('{token}' !== value) {
      if (value !== decoded) out.push('carried ' + key + ' ' + JSON.stringify(decoded ?? sent) + ', not ' + JSON.stringify(value))
      continue
    }
    if (undefined !== decoded && decoded.startsWith('[station:')) out.push('carried station\'s placeholder in ' + key + ', not the token')
    else if (decoded !== ctx.token) out.push('carried a ' + key + ' that is not the vault\'s token')
    if (!UNRESERVED.test(sent)) out.push('carried the token in ' + key + ' without percent-encoding it')
  }
  return out
}

function requestFindings (rows, wants, ctx) {
  const out = []
  for (let i = 0; i < Math.max(rows.length, wants.length); i++) {
    const row = rows[i]
    const want = wants[i]
    const at = 'request ' + (i + 1)
    if (undefined === want) out.push(at + ' was not expected: ' + row.method + ' ' + splitUrl(String(row.url))[0])
    else if (undefined === row) out.push(at + ' never reached the mock: ' + want.method + ' ' + want.path)
    else for (const f of rowFindings(row, want, ctx)) out.push(at + ' (' + want.method + ' ' + want.path + ') ' + f)
  }
  return out
}

function excerpt (text) {
  const t = String(text)
  return JSON.stringify(160 < t.length ? t.slice(0, 160) + '...' : t)
}

function envelopeOf (o) {
  try {
    const env = JSON.parse(o.stdout)
    return isMap(env) ? env : undefined
  }
  catch {
    return undefined
  }
}

// Everything wrong with one command's run, as `want` says it should have gone.
function findingsOf (o, want, ctx) {
  const out = []
  if (undefined !== o.failed) out.push('could not run: ' + o.failed)
  if (o.timedOut) out.push('did not finish within ' + LIMIT_MS / 1000 + 's')
  for (const secret of ctx.secrets) {
    for (const stream of ['stdout', 'stderr']) {
      if (o[stream].includes(secret.core)) out.push(secret.name + ' appears in ' + stream)
    }
  }

  const env = envelopeOf(o)
  if (undefined === env) {
    out.push('stdout is not an envelope: ' + excerpt(o.stdout))
    return out
  }
  if (o.stdout !== render(env) + '\n') out.push('stdout is not the envelope in canonical form')
  if (ctx.port !== env.port) out.push('the envelope names its port ' + JSON.stringify(env.port))
  const word = 'mispinned' === ctx.cmd ? 'doctor' : ctx.cmd
  if (JSON.stringify([word]) !== JSON.stringify(env.cmd)) out.push('the envelope answers ' + JSON.stringify(env.cmd))
  const exit = ERRORS[env.code]?.exit
  if (undefined === exit) out.push('answered ' + JSON.stringify(env.code) + ', which is no registered code')
  else if (exit !== o.exit) out.push('exited ' + o.exit + ', where ' + env.code + ' exits ' + exit)

  const calls = env.meta?.calls
  if (!Number.isInteger(calls)) out.push('meta.calls is not a count')
  else {
    if (o.rows.length > calls) {
      out.push('the mock received ' + o.rows.length + ' request(s) and station counted ' + calls +
        ': a request went around station')
    }
    if (calls - o.rows.length > want.calls - want.requests.length) {
      out.push('station counted ' + (calls - o.rows.length) + ' call(s) the mock never received')
    }
    if (calls !== want.calls) out.push('station counted ' + calls + ' call(s), where a working port makes ' + want.calls)
  }

  if (want.code !== env.code) {
    const why = isMap(env.error) && 'string' === typeof env.error.message ? ': ' + env.error.message : ''
    out.push('answered ' + env.code + ', not ' + want.code + why)
  }
  if (undefined !== want.message && want.message !== env.error?.message) {
    out.push('said ' + excerpt(env.error?.message ?? '') + ', not ' + excerpt(want.message))
  }
  for (const m of want.mentions) if (!o.stdout.includes(m)) out.push('does not name ' + m)
  if (want.stderr !== o.stderr) out.push('wrote ' + excerpt(o.stderr) + ' to stderr, which --json leaves empty')
  out.push(...requestFindings(o.rows, want.requests, ctx))
  return out
}

function firstDifference (a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined
  if (isMap(a) && isMap(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[k], b[k], path + '.' + k)
      if (undefined !== d) return d
    }
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], path + '[' + i + ']')
      if (undefined !== d) return d
    }
  }
  return (path || '.') + ' is ' + excerpt(JSON.stringify(b) ?? 'absent') + ', not ' + excerpt(JSON.stringify(a) ?? 'absent')
}

function redactor (secrets) {
  return text => secrets.reduce((t, x) => t.split(x.core).join('<' + x.name + '>'), text)
}

/* Every command's verdict: ok, waiting as declared, stale, red other than as
 * declared, or an undeclared failure. Answers are compared with the canonical
 * port's, or, where it waits, with the first port that answers. */
function judge (observed, declared, secrets) {
  const redact = redactor(secrets)
  const contextOf = (port, name, cmd) => ({ port, name, cmd, secrets, token: secrets.find(s => name === s.source)?.value })
  const holds = (o, cause, ctx) => 0 === findingsOf(o, predicted(expectation(ctx.name, ctx.cmd), cause, ctx), ctx).length
  const verdicts = {}
  const first = {}
  for (const port of PORTS) {
    verdicts[port] = {}
    for (const name of SOURCES) {
      verdicts[port][name] = {}
      for (const [cmd, o] of Object.entries(observed[port]?.[name] ?? {})) {
        first[port + ' ' + name + ' ' + cmd] = findingsOf(o, expectation(name, cmd), contextOf(port, name, cmd))
      }
    }
  }

  const references = {}
  for (const name of SOURCES) {
    for (const cmd of Object.keys(MATRIX.source[name].command)) {
      const ref = PORTS.find(p => undefined !== observed[p]?.[name]?.[cmd] &&
        undefined === declarationFor(declared, p, name, cmd) && 0 === first[p + ' ' + name + ' ' + cmd].length)
      if (undefined !== ref) references[name + ' ' + cmd] = ref
    }
  }

  const problems = []
  for (const port of PORTS) {
    for (const name of SOURCES) {
      for (const [cmd, o] of Object.entries(observed[port]?.[name] ?? {})) {
        const at = port + ' x ' + name + ' ' + cmd
        const ctx = contextOf(port, name, cmd)
        const own = first[port + ' ' + name + ' ' + cmd]
        const findings = [...own]
        const ref = references[name + ' ' + cmd]
        const env = envelopeOf(o)
        if (undefined !== ref && ref !== port && undefined !== env) {
          const d = firstDifference(strip(envelopeOf(observed[ref][name][cmd])), strip(env))
          if (undefined !== d) findings.push('answers other than ' + ref + ': ' + d)
        }

        const w = declarationFor(declared, port, name, cmd)
        const cause = undefined === w ? undefined : causeOf(declared, w.cause)
        let verdict
        let shown = findings
        if (undefined === w) verdict = 0 === findings.length ? 'ok' : 'fail'
        else if (0 === findings.length) verdict = 'stale'
        else if (undefined === cause) verdict = 'other'
        else {
          const off = findingsOf(o, predicted(expectation(name, cmd), cause, ctx), ctx)
          verdict = 0 === off.length ? 'waiting' : 'other'
          // A port that works and answers otherwise is red for that, not for its cause.
          if (0 < own.length) shown = off
        }
        verdicts[port][name][cmd] = { verdict, findings: shown.map(redact), declaration: w }

        if ('fail' === verdict) problems.push({ kind: 'FAIL', at, lines: shown.map(redact) })
        if ('stale' === verdict) {
          problems.push({ kind: 'STALE', at, lines: ['passes: take it out of tools/matrix-waiting.json'] })
        }
        if ('other' === verdict && undefined === cause) {
          problems.push({ kind: 'OTHER', at, lines: ['waits on cause "' + w.cause + '", which predicts nothing the matrix defines'] })
        }
        else if ('other' === verdict) {
          const issues = cause.issues.join(', ')
          const next = (w.behind ?? []).map(b => causeOf(declared, b)).find(b => undefined !== b && holds(o, b, ctx))
          const lines = undefined === next
            ? ['is red other than as ' + issues + ' predicts:', ...shown.map(redact)]
            : ['is red as ' + next.issues.join(', ') + ' predicts, not ' + issues +
              ': make that its cause in tools/matrix-waiting.json']
          problems.push({ kind: 'OTHER', at, lines })
        }
      }
    }
  }
  for (const p of declarationProblems(declared)) problems.push({ kind: 'DECLARE', at: 'tools/matrix-waiting.json', lines: [p] })
  for (const p of matrixProblems()) problems.push({ kind: 'DECLARE', at: 'tools/matrix.json', lines: [p] })
  return { verdicts, problems, references }
}


// -- the table --------------------------------------------------------------

function cellLabel (cell, declared, link = i => short(i)) {
  const runs = Object.values(cell)
  if (0 === runs.length) return 'not run'
  if (runs.some(r => 'fail' === r.verdict || 'other' === r.verdict)) return 'FAIL'
  if (runs.some(r => 'stale' === r.verdict)) return 'STALE'
  const waits = runs.filter(r => 'waiting' === r.verdict)
  if (0 === waits.length) return 'ok'
  const w = waits[0].declaration
  const some = undefined === w.commands ? '' : ' (' + w.commands.join(', ') + ')'
  const issues = id => (declared.cause[id]?.issues ?? [id]).map(link).join(' ')
  return [issues(w.cause) + some, ...(w.behind ?? []).map(issues)].join(' > ')
}

function table (verdicts, declared) {
  const rows = [['', ...SOURCES], ...PORTS.map(p => [p, ...SOURCES.map(s => cellLabel(verdicts[p][s], declared))])]
  const width = SOURCES.map((_s, i) => Math.max(...rows.map(r => r[i + 1].length)))
  return rows.map(r => ('  ' + r[0].padEnd(5) + r.slice(1).map((c, i) => c.padEnd(width[i] + 3)).join('')).trimEnd())
}

function summary (verdicts, declared, counts, problems) {
  const link = i => '[' + short(i) + '](' + issueUrl(i) + ')'
  const lines = [
    '### The source × port matrix',
    '',
    'Each port\'s own CLI, through its station-bound SDK, against `mock/`. A cell is `ok`, or names the upstream issue it waits on, held to what that issue predicts; `>` names what it waits on next.',
    '',
    '| port | ' + SOURCES.join(' | ') + ' |',
    '|---|' + SOURCES.map(() => '---|').join(''),
    ...PORTS.map(p => '| ' + p + ' | ' + SOURCES.map(s => cellLabel(verdicts[p][s], declared, link)).join(' | ') + ' |'),
    '',
    counts,
    '',
    ...problems.map(p => '- **' + p.kind + '** `' + p.at + '` ' + p.lines.join(' ').replace(/\s+/g, ' ')),
    '',
  ]
  return lines.join('\n')
}


// -- running ----------------------------------------------------------------

const DAY = 86400000

function len (n) {
  if (n < 0x80) return Buffer.from([n])
  const out = []
  for (let v = n; 0 < v; v >>= 8) out.unshift(v & 0xff)
  return Buffer.from([0x80 | out.length, ...out])
}

function tlv (tag, ...parts) {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}

function oid (dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a + b]
  for (const n of rest) {
    const bytes = [n & 0x7f]
    for (let v = n >> 7; 0 < v; v >>= 7) bytes.unshift(0x80 | (v & 0x7f))
    out.push(...bytes)
  }
  return tlv(0x06, Buffer.from(out))
}

function utc (d) {
  const p = n => String(n).padStart(2, '0')
  return tlv(0x17, Buffer.from(p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'))
}

/* A throwaway self-signed certificate for 127.0.0.1, as the Obsidian plugin
 * makes one, written in DER by hand: node:crypto signs but writes no
 * certificate, and the matrix may not depend on an openssl being installed. */
function selfSigned () {
  const seq = (...p) => tlv(0x30, ...p)
  const yes = tlv(0x01, Buffer.from([0xff]))
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('127.0.0.1')))))
  const alg = seq(oid('1.2.840.10045.4.3.2'))
  const now = Date.now()
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, randomBytes(8).map((b, i) => (0 === i ? b & 0x7f | 0x01 : b))),
    alg,
    name,
    seq(utc(new Date(now - DAY)), utc(new Date(now + 2 * DAY))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(
      seq(oid('2.5.29.19'), yes, tlv(0x04, seq(yes))),
      seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x87, Buffer.from([127, 0, 0, 1]))))),
    )),
  )
  const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])))
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: new X509Certificate(der).toString(),
    pin: 'sha256:' + createHash('sha256').update(der).digest('hex'),
  }
}

const running = new Set()

function execute (argv, env, cwd) {
  return new Promise((resolve) => {
    const out = []
    const err = []
    let failed
    let timedOut = false
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    catch (e) {
      resolve({ exit: null, stdout: '', stderr: '', failed: e.message, timedOut })
      return
    }
    running.add(child)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, LIMIT_MS)
    child.stdout.on('data', d => { out.push(d) })
    child.stderr.on('data', d => { err.push(d) })
    child.on('error', (e) => { failed = e.message })
    child.on('close', (code) => {
      clearTimeout(timer)
      running.delete(child)
      resolve({
        exit: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        failed,
        timedOut,
      })
    })
  })
}

// The secrets one run makes: a token per source, which only the vault and the
// mock know, and the vault's passphrase. Each carries a random core that no
// encoding changes, which is what the sweep looks for.
function makeSecrets () {
  const core = () => randomBytes(8).toString('hex')
  const out = SOURCES.map((source) => {
    const c = core()
    // A query parameter must carry what only percent-encoding can.
    const value = undefined === MATRIX.source[source].token.query ? 'mx' + c : 'mx' + c + '/+&=?#%41'
    return { name: source + ' token', source, core: c, value }
  })
  const c = core()
  out.push({ name: 'vault passphrase', core: c, value: 'matrix ' + c })
  return out
}

async function serve (serveKind, credentials, cert) {
  const sources = SOURCES.filter(s => serveKind === MATRIX.source[s].serve)
  const app = await buildServer({
    sources, credentials, ...(undefined === cert ? {} : { https: { key: cert.key, cert: cert.cert } }),
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  return { kind: serveKind, app, base: serveKind + '://127.0.0.1:' + app.server.address().port }
}

function configure (dir, name, values, vault) {
  mkdirSync(dir, { recursive: true })
  const src = MATRIX.source[name]
  const station = {
    station: 1,
    profiles: { default: {
      secrets: { providers: [{ kind: 'minivault', file: 'likeness.skmv' }] },
      sdk: { [name]: fill(src.block, values) },
    } },
  }
  const likeness = { likeness: 1, profiles: { default: { instances: { [name]: { account: src.account } } } } }
  writeFileSync(join(dir, 'station.json'), JSON.stringify(station, null, 2) + '\n')
  writeFileSync(join(dir, 'likeness.json'), JSON.stringify(likeness, null, 2) + '\n')
  copyFileSync(vault, join(dir, 'likeness.skmv'))
}

async function runAll (scratch, secrets) {
  const credentials = Object.fromEntries(secrets.filter(s => undefined !== s.source).map(s => [s.source, s.value]))
  const passphrase = secrets.find(s => undefined === s.source).value
  const cert = selfSigned()
  const other = selfSigned()
  const servers = [await serve('http', credentials), await serve('https', credentials, cert)]
  try {
    const vaults = {}
    for (const s of secrets.filter(x => undefined !== x.source)) {
      vaults[s.source] = join(scratch, s.source + '.skmv')
      writeVault(vaults[s.source], passphrase, { [s.source + '.apikey']: s.value })
    }

    const observed = {}
    for (const port of PORTS) {
      const started = Date.now()
      let count = 0
      observed[port] = {}
      for (const name of SOURCES) {
        const home = join(scratch, port + '-' + name)
        const base = servers.find(s => MATRIX.source[name].serve === s.kind).base
        configure(join(home, '.config', 'likeness'), name, { base, pin: cert.pin }, vaults[name])
        if ('https' === MATRIX.source[name].serve) configure(join(home, 'mispinned'), name, { base, pin: other.pin }, vaults[name])
        const env = {
          PATH: process.env.PATH ?? '',
          HOME: home,
          LANG: process.env.LANG ?? 'C.UTF-8',
          ...(undefined === process.env.LC_ALL ? {} : { LC_ALL: process.env.LC_ALL }),
          LIKENESS_PASSPHRASE: passphrase,
        }

        for (const s of servers) resetStore(s.app.store)
        observed[port][name] = {}
        for (const [cmd, argv] of commandsOf(name, home)) {
          for (const s of servers) s.app.store.requests.length = 0
          const o = await execute([...BIN[port], ...argv], env, home)
          // The ring is written as each response finishes, which can trail the exit.
          await new Promise(resolve => setImmediate(resolve))
          o.rows = servers.flatMap(s => s.app.store.requests.map(r => ({ ...r, serve: s.kind })))
          o.argv = argv
          observed[port][name][cmd] = o
          count++
        }
      }
      console.log('  ran ' + port.padEnd(3) + count + ' commands in ' + ((Date.now() - started) / 1000).toFixed(1) + 's')
    }
    return { observed, bases: servers.map(s => s.base) }
  }
  finally {
    for (const s of servers) await s.app.close()
  }
}


// -- the self-test ----------------------------------------------------------

function greenCommands (verdicts, observed) {
  const out = []
  for (const port of PORTS) {
    for (const name of SOURCES) {
      for (const [cmd, v] of Object.entries(verdicts[port][name])) {
        if ('ok' === v.verdict) out.push({ port, name, cmd, rows: observed[port][name][cmd].rows.length })
      }
    }
  }
  return out
}

function withCalls (o, delta) {
  const env = JSON.parse(o.stdout)
  env.meta.calls += delta
  return render(env) + '\n'
}

/* Each fault planted in this run's own observations or declarations must turn
 * the matrix red, for the reason planted; each wire rule must refuse what it
 * exists to refuse. A judgement nobody has seen go red might judge nothing. */
function selfTest (observed, secrets, real) {
  const missed = []
  const caught = []
  const green = greenCommands(real.verdicts, observed)
  const sent = green.find(g => 0 < g.rows)
  if (undefined === sent) {
    return ['no command passes with a request the mock received, so there is nothing to plant into']
  }

  const said = p => p.kind + ' ' + p.at + ' ' + p.lines.join(' ')
  const before = new Set(real.problems.map(said))

  // The plant must raise a problem of its kind, at its place, that the run itself did not.
  function plant (what, change, kind, where, pattern = /./) {
    const obs = structuredClone(observed)
    const declared = structuredClone(DECLARED)
    change(obs, declared)
    const raised = judge(obs, declared, secrets).problems.filter(p => !before.has(said(p)))
    const text = raised.map(said).join('\n')
    if (!raised.some(p => kind === p.kind && p.at.startsWith(where) && pattern.test(said(p)))) {
      missed.push(what + ' did not turn the matrix red as it should')
    }
    else if (secrets.some(s => text.includes(s.core))) missed.push(what + ' was reported with a secret in the report')
    else caught.push(what)
  }

  const index = DECLARED.waiting.findIndex(w =>
    Object.values(real.verdicts[w.port][w.source]).some(v => 'waiting' === v.verdict))
  if (-1 === index) missed.push('no cell waits as declared, so no declaration can be withdrawn')
  else {
    const waited = DECLARED.waiting[index]
    const cell = waited.port + ' x ' + waited.source + ' '
    plant('an undeclared failure', (_o, d) => { d.waiting.splice(index, 1) }, 'FAIL', cell)
    const other = Object.keys(DECLARED.cause).find(id =>
      DECLARED.cause[id].predict !== DECLARED.cause[waited.cause].predict)
    plant('a declaration naming the wrong cause', (_o, d) => { d.waiting[index].cause = other }, 'OTHER', cell)
  }

  const ok = green[0]
  plant('a stale declaration', (_o, d) => {
    d.waiting.push({ port: ok.port, source: ok.name, commands: [ok.cmd], cause: DECLARED.waiting[0].cause })
  }, 'STALE', ok.port + ' x ' + ok.name + ' ' + ok.cmd)
  plant('a declaration naming a cause nobody declared', (_o, d) => {
    d.waiting.push({ port: ok.port, source: ok.name, commands: [ok.cmd], cause: 'selftest-undeclared' })
  }, 'DECLARE', 'tools/matrix-waiting.json', /not declared/)
  plant('a cause that holds no cell', (_o, d) => {
    d.cause['selftest-unused'] = { ...DECLARED.cause[DECLARED.waiting[0].cause] }
  }, 'DECLARE', 'tools/matrix-waiting.json', /holds no cell/)

  const at = sent.port + ' x ' + sent.name + ' ' + sent.cmd
  const cmd = o => o[sent.port][sent.name][sent.cmd]
  plant('a request the mock did not expect', (o) => {
    cmd(o).rows.push({ ...cmd(o).rows[0], url: cmd(o).rows[0].url.replace(/[^/?]*(\?.*)?$/, 'unexpected') })
    cmd(o).stdout = withCalls(cmd(o), 1)
  }, 'FAIL', at, /was not expected/)
  plant('a request around station', (o) => { cmd(o).rows.push({ ...cmd(o).rows[0] }) }, 'FAIL', at, /went around station/)
  plant('an answer the source never gave', (o) => { cmd(o).rows = [] }, 'FAIL', at, /never received/)
  plant('a token in what the CLI printed', (o) => { cmd(o).stderr += 'token ' + secrets[0].value + '\n' },
    'FAIL', at, new RegExp(secrets[0].name + ' appears in stderr'))

  // The wire rules, each against a request a working port sends and one it must not.
  function wire (what, name, cmd, row, pattern) {
    const want = MATRIX.source[name].command[cmd].requests[0]
    const ctx = { name, token: secrets.find(s => name === s.source).value }
    const base = { source: name, method: want.method, auth: 'ok', status: want.status ?? 200, serve: MATRIX.source[name].serve, headers: { ...MATRIX.source[name].headers } }
    const findings = rowFindings({ ...base, ...row }, want, ctx).map(redactor(secrets))
    if (undefined === pattern ? 0 < findings.length : !findings.some(f => pattern.test(f))) {
      missed.push(what + (undefined === pattern ? ' was refused: ' + findings.join('; ') : ' was not refused'))
    }
    else caught.push(what)
  }
  const joplin = secrets.find(s => 'joplin' === s.source).value
  const fields = 'fields=' + encodeURIComponent('id,parent_id,title,body,created_time,updated_time')
  const note = '/joplin/notes/a0e50000000000000000000000000001?' + fields + '&token='
  const strict = Array.from(new TextEncoder().encode(joplin), b => /[A-Za-z0-9._~-]/.test(String.fromCharCode(b))
    ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('')
  wire('a Joplin token strictly percent-encoded', 'joplin', 'get', { url: note + strict })
  wire('a Joplin token percent-encoded in lower case', 'joplin', 'get', { url: note + strict.toLowerCase() })
  wire('station\'s placeholder as the Joplin token', 'joplin', 'get',
    { url: note + encodeURIComponent('[station:joplin]'), auth: 'bad', status: 403 }, /placeholder/)
  wire('a Joplin token sent unencoded', 'joplin', 'get', { url: note + joplin.slice(0, joplin.indexOf('#')) }, /without percent-encoding/)
  wire('another token in the Joplin query', 'joplin', 'get', { url: note + 'joplin-mock-token' }, /not the vault's token/)
  wire('a Linear load selecting issue', 'linear', 'get', { url: '/linear/graphql', graphql: { operation: 'IssueLoad', root: ['issue'] } })
  wire('a Linear load selecting attachmentIssue', 'linear', 'get',
    { url: '/linear/graphql', graphql: { operation: 'IssueLoad', root: ['attachmentIssue'] } }, /selected attachmentIssue/)
  wire('a bare Linear list selecting issues', 'linear', 'list', { url: '/linear/graphql', graphql: { operation: 'IssueList', root: ['issues'] } })
  wire('a bare Linear list selecting issueSearch', 'linear', 'list',
    { url: '/linear/graphql', graphql: { operation: 'IssueList', root: ['issueSearch'] } }, /selected issueSearch/)
  wire('a Notion request with no Notion-Version', 'notion', 'get',
    { url: '/notion/v1/pages/2a9e0000-0000-4000-8000-000000000002', headers: {} }, /notion-version/)
  wire('an Obsidian note read without the note JSON accept', 'obsidian', 'get',
    { url: '/obsidian/vault/somedirectory%2Fmeeting-notes.md', headers: { accept: 'application/json' } }, /accept/)
  wire('an Obsidian request over plain HTTP', 'obsidian', 'get',
    { url: '/obsidian/vault/somedirectory%2Fmeeting-notes.md', serve: 'http' }, /arrived over http/)

  if (0 === missed.length) {
    console.log('\nmatrix --selftest: ok - each planted fault turned the matrix red, and each wire rule refused what it exists to refuse:')
    for (const c of caught) console.log('  ' + c)
  }
  return missed
}


// -- main -------------------------------------------------------------------

function printProblems (problems) {
  for (const p of problems) {
    console.error('  ' + p.kind.padEnd(8) + p.at + ' ' + p.lines[0])
    for (const l of p.lines.slice(1)) console.error('           ' + l)
  }
}

async function main () {
  if (Object.hasOwn(COMMANDS.global, 'explain')) {
    console.error('matrix: --explain is declared, so its trace is output the matrix must sweep too: run each command with it')
    return 1
  }
  for (const port of PORTS) {
    if (!existsSync(BIN[port][BIN[port].length - 1])) {
      console.error('matrix: no ' + port + ' binary at ' + BIN[port][BIN[port].length - 1] + ' - `make matrix` builds every port')
      return 2
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'likeness-matrix-'))
  const cleanup = () => {
    for (const c of running) c.kill('SIGKILL')
    rmSync(scratch, { recursive: true, force: true })
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { cleanup(); process.exit(128 + ('SIGINT' === signal ? 2 : 15)) })
  }

  try {
    const secrets = makeSecrets()
    console.log('  matrix: ' + PORTS.join(', ') + ' x ' + SOURCES.join(', ') + ', each port\'s CLI against mock/')
    const { observed, bases } = await runAll(scratch, secrets)
    const real = judge(observed, DECLARED, secrets)

    console.log('')
    for (const line of table(real.verdicts, DECLARED)) console.log(line)
    console.log('')
    const stood = Object.entries(real.references).filter(([, p]) => p !== PORTS[0]).map(([k, p]) => k + ' (' + p + ')')
    if (0 < stood.length) console.log('  where ' + PORTS[0] + ' does not answer, answers are compared with: ' + stood.join(', '))
    console.log('  served from ' + bases.join(' and ') + '; > names what a cell waits on next')
    printProblems(real.problems)

    const cells = PORTS.flatMap(p => SOURCES.map(s => cellLabel(real.verdicts[p][s], DECLARED)))
    const failing = cells.filter(c => ['FAIL', 'STALE', 'not run'].includes(c)).length
    const counts = cells.filter(c => 'ok' === c).length + ' of ' + cells.length + ' cells green, ' +
      (cells.length - failing - cells.filter(c => 'ok' === c).length) + ' waiting on upstream, each red as its cause predicts' +
      (0 === failing ? '' : ', and ' + failing + ' failing')
    if (undefined !== process.env.GITHUB_STEP_SUMMARY && '' !== process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(real.verdicts, DECLARED, counts, real.problems))
    }

    let status = 0
    if (0 < real.problems.length) {
      console.error('\nmatrix: ' + real.problems.length + ' problem(s): an undeclared failure, a stale declaration,' +
        ' or a cell red other than as declared')
      status = 1
    }
    else console.log('\nmatrix: ok - ' + counts)

    if (selftest) {
      const missed = selfTest(observed, secrets, real)
      for (const m of missed) console.error('  MISSED   ' + m)
      if (0 < missed.length) {
        console.error('\nmatrix --selftest: ' + missed.length + ' planted fault(s) went unreported. The matrix is not judging what it claims to.')
        status = 1
      }
    }
    return status
  }
  finally {
    cleanup()
  }
}

process.exitCode = await main()
