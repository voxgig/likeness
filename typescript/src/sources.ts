import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Station } from '@voxgig/station'

import { LikenessError } from './errors.js'
import { ADAPTERS, type Adapter, type Ask, type Given } from './adapters.js'
import { connectOf, sourceFlags, type Connect } from './caps.js'
import { openStation, withChain, profileOf } from './station.js'
import {
  ConfigError, WriteError, NODE_FS, parseDoc, renderDoc, docOf, plainOf, member, put, drop, rekey, held, writeAll,
  type Fs, type Held, type Obj, type Write,
} from './config.js'
import { vaultEntry, present, passphrase, opened, written, shown, type VaultEntry, type VaultFlags } from './vault.js'

// What a `sources` action needs of the run: where the files are, and a terminal.
export type Place = {
  env?: Record<string, string>
  home?: string
  dir?: string
  config?: string
  tty?: boolean
  prompt?: (label: string) => Promise<string | undefined>
  presented?: (base: string) => Promise<string>
  fs?: Fs
  fixture?: Record<string, unknown>
}

export type Reply = { data: unknown, count: number, text?: string, empty?: boolean }

const TAG = /^[a-z0-9-]+$/
const NAME = /^[a-z][a-z0-9-]*$/
// Scheme, host and port, and a path: no userinfo, query or fragment, which is
// where a credential would be written.
const BASE = /^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?(?:\/[\x21\x22\x24-\x3e\x40-\x7e]*)?$/

const LIST_REMEDY = 'run `likeness sources list` to see the configured connections'
const FILE_REMEDY = 'fix the file, or point --config at another'
const EMPTY: Obj = { t: 'obj', m: [] }

function bad (message: string, remedy: string): LikenessError {
  return new LikenessError('invalid-argument', message, remedy)
}

// Station's name for an instance's secret when its block names none.
export function secretName (ref: string): string {
  return ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() + '.apikey'
}

/* The ref `sources add` writes: the API alone, the API with --instance as its
 * tag, or --instance itself where it is a ref to the same API. A `$`-less
 * value is always a tag, as station reads one. */
export function refFor (source: string, instance?: string): string {
  if (!NAME.test(source)) throw bad('--source takes a source\'s name', 'run `likeness help sources add`')
  if (undefined === instance) return source
  const at = instance.indexOf('$')
  if (-1 !== at && instance.slice(0, at) !== source) {
    throw bad('--instance names a connection to another API than --source does',
      'give the tag alone: `--source ' + source + ' --instance <tag>` adds ' + source + '$<tag>')
  }
  const tag = -1 === at ? instance : instance.slice(at + 1)
  if (!TAG.test(tag)) {
    throw bad('--instance takes a tag of lowercase letters, digits and hyphens',
      'write `--instance work` to add ' + source + '$work')
  }
  return source + '$' + tag
}

function refApi (ref: string): string {
  const at = ref.indexOf('$')
  return -1 === at ? ref : ref.slice(0, at)
}

function named (block: Record<string, unknown>): boolean {
  return 'string' === typeof block.secret && '' !== block.secret
}

function secretOf (block: Record<string, unknown>, ref: string): string {
  return named(block) ? block.secret as string : secretName(ref)
}

function listed (names: string[]): string {
  return 1 === names.length ? names[0] : names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1]
}

export type Row = {
  instance: string
  source: string
  secret: string
  base?: string
  account?: string
  active?: boolean
}

function rowOf (ref: string, block: Record<string, unknown>, account: string | undefined, active: boolean): Row {
  const row: Row = { instance: ref, source: refApi(ref), secret: secretOf(block, ref) }
  if ('string' === typeof block.base) row.base = block.base
  if (undefined !== account) row.account = account
  if (!active) row.active = false
  return row
}

// Every instance the active profile declares, the inactive ones marked, and
// the account of each that likeness.json gives one.
export function list (station: Station, accounts: Record<string, string>): Reply {
  const rows = station.instances().map(i =>
    rowOf(i.name, i.block as Record<string, unknown>, Object.hasOwn(accounts, i.name) ? accounts[i.name] : undefined, i.active))
  return { data: rows, count: rows.length, empty: 0 === rows.length }
}


type Config = {
  home: string
  path: { station: string, likeness: string }
  station?: Held
  likeness?: Held
  doc: Obj
  accounts?: Obj
}

// Both files, read fresh: a write keeps everything in them it does not change.
function configOf (place: Place): Config {
  const home = place.home ?? homedir()
  const station = place.config ?? join(place.dir ?? join(home, '.config', 'likeness'), 'station.json')
  const likeness = join(dirname(station), 'likeness.json')
  try {
    const s = held(station, shown(station, home))
    const l = held(likeness, shown(likeness, home))
    return {
      home,
      path: { station, likeness },
      station: s,
      likeness: l,
      doc: undefined === s ? docOf({ station: 1, profiles: {} }) as Obj : parseDoc(s.text, shown(station, home)),
      accounts: undefined === l ? undefined : parseDoc(l.text, shown(likeness, home)),
    }
  }
  catch (err) {
    if (err instanceof ConfigError) throw new LikenessError('invalid-project', err.message, FILE_REMEDY)
    throw err
  }
}

function stationOf (config: Config, place: Place, refused: (code: string, message: string) => LikenessError): Station {
  try {
    return openStation(withChain(plainOf(config.doc), []), place.env)
  }
  catch (err: any) {
    if ('string' === typeof err?.code && err.code.startsWith('station_')) throw refused(err.code, String(err.message))
    throw err
  }
}

function asRead (config: Config, place: Place): Station {
  return stationOf(config, place, (_code, message) =>
    new LikenessError('invalid-project', shown(config.path.station, config.home) + ': ' + message, FILE_REMEDY))
}

// The object at path, or undefined where a level is missing or not an object.
function find (o: Obj | undefined, path: string[]): Obj | undefined {
  let at = o
  for (const k of path) {
    const next = undefined === at ? undefined : member(at, k)
    at = undefined !== next && 'obj' === next.t ? next : undefined
  }
  return at
}

// The object at path, each missing level made; a level that is not an object is refused.
function make (o: Obj, path: string[], file: string): Obj {
  let at = o
  for (let i = 0; i < path.length; i++) {
    let next = member(at, path[i])
    if (undefined === next) {
      next = { t: 'obj', m: [] }
      put(at, path[i], next)
    }
    if ('obj' !== next.t) {
      throw new LikenessError('invalid-project', file + '\'s ' + path.slice(0, i + 1).join('.') + ' is not an object',
        FILE_REMEDY)
    }
    at = next
  }
  return at
}

function sdkOf (config: Config, profile: string): Obj | undefined {
  return find(config.doc, ['profiles', profile, 'sdk'])
}

/* Whether the active profile's own block declares ref, and whether the
 * default profile, which every other one inherits, declares it as well. */
function owned (config: Config, profile: string, ref: string): void {
  const mine = undefined !== member(sdkOf(config, profile) ?? EMPTY, ref)
  const base = 'default' !== profile && undefined !== member(sdkOf(config, 'default') ?? EMPTY, ref)
  if (!mine && !base) throw new LikenessError('no-such-source', 'no connection named "' + ref + '"', LIST_REMEDY)
  if (!mine) {
    throw bad('connection "' + ref + '" is the default profile\'s, which "' + profile + '" inherits',
      'change it under the default profile, with VOXGIG_STATION_PROFILE unset')
  }
  if (base) {
    throw bad('connection "' + ref + '" would remain: the default profile declares it too, and "' + profile + '" inherits it',
      'remove the default profile\'s first, with VOXGIG_STATION_PROFILE unset')
  }
}

function block (station: Station, ref: string): Record<string, unknown> {
  return station.instances().find(i => i.name === ref)?.block as Record<string, unknown> ?? {}
}

// likeness.json first, so station.json, which makes a connection, changes last.
function commit (place: Place, config: Config, accounts: Obj | undefined): void {
  const writes: Write[] = []
  if (undefined !== accounts) writes.push({ path: config.path.likeness, text: renderDoc(accounts), was: config.likeness })
  writes.push({ path: config.path.station, text: renderDoc(config.doc), was: config.station })
  const dir = shown(dirname(config.path.station), config.home)
  const remedy = 'check that ' + dir + ' is writable and its disk has space'
  try {
    mkdirSync(dirname(config.path.station), { recursive: true, mode: 0o700 })
    writeAll(writes, place.fs ?? NODE_FS)
  }
  catch (err) {
    if (!(err instanceof WriteError)) {
      throw new LikenessError('invalid-project', dir + ' could not be written, and nothing was changed', remedy)
    }
    throw new LikenessError('invalid-project', shown(err.path, config.home) + ' could not be written, and ' +
      (err.restored ? 'nothing was changed' : 'a file already replaced could not be put back'), remedy)
  }
}


function askOf (place: Place): Ask {
  const tty = true === place.tty && undefined !== place.prompt
  return {
    tty,
    confirm: async (label) => {
      const typed = tty ? await (place.prompt as (l: string) => Promise<string | undefined>)(label) : undefined
      return undefined !== typed && /^(?:y|yes)$/i.test(typed.trim())
    },
    presented: async (base) => {
      if (undefined === place.presented) throw new Error('no probe for ' + base)
      return place.presented(base)
    },
  }
}

function accountOf (source: string, connect: Connect, given: unknown): string | undefined {
  const { term, discover, why } = connect.account
  if (discover) {
    if (undefined !== given) throw bad('--account is for a source that cannot name its account, and ' + source + ' names its own',
      'drop --account; `sources add` asks ' + source + ' for it')
    return undefined
  }
  if (undefined === given) {
    throw bad(source + '\'s account cannot be discovered' + (undefined === why ? '' : ': ' + why),
      'give --account with ' + term + '; every note\'s identity derives from it')
  }
  if ('' === given) throw bad('--account is empty', 'give --account with ' + term)
  return given as string
}

const plain = async (_instance: string, given: Given): Promise<Record<string, unknown>> =>
  undefined === given.base ? {} : { base: given.base }

// The account the source names, asked through a station on the configuration being written.
async function discover (
  place: Place, adapter: Adapter, config: Config, ref: string, chain: unknown[], watch: (s: Station) => void,
): Promise<string> {
  const seed = place.fixture?.[ref]
  const station = openStation(withChain(plainOf(config.doc), undefined === seed ? chain : []), place.env)
  watch(station)
  const conn = { instance: ref, source: refApi(ref), account: '' }
  let account: unknown
  try {
    const handle = adapter.connect(station, conn, adapter.configure?.(ref, block(station, ref)), seed)
    account = await (adapter.account as (h: unknown) => Promise<string>)(handle)
  }
  catch (err: any) {
    if (err instanceof LikenessError) throw err
    const code = 401 === err?.status || 403 === err?.status ? 'auth-failed' : 429 === err?.status ? 'rate-limited' : 'source-unavailable'
    throw new LikenessError(code, refApi(ref) + ' did not name the account ' + ref + ' reaches',
      'run `likeness sources add` again once ' + refApi(ref) + ' answers, or check its token', { source: refApi(ref), instance: ref })
  }
  if ('string' !== typeof account || '' === account) {
    throw new LikenessError('source-unavailable', refApi(ref) + ' named no account for ' + ref,
      'this is a bug in the source or its SDK', { source: refApi(ref), instance: ref })
  }
  return account
}

/* A connection added: refused before any prompt where the flags alone decide
 * it, its token stored in the vault before either file changes, and both
 * files written together or not at all. */
export async function add (
  place: Place, given: Record<string, unknown>, flags: VaultFlags, watch: (s: Station) => void = () => {},
): Promise<Reply> {
  const addable = Object.keys(ADAPTERS).filter(s => undefined !== connectOf(s)).sort()
  const choose = 'name one of ' + listed(addable)
  const sources = (given.source ?? []) as string[]
  if (0 === sources.length) throw bad('`sources add` needs --source, the API to connect', choose)
  if (1 < sources.length) throw bad('--source was given more than once, and `sources add` adds one connection', 'give --source once')
  const source = sources[0]
  const connect = connectOf(source)
  if (undefined === connect) throw new LikenessError('no-such-source', 'likeness reaches no source by the name --source gives', choose)
  const adapter = ADAPTERS[source]
  if (undefined === adapter) {
    throw new LikenessError('unsupported-capability', 'no adapter for source "' + source + '" yet', choose, { source })
  }
  const foreign = sourceFlags().filter(f => undefined !== given[f] && !connect.flag.includes(f))
  if (0 < foreign.length) {
    throw bad('--' + foreign[0] + ' does not apply to a ' + source + ' connection',
      'run `likeness help sources add` for the flags each source reads')
  }
  const instances = (given.instance ?? []) as string[]
  if (1 < instances.length) {
    throw bad('--instance was given more than once, and `sources add` adds one connection', 'give --instance once, with the tag')
  }
  const ref = refFor(source, instances[0])
  if (undefined !== given.base && !BASE.test(given.base as string)) {
    throw bad('--base is not an http or https address without credentials, a query or a fragment',
      'give where the application answers' + (undefined === connect.default.base ? ', as scheme, host and port' : ', such as ' + connect.default.base))
  }
  const account = accountOf(source, connect, given.account)
  const existing = given.secret as string | undefined
  const ask = askOf(place)
  if (undefined === existing && !ask.tty) {
    throw bad('the token is typed at a prompt, and stdin is not a terminal',
      'store it with `likeness secrets set ' + secretName(ref) + ' -`, and name it with --secret ' + secretName(ref))
  }

  const config = configOf(place)
  const profile = profileOf(place.env)
  const current = asRead(config, place)
  if (undefined !== member(sdkOf(config, profile) ?? EMPTY, ref)) {
    throw new LikenessError('instance-exists', 'a connection named "' + ref + '" is already configured' +
      ('default' === profile ? '' : ' under the profile "' + profile + '"'),
    'choose another tag with --instance, or remove it first with `likeness sources remove ' + ref + '`')
  }
  const entry: VaultEntry = vaultEntry(plainOf(config.doc), {
    profile, home: config.home, dir: dirname(config.path.station), key: flags.vaultKey,
  })
  present(entry)

  const chosen: Given = { ...connect.default }
  for (const f of ['base', ...connect.flag]) if (undefined !== given[f]) chosen[f] = given[f]
  const made = await (adapter.setup ?? plain)(ref, chosen, ask)

  const sdk = make(config.doc, ['profiles', profile, 'sdk'], shown(config.path.station, config.home))
  // Station words a shared secret name differently in each of its ports.
  const refused = (code: string, message: string): LikenessError => {
    if ('station_secret_collision' !== code) {
      return bad('station refuses the connection this would add: ' + message,
        'give --secret a name `likeness secrets list` shows')
    }
    const want = existing ?? secretName(ref)
    const other = current.instances().find(i => secretOf(i.block as Record<string, unknown>, i.name) === want)
    return bad(undefined === other
      ? ref + '\'s secret name is another connection\'s as well'
      : ref + ' would take its token from ' + want + ', as ' + other.name + ' does',
    'choose another tag with --instance, or name a secret of its own with --secret')
  }
  put(sdk, ref, docOf(made))
  let found = block(stationOf(config, place, refused), ref)
  if (undefined !== existing && existing !== secretOf(found, ref)) {
    put(sdk, ref, docOf({ ...made, secret: existing }))
    found = block(stationOf(config, place, refused), ref)
  }
  try { adapter.configure?.(ref, found) }
  catch (err) {
    if (err instanceof LikenessError) throw bad(err.message, 'run `likeness help sources add` for the flags each source reads')
    throw err
  }
  const secret = secretOf(found, ref)

  const phrase = await passphrase(place, flags, entry.key)
  const { vault, info } = opened(entry, phrase)
  let stored: string | undefined
  try {
    if (undefined !== existing) {
      if (!vault.list().includes(secret)) {
        throw new LikenessError('not-found', 'the vault has no ' + secret + ' that the key ' + entry.key + ' can read',
          'store it with `likeness secrets set ' + secret + '`, or name another with --secret')
      }
    }
    else {
      if (!info.master) {
        throw new LikenessError('vault-denied', 'only a master key stores a new secret, and the key ' + entry.key + ' is restricted',
          'run it as the master key, or store the token first and name it with --secret')
      }
      if (vault.list().includes(secret)) {
        throw new LikenessError('vault-exists', 'the vault already holds ' + secret + ', and `sources add` never overwrites a token',
          'use it with --secret ' + secret + ', or drop it first with `likeness secrets remove ' + secret + '`')
      }
      const token = await (place.prompt as (l: string) => Promise<string | undefined>)('token for ' + ref)
      if (undefined === token || '' === token) throw bad('no token was given', 'run it again, and type the token')
      written(entry, () => vault.set(secret, token))
      stored = secret
    }

    const id = account ?? await discover(place, adapter, config, ref,
      [{ kind: 'minivault', file: entry.file, vaultkey: entry.key, passphrase: phrase }], watch)
    const accounts = config.accounts ?? docOf({ likeness: 1, profiles: {} }) as Obj
    put(make(accounts, ['profiles', profile, 'instances'], shown(config.path.likeness, config.home)), ref, docOf({ account: id }))
    commit(place, config, accounts)

    const row = rowOf(ref, found, id, true)
    return {
      data: row,
      count: 1,
      text: 'added ' + ref + ('default' === profile ? '' : ' to the profile ' + profile) +
        ', its token in the vault as ' + secret + '\n',
    }
  }
  catch (err) {
    if (undefined !== stored) {
      try { vault.remove(stored) }
      catch { /* the refusal below names what failed; the token stays where it was put */ }
    }
    throw err
  }
  finally {
    vault.close()
  }
}

// A connection and its account removed together. The vault is the secrets group's.
export function remove (place: Place, ref: string): Reply {
  const config = configOf(place)
  const profile = profileOf(place.env)
  const secret = secretOf(block(asRead(config, place), ref), ref)
  owned(config, profile, ref)
  drop(sdkOf(config, profile) as Obj, ref)
  const accounts = find(config.accounts, ['profiles', profile, 'instances'])
  commit(place, config, undefined !== accounts && drop(accounts, ref) ? config.accounts : undefined)
  return {
    data: { instance: ref, secret },
    count: 1,
    text: 'removed ' + ref + '; the vault still holds ' + secret + ', which `likeness secrets` manages\n',
  }
}

/* A connection under a new ref, keeping its place in both files. A token found
 * by the ref's derived name is named in the block, since that name changes
 * with the ref. */
export function rename (place: Place, from: string, to: string): Reply {
  if (from === to) {
    throw bad(from + ' already has that ref', 'give the new ref second: `likeness sources rename ' + from + ' <new-ref>`')
  }
  const api = refApi(from)
  if (refApi(to) !== api) {
    throw bad('a connection keeps its API, so ' + from + ' cannot become ' + to,
      'rename it to ' + api + ' or ' + api + '$<tag>; a connection to another API is added with `likeness sources add`')
  }
  const config = configOf(place)
  const profile = profileOf(place.env)
  const station = asRead(config, place)
  owned(config, profile, from)
  if (station.instances().some(i => i.name === to)) {
    throw new LikenessError('instance-exists', 'a connection named "' + to + '" is already configured',
      'choose another ref, or remove that one first with `likeness sources remove ' + to + '`')
  }
  const before = block(station, from)
  const sdk = sdkOf(config, profile) as Obj
  rekey(sdk, from, to)
  if (!named(before)) put(member(sdk, to) as Obj, 'secret', docOf(secretName(from)))
  const after = block(stationOf(config, place, (code) =>
    bad(from + ' cannot become ' + to + ': station refuses the configuration that would leave, as ' + code,
      'choose another ref')), to)

  const accounts = find(config.accounts, ['profiles', profile, 'instances'])
  let moved = false
  if (undefined !== accounts) {
    moved = drop(accounts, to)
    if (undefined !== member(accounts, from)) { rekey(accounts, from, to); moved = true }
  }
  commit(place, config, moved ? config.accounts : undefined)
  const secret = secretOf(after, to)
  return {
    data: { instance: to, was: from, secret },
    count: 1,
    text: 'renamed ' + from + ' to ' + to + '; its token is still ' + secret + ' in the vault\n',
  }
}
