import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createvault, openvault, type MiniVault, type VaultKeyInfo } from '@voxgig/sekreto/plugins/minivault'

import { LikenessError } from './errors.js'
import { renderRaw } from './envelope.js'
import { compareCodePoints } from './note.js'

export const DEFAULT_FILE = 'likeness.skmv'
export const PASSPHRASE_ENV = 'LIKENESS_PASSPHRASE'
export const NEW_PASSPHRASE_ENV = 'LIKENESS_NEW_PASSPHRASE'

const ENTRY_KEYS = ['file', 'kind', 'vaultkey']
const KEY_RE = /^[a-z][a-z0-9-]*$/

export type VaultEntry = { file: string, key: string, shown: string }

export type Asker = {
  env?: Record<string, string>
  tty?: boolean
  prompt?: (label: string) => Promise<string | undefined>
  stdin?: () => Promise<string>
}

export type VaultFlags = {
  passphraseEnv?: string
  newPassphraseEnv?: string
  vaultKey?: string
  reveal: boolean
  write: boolean
}

export type Answer = { data: unknown, count: number, text: string, empty?: boolean }

const REMEDY = 'name the vault alone: "providers": [{ "kind": "minivault", "file": "likeness.skmv" }]'

function refused (message: string, remedy: string = REMEDY): LikenessError {
  return new LikenessError('invalid-project', message, remedy)
}

function isMap (v: unknown): v is Record<string, unknown> {
  return null !== v && 'object' === typeof v && !Array.isArray(v)
}

export function shown (path: string, home: string): string {
  const h = resolve(home)
  if (path === h) return '~'
  return path.startsWith(h + '/') ? '~/' + path.slice(h.length + 1) : path
}

function located (file: string, home: string, dir: string): string {
  if (file.startsWith('~/')) return resolve(join(home, file.slice(2)))
  return isAbsolute(file) ? resolve(file) : resolve(dir, file)
}

// The one secret store likeness allows: a minivault, chosen the way station
// chooses its profile's chain, with no passphrase written beside it.
export function vaultEntry (
  station: unknown, opts: { profile: string, home: string, dir: string, key?: string },
): VaultEntry {
  const profiles = isMap(station) && isMap(station.profiles) ? station.profiles : {}
  const chain = (p: unknown): unknown =>
    isMap(p) && isMap(p.secrets) ? p.secrets.providers : undefined
  const providers = ('default' === opts.profile ? undefined : chain(profiles[opts.profile])) ??
    chain(profiles.default)

  let entry: Record<string, unknown> = { kind: 'minivault' }
  if (undefined !== providers && null !== providers) {
    if (!Array.isArray(providers) || 1 !== providers.length) {
      throw refused('station.json\'s secrets.providers must name one store, the vault')
    }
    const only = providers[0]
    if (isMap(only) && !Object.hasOwn(only, 'kind')) {
      throw refused('the vault entry in station.json does not name its kind')
    }
    const kind = isMap(only) ? only.kind : only
    if (!isMap(only) || 'minivault' !== kind) {
      throw refused('likeness reads secrets from its vault alone, and station.json names the store "' +
        ('string' === typeof kind ? kind : renderRaw(kind)) + '"')
    }
    if (Object.hasOwn(only, 'passphrase')) {
      throw refused('station.json holds the vault\'s passphrase, and a passphrase is never written to a file',
        'remove it, and set ' + PASSPHRASE_ENV + ' or name a variable with --passphrase-env')
    }
    const extra = Object.keys(only).filter(k => !ENTRY_KEYS.includes(k)).sort(compareCodePoints)
    if (0 < extra.length) {
      throw refused('the vault entry in station.json has no key "' + extra[0] + '"',
        'the vault entry takes kind, file and vaultkey')
    }
    if (undefined !== only.file && ('string' !== typeof only.file || '' === only.file)) {
      throw refused('the vault entry\'s file is not a path', 'name the file: "file": "likeness.skmv"')
    }
    if (undefined !== only.vaultkey && ('string' !== typeof only.vaultkey || !KEY_RE.test(only.vaultkey))) {
      throw refused('the vault entry\'s vaultkey is not a key name', 'a key name is [a-z][a-z0-9-]*')
    }
    entry = only
  }

  const file = located('string' === typeof entry.file ? entry.file : DEFAULT_FILE, opts.home, opts.dir)
  const key = opts.key ?? ('string' === typeof entry.vaultkey ? entry.vaultkey : 'master')
  return { file, key, shown: shown(file, opts.home) }
}

function present (entry: VaultEntry): void {
  if (!existsSync(entry.file)) {
    throw new LikenessError('secret-backend-unavailable', 'no vault at ' + entry.shown,
      'run `likeness secrets init` to create it, or point station.json at the vault')
  }
}

// The passphrase that opens the vault: from the environment, else typed.
async function passphrase (ask: Asker, flags: VaultFlags, key: string): Promise<string> {
  const name = flags.passphraseEnv ?? PASSPHRASE_ENV
  const value = ask.env?.[name]
  if (undefined !== value && '' !== value) return value
  if (true === ask.tty && undefined !== ask.prompt) {
    const typed = await ask.prompt('passphrase for ' + key)
    if (undefined === typed || '' === typed) {
      throw new LikenessError('vault-locked', 'no passphrase was given', 'run it again, and type the passphrase')
    }
    return typed
  }
  // The variable a flag named is not repeated: a passphrase given there by
  // mistake would otherwise be printed.
  throw new LikenessError('vault-locked', undefined === flags.passphraseEnv
    ? 'no passphrase: ' + PASSPHRASE_ENV + ' is not set, and stdin is not a terminal to ask on'
    : 'no passphrase: the variable --passphrase-env names is not set, and stdin is not a terminal to ask on',
  undefined === flags.passphraseEnv
    ? 'set ' + PASSPHRASE_ENV + ', or name another variable with --passphrase-env'
    : 'set that variable, or run on a terminal to be asked')
}

// A passphrase for a key being made, typed twice when it is typed at all.
async function newPassphrase (
  ask: Asker, flagged: string | undefined, fallback: string, flag: string, label: string,
): Promise<string> {
  const value = ask.env?.[flagged ?? fallback]
  if (undefined !== value && '' !== value) return value
  if (true === ask.tty && undefined !== ask.prompt) {
    const first = await ask.prompt(label)
    if (undefined === first || '' === first) {
      throw new LikenessError('invalid-argument', 'no passphrase was given', 'run it again, and type one')
    }
    if (first !== await ask.prompt('the same passphrase again')) {
      throw new LikenessError('invalid-argument', 'the two passphrases differ', 'run it again')
    }
    return first
  }
  throw new LikenessError('invalid-argument', undefined === flagged
    ? 'no passphrase for the new key: ' + fallback + ' is not set, and stdin is not a terminal to ask on'
    : 'no passphrase for the new key: the variable --' + flag + ' names is not set, and stdin is not a terminal to ask on',
  undefined === flagged
    ? 'set ' + fallback + ', or name another variable with --' + flag
    : 'set that variable, or run on a terminal to be asked')
}

function opened (entry: VaultEntry, phrase: string): { vault: MiniVault, info: VaultKeyInfo } {
  const vault = openvault({ file: entry.file, key: entry.key, passphrase: phrase })
  try {
    return { vault, info: vault.open() }
  }
  catch {
    throw new LikenessError('vault-locked',
      'the vault does not open as the key ' + entry.key +
        ': the passphrase is wrong, the key is not there, or the file is damaged',
      'check the passphrase, and the key --vault-key names')
  }
}

function written (entry: VaultEntry, write: () => void): void {
  try {
    write()
  }
  catch {
    throw new LikenessError('secret-backend-unavailable', 'the vault could not be written',
      'check that ' + dirname(entry.shown) + ' is writable and its disk has space')
  }
}

function master (info: VaultKeyInfo, action: string): void {
  if (!info.master) {
    throw new LikenessError('vault-denied',
      '`secrets ' + action + '` needs a master key, and ' + info.key + ' is restricted',
      'run it as the master key, with --vault-key')
  }
}

function sorted (names: string[]): string[] {
  return [...names].sort(compareCodePoints)
}

function role (k: VaultKeyInfo): string {
  return k.master ? 'master' : k.write ? 'write' : 'read'
}

// The chain station resolves a live connection's token through. Offline, the
// SDKs' test transport answers and nothing is resolved, so the chain is empty.
export async function vaultChain (
  ask: Asker, entry: VaultEntry, flags: VaultFlags,
): Promise<unknown[]> {
  present(entry)
  const phrase = await passphrase(ask, flags, entry.key)
  opened(entry, phrase).vault.close()
  return [{ kind: 'minivault', file: entry.file, vaultkey: entry.key, passphrase: phrase }]
}

export async function secrets (
  action: string, args: string[], entry: VaultEntry, ask: Asker, flags: VaultFlags,
): Promise<Answer> {
  if ('init' === action) {
    if (existsSync(entry.file)) {
      throw new LikenessError('vault-exists', entry.shown + ' already exists, and init never overwrites it',
        'use the vault that is there, or name another file in station.json')
    }
    const phrase = await newPassphrase(ask, flags.passphraseEnv, PASSPHRASE_ENV, 'passphrase-env',
      'new passphrase for ' + entry.key)
    written(entry, () => {
      mkdirSync(dirname(entry.file), { recursive: true, mode: 0o700 })
      createvault({ file: entry.file, key: entry.key, passphrase: phrase }).close()
    })
    return {
      data: { file: entry.shown, key: entry.key },
      count: 1,
      text: 'created the vault ' + entry.shown + ', with the key ' + entry.key + '\n',
    }
  }

  present(entry)
  const name = args[0]
  if ('set' === action && '-' !== args[1] && true !== ask.tty) {
    throw new LikenessError('invalid-argument',
      '`secrets set` reads the value from a terminal, or from stdin given as -',
      'pipe the value in, with - after the name')
  }

  const { vault, info } = opened(entry, await passphrase(ask, flags, entry.key))
  try {
    if ('list' === action) {
      const names = sorted(vault.list())
      return { data: names, count: names.length, text: names.map(n => n + '\n').join(''), empty: 0 === names.length }
    }

    if ('get' === action) {
      const value = vault.get(name)
      if (undefined === value) {
        throw new LikenessError('not-found', 'the vault has no ' + name + ' that the key ' + entry.key + ' can read',
          'run `likeness secrets list` for the names it can read')
      }
      return flags.reveal
        ? { data: { name, value }, count: 1, text: value + '\n' }
        : { data: { name }, count: 1, text: name + ' is set; --reveal prints its value\n' }
    }

    if ('set' === action) {
      if (!info.master) {
        if (!info.write) {
          throw new LikenessError('vault-denied', 'the key ' + entry.key + ' is read-only',
            'run it as the master key, or as one granted --write')
        }
        if (!info.grants.includes(name)) {
          throw new LikenessError('vault-denied', 'the key ' + entry.key + ' was not granted ' + name,
            'run it as the master key, or as a key granted that name')
        }
        if (!vault.list().includes(name)) {
          throw new LikenessError('vault-denied',
            'only a master key creates a secret, and ' + name + ' is not in the vault',
            'set it once as the master key')
        }
      }
      const given = '-' === args[1]
        ? await ask.stdin?.()
        : await ask.prompt?.('value for ' + name)
      // One line ending goes: `echo token |` should store the token.
      const value = (given ?? '').replace(/\r?\n$/, '')
      if ('' === value) {
        throw new LikenessError('invalid-argument', 'the value is empty',
          'a secret needs a value; `likeness secrets remove` drops one')
      }
      written(entry, () => vault.set(name, value))
      return { data: { name }, count: 1, text: 'set ' + name + '\n' }
    }

    if ('remove' === action) {
      master(info, action)
      if (!vault.list().includes(name)) {
        throw new LikenessError('not-found', 'the vault has no ' + name + ' that the key ' + entry.key + ' can read',
          'run `likeness secrets list` for the names it can read')
      }
      written(entry, () => vault.remove(name))
      return { data: { name }, count: 1, text: 'removed ' + name + '\n' }
    }

    if ('keys' === action) {
      master(info, action)
      const keys = vault.keys().sort((a, b) => compareCodePoints(a.key, b.key))
      const width = Math.max(...keys.map(k => k.key.length))
      const text = keys.map(k =>
        (k.key.padEnd(width) + '  ' + role(k).padEnd(6) + '  ' + k.grants.join(', ')).trimEnd() + '\n').join('')
      return { data: keys, count: keys.length, text }
    }

    if ('grant' === action) {
      master(info, action)
      const key = args[0]
      const names = sorted([...new Set(args.slice(1))])
      if (vault.keys().some(k => k.key === key)) {
        throw new LikenessError('vault-exists', 'the vault already has a key ' + key,
          'revoke it first, or choose another name')
      }
      const phrase = await newPassphrase(ask, flags.newPassphraseEnv, NEW_PASSPHRASE_ENV, 'new-passphrase-env',
        'passphrase for the new key ' + key)
      written(entry, () => vault.grant({ key, passphrase: phrase, names, write: flags.write }))
      return {
        data: { grants: names, key, write: flags.write },
        count: 1,
        text: 'granted ' + key + ', ' + (flags.write ? 'reading and writing ' : 'reading ') + names.join(', ') + '\n',
      }
    }

    if ('revoke' === action) {
      master(info, action)
      const key = args[0]
      if (key === entry.key) {
        throw new LikenessError('vault-denied', key + ' cannot revoke itself',
          '`likeness secrets rotate` withdraws every other key')
      }
      if (!vault.keys().some(k => k.key === key)) {
        throw new LikenessError('not-found', 'the vault has no key ' + key,
          'run `likeness secrets keys` for the keys there are')
      }
      written(entry, () => vault.revoke(key))
      return { data: { key }, count: 1, text: 'revoked ' + key + '\n' }
    }

    if ('rotate' === action) {
      master(info, action)
      const dropped = sorted(vault.keys().map(k => k.key).filter(k => k !== entry.key))
      written(entry, () => vault.rotate())
      return {
        data: { dropped },
        count: 1,
        text: 'rotated the vault' + (0 < dropped.length ? '; dropped ' + dropped.join(', ') : '') + '\n',
      }
    }

    throw new Error('no such secrets action: ' + action)
  }
  finally {
    vault.close()
  }
}

