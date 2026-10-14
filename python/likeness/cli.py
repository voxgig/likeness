"""The thin argv shell: read the configuration, probe PATH, run, write."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any, BinaryIO

from likeness.core import PORT, VERSION, Ctx, open_station, run
from likeness.envelope import compare_code_points, render_raw
from likeness.identity import rfc3339
from likeness.text import utf8

REMEDY = 'fix the file, or point --config at another'


class ConfigError(Exception):
    pass


def _refuse_constant(name: str) -> Any:
    raise ValueError('not JSON: ' + name)


def _parse_json(source: str, path: str) -> Any:
    try:
        return json.loads(source, parse_constant=_refuse_constant)
    except (ValueError, RecursionError):
        raise ConfigError(path + ' is not valid JSON') from None


def parse_station(source: str, path: str) -> Any:
    """station.json, parsed here and validated by station against its own shape."""
    doc = _parse_json(source, path)
    try:
        open_station(doc)
    except Exception as err:
        if 'station_config_invalid' == getattr(err, 'code', None):
            raise ConfigError(path + ': ' + str(err)) from None
        raise
    return doc


def parse_accounts(source: str, path: str) -> dict[str, str]:
    """The account each instance ref belongs to, from likeness.json."""
    doc = _parse_json(source, path)
    instances = doc.get('instances') if isinstance(doc, dict) else None
    out: dict[str, str] = {}
    if not isinstance(instances, dict):
        return out
    for ref in sorted(instances):
        entry = instances[ref]
        account = entry.get('account') if isinstance(entry, dict) else None
        if account is not None:
            out[ref] = account if isinstance(account, str) else render_raw(account)
    return out


def _read(path: str) -> str:
    with open(path, encoding='utf-8', errors='replace') as handle:
        return handle.read()


def load_config(config_path: str | None = None) -> tuple[Any, dict[str, str]]:
    path = config_path if config_path is not None else \
        os.path.join(os.path.expanduser('~'), '.config', 'likeness', 'station.json')
    if not os.path.exists(path):
        return None, {}
    station = parse_station(_read(path), path)
    lpath = os.path.normpath(os.path.join(os.path.dirname(path), 'likeness.json'))
    accounts = parse_accounts(_read(lpath), lpath) if os.path.exists(lpath) else {}
    return station, accounts


_BINARY = re.compile('likeness(?:-([a-z]+))?')


def probe_path(env: dict[str, str]) -> list[dict[str, str]]:
    """The port is read from the file name, never by running it: `which` must
    not execute whatever is on PATH under a matching name."""
    seen: set[str] = set()
    rows: list[dict[str, str]] = []
    for directory in env.get('PATH', '').split(os.pathsep):
        if '' == directory:
            continue
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            m = _BINARY.fullmatch(name)
            if m is None:
                continue
            full = os.path.normpath(os.path.join(directory, name))
            if full in seen or not os.path.isfile(full):
                continue
            seen.add(full)
            rows.append({'path': full, 'port': m.group(1) or '', 'version': ''})
    if 0 == len(rows):
        rows.append({'path': '(this port, not on PATH)', 'port': PORT, 'version': VERSION})
    return rows


def take_config_option(argv: list[str]) -> tuple[list[str], str | None]:
    """`--config PATH` or `--config=PATH`, taken out before the command runs.
    Only a single well-formed one after the command and before `--` is taken;
    anything else is left in place for the grammar to refuse."""
    found: list[tuple[int, int, str]] = []
    bad = False
    i = 1
    while i < len(argv):
        a = argv[i]
        if '--' == a:
            break
        if '--config' == a:
            following = argv[i + 1] if i + 1 < len(argv) else None
            if following is None or (following.startswith('-') and '-' != following):
                bad = True
            else:
                found.append((i, 2, following))
            i += 1
        elif a.startswith('--config='):
            value = a[len('--config='):]
            if '' == value:
                bad = True
            else:
                found.append((i, 1, value))
        i += 1
    if bad or 1 != len(found):
        return list(argv), None
    at, width, value = found[0]
    return argv[:at] + argv[at + width:], value


def _write(stream: BinaryIO, text: str) -> bool:
    """False when the reader has gone away."""
    try:
        stream.write(utf8(text))
        stream.flush()
        return True
    except BrokenPipeError:
        # Point the descriptor at /dev/null, so the flush at exit stays quiet too.
        os.dup2(os.open(os.devnull, os.O_WRONLY), stream.fileno())
        return False


def main(argv: list[str]) -> int:
    rest, config_path = take_config_option(argv)
    env = dict(os.environ)

    try:
        station, accounts = load_config(config_path)
    except ConfigError as err:
        quiet = not _write(sys.stderr.buffer,
                           'error: invalid-project\n  ' + str(err) + '\n  remedy  ' + REMEDY + '\n')
        return 0 if quiet else 3

    res = run(Ctx(
        argv=rest,
        env=env,
        clock=rfc3339(time.time_ns() // 1_000_000),
        station=station,
        accounts=accounts,
        path=probe_path(env),
    ))

    # A reader that went away is not the port's failure: exit quietly with 0.
    delivered = True
    if '' != res.stdout:
        delivered = _write(sys.stdout.buffer, res.stdout)
    if '' != res.stderr:
        delivered = _write(sys.stderr.buffer, res.stderr) and delivered
    return res.exit if delivered else 0


def entry() -> None:
    sys.exit(main(sys.argv[1:]))
