"""station.json and likeness.json beside it: where they are, and how each is read."""

from __future__ import annotations

import json
import math
import os
from typing import Any

from likeness.envelope import render_raw
from likeness.station import open_station, with_chain


class ConfigError(Exception):
    pass


def homedir() -> str:
    """As the canonical port's os.homedir(): HOME whenever it is set, even empty."""
    home = os.environ.get('HOME')
    return home if home is not None else os.path.expanduser('~')


def join(*parts: str) -> str:
    """As the canonical port's path.join: normalised lexically, so a missing
    directory before a `..` does not hide the file, and a leading // is one /."""
    p = os.path.normpath(os.path.join(*parts))
    return '/' + p.lstrip('/') if p.startswith('//') else p


def _refuse_constant(name: str) -> Any:
    raise ValueError('not JSON: ' + name)


def _finite_float(text: str) -> float:
    value = float(text)
    if math.isinf(value):
        raise ValueError('beyond a double: ' + text)
    return value


def _finite_int(text: str) -> int:
    """Held to a double's range as well: the canonical port reads every number as one."""
    _finite_float(text)
    return int(text)


def _loads(source: str) -> Any:
    """JSON as the canonical port's JSON.parse reads it, a number no double holds refused."""
    return json.loads(source, parse_constant=_refuse_constant, parse_float=_finite_float,
                      parse_int=_finite_int)


CONFIG_DEPTH = 64


def _too_deep(source: str) -> bool:
    """Counted on the text before it is parsed: each port's parser, and the
    copy made of station.json, recurse, and each would give out at its own
    depth."""
    depth = 0
    quoted = False
    i = 0
    while i < len(source):
        c = source[i]
        if quoted:
            if '\\' == c:
                i += 1
            elif '"' == c:
                quoted = False
        elif '"' == c:
            quoted = True
        elif c in '[{':
            depth += 1
            if CONFIG_DEPTH < depth:
                return True
        elif c in ']}' and 0 < depth:
            depth -= 1
        i += 1
    return False


def _parse_json(source: str, path: str) -> dict[str, Any]:
    if _too_deep(source):
        raise ConfigError(f'{path} is nested more than {CONFIG_DEPTH} deep')
    try:
        doc = _loads(source)
    except (ValueError, RecursionError):
        raise ConfigError(path + ' is not valid JSON') from None
    if not isinstance(doc, dict):
        raise ConfigError(path + ' is not a JSON object')
    return doc


def parse_station(source: str, path: str) -> Any:
    """station.json, parsed here and validated by station against its own
    shape. Its secret chain is likeness's to check, and is checked when used."""
    doc = _parse_json(source, path)
    try:
        open_station(with_chain(doc, []))
    except Exception as err:
        code = getattr(err, 'code', None)
        if isinstance(code, str) and code.startswith('station_'):
            raise ConfigError(path + ': ' + str(err)) from None
        raise
    return doc


def parse_accounts(source: str, path: str, profile: str) -> dict[str, str]:
    """The account each instance ref of one station profile belongs to, from
    likeness.json. A profile reads only its own: none is inherited."""
    profiles = _parse_json(source, path).get('profiles')
    scoped = profiles.get(profile) if isinstance(profiles, dict) else None
    instances = scoped.get('instances') if isinstance(scoped, dict) else None
    out: dict[str, str] = {}
    if not isinstance(instances, dict):
        return out
    for ref in sorted(instances):
        entry = instances[ref]
        account = entry.get('account') if isinstance(entry, dict) else None
        if account is not None:
            out[ref] = account if isinstance(account, str) else render_raw(account)
    return out


def _read(path: str) -> str | None:
    """None when the file is not there. One that is there and cannot be read
    as a file, such as a directory, is refused rather than taken for absent."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8', errors='replace') as handle:
            return handle.read()
    except OSError:
        raise ConfigError(path + ' cannot be read') from None


def load_config(path: str, profile: str) -> tuple[Any, dict[str, str]]:
    source = _read(path)
    if source is None:
        return None, {}
    station = parse_station(source, path)
    lpath = join(os.path.dirname(path), 'likeness.json')
    lsource = _read(lpath)
    accounts = {} if lsource is None else parse_accounts(lsource, lpath, profile)
    return station, accounts
