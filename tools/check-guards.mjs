#!/usr/bin/env node
/* Two rules no port's code may break, checked over the tree as git sees it;
 * PROCESS.md says why each exists.
 *
 *   node tools/check-guards.mjs
 *   node tools/check-guards.mjs --selftest   # a planted breach of each rule must fail
 *
 * source-name: a source's name as a string literal, outside the capability
 * data and the adapter named for that source, in any port's shipped code.
 * tls-verify: any spelling of certificate verification turned off, anywhere.
 * tools/check-guards.json excuses findings by their exact line, and an excuse
 * that matches nothing fails.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SELF = 'tools/check-guards.mjs'

const SHIPPED = [
  { root: 'typescript/src/', ext: ['.ts'] },
  { root: 'go/', ext: ['.go'], skip: /_test\.go$/ },
  { root: 'python/likeness/', ext: ['.py'] },
  { root: 'ruby/lib/', ext: ['.rb'] },
  // spec_embed.c is the capability data itself, written by tools/build-spec.mjs.
  { root: 'c/src/', ext: ['.c', '.h'], skip: /\/spec_embed\.c$/ },
]

const TLS_ROOTS = ['typescript/', 'go/', 'python/', 'ruby/', 'c/', 'mock/', 'tools/']
const TLS_EXT = ['.ts', '.js', '.mjs', '.cjs', '.go', '.py', '.rb', '.c', '.h']

const DISABLES_TLS = [
  /rejectUnauthorized\s*:\s*false/,
  /NODE_TLS_REJECT_UNAUTHORIZED/,
  /InsecureSkipVerify\s*:\s*true/,
  /verify\s*=\s*False/,
  /CERT_NONE/,
  /_create_unverified_context/,
  /check_hostname\s*=\s*False/,
  /VERIFY_NONE/,
  /CURLOPT_SSL_VERIFY(PEER|HOST)/,
]

function files () {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' })
  return [...new Set(out.split('\n').filter(Boolean))].sort()
}

// Single-line literals in any of the five languages' quote characters.
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g

function sourceNames () {
  return Object.keys(JSON.parse(readFileSync(join(ROOT, 'spec', 'sources.json'), 'utf8')).source).sort()
}

function namesSource (text, name) {
  return text === name || text.startsWith(name + '$') || text.startsWith(name + ':')
}

function adapterOf (file, name) {
  return file.split('/').some(part => part === name || new RegExp('^' + name + '[._-]').test(part))
}

function sourceFindings (file, text, sources) {
  const found = []
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(LITERAL)) {
      for (const name of sources) {
        if (namesSource(m[2], name) && !adapterOf(file, name)) {
          found.push({ rule: 'source-name', file, line: i + 1, text: line.trim(), name })
        }
      }
    }
  })
  return found
}

function tlsFindings (file, text) {
  const found = []
  text.split('\n').forEach((line, i) => {
    if (DISABLES_TLS.some(re => re.test(line))) {
      found.push({ rule: 'tls-verify', file, line: i + 1, text: line.trim() })
    }
  })
  return found
}

function scan (read) {
  const sources = sourceNames()
  const out = []
  for (const file of files()) {
    const shipped = SHIPPED.find(s => file.startsWith(s.root) && s.ext.some(e => file.endsWith(e)) &&
      !(s.skip?.test(file)))
    const tls = file !== SELF && TLS_ROOTS.some(r => file.startsWith(r)) && TLS_EXT.some(e => file.endsWith(e))
    if (undefined === shipped && !tls) continue
    const text = read(file)
    if (undefined !== shipped) out.push(...sourceFindings(file, text, sources))
    if (tls) out.push(...tlsFindings(file, text))
  }
  return out
}

function excused () {
  return JSON.parse(readFileSync(join(ROOT, 'tools', 'check-guards.json'), 'utf8')).allow
}

function judge (found, allow) {
  const used = new Set()
  const fail = []
  for (const f of found) {
    const at = allow.findIndex(a => a.rule === f.rule && a.file === f.file && a.text === f.text)
    if (0 <= at) used.add(at)
    else fail.push(f)
  }
  const stale = allow.filter((_, i) => !used.has(i))
  return { fail, stale }
}

const read = (file) => readFileSync(join(ROOT, file), 'utf8')

if (process.argv.includes('--selftest')) {
  const core = 'typescript/src/core.ts'
  const joplin = 'typescript/src/adapter/joplin.ts'
  const planted = {
    [core]: read(core) + "\nif ('notion' === c.source) {}\n",
    [joplin]: read(joplin) + "\nconst other = 'obsidian$work'\nconst agent = { rejectUnauthorized: false }\n",
  }
  const found = scan(f => planted[f] ?? read(f))
  const saw = (rule, file, needle) => found.some(f => f.rule === rule && f.file === file && f.text.includes(needle))
  const want = [
    saw('source-name', core, "'notion' === c.source"),
    saw('source-name', joplin, "'obsidian$work'"),
    saw('tls-verify', joplin, 'rejectUnauthorized'),
    !found.some(f => f.file === joplin && f.text.includes("SOURCE = 'joplin'")),
  ]
  if (want.every(Boolean)) {
    console.log('check-guards: selftest ok - a planted source branch, a foreign source name and a disabled' +
      ' TLS check are each reported, and an adapter naming its own source is not')
    process.exit(0)
  }
  console.error('check-guards: selftest FAILED - the planted breaches were not all reported as expected')
  process.exit(1)
}

const { fail, stale } = judge(scan(read), excused())
for (const f of fail) console.error(`  FAIL  ${f.rule}  ${f.file}:${f.line}  ${f.text}`)
for (const s of stale) console.error(`  STALE ${s.rule}  ${s.file}  "${s.text}" is excused in tools/check-guards.json and no longer found`)
if (0 < fail.length + stale.length) {
  console.error(`\ncheck-guards: ${fail.length} finding(s), ${stale.length} stale excuse(s)`)
  process.exit(1)
}
console.log('check-guards: ok - no source name outside its adapter or the capability data, and no TLS check' +
  ' turned off, in ' + SHIPPED.map(s => s.root).join(' ') + ' (' + excused().length + ' excused)')
