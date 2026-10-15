"""The sources group's writes, beyond what a transcript can show: both files or
neither, a symlink kept, a probe that writes nothing, an account asked of its
source, and the argv shell's --config."""

from __future__ import annotations

import copy
import errno
import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import types
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest import mock
from urllib.parse import urlsplit

from likeness.adapter import joplin
from likeness.adapters import ADAPTERS
from likeness.calls import Call
from likeness.caps import caps
from likeness.config import OS_FS, Fs, Held, Write, WriteError, load_config, parse_accounts, write_all
from likeness.core import Ctx, run
from likeness.identity import lid
from likeness.pin import fingerprint_of, presented_fingerprint
from tests.harness import ROOT, Terminal, binary, build_ctx, entries, located
from tests.test_wire_obsidian import CERT, OTHER, Counting

MASTER = 'fixture master passphrase'
NOTE = 'a0e50000000000000000000000000001'
ALL = entries('cli')


def entry(id: str) -> dict[str, Any]:
    found = [e for e in ALL if e['id'] == id]
    assert found, 'no corpus entry with id ' + id
    return copy.deepcopy(found[0])


def seed(name: str) -> dict[str, Any]:
    s = json.loads((ROOT / 'fixtures' / 'sources' / name / 'seed.json').read_text(encoding='utf-8'))
    del s['_doc']
    return s


def failing(nth: int) -> Fs:
    """The system's own file operations, but for the nth rename, which fails as a full disk would."""
    renames = 0

    def rename(src: str, dst: str) -> None:
        nonlocal renames
        renames += 1
        if nth == renames:
            raise OSError(errno.ENOSPC, 'no space left on device')
        os.replace(src, dst)

    return replace(OS_FS, rename=rename)


def folder(test: unittest.TestCase, files: dict[str, str]) -> str:
    dir = tempfile.mkdtemp(prefix='likeness-write-')
    test.addCleanup(shutil.rmtree, dir, True)
    for name, text in files.items():
        Path(dir, name).write_text(text, encoding='utf-8')
    return dir


def held(path: str) -> Held:
    data = Path(path).read_bytes()
    return Held(data.decode('utf-8'), data, stat.S_IMODE(os.stat(path).st_mode))


def read(*path: str) -> str:
    return Path(*path).read_text(encoding='utf-8')


def both(ctx: Ctx) -> list[bytes]:
    return [Path(located(ctx, name)).read_bytes() for name in ('station.json', 'likeness.json')]


def vault_names(ctx: Ctx, file: str = 'likeness.skmv') -> list[str]:
    from voxgig_sekreto.plugins.minivault import openvault
    return list(openvault({'file': located(ctx, file), 'key': 'master', 'passphrase': MASTER}).list())


def after(ctx: Ctx, argv: list[str], seeded: str) -> tuple[int, Any]:
    """The next command, run over what the files now say, with the SDK's offline transport seeded."""
    station, accounts = load_config(located(ctx, 'station.json'), 'default')
    r = run(Ctx(argv=argv, clock='2026-10-15T00:00:00Z', station=station, accounts=accounts,
                fixture={seeded: seed('joplin')}, home=ctx.home, dir=ctx.dir))
    return r.exit, json.loads(r.stdout)


class Writer(unittest.TestCase):
    def test_a_second_rename_that_fails_puts_the_first_file_back_and_leaves_no_temporary_file(self) -> None:
        dir = folder(self, {'likeness.json': 'old likeness\n', 'station.json': 'old station\n'})
        likeness, station = os.path.join(dir, 'likeness.json'), os.path.join(dir, 'station.json')
        with self.assertRaises(WriteError) as raised:
            write_all([Write(likeness, 'new likeness\n', held(likeness)),
                       Write(station, 'new station\n', held(station))], failing(2))
        self.assertEqual((True, station), (raised.exception.restored, raised.exception.path))
        self.assertEqual(['old likeness\n', 'old station\n'], [read(likeness), read(station)])
        self.assertEqual(['likeness.json', 'station.json'], sorted(os.listdir(dir)))

    def test_a_file_that_was_not_there_is_gone_again_when_the_rename_after_it_fails(self) -> None:
        dir = folder(self, {'station.json': 'old station\n'})
        station = os.path.join(dir, 'station.json')
        with self.assertRaises(WriteError):
            write_all([Write(os.path.join(dir, 'likeness.json'), 'new likeness\n'),
                       Write(station, 'new station\n', held(station))], failing(2))
        self.assertEqual(['station.json'], os.listdir(dir))
        self.assertEqual('old station\n', read(station))

    def test_a_first_rename_that_fails_changes_nothing_and_a_write_that_succeeds_keeps_each_mode(self) -> None:
        dir = folder(self, {'likeness.json': 'old likeness\n', 'station.json': 'old station\n'})
        likeness, station = os.path.join(dir, 'likeness.json'), os.path.join(dir, 'station.json')

        def writes() -> list[Write]:
            return [Write(likeness, 'new likeness\n', held(likeness)),
                    Write(station, 'new station\n', replace(held(station), mode=0o640))]

        with self.assertRaises(WriteError):
            write_all(writes(), failing(1))
        self.assertEqual(['old likeness\n', 'old station\n'], [read(likeness), read(station)])
        write_all(writes())
        self.assertEqual(['new likeness\n', 'new station\n'], [read(likeness), read(station)])
        self.assertEqual(0o640, stat.S_IMODE(os.stat(station).st_mode))
        self.assertEqual(['likeness.json', 'station.json'], sorted(os.listdir(dir)))


class Sources(unittest.TestCase):
    def test_add_whose_second_rename_fails_changes_neither_file_and_takes_its_token_out_of_the_vault(
            self) -> None:
        ctx = build_ctx(entry('connections/add-keeps-the-file'))
        before = both(ctx)
        ctx.fs = failing(2)
        r = run(ctx)
        self.assertEqual(3, r.exit, r.stdout)
        env = json.loads(r.stdout)
        self.assertEqual('invalid-project', env['code'])
        self.assertEqual('~/.config/likeness/station.json could not be written, and nothing was changed',
                         env['error']['message'])
        self.assertEqual(before, both(ctx))
        assert ctx.dir is not None
        self.assertEqual(['likeness.json', 'likeness.skmv', 'station.json'], sorted(os.listdir(ctx.dir)))
        self.assertEqual(['joplin.apikey', 'notion.apikey'], vault_names(ctx))

    def test_into_a_home_with_no_configuration_a_failed_second_rename_leaves_neither_file_behind(self) -> None:
        ctx = build_ctx(entry('connections/add-joplin'))
        ctx.fs = failing(2)
        self.assertEqual(3, run(ctx).exit)
        assert ctx.dir is not None
        self.assertEqual(['likeness.skmv'], os.listdir(ctx.dir))
        self.assertEqual(['joplin.apikey', 'notion.apikey'], vault_names(ctx))

    def test_a_configuration_file_that_is_a_symlink_is_written_where_it_points_and_stays_one(self) -> None:
        ctx = build_ctx(entry('connections/add-keeps-the-file'))
        dotfiles = tempfile.mkdtemp(prefix='likeness-dotfiles-')
        self.addCleanup(shutil.rmtree, dotfiles, True)
        names = ('station.json', 'likeness.json')
        for name in names:
            os.rename(located(ctx, name), os.path.join(dotfiles, name))
            os.symlink(os.path.join(dotfiles, name), located(ctx, name))
        self.assertEqual(0, run(ctx).exit)
        for name in names:
            self.assertTrue(os.path.islink(located(ctx, name)), name + ' is still a link')
            self.assertEqual(
                (ROOT / 'spec' / 'written' / 'connections' / 'add-keeps-the-file' / name).read_bytes(),
                Path(dotfiles, name).read_bytes(), name)
        self.assertEqual(['likeness.json', 'station.json'], sorted(os.listdir(dotfiles)))

    def test_a_remove_or_a_rename_whose_second_rename_fails_changes_neither_file(self) -> None:
        for id in ('connections/remove', 'connections/rename'):
            ctx = build_ctx(entry(id))
            before = both(ctx)
            ctx.fs = failing(2)
            self.assertEqual(3, run(ctx).exit, id)
            self.assertEqual(before, both(ctx), id)

    def test_a_connection_sources_add_writes_is_one_the_next_commands_read_and_reach(self) -> None:
        ctx = build_ctx(entry('connections/add-joplin'))
        self.assertEqual(0, run(ctx).exit)
        code, listed = after(ctx, ['list', '--json'], 'joplin$work')
        self.assertEqual(0, code)
        self.assertLess(0, len(listed['data']))
        for n in listed['data']:
            self.assertEqual('joplin$work', n['instance'])
            self.assertEqual(lid('joplin', 'local', 'note', n['id']), n['lid'])
        code, doctor = after(ctx, ['doctor', '--json'], 'joplin$work')
        self.assertEqual((0, 'ok', 1), (code, doctor['code'], len(doctor['data'])))

    def test_a_rename_changes_no_notes_lid_since_the_account_moves_with_the_ref(self) -> None:
        ctx = build_ctx(entry('connections/rename'))
        code, before = after(ctx, ['get', 'joplin$work:' + NOTE, '--json'], 'joplin$work')
        self.assertEqual(0, code)
        self.assertEqual(0, run(ctx).exit)
        code, renamed = after(ctx, ['get', 'joplin$office:' + NOTE, '--json'], 'joplin$office')
        self.assertEqual(0, code)
        self.assertEqual(before['data'][0]['lid'], renamed['data'][0]['lid'])
        self.assertEqual(lid('joplin', 'office', 'note', NOTE), before['data'][0]['lid'])

    def test_a_remove_leaves_no_account_behind_and_a_configuration_the_next_command_reads(self) -> None:
        ctx = build_ctx(entry('connections/remove'))
        self.assertEqual(0, run(ctx).exit)
        accounts = parse_accounts(read(located(ctx, 'likeness.json')), 'likeness.json', 'default')
        self.assertNotIn('joplin$work', accounts)
        _, listed = after(ctx, ['sources', 'list', '--json'], 'joplin')
        self.assertEqual(['joplin', 'joplin$a-b', 'notion$docs'], [r['instance'] for r in listed['data']])


class Plugin(Counting):
    """Counting, and told when each connection has been read to its end."""

    def __init__(self) -> None:
        self.read: list[threading.Event] = []
        super().__init__(CERT, None)

    def opened(self, at: int) -> None:
        super().opened(at)
        self.read.append(threading.Event())

    def ended(self, at: int) -> None:
        self.read[at].set()

    def counted(self) -> list[int]:
        """Bounded, so a connection left open fails the test rather than hanging it."""
        for e in self.read:
            e.wait(5)
        return list(self.bytes)


class Probe(unittest.TestCase):
    def setUp(self) -> None:
        self.server = Plugin()
        self.addCleanup(self.server.close)
        self.base = 'https://127.0.0.1:' + str(urlsplit(self.server.url).port)

    def test_add_pins_the_certificate_the_plugin_presents_read_by_a_probe_that_writes_nothing_to_it(
            self) -> None:
        e = entry('connections/add-obsidian-confirmed')
        e['args'] = ['sources', 'add', '--source', 'obsidian', '--account', 'wirevault', '--base', self.base, '--json']
        ctx = build_ctx(e)
        ctx.presented = presented_fingerprint
        r = run(ctx)
        self.assertEqual(0, r.exit, r.stdout)
        pinned = json.loads(read(located(ctx, 'station.json')))['profiles']['default']['sdk']['obsidian']
        self.assertEqual({'base': self.base, 'options': {'tls': {'fingerprint': fingerprint_of(CERT.der)}}}, pinned)
        assert isinstance(ctx.prompt, Terminal)
        self.assertEqual('obsidian at ' + self.base + ' presents ' + fingerprint_of(CERT.der) + '; type yes to pin it',
                         ctx.prompt.shown[0])
        self.assertEqual([0], self.server.counted())

    def test_a_fingerprint_the_plugin_does_not_present_is_refused_and_nothing_is_written(self) -> None:
        e = entry('connections/add-obsidian-fingerprint-differs')
        e['args'] = ['sources', 'add', '--source', 'obsidian', '--account', 'wirevault', '--base', self.base,
                     '--fingerprint', fingerprint_of(OTHER.der), '--json']
        ctx = build_ctx(e)
        ctx.presented = presented_fingerprint
        r = run(ctx)
        self.assertEqual((4, 'certificate-rejected'), (r.exit, json.loads(r.stdout)['code']))
        self.assertFalse(os.path.exists(located(ctx, 'station.json')))
        self.assertEqual([0], self.server.counted())


class Confirm(unittest.TestCase):
    def test_an_answer_is_trimmed_as_the_canonical_port_trims_it_and_str_strip_does_not(self) -> None:
        for typed, exit in (('﻿yes ', 0), (' Y\t', 0), ('yes\x1c', 4), ('yess', 4)):
            e = entry('connections/add-obsidian-confirmed')
            e['ctx']['tty'] = [typed, 'typed-obsidian-token']
            self.assertEqual(exit, run(build_ctx(e)).exit, repr(typed))


class Discovery(unittest.TestCase):
    def test_where_the_capability_data_says_a_source_names_its_account_it_is_asked_and_account_refused(
            self) -> None:
        def account(client: Any) -> str:
            client.Note().list({})
            return 'discovered-profile'

        stub = types.SimpleNamespace(**{k: v for k, v in vars(joplin).items() if not k.startswith('__')},
                                     account=account)
        with mock.patch.dict(caps()['joplin']['connect']['account'], {'discover': True}), \
                mock.patch.dict(ADAPTERS, {'joplin': stub}):
            e = entry('connections/add-joplin')
            e['args'] = ['sources', 'add', '--source', 'joplin', '--instance', 'work', '--json']
            ctx = build_ctx(e)
            ctx.fixture = {'joplin$work': seed('joplin')}
            r = run(ctx)
            self.assertEqual(0, r.exit, r.stdout)
            self.assertEqual([Call('joplin$work', 'GET', '/notes')], r.calls)
            accounts = parse_accounts(read(located(ctx, 'likeness.json')), 'likeness.json', 'default')
            self.assertEqual({'joplin$work': 'discovered-profile'}, accounts)

            refused = run(build_ctx(entry('connections/add-joplin')))
            self.assertEqual((3, 'invalid-argument'), (refused.exit, json.loads(refused.stdout)['code']))


class ArgvShell(unittest.TestCase):
    def test_station_json_is_written_where_config_names_it_and_likeness_json_beside_it(self) -> None:
        home = tempfile.mkdtemp(prefix='likeness-')
        self.addCleanup(shutil.rmtree, home, True)
        dir = os.path.join(home, 'elsewhere')
        os.mkdir(dir)
        shutil.copyfile(ROOT / 'fixtures' / 'vault' / 'likeness.skmv', os.path.join(dir, 'likeness.skmv'))
        config = os.path.join(dir, 'my-station.json')
        env = {'HOME': home, 'PATH': os.environ.get('PATH', ''), 'LIKENESS_PASSPHRASE': MASTER}

        def likeness(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run([str(binary()), *args, '--json', '--config', config], cwd=home, env=env,
                                  stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False)

        added = likeness('sources', 'add', '--source', 'joplin', '--account', 'local', '--secret', 'joplin.apikey')
        self.assertEqual(0, added.returncode, added.stdout + added.stderr)
        self.assertEqual({'joplin': {'base': 'http://127.0.0.1:41184'}},
                         json.loads(read(config))['profiles']['default']['sdk'])
        self.assertEqual({'joplin': {'account': 'local'}},
                         json.loads(read(dir, 'likeness.json'))['profiles']['default']['instances'])
        listed = likeness('sources', 'list')
        self.assertEqual(0, listed.returncode, listed.stderr)
        self.assertEqual([{'account': 'local', 'base': 'http://127.0.0.1:41184', 'instance': 'joplin',
                           'secret': 'joplin.apikey', 'source': 'joplin'}], json.loads(listed.stdout)['data'])
