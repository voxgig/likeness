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


def actions_of(group: str) -> list[str]:
    """The actions of a group, `secrets` in `secrets init`, in code-point order."""
    return sorted(n[len(group) + 1:] for n in _table()['command'] if n.startswith(group + ' '))


def command_words(argv: list[str]) -> list[str]:
    """The words naming the command argv starts with, as far as they can be read."""
    if 1 < len(argv) and command_def(argv[0]) is None and command_def(argv[0] + ' ' + argv[1]) is not None:
        return [argv[0], argv[1]]
    return [argv[0] if argv else '']


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
_SECRET = re.compile(r'[a-z0-9_]+(\.[a-z0-9_]+)*')
_ENVVAR = re.compile('[A-Za-z_][A-Za-z0-9_]*')

# Where a secret is most likely to be typed by mistake, so never repeated.
_UNECHOED = ('envvar', 'stdin')


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
    if 'secret' == kind:
        return 'a secret name ([a-z0-9_] words joined by dots)'
    if 'envvar' == kind:
        return 'an environment variable name'
    return 'a string'


def _in_range(raw: str, definition: dict[str, Any]) -> bool:
    """Decided on the digits first, so a value too long for any host number is refused."""
    low, high = definition.get('min'), definition.get('max')
    if high is not None and len(str(high)) < len(raw):
        return False
    n = int(raw)
    return (low is None or low <= n) and (high is None or n <= high)


def _checked(label: str, definition: dict[str, Any], raw: str, remedy: str, echo: bool) -> Any:
    kind = definition['type']
    if 'integer' == kind:
        ok = _INTEGER.fullmatch(raw) is not None and _in_range(raw, definition)
    elif 'name' == kind:
        ok = _NAME.fullmatch(raw) is not None
    elif 'instance' == kind:
        ok = _INSTANCE.fullmatch(raw) is not None
    elif 'path' == kind:
        ok = '' != raw
    elif 'secret' == kind:
        ok = _SECRET.fullmatch(raw) is not None
    elif 'envvar' == kind:
        ok = _ENVVAR.fullmatch(raw) is not None
    else:
        ok = True
    if not ok:
        shown = ', not "' + raw + '"' if echo and kind not in _UNECHOED else ''
        raise _bad(label + ' takes ' + _described(definition) + shown, remedy)
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
    at = 1
    actions = actions_of(name) if command_def(name) is None else []
    if actions:
        action = argv[1] if 1 < len(argv) else None
        if action is None or action.startswith('-'):
            raise _bad('`' + name + '` needs an action: ' + ', '.join(actions[:-1]) + ' or ' + actions[-1],
                       'run `likeness help ' + name + '` for what each does')
        if command_def(name + ' ' + action) is None:
            raise _bad('no such command: ' + name + ' ' + action,
                       'run `likeness help ' + name + '` for its actions')
        name = name + ' ' + action
        at = 2
    cmd = command_def(name)
    if cmd is None:
        raise _bad('no such command: ' + name, 'run `likeness help` for the command list')

    echo = cmd.get('echo') is not False
    remedy = 'run `likeness help ' + name + '` for its arguments'
    flags: dict[str, Any] = {}
    positional: list[str] = []
    rest = argv[at:]

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
                if not echo:
                    raise _bad('an argument begins with - and is not a flag; it is not repeated here, '
                               'in case it is a secret', 'a positional that begins with - must follow --')
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
            raise _bad('`' + name + '` has no flag --' + given if echo else
                       '`' + name + '` has no such flag; it is not repeated here, in case it is a secret', remedy)

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
            value = _checked('--' + key, definition, raw, remedy, echo)

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
            if 'stdin' == definition['type'] and '-' != raw:
                raise _bad('`' + name + '` takes - there, never the value itself',
                           'pipe the value in, with - after the name')
            args.append(_checked('<' + definition['name'] + '>', definition, raw, remedy, echo))
        p += len(taken)
    if p < len(positional):
        raise _bad('`' + name + '` does not take the argument "' + positional[p] + '"' if echo else
                   '`' + name + '` takes no further argument; it is not repeated here, in case it is a secret',
                   remedy)
    return Parsed(name, flags, args)
