import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { openStation, withChain } from './station.js'
import { escapeString, renderRaw } from './envelope.js'
import { compareCodePoints } from './note.js'

export class ConfigError extends Error {}

function has (v: unknown): boolean { return undefined !== v && null !== v }
function text (v: unknown): string { return 'string' === typeof v ? v : renderRaw(v) }

// A number past a double's range parses as an infinity, which nothing can
// write back. Walked without recursion, so nesting costs heap, not stack.
function finite (doc: unknown): boolean {
  const pending: unknown[] = [doc]
  while (0 < pending.length) {
    const v = pending.pop()
    if ('number' === typeof v && !Number.isFinite(v)) return false
    if (null !== v && 'object' === typeof v) for (const x of Object.values(v)) pending.push(x)
  }
  return true
}

export const CONFIG_DEPTH = 64

// Counted on the text before it is parsed: each port's parser, and the copy
// made of station.json, recurse, and each would give out at its own depth.
function tooDeep (source: string): boolean {
  let depth = 0
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quoted) {
      if ('\\' === c) i++
      else if ('"' === c) quoted = false
    }
    else if ('"' === c) quoted = true
    else if ('[' === c || '{' === c) {
      if (CONFIG_DEPTH < ++depth) return true
    }
    else if ((']' === c || '}' === c) && 0 < depth) depth--
  }
  return false
}

function parseJson (source: string, path: string): any {
  if (tooDeep(source)) throw new ConfigError(path + ' is nested more than ' + CONFIG_DEPTH + ' deep')
  let doc: unknown
  try { doc = JSON.parse(source) }
  catch { throw new ConfigError(path + ' is not valid JSON') }
  if (!finite(doc)) throw new ConfigError(path + ' is not valid JSON')
  if (null === doc || 'object' !== typeof doc || Array.isArray(doc)) {
    throw new ConfigError(path + ' is not a JSON object')
  }
  return doc
}

// station.json, parsed here and validated by station against its own shape.
// Its secret chain is likeness's to check, and is checked when it is used.
export function parseStation (source: string, path: string): unknown {
  const doc = parseJson(source, path)
  try { openStation(withChain(doc, [])) }
  catch (err: any) {
    if ('string' === typeof err?.code && err.code.startsWith('station_')) {
      throw new ConfigError(path + ': ' + err.message)
    }
    throw err
  }
  return doc
}

function object (v: unknown): Record<string, unknown> | undefined {
  return null !== v && 'object' === typeof v && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

// The account each instance ref of one station profile belongs to, from
// likeness.json. A profile reads only its own: none is inherited. Each level
// is read only as an object, so an array's indices never stand for names.
export function parseAccounts (source: string, path: string, profile: string): Record<string, string> {
  const instances: Record<string, any> =
    object(object(object(parseJson(source, path).profiles)?.[profile])?.instances) ?? {}
  const out: Record<string, string> = {}
  for (const ref of Object.keys(instances).sort(compareCodePoints)) {
    const account = instances[ref]?.account
    if (has(account)) out[ref] = text(account)
  }
  return out
}

// A file that is not there is absent; one that is there and cannot be read as
// a file, such as a directory, is refused rather than taken for absent.
function readConfig (path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try { return readFileSync(path, 'utf8') }
  catch { throw new ConfigError(path + ' cannot be read') }
}

export type Held = { text: string, bytes: Buffer, mode: number }

// A file's text, with the bytes and mode it would be put back with.
export function held (path: string, named: string): Held | undefined {
  if (!existsSync(path)) return undefined
  try {
    const bytes = readFileSync(path)
    return { text: bytes.toString('utf8'), bytes, mode: statSync(path).mode & 0o777 }
  }
  catch { throw new ConfigError(named + ' cannot be read') }
}

export function loadConfig (path: string, profile: string): { station: unknown, accounts: Record<string, string> } {
  const source = readConfig(path)
  if (undefined === source) return { station: null, accounts: {} }
  const station = parseStation(source, path)
  const lpath = join(dirname(path), 'likeness.json')
  const lsource = readConfig(lpath)
  const accounts = undefined === lsource ? {} : parseAccounts(lsource, lpath, profile)
  return { station, accounts }
}


/* A configuration file as it is written: each object's keys in the file's
 * order, and each key and scalar as its own text, so a file written back
 * after one change differs from what was read only by that change and by
 * the layout renderDoc gives every file. */
export type Doc =
  | { t: 'lit', raw: string, v: unknown }
  | { t: 'obj', m: Member[] }
  | { t: 'arr', v: Doc[] }
export type Member = { k: string, raw: string, v: Doc }
export type Obj = Extract<Doc, { t: 'obj' }>

const WS = /[ \t\n\r]*/y
const STRING = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y
const SCALAR = /true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y

class Syntax extends Error {}

// JSON as JSON.parse reads it, a key given twice keeping its first place and
// its last value.
function readDoc (s: string): Doc {
  let at = 0
  const skip = (): void => { WS.lastIndex = at; WS.exec(s); at = WS.lastIndex }
  const token = (re: RegExp): string | undefined => {
    re.lastIndex = at
    const m = re.exec(s)
    if (null === m) return undefined
    at = re.lastIndex
    return m[0]
  }
  const next = (c: string): boolean => {
    skip()
    if (c !== s[at]) return false
    at++
    return true
  }
  const value = (): Doc => {
    skip()
    if (next('{')) {
      const m: Member[] = []
      if (next('}')) return { t: 'obj', m }
      do {
        skip()
        const raw = token(STRING)
        if (undefined === raw || !next(':')) throw new Syntax()
        const k = JSON.parse(raw) as string
        const v = value()
        const same = m.find(x => x.k === k)
        if (undefined === same) m.push({ k, raw, v })
        else same.v = v
      } while (next(','))
      if (!next('}')) throw new Syntax()
      return { t: 'obj', m }
    }
    if (next('[')) {
      const v: Doc[] = []
      if (next(']')) return { t: 'arr', v }
      do v.push(value())
      while (next(','))
      if (!next(']')) throw new Syntax()
      return { t: 'arr', v }
    }
    const raw = token(STRING) ?? token(SCALAR)
    if (undefined === raw) throw new Syntax()
    const v: unknown = JSON.parse(raw)
    if ('number' === typeof v && !Number.isFinite(v)) throw new Syntax()
    return { t: 'lit', raw, v }
  }
  const doc = value()
  skip()
  if (at !== s.length) throw new Syntax()
  return doc
}

// Refused as the readers above refuse it, and in their words.
export function parseDoc (source: string, path: string): Obj {
  if (tooDeep(source)) throw new ConfigError(path + ' is nested more than ' + CONFIG_DEPTH + ' deep')
  let doc: Doc
  try { doc = readDoc(source) }
  catch (err) {
    if (err instanceof Syntax || err instanceof SyntaxError) throw new ConfigError(path + ' is not valid JSON')
    throw err
  }
  if ('obj' !== doc.t) throw new ConfigError(path + ' is not a JSON object')
  return doc
}

// JSON.stringify's layout at an indent of 2, over the text each key and scalar had.
export function renderDoc (doc: Doc): string {
  return render(doc, '') + '\n'
}

function render (d: Doc, at: string): string {
  if ('lit' === d.t) return d.raw
  const inner = at + '  '
  if ('arr' === d.t) {
    return 0 === d.v.length ? '[]' : '[\n' + d.v.map(x => inner + render(x, inner)).join(',\n') + '\n' + at + ']'
  }
  return 0 === d.m.length
    ? '{}'
    : '{\n' + d.m.map(x => inner + x.raw + ': ' + render(x.v, inner)).join(',\n') + '\n' + at + '}'
}

// What the next reader of the file will see, which is what station validates.
export function plainOf (doc: Doc): unknown {
  return JSON.parse(renderDoc(doc))
}

export function docOf (v: unknown): Doc {
  if (Array.isArray(v)) return { t: 'arr', v: v.map(docOf) }
  if (null !== v && 'object' === typeof v) {
    return { t: 'obj', m: Object.entries(v).map(([k, x]) => ({ k, raw: escapeString(k), v: docOf(x) })) }
  }
  return { t: 'lit', raw: 'string' === typeof v ? escapeString(v) : renderRaw(v), v }
}

export function member (o: Obj, k: string): Doc | undefined {
  return o.m.find(x => x.k === k)?.v
}

// Replaced where it stands, or added last.
export function put (o: Obj, k: string, v: Doc): void {
  const at = o.m.find(x => x.k === k)
  if (undefined === at) o.m.push({ k, raw: escapeString(k), v })
  else at.v = v
}

export function drop (o: Obj, k: string): boolean {
  const i = o.m.findIndex(x => x.k === k)
  if (-1 === i) return false
  o.m.splice(i, 1)
  return true
}

export function rekey (o: Obj, from: string, to: string): void {
  const at = o.m.find(x => x.k === from)
  if (undefined !== at) { at.k = to; at.raw = escapeString(to) }
}


export type Fs = {
  writeFileSync: typeof writeFileSync
  renameSync: typeof renameSync
  unlinkSync: typeof unlinkSync
}

export const NODE_FS: Fs = { writeFileSync, renameSync, unlinkSync }

/* One file to replace: its new text, and what it held, absent for a file not
 * there yet. */
export type Write = { path: string, text: string, was?: { bytes: Buffer, mode: number } }

export class WriteError extends Error {
  path: string
  restored: boolean
  constructor (path: string, restored: boolean) {
    super('could not write ' + path)
    this.path = path
    this.restored = restored
  }
}

let made = 0

function tempOf (path: string): string {
  return join(dirname(path), '.' + basename(path) + '.' + process.pid + '.' + (++made) + '.tmp')
}

/* Every file replaced, or none. Each new text, and each file's old bytes, is
 * written beside it before anything is renamed into place, so a rename that
 * fails is undone by renames alone. A file that is a symlink is replaced where
 * the link points, so the link survives. */
export function writeAll (writes: Write[], fs: Fs = NODE_FS): void {
  const target = writes.map(w => undefined !== w.was && lstatSync(w.path).isSymbolicLink() ? realpathSync(w.path) : w.path)
  const temps: string[] = []
  const place = (path: string, data: string | Buffer, mode: number): string => {
    const t = tempOf(path)
    try {
      fs.writeFileSync(t, data, { flag: 'wx', mode })
    }
    catch (err) {
      // A write that fails leaves the file the exclusive open made; EEXIST means it made none.
      if ('EEXIST' !== (err as NodeJS.ErrnoException)?.code) {
        try { fs.unlinkSync(t) }
        catch { /* never created */ }
      }
      throw err
    }
    temps.push(t)
    return t
  }
  const clear = (): void => {
    for (const t of temps) {
      try { fs.unlinkSync(t) }
      catch { /* renamed into place, or never written */ }
    }
  }

  const fresh: string[] = []
  const old: (string | undefined)[] = []
  let at = 0
  try {
    for (; at < writes.length; at++) fresh.push(place(target[at], writes[at].text, writes[at].was?.mode ?? 0o600))
    for (at = 0; at < writes.length; at++) {
      const was = writes[at].was
      old.push(undefined === was ? undefined : place(target[at], was.bytes, was.mode))
    }
  }
  catch {
    clear()
    throw new WriteError(writes[at].path, true)
  }

  for (let i = 0; i < writes.length; i++) {
    try {
      fs.renameSync(fresh[i], target[i])
    }
    catch {
      let restored = true
      for (let j = i - 1; 0 <= j; j--) {
        try {
          const back = old[j]
          if (undefined === back) fs.unlinkSync(target[j])
          else fs.renameSync(back, target[j])
        }
        catch { restored = false }
      }
      clear()
      throw new WriteError(writes[i].path, restored)
    }
  }
  clear()
}
