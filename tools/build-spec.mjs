#!/usr/bin/env node
/* Compile the aontu ground truth to the JSON every port reads.
 *
 *   node tools/build-spec.mjs          # write spec/*.json
 *   node tools/build-spec.mjs --check  # fail if the committed JSON is stale
 *
 * NEVER HAND-EDIT THE JSON. It is build output; the .aontu file is the source,
 * and `make spec-fresh` runs the --check mode so drift fails a build rather
 * than being discovered a month later when a port disagrees with the spec it
 * claims to implement.
 *
 * The ports read JSON rather than aontu because four of the five have no aontu
 * implementation, and adding one to each would be five more things to keep in
 * agreement. One compile step, one artefact, five readers.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const AONTU_RAW = (process.env.AONTU || 'aontu').trim()
const AONTU = AONTU_RAW.split(/\s+/)

// Data files only: a shape file under spec/def/ is a truth rather than a
// value, so it has nothing to compile.
const SOURCES = [
  'errors.aontu', 'caps.aontu', 'sources.aontu', 'replica.aontu',
  // The two corpora. They are ground truth like everything else here: written
  // in aontu, checked against spec/def/corpus.aontu, and compiled to the JSON
  // that each port's harness runs. A port reads the JSON; nobody writes it.
  'unit.aontu', 'cli.aontu',
  // The command surface: every port's parser runs on its compiled form.
  'commands.aontu',
]

// The files a port reads at RUN time are also written into each port, where
// its build embeds them: an installed binary then needs no checkout, and
// `--check` holds the copies to the same bytes as spec/.
const EMBED = {
  'errors.aontu': [
    'typescript/src/spec/errors.json', 'go/spec/errors.json', 'python/likeness/spec/errors.json',
  ],
  'caps.aontu': [
    'typescript/src/spec/caps.json', 'go/spec/caps.json', 'python/likeness/spec/caps.json',
  ],
  'commands.aontu': [
    'typescript/src/spec/commands.json', 'go/spec/commands.json', 'python/likeness/spec/commands.json',
  ],
}

// Rendered from commands.aontu here, once, and printed by `help` in every port
// (SPEC 13.1 rule 9), so help text is a corpus entry rather than five drafts.
const HELP = [
  'spec/help.json', 'typescript/src/spec/help.json', 'go/spec/help.json',
  'python/likeness/spec/help.json',
]

const check = process.argv.includes('--check')
let stale = 0
let wrote = 0
const compiled = {}

function emit (dst, text, src) {
  if (check) {
    const have = existsSync(dst) ? readFileSync(dst, 'utf8') : ''
    if (have !== text) {
      console.error(`  STALE   ${dst} does not match ${src}`)
      stale++
    }
    else console.log(`  fresh   ${dst}`)
  }
  else {
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, text)
    console.log(`  wrote   ${dst}`)
    wrote++
  }
}

for (const name of SOURCES) {
  const src = join('spec', name)
  const dsts = [join('spec', name.replace(/\.aontu$/, '.json')), ...(EMBED[name] ?? [])]
  if (!existsSync(src)) {
    console.error(`  MISSING ${src}`)
    process.exit(2)
  }

  let out
  try {
    out = execFileSync(AONTU[0], [...AONTU.slice(1), src], { encoding: 'utf8' })
  }
  catch (err) {
    console.error(`  FAILED  ${src} did not evaluate`)
    console.error(String(err.stdout || err.stderr || err.message))
    process.exit(2)
  }

  // Re-render through our own serialiser rules rather than trusting aontu's
  // spacing: sorted keys and exactly one trailing newline, so the committed
  // bytes are stable whatever the compiler does with whitespace.
  const value = JSON.parse(out)
  compiled[name] = value
  const text = JSON.stringify(sortDeep(value), null, 2) + '\n'

  for (const dst of dsts) emit(dst, text, src)
}

const faults = grammarFaults(compiled['commands.aontu'], compiled['errors.aontu'])
if (0 < faults.length) {
  for (const f of faults) console.error(`  INVALID spec/commands.aontu: ${f}`)
  process.exit(2)
}
const help = JSON.stringify(sortDeep(renderHelp(compiled['commands.aontu'])), null, 2) + '\n'
for (const dst of HELP) emit(dst, help, 'spec/commands.aontu')

// What the shape cannot say: a command may not redeclare a global flag (rule
// 8), only the last positional repeats, a valued flag names its value, a range
// is an integer's, every exit is a registered code, and a command is one word
// or a group's action, never both a group and a command.
function grammarFaults (table, errors) {
  const out = []
  for (const [name, cmd] of Object.entries(table.command)) {
    if (!/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/.test(name)) {
      out.push(`"${name}" is neither one word nor a group and an action`)
    }
    if (name in groupsOf(table)) out.push(`${name} is both a command and a group`)
    for (const flag of Object.keys(cmd.flag)) {
      if (flag in table.global) out.push(`${name} redeclares the global flag --${flag}`)
    }
    cmd.arg.forEach((a, i) => {
      if (a.repeat && i < cmd.arg.length - 1) out.push(`${name}: only the last positional may repeat`)
    })
    for (const [flag, f] of Object.entries({ ...table.global, ...cmd.flag })) {
      if ('boolean' !== f.type && undefined === f.value) out.push(`--${flag} takes a value and names none`)
      if ('integer' !== f.type && (undefined !== f.min || undefined !== f.max)) {
        out.push(`--${flag} has a range but is not an integer`)
      }
    }
    for (const code of cmd.exits) {
      if (undefined === errors.error[code]) out.push(`${name} exits with "${code}", which is not a registered code`)
    }
  }
  return out
}

function groupsOf (table) {
  const groups = {}
  for (const name of Object.keys(table.command)) {
    const at = name.indexOf(' ')
    if (-1 !== at) (groups[name.slice(0, at)] ??= []).push(name)
  }
  return groups
}

function flagUsage (name, f) {
  const text = 'boolean' === f.type ? `--${name}` : `--${name} ${f.value}`
  return f.repeat ? `${text}...` : text
}

// A stdin positional takes `-` and nothing else, so its usage is the dash.
function argLabel (a) {
  return ('stdin' === a.type ? '-' : `<${a.name}>`) + (a.repeat ? '...' : '')
}

function argUsage (a) {
  return a.required ? argLabel(a) : `[${argLabel(a)}]`
}

function range (f) {
  if (undefined !== f.min && undefined !== f.max) return `, ${f.min} to ${f.max}`
  if (undefined !== f.min) return `, at least ${f.min}`
  if (undefined !== f.max) return `, at most ${f.max}`
  return ''
}

function columns (rows) {
  const width = Math.max(...rows.map(r => r[0].length))
  return rows.map(([l, r]) => `  ${l.padEnd(width)}  ${r}`.trimEnd()).join('\n')
}

function renderHelp (table) {
  const names = Object.keys(table.command).sort()
  const globals = Object.keys(table.global).sort()
    .map(n => flagUsage(n, table.global[n])).join(', ')
  const text = {}
  const rows = []

  for (const name of names) {
    const cmd = table.command[name]
    const flags = Object.keys(cmd.flag).sort()
    const takes = cmd.arg.map(argUsage).join(' ')
    const usage = ['likeness', name, takes, ...flags.map(f => `[${flagUsage(f, cmd.flag[f])}]`)]
      .filter(Boolean).join(' ')
    const lines = [
      ...cmd.arg.map(a => [argLabel(a), a.short]),
      ...flags.map(f => [flagUsage(f, cmd.flag[f]), cmd.flag[f].short + range(cmd.flag[f])]),
    ]
    text[name] = [
      usage, '', cmd.short + (cmd.ready ? '' : '\nnot implemented yet'),
      ...(0 < lines.length ? ['', columns(lines)] : []),
      '', `global flags: ${globals}`, '',
    ].join('\n')
    rows.push({ command: name, takes, does: cmd.short + (cmd.ready ? '' : ' (not implemented yet)') })
  }

  for (const [group, members] of Object.entries(groupsOf(table))) {
    text[group] = [
      `likeness ${group} <action> [arguments] [flags]`, '',
      columns(members.sort().map(n => [n.slice(group.length + 1), table.command[n].short])), '',
      `global flags: ${globals}`,
      `run \`likeness help ${group} <action>\` for one action`, '',
    ].join('\n')
  }

  const ready = names.filter(n => table.command[n].ready)
  const pending = names.filter(n => !table.command[n].ready)
  text[''] = [
    'likeness <command> [arguments] [flags]', '',
    columns(ready.map(n => [n, table.command[n].short])), '',
    `declared, not implemented yet: ${pending.join(', ')}`, '',
    `global flags: ${globals}`,
    'run `likeness help <command>` for one command', '',
  ].join('\n')

  return { text, rows }
}

function sortDeep (v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (null !== v && 'object' === typeof v) {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k])
    return out
  }
  return v
}

if (check && 0 < stale) {
  console.error(`\nbuild-spec: ${stale} stale file(s). Run \`make spec-build\` and commit the result.`)
  process.exit(1)
}
if (!check) console.log(`\nbuild-spec: ${wrote} file(s) written`)
