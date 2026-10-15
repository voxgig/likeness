import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { openStation, withChain } from './station.js'
import { renderRaw } from './envelope.js'
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

export function loadConfig (path: string, profile: string): { station: unknown, accounts: Record<string, string> } {
  const source = readConfig(path)
  if (undefined === source) return { station: null, accounts: {} }
  const station = parseStation(source, path)
  const lpath = join(dirname(path), 'likeness.json')
  const lsource = readConfig(lpath)
  const accounts = undefined === lsource ? {} : parseAccounts(lsource, lpath, profile)
  return { station, accounts }
}
