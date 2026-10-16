"""The transcript corpus's subject for omni: a whole command in-process, held to the committed bytes."""

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
from voxgig_omni import OmniError, makeRunner

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


def _vault_seen(want: dict[str, Any], ctx: Ctx, fault: Callable[[str], None]) -> Any:
    """The vault afterwards, as much of it as the entry asserts: its names, its
    keys if the entry gives them, and the values it names."""
    from voxgig_sekreto.plugins.minivault import openvault

    file = located(ctx, want.get('file', 'likeness.skmv'))
    try:
        vault = openvault({'file': file, 'key': want.get('key', 'master'), 'passphrase': want['passphrase']})
        seen: dict[str, Any] = {'names': vault.list()}
    except Exception as err:
        fault('the vault does not open afterwards: ' + str(err))
        return None
    if want['keys']:
        seen['keys'] = sorted(vault.keys(), key=lambda k: k['key'])
    if want['values']:
        seen['values'] = {name: vault.get(name) for name in want['values']}
    return seen


def _text(path: Path) -> str:
    """Bytes as a string, losslessly, so the comparison stays byte for byte."""
    return path.read_bytes().decode('utf-8', 'surrogateescape')


def _refuse_constant(name: str) -> Any:
    raise ValueError('not JSON: ' + name)


def seen_stdout(json_wanted: bool, actual: str, fault: Callable[[str], None]) -> str:
    """The stdout to compare: as printed, or for JSON the canonical bytes less
    the fields that may differ by port, each of those asserted here instead."""
    if not json_wanted:
        return actual

    try:
        parsed = json.loads(actual, parse_constant=_refuse_constant)
    except ValueError:
        fault('stdout is not JSON, and the entry says it should be')
        return actual

    # Raw bytes first: indented or CRLF output carries the right values in the
    # wrong bytes, and a value comparison alone would let that through.
    try:
        canonical = serialise(parsed)
    except SerialiseError as err:
        fault('stdout cannot be re-rendered: ' + str(err))
        return actual
    if actual != canonical:
        fault('stdout is not in canonical form (sorted keys, one line, one trailing newline): ' +
              json.dumps(actual[:80]))

    if not isinstance(parsed, dict) or PORT != parsed.get('port'):
        fault('envelope port is ' + json.dumps(parsed.get('port') if isinstance(parsed, dict) else None) +
              ', expected "' + PORT + '"')
    data = parsed.get('data') if isinstance(parsed, dict) else None
    if isinstance(data, dict) and 'port' in data and PORT != data['port']:
        fault('data.port is ' + json.dumps(data['port']) + ', expected "' + PORT + '"')
    meta = parsed.get('meta') if isinstance(parsed, dict) else None
    elapsed = meta.get('elapsed_ms') if isinstance(meta, dict) else None
    if not isinstance(elapsed, int) or isinstance(elapsed, bool) or elapsed < 0:
        fault('meta.elapsed_ms is ' + json.dumps(elapsed) + ', expected a non-negative integer')

    return serialise(strip_parity_exceptions(parsed))


def stdout_failures(e: dict[str, Any], actual: str) -> list[str]:
    """The stdout checks alone, over bytes no port produced, for the meta-tests."""
    out: list[str] = []
    rel = e['out']['stdout']
    if seen_stdout(rel.endswith('.json'), actual, out.append) != _text(ROOT / rel):
        out.append('stdout differs from ' + rel)
    return out


def resolved(e: dict[str, Any]) -> dict[str, Any]:
    """The entry as omni runs it. What the entry's `out` names by path becomes
    the bytes, and what the subject must look at to answer it rides in `ctx`."""
    o = e['out']
    observe: dict[str, Any] = {'id': e['id'], 'json': o['stdout'].endswith('.json')}
    want: dict[str, Any] = {
        'exit': o['exit'],
        'stdout': _text(ROOT / o['stdout']),
        'stderr': o.get('stderr', ''),
        'calls': [Call(c['instance'], c['method'], c['path']).value() for c in o['calls']],
        'prompts': o.get('prompts', []),
        'faults': [],
    }
    if 'vault' in o:
        v = o['vault']
        observe['vault'] = {**{k: v[k] for k in ('file', 'key', 'passphrase') if k in v},
                            'keys': 'keys' in v, 'values': sorted(v.get('values', {}))}
        want['vault'] = {'names': v['names']}
        if 'keys' in v:
            want['vault']['keys'] = [{'key': k['key'], 'master': k['master'], 'write': k['write'],
                                      'grants': k['grants']} for k in v['keys']]
        if 'values' in v:
            want['vault']['values'] = v['values']
    if 'files' in o:
        observe['files'] = sorted(o['files'])
        want['files'] = {n: _text(ROOT / f) for n, f in o['files'].items()}
    if 'absent' in o:
        observe['absent'] = list(o['absent'])
        want['absent'] = list(o['absent'])
    return {'id': e['id'], 'args': e['args'], 'ctx': {**e['ctx'], 'observe': observe}, 'out': want}


def transcript(ctx: dict[str, Any], *argv: str) -> dict[str, Any]:
    """omni's subject for the transcript corpus: one command, in-process."""
    observe = ctx['observe']
    entry = {'id': observe['id'], 'args': list(argv),
             'ctx': {k: v for k, v in ctx.items() if k not in ('observe', 'client')}}
    c = build_ctx(entry)
    r = run(c)
    faults: list[str] = []
    seen: dict[str, Any] = {
        'exit': r.exit,
        'stdout': seen_stdout(observe['json'], r.stdout, faults.append),
        'stderr': r.stderr,
        'calls': [call.value() for call in r.calls],
        'prompts': c.prompt.shown if isinstance(c.prompt, Terminal) else [],
        'faults': faults,
    }
    if 'vault' in observe:
        seen['vault'] = _vault_seen(observe['vault'], c, faults.append)
    if 'files' in observe:
        seen['files'] = {n: _text(Path(located(c, n))) if os.path.exists(located(c, n)) else None
                         for n in observe['files']}
    if 'absent' in observe:
        seen['absent'] = [n for n in observe['absent'] if not os.path.exists(located(c, n))]
    return seen


CLI_OMNI = {'version': 1, 'requires': ['ctxargs']}


def cli_runner(spec: Any) -> Any:
    return makeRunner(spec, {'subject': lambda name: transcript if 'cli' == name else None})('cli')


def check(e: dict[str, Any]) -> list[str]:
    """One entry through omni: no failures, or the one omni reports."""
    spec = {'OMNI': CLI_OMNI, 'cli': {'one': {'set': [resolved(e)]}}}
    try:
        cli_runner(spec)['runsetflags'](spec['cli']['one'], {'null': False})
    except OmniError as err:
        return [str(err)]
    return []


def parity_dir() -> str | None:
    return os.environ.get('LIKENESS_PARITY_OUT') or None
