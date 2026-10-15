import { test } from 'node:test'
import assert from 'node:assert'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { openvault } from '@voxgig/sekreto/plugins/minivault'

import { buildCtx, entries, located, PROMPTS, ROOT, type CliEntry } from './harness.js'
import { selfSigned, type Throwaway } from './cert.js'
import { run, type Ctx } from '../src/core.js'
import { NODE_FS, WriteError, loadConfig, parseAccounts, writeAll, type Fs } from '../src/config.js'
import { lid } from '../src/identity.js'
import { fingerprintOf, presentedFingerprint } from '../src/pin.js'
import { ADAPTERS } from '../src/adapters.js'
import { caps } from '../src/caps.js'
import * as joplin from '../src/adapter/joplin.js'

const MASTER = 'fixture master passphrase'
const NOTE = 'a0e50000000000000000000000000001'
const all = entries<CliEntry>('cli')

function entry (id: string): CliEntry {
  const e = all.find(x => x.id === id)
  assert.ok(undefined !== e, 'no corpus entry with id ' + id)
  return JSON.parse(JSON.stringify(e)) as CliEntry
}

function seed (name: string): Record<string, unknown> {
  const s = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'sources', name, 'seed.json'), 'utf8'))
  delete s._doc
  return s
}

// Node's own file operations, but for the nth rename, which fails as a full disk would.
function failing (nth: number): Fs {
  let renames = 0
  return {
    ...NODE_FS,
    renameSync: ((from: string, to: string) => {
      if (nth === ++renames) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      renameSync(from, to)
    }) as Fs['renameSync'],
  }
}

function folder (files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'likeness-write-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

function held (path: string): { bytes: Buffer, mode: number } {
  return { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }
}

function vaultNames (ctx: Ctx, file = 'likeness.skmv'): string[] {
  return openvault({ file: located(ctx, file), passphrase: MASTER }).list()
}

test('a second rename that fails puts the first file back, and leaves no temporary file', () => {
  const dir = folder({ 'likeness.json': 'old likeness\n', 'station.json': 'old station\n' })
  try {
    const likeness = join(dir, 'likeness.json')
    const station = join(dir, 'station.json')
    assert.throws(() => writeAll([
      { path: likeness, text: 'new likeness\n', was: held(likeness) },
      { path: station, text: 'new station\n', was: held(station) },
    ], failing(2)), (err: unknown) => err instanceof WriteError && err.restored && station === err.path)
    assert.equal(readFileSync(likeness, 'utf8'), 'old likeness\n')
    assert.equal(readFileSync(station, 'utf8'), 'old station\n')
    assert.deepStrictEqual(readdirSync(dir).sort(), ['likeness.json', 'station.json'])
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a file that was not there is gone again when the rename after it fails', () => {
  const dir = folder({ 'station.json': 'old station\n' })
  try {
    assert.throws(() => writeAll([
      { path: join(dir, 'likeness.json'), text: 'new likeness\n' },
      { path: join(dir, 'station.json'), text: 'new station\n', was: held(join(dir, 'station.json')) },
    ], failing(2)), WriteError)
    assert.deepStrictEqual(readdirSync(dir), ['station.json'])
    assert.equal(readFileSync(join(dir, 'station.json'), 'utf8'), 'old station\n')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a first rename that fails changes nothing, and a write that succeeds keeps each file\'s mode', () => {
  const dir = folder({ 'likeness.json': 'old likeness\n', 'station.json': 'old station\n' })
  try {
    const likeness = join(dir, 'likeness.json')
    const station = join(dir, 'station.json')
    const writes = (): Parameters<typeof writeAll>[0] => [
      { path: likeness, text: 'new likeness\n', was: held(likeness) },
      { path: station, text: 'new station\n', was: { ...held(station), mode: 0o640 } },
    ]
    assert.throws(() => writeAll(writes(), failing(1)), WriteError)
    assert.deepStrictEqual([readFileSync(likeness, 'utf8'), readFileSync(station, 'utf8')], ['old likeness\n', 'old station\n'])
    writeAll(writes())
    assert.deepStrictEqual([readFileSync(likeness, 'utf8'), readFileSync(station, 'utf8')], ['new likeness\n', 'new station\n'])
    assert.equal(statSync(station).mode & 0o777, 0o640)
    assert.deepStrictEqual(readdirSync(dir).sort(), ['likeness.json', 'station.json'])
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sources add whose second rename fails changes neither file, and takes its token out of the vault', async () => {
  const ctx = buildCtx(entry('connections/add-keeps-the-file'))
  const before = [readFileSync(located(ctx, 'station.json')), readFileSync(located(ctx, 'likeness.json'))]
  ctx.fs = failing(2)
  const r = await run(ctx)
  assert.equal(r.exit, 3, r.stdout)
  const env = JSON.parse(r.stdout)
  assert.equal(env.code, 'invalid-project')
  assert.equal(env.error.message, '~/.config/likeness/station.json could not be written, and nothing was changed')
  assert.deepStrictEqual([readFileSync(located(ctx, 'station.json')), readFileSync(located(ctx, 'likeness.json'))], before)
  assert.deepStrictEqual(readdirSync(ctx.dir as string).sort(), ['likeness.json', 'likeness.skmv', 'station.json'])
  assert.deepStrictEqual(vaultNames(ctx), ['joplin.apikey', 'notion.apikey'])
})

test('into a home with no configuration, a failed second rename leaves neither file behind', async () => {
  const ctx = buildCtx(entry('connections/add-joplin'))
  ctx.fs = failing(2)
  assert.equal((await run(ctx)).exit, 3)
  assert.deepStrictEqual(readdirSync(ctx.dir as string), ['likeness.skmv'])
  assert.deepStrictEqual(vaultNames(ctx), ['joplin.apikey', 'notion.apikey'])
})

test('a configuration file that is a symlink is written where it points, and stays a symlink', async () => {
  const ctx = buildCtx(entry('connections/add-keeps-the-file'))
  const dotfiles = mkdtempSync(join(tmpdir(), 'likeness-dotfiles-'))
  try {
    for (const name of ['station.json', 'likeness.json']) {
      renameSync(located(ctx, name), join(dotfiles, name))
      symlinkSync(join(dotfiles, name), located(ctx, name))
    }
    assert.equal((await run(ctx)).exit, 0)
    for (const name of ['station.json', 'likeness.json']) {
      assert.ok(lstatSync(located(ctx, name)).isSymbolicLink(), name + ' is still a link')
      assert.deepStrictEqual(readFileSync(join(dotfiles, name)),
        readFileSync(join(ROOT, 'spec', 'written', 'connections', 'add-keeps-the-file', name)), name)
    }
    assert.deepStrictEqual(readdirSync(dotfiles).sort(), ['likeness.json', 'station.json'])
  }
  finally { rmSync(dotfiles, { recursive: true, force: true }) }
})

test('a remove or a rename whose second rename fails changes neither file', async () => {
  for (const id of ['connections/remove', 'connections/rename']) {
    const ctx = buildCtx(entry(id))
    const before = [readFileSync(located(ctx, 'station.json')), readFileSync(located(ctx, 'likeness.json'))]
    ctx.fs = failing(2)
    assert.equal((await run(ctx)).exit, 3, id)
    assert.deepStrictEqual([readFileSync(located(ctx, 'station.json')), readFileSync(located(ctx, 'likeness.json'))], before, id)
  }
})

// The next command, run over what the files now say, with the SDK's offline transport seeded.
async function next (ctx: Ctx, argv: string[], seeded: string): Promise<any> {
  const loaded = loadConfig(located(ctx, 'station.json'), 'default')
  const r = await run({
    argv, clock: '2026-10-15T00:00:00Z', station: loaded.station, accounts: loaded.accounts,
    fixture: { [seeded]: seed('joplin') }, home: ctx.home, dir: ctx.dir,
  })
  return { exit: r.exit, env: JSON.parse(r.stdout) }
}

test('a connection sources add writes is one the next commands read and reach', async () => {
  const ctx = buildCtx(entry('connections/add-joplin'))
  assert.equal((await run(ctx)).exit, 0)
  const listed = await next(ctx, ['list', '--json'], 'joplin$work')
  assert.equal(listed.exit, 0)
  assert.ok(0 < listed.env.data.length)
  for (const n of listed.env.data) {
    assert.equal(n.instance, 'joplin$work')
    assert.equal(n.lid, lid('joplin', 'local', 'note', n.id))
  }
  const doctor = await next(ctx, ['doctor', '--json'], 'joplin$work')
  assert.deepStrictEqual([doctor.exit, doctor.env.code, doctor.env.data.length], [0, 'ok', 1])
})

test('a rename changes no note\'s lid, since the account moves with the ref', async () => {
  const ctx = buildCtx(entry('connections/rename'))
  const before = await next(ctx, ['get', 'joplin$work:' + NOTE, '--json'], 'joplin$work')
  assert.equal(before.exit, 0)
  assert.equal((await run(ctx)).exit, 0)
  const after = await next(ctx, ['get', 'joplin$office:' + NOTE, '--json'], 'joplin$office')
  assert.equal(after.exit, 0)
  assert.equal(after.env.data[0].lid, before.env.data[0].lid)
  assert.equal(before.env.data[0].lid, lid('joplin', 'office', 'note', NOTE))
})

test('a remove leaves no account behind, and a configuration the next command reads', async () => {
  const ctx = buildCtx(entry('connections/remove'))
  assert.equal((await run(ctx)).exit, 0)
  const accounts = parseAccounts(readFileSync(located(ctx, 'likeness.json'), 'utf8'), 'likeness.json', 'default')
  assert.ok(!Object.hasOwn(accounts, 'joplin$work'))
  const listed = await next(ctx, ['sources', 'list', '--json'], 'joplin')
  assert.deepStrictEqual(listed.env.data.map((r: { instance: string }) => r.instance), ['joplin', 'joplin$a-b', 'notion$docs'])
})

// A TLS server counting the application bytes each connection sends it.
async function plugin (cert: Throwaway): Promise<{ base: string, bytes: number[], close: () => void }> {
  const bytes: number[] = []
  const open = new Set<Socket>()
  const server = tls.createServer({ key: cert.key, cert: cert.cert }, (socket) => {
    const at = bytes.length - 1
    socket.on('data', (d: Buffer) => { bytes[at] += d.length })
    socket.on('error', () => {})
  })
  server.on('connection', (raw: Socket) => {
    open.add(raw)
    raw.on('close', () => { open.delete(raw) })
    bytes.push(0)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  return {
    base: 'https://127.0.0.1:' + port,
    bytes,
    close: () => { for (const raw of open) raw.destroy(); server.close() },
  }
}

test('sources add pins the certificate the plugin presents, read by a probe that writes nothing to it', async () => {
  const cert = selfSigned()
  const server = await plugin(cert)
  try {
    const e = entry('connections/add-obsidian-confirmed')
    e.args = ['sources', 'add', '--source', 'obsidian', '--account', 'wirevault', '--base', server.base, '--json']
    const ctx = buildCtx(e)
    ctx.presented = presentedFingerprint
    const r = await run(ctx)
    assert.equal(r.exit, 0, r.stdout)
    const pinned = JSON.parse(readFileSync(located(ctx, 'station.json'), 'utf8')).profiles.default.sdk.obsidian
    assert.deepStrictEqual(pinned, { base: server.base, options: { tls: { fingerprint: fingerprintOf(cert.der) } } })
    assert.equal(PROMPTS.get(ctx)?.[0], 'obsidian at ' + server.base + ' presents ' + fingerprintOf(cert.der) + '; type yes to pin it')
    assert.deepStrictEqual(server.bytes, [0])
  }
  finally { server.close() }
})

test('a fingerprint the plugin does not present is refused, and nothing is written', async () => {
  const cert = selfSigned()
  const server = await plugin(cert)
  try {
    const e = entry('connections/add-obsidian-fingerprint-differs')
    e.args = ['sources', 'add', '--source', 'obsidian', '--account', 'wirevault', '--base', server.base,
      '--fingerprint', fingerprintOf(selfSigned().der), '--json']
    const ctx = buildCtx(e)
    ctx.presented = presentedFingerprint
    const r = await run(ctx)
    assert.deepStrictEqual([r.exit, JSON.parse(r.stdout).code], [4, 'certificate-rejected'])
    assert.ok(!existsSync(located(ctx, 'station.json')))
    assert.deepStrictEqual(server.bytes, [0])
  }
  finally { server.close() }
})

test('where the capability data says a source names its account, it is asked, and --account refused', async () => {
  const row = caps().joplin.connect.account
  const was = ADAPTERS.joplin
  row.discover = true
  ADAPTERS.joplin = { ...joplin, account: async (client: any) => { await client.Note().list({}); return 'discovered-profile' } }
  try {
    const e = entry('connections/add-joplin')
    e.args = ['sources', 'add', '--source', 'joplin', '--instance', 'work', '--json']
    const ctx = buildCtx(e)
    ctx.fixture = { 'joplin$work': seed('joplin') }
    const r = await run(ctx)
    assert.equal(r.exit, 0, r.stdout)
    assert.deepStrictEqual(r.calls, [{ instance: 'joplin$work', method: 'GET', path: '/notes' }])
    const accounts = parseAccounts(readFileSync(located(ctx, 'likeness.json'), 'utf8'), 'likeness.json', 'default')
    assert.deepStrictEqual(accounts, { 'joplin$work': 'discovered-profile' })

    const given = entry('connections/add-joplin')
    const refused = await run(buildCtx(given))
    assert.deepStrictEqual([refused.exit, JSON.parse(refused.stdout).code], [3, 'invalid-argument'])
  }
  finally {
    row.discover = false
    ADAPTERS.joplin = was
  }
})

test('the argv shell writes station.json where --config names it, and likeness.json beside it', () => {
  const home = mkdtempSync(join(tmpdir(), 'likeness-'))
  try {
    const dir = join(home, 'elsewhere')
    mkdirSync(dir)
    copyFileSync(join(ROOT, 'fixtures', 'vault', 'likeness.skmv'), join(dir, 'likeness.skmv'))
    const config = join(dir, 'my-station.json')
    const bin = join(ROOT, 'typescript', 'bin', 'likeness.js')
    const env = { HOME: home, PATH: process.env.PATH ?? '', LIKENESS_PASSPHRASE: MASTER }
    const added = spawnSync(process.execPath,
      [bin, 'sources', 'add', '--source', 'joplin', '--account', 'local', '--secret', 'joplin.apikey', '--json', '--config', config],
      { cwd: home, env, encoding: 'utf8' })
    assert.equal(added.status, 0, added.stdout + added.stderr)
    assert.deepStrictEqual(JSON.parse(readFileSync(config, 'utf8')).profiles.default.sdk,
      { joplin: { base: 'http://127.0.0.1:41184' } })
    assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, 'likeness.json'), 'utf8')).profiles.default.instances,
      { joplin: { account: 'local' } })
    const listed = spawnSync(process.execPath, [bin, 'sources', 'list', '--json', '--config', config],
      { cwd: home, env, encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    assert.deepStrictEqual(JSON.parse(listed.stdout).data,
      [{ account: 'local', base: 'http://127.0.0.1:41184', instance: 'joplin', secret: 'joplin.apikey', source: 'joplin' }])
  }
  finally { rmSync(home, { recursive: true, force: true }) }
})
