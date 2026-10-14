"""The one secret store likeness allows: a minivault, managed from the command line."""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from types import ModuleType
from typing import Any

from likeness.envelope import render_raw
from likeness.errors import LikenessError

DEFAULT_FILE = 'likeness.skmv'
PASSPHRASE_ENV = 'LIKENESS_PASSPHRASE'
NEW_PASSPHRASE_ENV = 'LIKENESS_NEW_PASSPHRASE'

_ENTRY_KEYS = ('file', 'kind', 'vaultkey')
_KEY = re.compile('[a-z][a-z0-9-]*')

_REMEDY = 'name the vault alone: "providers": [{ "kind": "minivault", "file": "likeness.skmv" }]'

_ABSENT = object()


@dataclass(frozen=True)
class VaultEntry:
    file: str
    key: str
    shown: str


@dataclass
class Answer:
    data: Any
    count: int
    text: str
    empty: bool = False


def _minivault() -> ModuleType:
    # Imported on first use, like station: `version` and `help` need neither.
    from voxgig_sekreto.plugins import minivault
    return minivault


def _refused(message: str, remedy: str = _REMEDY) -> LikenessError:
    return LikenessError('invalid-project', message, remedy)


def _resolve(*parts: str) -> str:
    """As the canonical port's path.resolve: posixpath keeps a leading `//`, it does not."""
    p = os.path.abspath(os.path.join(*parts))
    return '/' + p.lstrip('/') if p.startswith('//') else p


def shown(path: str, home: str) -> str:
    h = _resolve(home)
    if path == h:
        return '~'
    return '~/' + path[len(h) + 1:] if path.startswith(h + '/') else path


def _located(file: str, home: str, dir: str) -> str:
    if file.startswith('~/'):
        return _resolve(home, file[2:])
    return _resolve(file) if os.path.isabs(file) else _resolve(dir, file)


def _chain(p: Any) -> Any:
    if isinstance(p, dict) and isinstance(p.get('secrets'), dict):
        return p['secrets'].get('providers', _ABSENT)
    return _ABSENT


def vault_entry(station: Any, profile: str, home: str, dir: str, key: str | None = None) -> VaultEntry:
    """Chosen the way station chooses its profile's chain, with no passphrase written beside it."""
    profiles = station.get('profiles') if isinstance(station, dict) else None
    profiles = profiles if isinstance(profiles, dict) else {}
    providers = _ABSENT if 'default' == profile else _chain(profiles.get(profile))
    # A null chain falls through to the default profile's, as an absent one does.
    if providers is _ABSENT or providers is None:
        providers = _chain(profiles.get('default'))

    entry: dict[str, Any] = {'kind': 'minivault'}
    if providers is not _ABSENT:
        if not isinstance(providers, list) or 1 != len(providers):
            raise _refused("station.json's secrets.providers must name one store, the vault")
        only = providers[0]
        kind = only.get('kind', _ABSENT) if isinstance(only, dict) else only
        if not isinstance(only, dict) or 'minivault' != kind:
            named = kind if isinstance(kind, str) else render_raw(None if kind is _ABSENT else kind)
            raise _refused('likeness reads secrets from its vault alone, and station.json names the store "' +
                           named + '"')
        if 'passphrase' in only:
            raise _refused("station.json holds the vault's passphrase, and a passphrase is never written to a file",
                           'remove it, and set ' + PASSPHRASE_ENV + ' or name a variable with --passphrase-env')
        extra = sorted(k for k in only if k not in _ENTRY_KEYS)
        if extra:
            raise _refused('the vault entry in station.json has no key "' + extra[0] + '"',
                           'the vault entry takes kind, file and vaultkey')
        if 'file' in only and (not isinstance(only['file'], str) or '' == only['file']):
            raise _refused("the vault entry's file is not a path", 'name the file: "file": "likeness.skmv"')
        if 'vaultkey' in only and (not isinstance(only['vaultkey'], str) or
                                   _KEY.fullmatch(only['vaultkey']) is None):
            raise _refused("the vault entry's vaultkey is not a key name", 'a key name is [a-z][a-z0-9-]*')
        entry = only

    file = _located(entry['file'] if isinstance(entry.get('file'), str) else DEFAULT_FILE, home, dir)
    if key is None:
        key = entry['vaultkey'] if isinstance(entry.get('vaultkey'), str) else 'master'
    return VaultEntry(file, key, shown(file, home))


def _present(entry: VaultEntry) -> None:
    if not os.path.exists(entry.file):
        raise LikenessError('secret-backend-unavailable', 'no vault at ' + entry.shown,
                            'run `likeness secrets init` to create it, or point station.json at the vault')


def _env(ask: Any, name: str) -> str | None:
    value = (ask.env or {}).get(name)
    return value if isinstance(value, str) and '' != value else None


def _passphrase(ask: Any, flags: Any, key: str) -> str:
    """From the environment, else typed."""
    value = _env(ask, flags.passphrase_env if flags.passphrase_env is not None else PASSPHRASE_ENV)
    if value is not None:
        return value
    if ask.tty is True and ask.prompt is not None:
        typed = ask.prompt('passphrase for ' + key)
        if typed is None or '' == typed:
            raise LikenessError('vault-locked', 'no passphrase was given', 'run it again, and type the passphrase')
        return typed
    # The variable a flag named is not repeated: a passphrase given there by
    # mistake would otherwise be printed.
    if flags.passphrase_env is None:
        raise LikenessError(
            'vault-locked',
            'no passphrase: ' + PASSPHRASE_ENV + ' is not set, and stdin is not a terminal to ask on',
            'set ' + PASSPHRASE_ENV + ', or name another variable with --passphrase-env')
    raise LikenessError(
        'vault-locked',
        'no passphrase: the variable --passphrase-env names is not set, and stdin is not a terminal to ask on',
        'set that variable, or run on a terminal to be asked')


def _new_passphrase(ask: Any, flagged: str | None, fallback: str, flag: str, label: str) -> str:
    """For a key being made, typed twice when it is typed at all."""
    value = _env(ask, flagged if flagged is not None else fallback)
    if value is not None:
        return value
    if ask.tty is True and ask.prompt is not None:
        first = ask.prompt(label)
        if first is None or '' == first:
            raise LikenessError('invalid-argument', 'no passphrase was given', 'run it again, and type one')
        if first != ask.prompt('the same passphrase again'):
            raise LikenessError('invalid-argument', 'the two passphrases differ', 'run it again')
        return first
    if flagged is None:
        raise LikenessError(
            'invalid-argument',
            'no passphrase for the new key: ' + fallback + ' is not set, and stdin is not a terminal to ask on',
            'set ' + fallback + ', or name another variable with --' + flag)
    raise LikenessError(
        'invalid-argument',
        'no passphrase for the new key: the variable --' + flag +
        ' names is not set, and stdin is not a terminal to ask on',
        'set that variable, or run on a terminal to be asked')


def _opened(entry: VaultEntry, phrase: str) -> tuple[Any, dict[str, Any]]:
    vault = _minivault().openvault({'file': entry.file, 'key': entry.key, 'passphrase': phrase})
    try:
        return vault, vault.open()
    except Exception:
        raise LikenessError(
            'vault-locked',
            'the vault does not open as the key ' + entry.key +
            ': the passphrase is wrong, the key is not there, or the file is damaged',
            'check the passphrase, and the key --vault-key names') from None


def _written(entry: VaultEntry, write: Callable[[], Any]) -> None:
    try:
        write()
    except Exception:
        raise LikenessError(
            'secret-backend-unavailable', 'the vault could not be written',
            'check that ' + os.path.dirname(entry.shown) + ' is writable and its disk has space') from None


def _master(info: dict[str, Any], action: str) -> None:
    if not info['master']:
        raise LikenessError(
            'vault-denied', '`secrets ' + action + '` needs a master key, and ' + info['key'] + ' is restricted',
            'run it as the master key, with --vault-key')


def _not_readable(name: str, key: str) -> LikenessError:
    return LikenessError('not-found', 'the vault has no ' + name + ' that the key ' + key + ' can read',
                         'run `likeness secrets list` for the names it can read')


def _role(k: dict[str, Any]) -> str:
    return 'master' if k['master'] else 'write' if k['write'] else 'read'


def _mkdirs(path: str) -> None:
    """Every directory made is private, not only the last, as in the other ports."""
    parent = os.path.dirname(path)
    if parent != path and not os.path.isdir(parent):
        _mkdirs(parent)
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        if not os.path.isdir(path):
            raise


def vault_chain(ask: Any, entry: VaultEntry, flags: Any) -> list[dict[str, str]]:
    """The chain station resolves a live connection's token through. Offline,
    the SDKs' test transport answers and nothing is resolved."""
    _present(entry)
    phrase = _passphrase(ask, flags, entry.key)
    _opened(entry, phrase)[0].close()
    return [{'kind': 'minivault', 'file': entry.file, 'vaultkey': entry.key, 'passphrase': phrase}]


def _init(entry: VaultEntry, ask: Any, flags: Any) -> Answer:
    if os.path.exists(entry.file):
        raise LikenessError('vault-exists', entry.shown + ' already exists, and init never overwrites it',
                            'use the vault that is there, or name another file in station.json')
    phrase = _new_passphrase(ask, flags.passphrase_env, PASSPHRASE_ENV, 'passphrase-env',
                             'new passphrase for ' + entry.key)

    def create() -> None:
        _mkdirs(os.path.dirname(entry.file))
        _minivault().createvault({'file': entry.file, 'key': entry.key, 'passphrase': phrase}).close()

    _written(entry, create)
    return Answer({'file': entry.shown, 'key': entry.key}, 1,
                  'created the vault ' + entry.shown + ', with the key ' + entry.key + '\n')


def secrets(action: str, args: list[str], entry: VaultEntry, ask: Any, flags: Any) -> Answer:
    if 'init' == action:
        return _init(entry, ask, flags)

    _present(entry)
    name = args[0] if args else ''
    from_stdin = 1 < len(args) and '-' == args[1]
    if 'set' == action and not from_stdin and ask.tty is not True:
        raise LikenessError('invalid-argument', '`secrets set` reads the value from a terminal, or from stdin given as -',
                            'pipe the value in, with - after the name')

    vault, info = _opened(entry, _passphrase(ask, flags, entry.key))
    try:
        if 'list' == action:
            names = sorted(vault.list())
            return Answer(names, len(names), ''.join(n + '\n' for n in names), 0 == len(names))

        if 'get' == action:
            value = vault.get(name)
            if value is None:
                raise _not_readable(name, entry.key)
            if flags.reveal:
                return Answer({'name': name, 'value': value}, 1, value + '\n')
            return Answer({'name': name}, 1, name + ' is set; --reveal prints its value\n')

        if 'set' == action:
            if not info['master']:
                if not info['write']:
                    raise LikenessError('vault-denied', 'the key ' + entry.key + ' is read-only',
                                        'run it as the master key, or as one granted --write')
                if name not in info['grants']:
                    raise LikenessError('vault-denied', 'the key ' + entry.key + ' was not granted ' + name,
                                        'run it as the master key, or as a key granted that name')
                if name not in vault.list():
                    raise LikenessError('vault-denied',
                                        'only a master key creates a secret, and ' + name + ' is not in the vault',
                                        'set it once as the master key')
            reader = ask.stdin if from_stdin else None
            given = reader() if reader is not None else \
                ask.prompt('value for ' + name) if not from_stdin and ask.prompt is not None else None
            # One line ending goes: `echo token |` should store the token.
            value = given or ''
            if value.endswith('\n'):
                value = value[:-2] if value.endswith('\r\n') else value[:-1]
            if '' == value:
                raise LikenessError('invalid-argument', 'the value is empty',
                                    'a secret needs a value; `likeness secrets remove` drops one')
            _written(entry, lambda: vault.set(name, value))
            return Answer({'name': name}, 1, 'set ' + name + '\n')

        if 'remove' == action:
            _master(info, action)
            if name not in vault.list():
                raise _not_readable(name, entry.key)
            _written(entry, lambda: vault.remove(name))
            return Answer({'name': name}, 1, 'removed ' + name + '\n')

        if 'keys' == action:
            _master(info, action)
            keys = sorted(vault.keys(), key=lambda k: k['key'])
            width = max(len(k['key']) for k in keys)
            text = ''.join((k['key'].ljust(width) + '  ' + _role(k).ljust(6) + '  ' +
                            ', '.join(k['grants'])).rstrip() + '\n' for k in keys)
            rows = [{'key': k['key'], 'master': k['master'], 'write': k['write'], 'grants': list(k['grants'])}
                    for k in keys]
            return Answer(rows, len(rows), text)

        if 'grant' == action:
            _master(info, action)
            key = args[0]
            names = sorted(set(args[1:]))
            if any(k['key'] == key for k in vault.keys()):
                raise LikenessError('vault-exists', 'the vault already has a key ' + key,
                                    'revoke it first, or choose another name')
            phrase = _new_passphrase(ask, flags.new_passphrase_env, NEW_PASSPHRASE_ENV, 'new-passphrase-env',
                                     'passphrase for the new key ' + key)
            _written(entry, lambda: vault.grant({'key': key, 'passphrase': phrase, 'names': names,
                                                 'write': flags.write}))
            return Answer({'grants': names, 'key': key, 'write': flags.write}, 1,
                          'granted ' + key + ', ' + ('reading and writing ' if flags.write else 'reading ') +
                          ', '.join(names) + '\n')

        if 'revoke' == action:
            _master(info, action)
            key = args[0]
            if key == entry.key:
                raise LikenessError('vault-denied', key + ' cannot revoke itself',
                                    '`likeness secrets rotate` withdraws every other key')
            if not any(k['key'] == key for k in vault.keys()):
                raise LikenessError('not-found', 'the vault has no key ' + key,
                                    'run `likeness secrets keys` for the keys there are')
            _written(entry, lambda: vault.revoke(key))
            return Answer({'key': key}, 1, 'revoked ' + key + '\n')

        if 'rotate' == action:
            _master(info, action)
            dropped = sorted(k['key'] for k in vault.keys() if k['key'] != entry.key)
            _written(entry, vault.rotate)
            return Answer({'dropped': dropped}, 1,
                          'rotated the vault' + ('; dropped ' + ', '.join(dropped) if dropped else '') + '\n')

        raise RuntimeError('no such secrets action: ' + action)
    finally:
        vault.close()
