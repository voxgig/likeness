"""The corpus runner: a whole command in-process, held to the committed bytes."""

from __future__ import annotations

import atexit
import copy
import json
import os
import shutil
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from likeness.calls import Call
from likeness.config import load_config
from likeness.core import PORT, Ctx, run
from likeness.envelope import SerialiseError, serialise, strip_parity_exceptions
from likeness.station import profile_of

ROOT = Path(__file__).resolve().parents[2]


def binary() -> Path:
    """The console script `make py-deps` installs beside the interpreter."""
    return Path(sys.executable).with_name('likeness-py')


def corpus(name: str) -> dict[str, Any]:
    doc = json.loads((ROOT / 'spec' / (name + '.json')).read_text(encoding='utf-8'))
    return doc['primary'][name]


def entries(name: str) -> list[dict[str, Any]]:
    groups = corpus(name)
    out: list[dict[str, Any]] = []
    for g in sorted(groups):
        out.extend(groups[g]['set'])
    return out


_HOMES: list[str] = []
atexit.register(lambda: [shutil.rmtree(h, ignore_errors=True) for h in _HOMES])


class Terminal:
    """Answers each prompt with the next typed line, and keeps the labels it showed."""

    def __init__(self, typed: list[str]) -> None:
        self.typed = list(typed)
        self.shown: list[str] = []

    def __call__(self, label: str) -> str | None:
        self.shown.append(label)
        return self.typed.pop(0) if self.typed else None


def _seed(name: str) -> dict[str, Any]:
    seed = json.loads((ROOT / 'fixtures' / 'sources' / name / 'seed.json').read_text(encoding='utf-8'))
    del seed['_doc']
    return seed


def located(ctx: Ctx, name: str) -> str:
    """A file the entry names: under the home with `~/`, else in the configuration directory."""
    assert ctx.home is not None and ctx.dir is not None
    return os.path.join(ctx.home, name[2:]) if name.startswith('~/') else os.path.join(ctx.dir, name)


_CONFIG_FILES = ('station.json', 'likeness.json')


def _probe(presents: dict[str, str]) -> Callable[[str], str]:
    """Keyed by host:port, the port written out even where it is the scheme's."""
    def presented(base: str) -> str:
        url = urlsplit(base)
        host = url.hostname or ''
        at = ('[' + host + ']' if ':' in host else host) + ':' + str(url.port or 443)
        if at not in presents:
            raise ConnectionRefusedError('nothing answers at ' + at)
        return presents[at]
    return presented


def build_ctx(e: dict[str, Any]) -> Ctx:
    """Each connection becomes a declared station instance, its block the one
    the entry gives, its account the likeness.json entry beside it, and its
    seed, its own or the entry's, the SDK's offline transport. Every run gets a
    home of its own, holding the entry's files; an entry that brings
    station.json or likeness.json is configured by them alone, read as the argv
    shell reads them."""
    ectx = e['ctx']

    sdk: dict[str, Any] = {}
    accounts: dict[str, str] = {}
    fixture: dict[str, Any] = {}
    for c in ectx['connections']:
        sdk[c['instance']] = copy.deepcopy(c.get('block', {}))
        accounts[c['instance']] = c['account']
        own = _seed(c.get('fixture', ectx['fixture']))
        if 'net' in c:
            own['net'] = c['net']
        fixture[c['instance']] = own

    home = tempfile.mkdtemp(prefix='likeness-')
    _HOMES.append(home)
    dir = os.path.join(home, '.config', 'likeness')
    os.makedirs(dir)
    for name, src in ectx.get('files', {}).items():
        dst = os.path.join(home, name[2:]) if name.startswith('~/') else os.path.join(dir, name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(ROOT / src, dst)

    profile: dict[str, Any] = {'sdk': sdk}
    if 'secrets' in ectx:
        profile['secrets'] = ectx['secrets']
    station: Any = {'station': 1, 'profiles': {'default': profile}}
    read = accounts
    if any(name in _CONFIG_FILES for name in ectx.get('files', {})):
        if ectx['connections'] or 'secrets' in ectx:
            raise AssertionError(e['id'] + ': an entry that brings its configuration declares no connections or secrets')
        station, read = load_config(os.path.join(dir, 'station.json'), profile_of(ectx.get('env')))

    stdin = ectx.get('stdin', '')
    ctx = Ctx(
        argv=list(e['args']),
        env=ectx.get('env'),
        clock=ectx['clock'],
        seed=ectx['seed'],
        station=station,
        accounts=read,
        fixture=fixture,
        # Absent stays absent: being told about nothing is a different case
        # from being told about an empty list.
        path=ectx.get('path'),
        home=home,
        dir=dir,
        config=os.path.join(dir, 'station.json'),
        stdin=lambda: stdin,
        presented=_probe(ectx.get('presents', {})),
    )

    if 'tty' in ectx:
        ctx.tty = True
        ctx.prompt = Terminal(ectx['tty'])
    return ctx


def _vault_failures(e: dict[str, Any], ctx: Ctx, fail: Callable[[str], None]) -> None:
    want = e['out'].get('vault')
    if want is None:
        return
    from voxgig_sekreto.plugins.minivault import openvault

    file = located(ctx, want.get('file', 'likeness.skmv'))
    try:
        vault = openvault({'file': file, 'key': want.get('key', 'master'), 'passphrase': want['passphrase']})
        names = vault.list()
    except Exception as err:
        fail('the vault does not open afterwards: ' + str(err))
        return
    if names != want['names']:
        fail('vault names ' + _compact(names) + ', expected ' + _compact(want['names']))
    if 'keys' in want:
        keys = sorted(vault.keys(), key=lambda k: k['key'])
        expected = [{'key': k['key'], 'master': k['master'], 'write': k['write'], 'grants': k['grants']}
                    for k in want['keys']]
        # As canonical bytes, so `true` and `1` stay different answers.
        if serialise(keys) != serialise(expected):
            fail('vault keys ' + _compact(keys) + ', expected ' + _compact(want['keys']))
    for name, value in want.get('values', {}).items():
        if vault.get(name) != value:
            fail('vault value of ' + name + ' is not the one expected')


def _file_failures(e: dict[str, Any], ctx: Ctx, fail: Callable[[str], None]) -> None:
    """The configuration directory afterwards: each named file byte for byte,
    and the absent ones not there."""
    for name, want in e['out'].get('files', {}).items():
        at = located(ctx, name)
        if not os.path.exists(at):
            fail(name + ' is not there afterwards, and ' + want + ' says what it holds')
        elif Path(at).read_bytes() != (ROOT / want).read_bytes():
            fail(name + ' differs from ' + want)
    for name in e['out'].get('absent', []):
        if os.path.exists(located(ctx, name)):
            fail(name + ' is there afterwards, and the entry says it is not')


def _compact(v: Any) -> str:
    return json.dumps(v, separators=(',', ':'))


def _refuse_constant(name: str) -> Any:
    raise ValueError('not JSON: ' + name)


def check_stdout(e: dict[str, Any], actual: str, fail: Callable[[str], None]) -> None:
    rel = e['out']['stdout']
    want = (ROOT / rel).read_text(encoding='utf-8')

    if not rel.endswith('.json'):
        if actual != want:
            fail('stdout bytes differ from ' + rel)
        return

    try:
        parsed = json.loads(actual, parse_constant=_refuse_constant)
    except ValueError:
        fail('stdout is not JSON, and ' + rel + ' says it should be')
        return

    # Raw bytes first: indented or CRLF output carries the right values in the
    # wrong bytes, and a value comparison alone would let that through.
    try:
        canonical = serialise(parsed)
    except SerialiseError as err:
        fail('stdout cannot be re-rendered: ' + str(err))
        return
    if actual != canonical:
        fail('stdout is not in canonical form (sorted keys, one line, one trailing newline): ' +
             json.dumps(actual[:80]))

    # Removed from the comparison, so asserted here instead.
    if not isinstance(parsed, dict) or PORT != parsed.get('port'):
        fail('envelope port is ' + json.dumps(parsed.get('port') if isinstance(parsed, dict) else None) +
             ', expected "' + PORT + '"')
    data = parsed.get('data') if isinstance(parsed, dict) else None
    if isinstance(data, dict) and 'port' in data and PORT != data['port']:
        fail('data.port is ' + json.dumps(data['port']) + ', expected "' + PORT + '"')
    meta = parsed.get('meta') if isinstance(parsed, dict) else None
    elapsed = meta.get('elapsed_ms') if isinstance(meta, dict) else None
    if not isinstance(elapsed, int) or isinstance(elapsed, bool) or elapsed < 0:
        fail('meta.elapsed_ms is ' + json.dumps(elapsed) + ', expected a non-negative integer')

    got = serialise(strip_parity_exceptions(parsed))
    if got != want:
        fail('stdout differs from ' + rel +
             '\n  want ' + want.rstrip('\n') + '\n  got  ' + got.rstrip('\n'))


def stdout_failures(e: dict[str, Any], actual: str) -> list[str]:
    """The stdout checks alone, over bytes no port produced, for the meta-tests."""
    out: list[str] = []
    check_stdout(e, actual, out.append)
    return out


def check(e: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    fail = failures.append

    ctx = build_ctx(e)
    r = run(ctx)

    if r.exit != e['out']['exit']:
        fail('exit ' + str(r.exit) + ', expected ' + str(e['out']['exit']))
    check_stdout(e, r.stdout, fail)

    want_err = e['out'].get('stderr', '')
    if r.stderr != want_err:
        fail('stderr ' + json.dumps(r.stderr) + ', expected ' + json.dumps(want_err))

    got = [c.value() for c in r.calls]
    want = [Call(c['instance'], c['method'], c['path']).value() for c in e['out']['calls']]
    if got != want:
        fail('calls ' + _compact(got) + ', expected ' + _compact(want))

    prompts = ctx.prompt.shown if isinstance(ctx.prompt, Terminal) else []
    if prompts != e['out'].get('prompts', []):
        fail('prompts ' + _compact(prompts) + ', expected ' + _compact(e['out'].get('prompts', [])))

    _vault_failures(e, ctx, fail)
    _file_failures(e, ctx, fail)
    return failures


def parity_dir() -> str | None:
    return os.environ.get('LIKENESS_PARITY_OUT') or None
