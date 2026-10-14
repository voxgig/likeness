"""The corpus runner: a whole command in-process, held to the committed bytes."""

from __future__ import annotations

import copy
import json
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from likeness.calls import Call
from likeness.core import PORT, Ctx, run
from likeness.envelope import SerialiseError, serialise, strip_parity_exceptions

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


def build_ctx(e: dict[str, Any]) -> Ctx:
    """Each connection becomes a declared station instance, its account the
    likeness.json entry beside it, and its seed the SDK's offline transport."""
    ectx = e['ctx']
    path = ROOT / 'fixtures' / 'sources' / ectx['fixture'] / 'seed.json'
    seed = json.loads(path.read_text(encoding='utf-8'))
    del seed['_doc']

    sdk: dict[str, Any] = {}
    accounts: dict[str, str] = {}
    fixture: dict[str, Any] = {}
    for c in ectx['connections']:
        sdk[c['instance']] = {}
        accounts[c['instance']] = c['account']
        own = copy.deepcopy(seed)
        if 'net' in c:
            own['net'] = c['net']
        fixture[c['instance']] = own

    return Ctx(
        argv=list(e['args']),
        env=ectx.get('env'),
        clock=ectx['clock'],
        seed=ectx['seed'],
        station={'station': 1, 'profiles': {'default': {'sdk': sdk}}},
        accounts=accounts,
        fixture=fixture,
        # Absent stays absent: being told about nothing is a different case
        # from being told about an empty list.
        path=ectx.get('path'),
    )


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


def _calls_text(calls: list[dict[str, str]]) -> str:
    return json.dumps(calls, separators=(',', ':'))


def check(e: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    fail = failures.append

    r = run(build_ctx(e))

    if r.exit != e['out']['exit']:
        fail('exit ' + str(r.exit) + ', expected ' + str(e['out']['exit']))
    check_stdout(e, r.stdout, fail)

    want_err = e['out'].get('stderr', '')
    if r.stderr != want_err:
        fail('stderr ' + json.dumps(r.stderr) + ', expected ' + json.dumps(want_err))

    got = [c.value() for c in r.calls]
    want = [Call(c['instance'], c['method'], c['path']).value() for c in e['out']['calls']]
    if got != want:
        fail('calls ' + _calls_text(got) + ', expected ' + _calls_text(want))

    return failures


def parity_dir() -> str | None:
    return os.environ.get('LIKENESS_PARITY_OUT') or None
