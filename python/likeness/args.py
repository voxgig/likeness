"""The argument grammar: one table-driven parser over the embedded command table."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from likeness import spec
from likeness.errors import LikenessError


def _table() -> dict[str, Any]:
    return spec.load('commands')


def command_def(name: str) -> dict[str, Any] | None:
    return _table()['command'].get(name)


def help_text(name: str) -> str | None:
    return spec.load('help')['text'].get(name)


def help_rows() -> list[dict[str, str]]:
    return spec.load('help')['rows']


@dataclass
class Parsed:
    command: str
    flags: dict[str, Any] = field(default_factory=dict)
    args: list[str] = field(default_factory=list)


_NAME = re.compile('[a-z][a-z0-9-]*')
_INTEGER = re.compile('0|[1-9][0-9]*')
_INSTANCE = re.compile(r'[a-z][a-z0-9-]*(\$[a-z0-9-]+)?')


def _bad(message: str, remedy: str) -> LikenessError:
    return LikenessError('invalid-argument', message, remedy)


def _described(definition: dict[str, Any]) -> str:
    kind = definition['type']
    if 'integer' == kind:
        low, high = definition.get('min'), definition.get('max')
        if low is not None and high is not None:
            return 'an integer from ' + str(low) + ' to ' + str(high)
        if low is not None:
            return 'an integer of at least ' + str(low)
        if high is not None:
            return 'an integer of at most ' + str(high)
        return 'an integer'
    if 'name' == kind:
        return 'a name ([a-z][a-z0-9-]*)'
    if 'instance' == kind:
        return 'an instance ref (api or api$tag)'
    if 'path' == kind:
        return 'a path'
    return 'a string'


def _in_range(raw: str, definition: dict[str, Any]) -> bool:
    """Decided on the digits first, so a value too long for any host number is refused."""
    low, high = definition.get('min'), definition.get('max')
    if high is not None and len(str(high)) < len(raw):
        return False
    n = int(raw)
    return (low is None or low <= n) and (high is None or n <= high)


def _checked(label: str, definition: dict[str, Any], raw: str, remedy: str) -> Any:
    kind = definition['type']
    if 'integer' == kind:
        ok = _INTEGER.fullmatch(raw) is not None and _in_range(raw, definition)
    elif 'name' == kind:
        ok = _NAME.fullmatch(raw) is not None
    elif 'instance' == kind:
        ok = _INSTANCE.fullmatch(raw) is not None
    elif 'path' == kind:
        ok = '' != raw
    else:
        ok = True
    if not ok:
        raise _bad(label + ' takes ' + _described(definition) + ', not "' + raw + '"', remedy)
    return int(raw) if 'integer' == kind else raw


def _lookup(cmd: dict[str, Any], name: str) -> dict[str, Any] | None:
    found = cmd['flag'].get(name)
    return found if found is not None else _table()['global'].get(name)


def _flag_shaped(a: str) -> bool:
    return a.startswith('-') and '-' != a


def parse_argv(argv: list[str]) -> Parsed:
    if 0 == len(argv):
        raise _bad('no command given', 'try `likeness list`, or `likeness help` for the command list')
    name = argv[0]
    if name in ('--help', '-h'):
        name = 'help'
    elif '--version' == name:
        name = 'version'
    elif _flag_shaped(name):
        raise _bad('the command comes first, and ' + name + ' is a flag',
                   'put the command first: `likeness list ' + name + '`')
    cmd = command_def(name)
    if cmd is None:
        raise _bad('no such command: ' + name, 'run `likeness help` for the command list')

    remedy = 'run `likeness help ' + name + '` for its arguments'
    flags: dict[str, Any] = {}
    positional: list[str] = []
    rest = argv[1:]

    i = 0
    while i < len(rest):
        a = rest[i]
        i += 1
        if '--' == a:
            positional.extend(rest[i:])
            break
        if not a.startswith('--'):
            # A command still being built reads its global flags and nothing else.
            if _flag_shaped(a) and cmd['ready']:
                raise _bad(a + ' begins with - and is not a flag; a positional that begins with - '
                           'must follow --', 'write `likeness ' + name + ' -- ' + a + '`')
            if not _flag_shaped(a):
                positional.append(a)
            continue

        eq = a.find('=')
        given = a[2:] if -1 == eq else a[2:eq]
        key = given
        definition = _lookup(cmd, given)
        negated = False
        if definition is None and given.startswith('no-'):
            base = _lookup(cmd, given[3:])
            if base is not None and 'boolean' == base['type']:
                definition, key, negated = base, given[3:], True
        if definition is None:
            if not cmd['ready']:
                continue
            raise _bad('`' + name + '` has no flag --' + given, remedy)

        if 'boolean' == definition['type']:
            if -1 != eq:
                raise _bad('--' + given + ' takes no value', 'write --' + key + ', or --no-' + key)
            value: Any = not negated
        else:
            raw: str | None = None
            if -1 != eq:
                raw = a[eq + 1:]
            elif i < len(rest) and not _flag_shaped(rest[i]):
                raw = rest[i]
                i += 1
            if raw is None:
                shown = definition.get('value')
                raise _bad('--' + key + ' needs a value',
                           'write --' + key + ' ' + str(shown) + ', or --' + key + '=' + str(shown) +
                           ' for a value that begins with -')
            value = _checked('--' + key, definition, raw, remedy)

        if definition.get('repeat') is True:
            flags.setdefault(key, []).append(value)
        else:
            if key in flags:
                raise _bad('--' + key + ' was given twice', 'give it once')
            flags[key] = value

    if not cmd['ready']:
        return Parsed(name, flags, [])

    args: list[str] = []
    p = 0
    for definition in cmd['arg']:
        taken = positional[p:] if definition.get('repeat') is True else positional[p:p + 1]
        if definition['required'] and 0 == len(taken):
            raise _bad('`' + name + '` needs <' + definition['name'] + '>', remedy)
        for raw in taken:
            args.append(_checked('<' + definition['name'] + '>', definition, raw, remedy))
        p += len(taken)
    if p < len(positional):
        raise _bad('`' + name + '` does not take the argument "' + positional[p] + '"', remedy)
    return Parsed(name, flags, args)
