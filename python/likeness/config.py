"""station.json and likeness.json beside it: where they are, how each is read, and
how both are written back."""

from __future__ import annotations

import itertools
import json
import math
import os
import re
import stat
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from likeness.envelope import escape_string, render_raw
from likeness.station import open_station, with_chain
from likeness.text import utf8


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


@dataclass(frozen=True)
class Held:
    """A file's text, with the bytes and mode it would be put back with."""
    text: str
    data: bytes
    mode: int


def held(path: str, named: str) -> Held | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'rb') as handle:
            data = handle.read()
        return Held(data.decode('utf-8', errors='replace'), data, os.stat(path).st_mode & 0o777)
    except OSError:
        raise ConfigError(named + ' cannot be read') from None


# A configuration file as it is written: each object's keys in the file's
# order, and each key and scalar as its own text, so a file written back after
# one change differs from what was read only by that change and by the layout
# render_doc gives every file.

@dataclass
class Lit:
    raw: str


@dataclass
class Arr:
    v: list[Doc]


@dataclass
class Member:
    k: str
    raw: str
    v: Doc


@dataclass
class Obj:
    m: list[Member]


Doc = Lit | Arr | Obj

_STRING = re.compile(r'"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"')
_SCALAR = re.compile('true|false|null|-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')


class _Syntax(Exception):
    pass


class _Reader:
    """JSON as JSON.parse reads it, a key given twice keeping its first place
    and its last value."""

    def __init__(self, s: str) -> None:
        self.s = s
        self.at = 0

    def skip(self) -> None:
        while self.at < len(self.s) and self.s[self.at] in ' \t\n\r':
            self.at += 1

    def token(self, pattern: re.Pattern[str]) -> str | None:
        m = pattern.match(self.s, self.at)
        if m is None:
            return None
        self.at = m.end()
        return m.group()

    def take(self, c: str) -> bool:
        self.skip()
        if self.s.startswith(c, self.at):
            self.at += 1
            return True
        return False

    def value(self) -> Doc:
        self.skip()
        if self.take('{'):
            members: list[Member] = []
            if self.take('}'):
                return Obj(members)
            while True:
                self.skip()
                raw = self.token(_STRING)
                if raw is None or not self.take(':'):
                    raise _Syntax()
                k = json.loads(raw)
                v = self.value()
                same = next((x for x in members if x.k == k), None)
                if same is None:
                    members.append(Member(k, raw, v))
                else:
                    same.v = v
                if not self.take(','):
                    break
            if not self.take('}'):
                raise _Syntax()
            return Obj(members)
        if self.take('['):
            items: list[Doc] = []
            if self.take(']'):
                return Arr(items)
            while True:
                items.append(self.value())
                if not self.take(','):
                    break
            if not self.take(']'):
                raise _Syntax()
            return Arr(items)
        raw = self.token(_STRING)
        if raw is None:
            raw = self.token(_SCALAR)
            if raw is None or (raw[0] not in 'tfn' and not math.isfinite(float(raw))):
                raise _Syntax()
        return Lit(raw)

    def document(self) -> Doc:
        doc = self.value()
        self.skip()
        if self.at != len(self.s):
            raise _Syntax()
        return doc


def parse_doc(source: str, path: str) -> Obj:
    """Refused as the readers above refuse it, and in their words."""
    if _too_deep(source):
        raise ConfigError(f'{path} is nested more than {CONFIG_DEPTH} deep')
    try:
        doc = _Reader(source).document()
    except (_Syntax, ValueError):
        raise ConfigError(path + ' is not valid JSON') from None
    if not isinstance(doc, Obj):
        raise ConfigError(path + ' is not a JSON object')
    return doc


def render_doc(doc: Doc) -> str:
    """JSON.stringify's layout at an indent of 2, over the text each key and scalar had."""
    return _render(doc, '') + '\n'


def _render(d: Doc, at: str) -> str:
    if isinstance(d, Lit):
        return d.raw
    inner = at + '  '
    if isinstance(d, Arr):
        if 0 == len(d.v):
            return '[]'
        return '[\n' + ',\n'.join(inner + _render(x, inner) for x in d.v) + '\n' + at + ']'
    if 0 == len(d.m):
        return '{}'
    return '{\n' + ',\n'.join(inner + x.raw + ': ' + _render(x.v, inner) for x in d.m) + '\n' + at + '}'


def plain_of(doc: Doc) -> Any:
    """What the next reader of the file will see, which is what station validates."""
    return _loads(render_doc(doc))


def doc_of(v: Any) -> Doc:
    if isinstance(v, list):
        return Arr([doc_of(x) for x in v])
    if isinstance(v, dict):
        return Obj([Member(k, escape_string(k), doc_of(x)) for k, x in v.items()])
    return Lit(escape_string(v) if isinstance(v, str) else render_raw(v))


def member(o: Obj, k: str) -> Doc | None:
    return next((x.v for x in o.m if x.k == k), None)


def put(o: Obj, k: str, v: Doc) -> None:
    """Replaced where it stands, or added last."""
    at = next((x for x in o.m if x.k == k), None)
    if at is None:
        o.m.append(Member(k, escape_string(k), v))
    else:
        at.v = v


def drop(o: Obj, k: str) -> bool:
    for i, x in enumerate(o.m):
        if x.k == k:
            del o.m[i]
            return True
    return False


def rekey(o: Obj, old: str, new: str) -> None:
    at = next((x for x in o.m if x.k == old), None)
    if at is not None:
        at.k = new
        at.raw = escape_string(new)


def _create(path: str, data: bytes, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
    except BaseException:
        # A temporary file written in part is not left behind.
        try:
            os.unlink(path)
        except OSError:
            pass
        raise


@dataclass(frozen=True)
class Fs:
    """The file operations a write goes through: a file made that was not
    there, with its mode, a rename over a file, and a removal."""
    create: Callable[[str, bytes, int], None]
    rename: Callable[[str, str], None]
    unlink: Callable[[str], None]


OS_FS = Fs(_create, os.replace, os.unlink)


@dataclass(frozen=True)
class Write:
    """One file to replace: its new text, and what it held, None for a file not there yet."""
    path: str
    text: str
    was: Held | None = None


class WriteError(Exception):
    def __init__(self, path: str, restored: bool) -> None:
        super().__init__('could not write ' + path)
        self.path = path
        self.restored = restored


_made = itertools.count(1)


def _temp_of(path: str) -> str:
    return join(os.path.dirname(path),
                '.' + os.path.basename(path) + '.' + str(os.getpid()) + '.' + str(next(_made)) + '.tmp')


def _linked(path: str) -> bool:
    return stat.S_ISLNK(os.lstat(path).st_mode)


def write_all(writes: list[Write], fs: Fs = OS_FS) -> None:
    """Every file replaced, or none. Each new text, and each file's old bytes,
    is written beside it before anything is renamed into place, so a rename
    that fails is undone by renames alone. A file that is a symlink is
    replaced where the link points, so the link survives."""
    target = [os.path.realpath(w.path, strict=True) if w.was is not None and _linked(w.path) else w.path
              for w in writes]
    temps: list[str] = []

    def place(path: str, data: bytes, mode: int) -> str:
        t = _temp_of(path)
        fs.create(t, data, mode)
        temps.append(t)
        return t

    def clear() -> None:
        for t in temps:
            try:
                fs.unlink(t)
            except Exception:
                pass  # renamed into place, or never written

    fresh: list[str] = []
    old: list[str | None] = []
    at = 0
    try:
        for at, w in enumerate(writes):
            fresh.append(place(target[at], utf8(w.text), 0o600 if w.was is None else w.was.mode))
        for at, w in enumerate(writes):
            old.append(None if w.was is None else place(target[at], w.was.data, w.was.mode))
    except Exception:
        clear()
        raise WriteError(writes[at].path, True) from None

    for i in range(len(writes)):
        try:
            fs.rename(fresh[i], target[i])
        except Exception:
            restored = True
            for j in range(i - 1, -1, -1):
                try:
                    back = old[j]
                    if back is None:
                        fs.unlink(target[j])
                    else:
                        fs.rename(back, target[j])
                except Exception:
                    restored = False
            clear()
            raise WriteError(writes[i].path, restored) from None
    clear()
