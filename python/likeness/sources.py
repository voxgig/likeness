"""The `sources` group: station.json and likeness.json, changed together."""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from likeness.adapters import ADAPTERS
from likeness.caps import connect_of, source_flags
from likeness.config import (
    OS_FS, ConfigError, Held, Obj, Write, WriteError, doc_of, drop, held, homedir, join, member, parse_doc,
    plain_of, put, rekey, render_doc, write_all,
)
from likeness.errors import LikenessError
from likeness.station import Connection, open_station, profile_of, with_chain
from likeness.vault import VaultEntry, mkdirs, opened, passphrase, present, shown, vault_entry, written

if TYPE_CHECKING:
    from voxgig_station import Station

_TAG = re.compile('[a-z0-9-]+')
_NAME = re.compile('[a-z][a-z0-9-]*')
# Scheme, host and port, and a path: no userinfo, query or fragment, which is
# where a credential would be written.
_BASE = re.compile(r'https?://(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?'
                   r'(?:/[\x21\x22\x24-\x3e\x40-\x7e]*)?')
_YES = re.compile('[yY](?:[eE][sS])?')
# What String.prototype.trim strips, which str.strip's default is not.
_JS_SPACE = '\t\n\v\f\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a' \
    '\u2028\u2029\u202f\u205f\u3000\ufeff'

LIST_REMEDY = 'run `likeness sources list` to see the configured connections'
FILE_REMEDY = 'fix the file, or point --config at another'


@dataclass
class Reply:
    data: Any
    count: int
    text: str | None = None
    empty: bool = False


def _bad(message: str, remedy: str) -> LikenessError:
    return LikenessError('invalid-argument', message, remedy)


def secret_name(ref: str) -> str:
    """Station's name for an instance's secret when its block names none."""
    return re.sub('[^A-Z0-9]+', '_', ref.upper()).strip('_').lower() + '.apikey'


def ref_for(source: str, instance: str | None = None) -> str:
    """The ref `sources add` writes: the API alone, the API with --instance as
    its tag, or --instance itself where it is a ref to the same API. A
    `$`-less value is always a tag, as station reads one."""
    if _NAME.fullmatch(source) is None:
        raise _bad("--source takes a source's name", 'run `likeness help sources add`')
    if instance is None:
        return source
    at = instance.find('$')
    if -1 != at and instance[:at] != source:
        raise _bad('--instance names a connection to another API than --source does',
                   'give the tag alone: `--source ' + source + ' --instance <tag>` adds ' + source + '$<tag>')
    tag = instance if -1 == at else instance[at + 1:]
    if _TAG.fullmatch(tag) is None:
        raise _bad('--instance takes a tag of lowercase letters, digits and hyphens',
                   'write `--instance work` to add ' + source + '$work')
    return source + '$' + tag


def _api(ref: str) -> str:
    at = ref.find('$')
    return ref if -1 == at else ref[:at]


def _named(block: dict[str, Any]) -> bool:
    return isinstance(block.get('secret'), str) and '' != block['secret']


def _secret_of(block: dict[str, Any], ref: str) -> str:
    return block['secret'] if _named(block) else secret_name(ref)


def _listed(names: list[str]) -> str:
    return names[0] if 1 == len(names) else ', '.join(names[:-1]) + ' or ' + names[-1]


def _row_of(ref: str, block: dict[str, Any], account: str | None, active: bool) -> dict[str, Any]:
    row: dict[str, Any] = {'instance': ref, 'source': _api(ref), 'secret': _secret_of(block, ref)}
    if isinstance(block.get('base'), str):
        row['base'] = block['base']
    if account is not None:
        row['account'] = account
    if not active:
        row['active'] = False
    return row


def list_sources(station: Station, accounts: dict[str, str]) -> Reply:
    """Every instance the active profile declares, the inactive ones marked,
    and the account of each that likeness.json gives one."""
    rows = [_row_of(i['name'], i['block'], accounts[i['name']] if i['name'] in accounts else None, i['active'])
            for i in station.instances()]
    return Reply(rows, len(rows), empty=0 == len(rows))


@dataclass
class _Config:
    home: str
    station_path: str
    likeness_path: str
    station: Held | None
    likeness: Held | None
    doc: Obj
    accounts: Obj | None


def _config_of(place: Any) -> _Config:
    """Both files, read fresh: a write keeps everything in them it does not change."""
    home = place.home if place.home is not None else homedir()
    station = place.config if place.config is not None else join(
        place.dir if place.dir is not None else join(home, '.config', 'likeness'), 'station.json')
    likeness = join(os.path.dirname(station), 'likeness.json')
    try:
        s = held(station, shown(station, home))
        lk = held(likeness, shown(likeness, home))
        doc = doc_of({'station': 1, 'profiles': {}}) if s is None else parse_doc(s.text, shown(station, home))
        accounts = None if lk is None else parse_doc(lk.text, shown(likeness, home))
    except ConfigError as err:
        raise LikenessError('invalid-project', str(err), FILE_REMEDY) from None
    assert isinstance(doc, Obj)
    return _Config(home, station, likeness, s, lk, doc, accounts)


def _station_of(config: _Config, place: Any, refused: Callable[[str, str], LikenessError]) -> Station:
    try:
        return open_station(with_chain(plain_of(config.doc), []), place.env)
    except Exception as err:
        code = getattr(err, 'code', None)
        if isinstance(code, str) and code.startswith('station_'):
            raise refused(code, str(err)) from None
        raise


def _as_read(config: _Config, place: Any) -> Station:
    return _station_of(config, place, lambda _code, message: LikenessError(
        'invalid-project', shown(config.station_path, config.home) + ': ' + message, FILE_REMEDY))


def _find(o: Obj | None, path: list[str]) -> Obj | None:
    """The object at path, or None where a level is missing or not an object."""
    at = o
    for k in path:
        found = None if at is None else member(at, k)
        at = found if isinstance(found, Obj) else None
    return at


def _make(o: Obj, path: list[str], file: str) -> Obj:
    """The object at path, each missing level made; a level that is not an object is refused."""
    at = o
    for i, k in enumerate(path):
        found = member(at, k)
        if found is None:
            found = Obj([])
            put(at, k, found)
        if not isinstance(found, Obj):
            raise LikenessError('invalid-project', file + "'s " + '.'.join(path[:i + 1]) + ' is not an object',
                                FILE_REMEDY)
        at = found
    return at


def _sdk_of(config: _Config, profile: str) -> Obj | None:
    return _find(config.doc, ['profiles', profile, 'sdk'])


def _declares(o: Obj | None, ref: str) -> bool:
    return o is not None and member(o, ref) is not None


def _owned(config: _Config, profile: str, ref: str) -> None:
    """Whether the active profile's own block declares ref, and whether the
    default profile, which every other one inherits, declares it as well."""
    mine = _declares(_sdk_of(config, profile), ref)
    base = 'default' != profile and _declares(_sdk_of(config, 'default'), ref)
    if not mine and not base:
        raise LikenessError('no-such-source', 'no connection named "' + ref + '"', LIST_REMEDY)
    if not mine:
        raise _bad('connection "' + ref + "\" is the default profile's, which \"" + profile + '" inherits',
                   'change it under the default profile, with VOXGIG_STATION_PROFILE unset')
    if base:
        raise _bad('connection "' + ref + '" would remain: the default profile declares it too, and "' +
                   profile + '" inherits it',
                   "remove the default profile's first, with VOXGIG_STATION_PROFILE unset")


def _block(station: Station, ref: str) -> dict[str, Any]:
    return next((i['block'] for i in station.instances() if i['name'] == ref), {})


def _commit(place: Any, config: _Config, accounts: Obj | None) -> None:
    """likeness.json first, so station.json, which makes a connection, changes last."""
    writes = []
    if accounts is not None:
        writes.append(Write(config.likeness_path, render_doc(accounts), config.likeness))
    writes.append(Write(config.station_path, render_doc(config.doc), config.station))
    directory = os.path.dirname(config.station_path) or '.'
    where = shown(directory, config.home)
    remedy = 'check that ' + where + ' is writable and its disk has space'
    try:
        mkdirs(os.path.abspath(directory))
        write_all(writes, place.fs if place.fs is not None else OS_FS)
    except WriteError as err:
        left = 'nothing was changed' if err.restored else 'a file already replaced could not be put back'
        raise LikenessError('invalid-project', shown(err.path, config.home) + ' could not be written, and ' + left,
                            remedy) from None
    except Exception:
        raise LikenessError('invalid-project', where + ' could not be written, and nothing was changed',
                            remedy) from None


class _Ask:
    """What a source's setup may ask of the run: a terminal, and the probe."""

    def __init__(self, place: Any) -> None:
        self._place = place
        self.tty = place.tty is True and place.prompt is not None

    def confirm(self, label: str) -> bool:
        typed = self._place.prompt(label) if self.tty else None
        return typed is not None and _YES.fullmatch(typed.strip(_JS_SPACE)) is not None

    def presented(self, base: str) -> str:
        if self._place.presented is None:
            raise RuntimeError('no probe for ' + base)
        return self._place.presented(base)


def _account_of(source: str, connect: dict[str, Any], given: Any) -> str | None:
    account = connect['account']
    term = account['term']
    if account['discover']:
        if given is not None:
            raise _bad('--account is for a source that cannot name its account, and ' + source + ' names its own',
                       'drop --account; `sources add` asks ' + source + ' for it')
        return None
    if given is None:
        why = account.get('why')
        raise _bad(source + "'s account cannot be discovered" + ('' if why is None else ': ' + why),
                   'give --account with ' + term + "; every note's identity derives from it")
    if '' == given:
        raise _bad('--account is empty', 'give --account with ' + term)
    return str(given)


def _plain(_instance: str, given: dict[str, Any], _ask: _Ask) -> dict[str, Any]:
    return {'base': given['base']} if 'base' in given else {}


def _discover(place: Any, adapter: Any, config: _Config, ref: str, chain: list[Any],
              watch: Callable[[Station], None]) -> str:
    """The account the source names, asked through a station on the configuration being written."""
    seed = (place.fixture or {}).get(ref)
    station = open_station(with_chain(plain_of(config.doc), chain if seed is None else []), place.env)
    watch(station)
    conn = Connection(ref, _api(ref), '')
    detail = {'source': _api(ref), 'instance': ref}
    try:
        configure = getattr(adapter, 'configure', None)
        handle = adapter.connect(station, conn, None if configure is None else configure(ref, _block(station, ref)),
                                 seed)
        account = adapter.account(handle)
    except LikenessError:
        raise
    except Exception as err:
        status = getattr(err, 'status', None)
        code = 'auth-failed' if status in (401, 403) else 'rate-limited' if 429 == status else 'source-unavailable'
        raise LikenessError(code, _api(ref) + ' did not name the account ' + ref + ' reaches',
                            'run `likeness sources add` again once ' + _api(ref) + ' answers, or check its token',
                            detail) from None
    if not isinstance(account, str) or '' == account:
        raise LikenessError('source-unavailable', _api(ref) + ' named no account for ' + ref,
                            'this is a bug in the source or its SDK', detail)
    return account


def add(place: Any, given: dict[str, Any], flags: Any, watch: Callable[[Station], None] = lambda _s: None) -> Reply:
    """A connection added: refused before any prompt where the flags alone
    decide it, its token stored in the vault before either file changes, and
    both files written together or not at all."""
    choose = 'name one of ' + _listed(sorted(s for s in ADAPTERS if connect_of(s) is not None))
    sources = list(given.get('source') or [])
    if 0 == len(sources):
        raise _bad('`sources add` needs --source, the API to connect', choose)
    if 1 < len(sources):
        raise _bad('--source was given more than once, and `sources add` adds one connection', 'give --source once')
    source = sources[0]
    connect = connect_of(source)
    if connect is None:
        raise LikenessError('no-such-source', 'likeness reaches no source by the name --source gives', choose)
    adapter = ADAPTERS.get(source)
    if adapter is None:
        raise LikenessError('unsupported-capability', 'no adapter for source "' + source + '" yet', choose,
                            {'source': source})
    foreign = [f for f in source_flags() if f in given and f not in connect['flag']]
    if foreign:
        raise _bad('--' + foreign[0] + ' does not apply to a ' + source + ' connection',
                   'run `likeness help sources add` for the flags each source reads')
    instances = list(given.get('instance') or [])
    if 1 < len(instances):
        raise _bad('--instance was given more than once, and `sources add` adds one connection',
                   'give --instance once, with the tag')
    ref = ref_for(source, instances[0] if instances else None)
    if 'base' in given and _BASE.fullmatch(given['base']) is None:
        default = connect['default'].get('base')
        raise _bad('--base is not an http or https address without credentials, a query or a fragment',
                   'give where the application answers' +
                   (', as scheme, host and port' if default is None else ', such as ' + default))
    account = _account_of(source, connect, given.get('account'))
    existing = given.get('secret')
    ask = _Ask(place)
    if existing is None and not ask.tty:
        raise _bad('the token is typed at a prompt, and stdin is not a terminal',
                   'store it with `likeness secrets set ' + secret_name(ref) + ' -`, and name it with --secret ' +
                   secret_name(ref))

    config = _config_of(place)
    profile = profile_of(place.env)
    current = _as_read(config, place)
    if _declares(_sdk_of(config, profile), ref):
        raise LikenessError('instance-exists', 'a connection named "' + ref + '" is already configured' +
                            ('' if 'default' == profile else ' under the profile "' + profile + '"'),
                            'choose another tag with --instance, or remove it first with `likeness sources remove ' +
                            ref + '`')
    entry: VaultEntry = vault_entry(plain_of(config.doc), profile, config.home,
                                    os.path.dirname(config.station_path) or '.', flags.vault_key)
    present(entry)

    chosen = dict(connect['default'])
    for f in ['base', *connect['flag']]:
        if f in given:
            chosen[f] = given[f]
    made = getattr(adapter, 'setup', _plain)(ref, chosen, ask)

    sdk = _make(config.doc, ['profiles', profile, 'sdk'], shown(config.station_path, config.home))

    # Station words a shared secret name differently in each of its ports.
    def refused(code: str, message: str) -> LikenessError:
        if 'station_secret_collision' != code:
            return _bad('station refuses the connection this would add: ' + message,
                        'give --secret a name `likeness secrets list` shows')
        want = existing if existing is not None else secret_name(ref)
        other = next((i for i in current.instances() if _secret_of(i['block'], i['name']) == want), None)
        return _bad(ref + "'s secret name is another connection's as well" if other is None
                    else ref + ' would take its token from ' + want + ', as ' + other['name'] + ' does',
                    'choose another tag with --instance, or name a secret of its own with --secret')

    put(sdk, ref, doc_of(made))
    found = _block(_station_of(config, place, refused), ref)
    if existing is not None and existing != _secret_of(found, ref):
        put(sdk, ref, doc_of({**made, 'secret': existing}))
        found = _block(_station_of(config, place, refused), ref)
    configure = getattr(adapter, 'configure', None)
    if configure is not None:
        try:
            configure(ref, found)
        except LikenessError as err:
            raise _bad(err.message, 'run `likeness help sources add` for the flags each source reads') from None
    secret = _secret_of(found, ref)

    phrase = passphrase(place, flags, entry.key)
    vault, info = opened(entry, phrase)
    stored = None
    try:
        if existing is not None:
            if secret not in vault.list():
                raise LikenessError(
                    'not-found', 'the vault has no ' + secret + ' that the key ' + entry.key + ' can read',
                    'store it with `likeness secrets set ' + secret + '`, or name another with --secret')
        else:
            if not info['master']:
                raise LikenessError(
                    'vault-denied',
                    'only a master key stores a new secret, and the key ' + entry.key + ' is restricted',
                    'run it as the master key, or store the token first and name it with --secret')
            if secret in vault.list():
                raise LikenessError(
                    'vault-exists',
                    'the vault already holds ' + secret + ', and `sources add` never overwrites a token',
                    'use it with --secret ' + secret + ', or drop it first with `likeness secrets remove ' +
                    secret + '`')
            token = place.prompt('token for ' + ref)
            if token is None or '' == token:
                raise _bad('no token was given', 'run it again, and type the token')
            written(entry, lambda: vault.set(secret, token))
            stored = secret

        id = account if account is not None else _discover(
            place, adapter, config, ref,
            [{'kind': 'minivault', 'file': entry.file, 'vaultkey': entry.key, 'passphrase': phrase}], watch)
        accounts = config.accounts if config.accounts is not None else doc_of({'likeness': 1, 'profiles': {}})
        assert isinstance(accounts, Obj)
        put(_make(accounts, ['profiles', profile, 'instances'], shown(config.likeness_path, config.home)), ref,
            doc_of({'account': id}))
        _commit(place, config, accounts)

        return Reply(_row_of(ref, found, id, True), 1,
                     'added ' + ref + ('' if 'default' == profile else ' to the profile ' + profile) +
                     ', its token in the vault as ' + secret + '\n')
    except BaseException:
        if stored is not None:
            try:
                vault.remove(stored)
            except Exception:
                pass  # the refusal raised names what failed; the token stays where it was put
        raise
    finally:
        vault.close()


def remove(place: Any, ref: str) -> Reply:
    """A connection and its account removed together. The vault is the secrets group's."""
    config = _config_of(place)
    profile = profile_of(place.env)
    secret = _secret_of(_block(_as_read(config, place), ref), ref)
    _owned(config, profile, ref)
    sdk = _sdk_of(config, profile)
    assert sdk is not None
    drop(sdk, ref)
    accounts = _find(config.accounts, ['profiles', profile, 'instances'])
    _commit(place, config, config.accounts if accounts is not None and drop(accounts, ref) else None)
    return Reply({'instance': ref, 'secret': secret}, 1,
                 'removed ' + ref + '; the vault still holds ' + secret + ', which `likeness secrets` manages\n')


def rename(place: Any, old: str, new: str) -> Reply:
    """A connection under a new ref, keeping its place in both files. A token
    found by the ref's derived name is named in the block, since that name
    changes with the ref."""
    if old == new:
        raise _bad(old + ' already has that ref',
                   'give the new ref second: `likeness sources rename ' + old + ' <new-ref>`')
    api = _api(old)
    if _api(new) != api:
        raise _bad('a connection keeps its API, so ' + old + ' cannot become ' + new,
                   'rename it to ' + api + ' or ' + api +
                   '$<tag>; a connection to another API is added with `likeness sources add`')
    config = _config_of(place)
    profile = profile_of(place.env)
    station = _as_read(config, place)
    _owned(config, profile, old)
    if any(i['name'] == new for i in station.instances()):
        raise LikenessError('instance-exists', 'a connection named "' + new + '" is already configured',
                            'choose another ref, or remove that one first with `likeness sources remove ' + new + '`')
    before = _block(station, old)
    sdk = _sdk_of(config, profile)
    assert sdk is not None
    rekey(sdk, old, new)
    if not _named(before):
        moved_block = member(sdk, new)
        assert isinstance(moved_block, Obj)
        put(moved_block, 'secret', doc_of(secret_name(old)))
    after = _block(_station_of(config, place, lambda code, _message: _bad(
        old + ' cannot become ' + new + ': station refuses the configuration that would leave, as ' + code,
        'choose another ref')), new)

    accounts = _find(config.accounts, ['profiles', profile, 'instances'])
    moved = False
    if accounts is not None:
        moved = drop(accounts, new)
        if member(accounts, old) is not None:
            rekey(accounts, old, new)
            moved = True
    _commit(place, config, config.accounts if moved else None)
    secret = _secret_of(after, new)
    return Reply({'instance': new, 'was': old, 'secret': secret}, 1,
                 'renamed ' + old + ' to ' + new + '; its token is still ' + secret + ' in the vault\n')
