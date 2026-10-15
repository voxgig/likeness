"""One whole command as a function of its inputs: the station, the commands, the run."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from types import ModuleType
from typing import TYPE_CHECKING, Any

from likeness.adapter import Check
from likeness.adapters import ADAPTERS
from likeness.args import Parsed, command_def, command_words, help_rows, help_text, parse_argv
from likeness.calls import Call, Calls
from likeness.caps import supports, term_of
from likeness.config import Fs, homedir
from likeness.envelope import render, serialise
from likeness.errors import LikenessError, exit_for
from likeness.evaluate import evaluate
from likeness.identity import parse_time
from likeness.note import Note, sort_notes
from likeness.selector import SelectorError, fields_of, parse_selector
from likeness.sources import Reply, add, list_sources, remove, rename
from likeness.station import Connection, connections_of, open_station, profile_of, with_chain
from likeness.vault import VaultEntry, secrets, vault_chain, vault_entry

if TYPE_CHECKING:
    from voxgig_station import Station

VERSION = '0.1.0'
PORT = 'py'


@dataclass
class Ctx:
    """Every impure input, named. The connections are station's declared
    instances, and each one's account comes from likeness.json beside it."""
    argv: list[str]
    clock: str
    env: dict[str, str] | None = None
    seed: int | None = None
    station: Any = None
    accounts: dict[str, str] | None = None
    # Seed maps for the SDKs' offline test mode, by instance: present in every
    # test and absent in production.
    fixture: dict[str, Any] | None = None
    path: list[dict[str, str]] | None = None
    # A path under home is shown from `~`; a relative vault path is read from
    # dir, where station.json is. The `sources` group rewrites the file at
    # config, and likeness.json beside it.
    home: str | None = None
    dir: str | None = None
    config: str | None = None
    stdin: Callable[[], str] | None = None
    # Stdin is a terminal, so what the environment lacks may be asked for.
    tty: bool = False
    prompt: Callable[[str], str | None] | None = None
    # The fingerprint of the certificate an https base presents.
    presented: Callable[[str], str] | None = None
    # The file operations a `sources` write goes through.
    fs: Fs | None = None


@dataclass
class Result:
    exit: int
    stdout: str
    stderr: str
    calls: list[Call]


@dataclass
class Flags:
    json: bool = False
    raw: bool = False
    strict: bool = False
    deterministic: bool = False
    limit: int | None = None
    sort: str | None = None
    instance: list[str] = field(default_factory=list)
    source: list[str] = field(default_factory=list)
    passphrase_env: str | None = None
    new_passphrase_env: str | None = None
    vault_key: str | None = None
    reveal: bool = False
    write: bool = False


def _flags_of(parsed: Parsed) -> Flags:
    f = parsed.flags
    return Flags(
        json=True is f.get('json'),
        raw=True is f.get('raw'),
        strict=True is f.get('strict'),
        deterministic=True is f.get('deterministic'),
        limit=f.get('limit'),
        sort=f.get('sort'),
        instance=list(f.get('instance') or []),
        source=list(f.get('source') or []),
        passphrase_env=f.get('passphrase-env'),
        new_passphrase_env=f.get('new-passphrase-env'),
        vault_key=f.get('vault-key'),
        reveal=True is f.get('reveal'),
        write=True is f.get('write'),
    )


def _envelope(cmd: list[str], code: str, data: Any, count: int = 0, truncated: bool = False,
              sources: list[str] | None = None, incomplete: list[str] | None = None,
              calls: int = 0, error: dict[str, str] | None = None) -> dict[str, Any]:
    env: dict[str, Any] = {
        'ok': error is None,
        'code': code,
        'cmd': [w for c in cmd for w in c.split(' ')],
        'data': data,
        'meta': {
            'count': count,
            'truncated': truncated,
            'sources': sources or [],
            'incomplete': incomplete or [],
            'calls': calls,
            'elapsed_ms': 0,
        },
        'port': PORT,
        'version': VERSION,
    }
    if error is not None:
        env['error'] = error
    return env


def _fails(env: dict[str, Any], message: str, remedy: str) -> dict[str, Any]:
    env['error'] = {'message': message, 'remedy': remedy}
    env['ok'] = False
    return env


def _quoted(s: str) -> str:
    return '"' + s + '"'


def _selected(conns: list[Connection], flags: Flags) -> list[Connection]:
    unknown_instance = [i for i in flags.instance if not any(c.instance == i for c in conns)]
    if unknown_instance:
        raise LikenessError(
            'no-such-source',
            'no connection named ' + ', '.join(_quoted(i) for i in sorted(unknown_instance)),
            'run `likeness doctor` to see the configured connections')
    unknown_source = [s for s in flags.source if not any(c.source == s for c in conns)]
    if unknown_source:
        raise LikenessError(
            'no-such-source',
            'no connection uses source ' + ', '.join(_quoted(s) for s in sorted(unknown_source)),
            'run `likeness doctor` to see the configured connections')
    return [c for c in conns
            if (not flags.instance or c.instance in flags.instance) and
            (not flags.source or c.source in flags.source)]


def _adapter_for(c: Connection) -> ModuleType | None:
    return ADAPTERS.get(c.source)


def _listable(c: Connection) -> bool:
    """Decided from the capability data alone, before any call (SPEC 12.3)."""
    adapter = _adapter_for(c)
    return adapter is not None and hasattr(adapter, 'list_notes') and supports(c.source, 'note', 'list')


def _cannot_list(conns: list[Connection]) -> LikenessError:
    sources = sorted({c.source for c in conns})
    detail = {'entity': 'note', 'op': 'list'}
    if 1 == len(sources):
        detail['source'] = sources[0]
    if 1 == len(conns):
        detail['instance'] = conns[0].instance
    ref = conns[0].instance + ':<' + term_of(conns[0].source, 'note') + ' id>' if 1 == len(conns) \
        else '<instance>:<id>'
    return LikenessError(
        'unsupported-capability', ', '.join(sources) + ' cannot list notes',
        'get one by its ref instead: `likeness get ' + ref + '`'
        if all(supports(c.source, 'note', 'get') for c in conns)
        else 'narrow to a source that can list notes with --source',
        detail)


STATION_REMEDY = 'fix station.json; station validates it against its own shape'


def _open_configured(ctx: Ctx) -> Station:
    """Station opened on the configuration with no secret chain. Any refusal of
    station's own here is the project's, whatever its code: no source has been
    asked anything yet."""
    try:
        return open_station(with_chain(ctx.station, []), ctx.env)
    except Exception as err:
        code = getattr(err, 'code', None)
        if isinstance(code, str) and code.startswith('station_'):
            raise LikenessError('invalid-project', str(err), STATION_REMEDY) from None
        raise


def _entry_of(ctx: Ctx, flags: Flags) -> VaultEntry:
    home = ctx.home if ctx.home is not None else homedir()
    return vault_entry(ctx.station, profile_of(ctx.env), home,
                       ctx.dir if ctx.dir is not None else os.path.join(home, '.config', 'likeness'),
                       flags.vault_key)


class Session:
    """One station per run: every client is connected through it lazily, and
    the calls a command made are the requests it observed. A live run with a
    connection to make opens it on the vault."""

    def __init__(self, ctx: Ctx, flags: Flags) -> None:
        entry = _entry_of(ctx, flags)
        station = _open_configured(ctx)
        self.conns = connections_of(station, ctx.accounts or {}, profile_of(ctx.env))
        self._configs = _configured(station, self.conns)
        if ctx.fixture is None and self.conns:
            chain = vault_chain(ctx, entry, flags)
            try:
                station = open_station(with_chain(ctx.station, chain), ctx.env)
            except Exception:
                raise LikenessError(
                    'secret-backend-unavailable', 'station could not open the vault as its secret store',
                    'this port\'s station must read minivault stores; see "Secrets" in the README') from None
        self._station = station
        self.calls = Calls(station)
        self._fixture = ctx.fixture or {}
        self._handles: dict[str, Any] = {}

    def handle(self, c: Connection) -> Any:
        if c.instance not in self._handles:
            adapter = _adapter_for(c)
            assert adapter is not None
            self._handles[c.instance] = adapter.connect(
                self._station, c, self._configs.get(c.instance), self._fixture.get(c.instance))
        return self._handles[c.instance]


def _configured(station: Station, conns: list[Connection]) -> dict[str, Any]:
    """Each connection's block from station.json, read by its own adapter. A
    block the adapter cannot use refuses the command before any call or prompt."""
    blocks = {i['name']: i['block'] for i in station.instances()}
    out: dict[str, Any] = {}
    for c in conns:
        configure = getattr(_adapter_for(c), 'configure', None)
        if configure is not None:
            out[c.instance] = configure(c.instance, blocks.get(c.instance) or {})
    return out


@dataclass
class _Gathered:
    notes: list[Note]
    ok: list[str]
    failed: list[str]
    short: list[str]


def _no_adapter(c: Connection, remedy: str) -> LikenessError:
    return LikenessError(
        'unsupported-capability',
        'no adapter for source "' + c.source + '" (connection "' + c.instance + '")', remedy)


def _gather(session: Session, conns: list[Connection], with_raw: bool, strict: bool) -> _Gathered:
    """A failure is carried the whole length of the pipeline: a silently dropped
    source gives a confident, smaller, wrong answer."""
    got = _Gathered([], [], [], [])
    for c in conns:
        adapter = _adapter_for(c)
        if adapter is None:
            raise _no_adapter(
                c, 'drop that connection, or narrow to one that is supported with --source')
        # Asked nothing, and counted as a connection that did not answer.
        if not _listable(c):
            got.failed.append(c.instance)
            if strict:
                break
            continue
        # Inside the boundary: station refusing one binding is that connection failing.
        try:
            notes, more = adapter.list_notes(session.handle(c), c, with_raw)
            got.notes.extend(notes)
            got.ok.append(c.instance)
            if more:
                got.short.append(c.instance)
        except Exception as err:
            # A guard's refusal stops the command: it is never an unavailable source.
            if isinstance(err, LikenessError) and 4 == exit_for(err.code):
                raise
            got.failed.append(c.instance)
            # `--strict` HALTS: going on through the rest would spend requests
            # the caller asked not to spend.
            if strict:
                break
    return _Gathered(got.notes, sorted(got.ok), sorted(got.failed), sorted(got.short))


_UNIVERSAL = ('lid', 'id', 'title', 'url', 'created', 'updated', 'source', 'instance')


def _supplies(c: Connection) -> set[str]:
    adapter = _adapter_for(c)
    return set(_UNIVERSAL) | set(adapter.SUPPLIES if adapter is not None else [])


def _unanswerable(conns: list[Connection], fields: list[str]) -> list[str]:
    if 0 == len(conns):
        return []
    sets = [_supplies(c) for c in conns]
    return sorted(f for f in fields if not all(f in s for s in sets))


def _cmd_list(ctx: Ctx, flags: Flags, rest: list[str], session: Session) -> dict[str, Any]:
    conns = _selected(session.conns, flags)
    clock_ms = parse_time(ctx.clock)

    selector = ' '.join(rest)
    node = None if '' == selector else parse_selector(selector)

    unlisted = [c for c in conns if _adapter_for(c) is not None and not _listable(c)]
    if conns and len(unlisted) == len(conns):
        raise _cannot_list(unlisted)

    if node is not None:
        unsupported = _unanswerable([c for c in conns if c not in unlisted], fields_of(node))
        if unsupported:
            raise LikenessError(
                'unsupported-capability',
                'no source can answer a question about ' + ', '.join(unsupported),
                'drop that term, or narrow to a source that supplies it with --source')

    got = _gather(session, conns, flags.raw, flags.strict)
    notes = got.notes
    if node is not None:
        notes = [n for n in notes if evaluate(node, n, clock_ms)]
    notes = sort_notes(notes, flags.sort)

    truncated = False
    if flags.limit is not None and flags.limit < len(notes):
        notes = notes[:flags.limit]
        truncated = True

    # A source that filled its page may have more: marked truncated and NAMED,
    # because a silently short list makes every result computed from it wrong.
    if got.short:
        truncated = True

    incomplete = sorted(got.failed + got.short)
    none_answered = 0 < len(got.failed) and 0 == len(got.ok)

    if got.failed and flags.strict:
        code = 'fanout-halted'
    elif none_answered:
        code = 'source-unavailable'
    elif incomplete:
        code = 'partial'
    elif 0 == len(notes):
        # Exit 1 is the answer "none", not an error: `ok` stays true.
        code = 'no-match'
    else:
        code = 'ok'

    env = _envelope(['list'], code, notes, count=len(notes), truncated=truncated,
                    sources=got.ok, incomplete=incomplete, calls=session.calls.count())
    if 'fanout-halted' == code:
        return _fails(env, ', '.join(got.failed) + ' did not answer and --strict was given',
                      'drop --strict to accept a partial answer, or fix the named connection')
    if 'source-unavailable' == code:
        # null, not []: [] means the sources were asked and held nothing.
        env['data'] = None
        return _fails(env, 'no source answered: ' + ', '.join(got.failed),
                      'run `likeness doctor` to see which connection is failing and why')
    return env


def _cmd_get(flags: Flags, rest: list[str], session: Session) -> dict[str, Any]:
    out: list[Note] = []
    for ref in rest:
        idx = ref.find(':')
        if idx < 1:
            raise LikenessError('invalid-ref', 'not a ref: ' + ref,
                                'a ref is <instance>:<id>, a lid, #n or @alias')
        instance, id = ref[:idx], ref[idx + 1:]
        if '' == id:
            raise LikenessError('invalid-ref', 'not a ref: ' + ref + ' (no id after the colon)',
                                'a ref is <instance>:<id>, a lid, #n or @alias')
        # A dot segment substituted into a route would name another resource.
        if id in ('.', '..'):
            raise LikenessError('invalid-ref', 'not a ref: ' + ref + ' (an id is never . or ..)',
                                'a ref is <instance>:<id>, a lid, #n or @alias')
        c = next((x for x in session.conns if x.instance == instance), None)
        if c is None:
            raise LikenessError('no-such-source', 'no connection named "' + instance + '"',
                                'run `likeness doctor` to see the configured connections')
        adapter = _adapter_for(c)
        if adapter is None:
            raise _no_adapter(c, 'this source arrives in a later stage')
        if not hasattr(adapter, 'load_note') or not supports(c.source, 'note', 'get'):
            raise LikenessError('unsupported-capability', c.source + ' cannot get a note',
                                'run `likeness doctor` to see what each connection offers',
                                {'source': c.source, 'instance': c.instance, 'entity': 'note', 'op': 'get'})
        note = adapter.load_note(session.handle(c), c, id, flags.raw)
        if note is None:
            raise LikenessError('not-found', ref + ' does not exist',
                                'check the ref, or run `likeness list` to see what is there')
        out.append(note)
    return _envelope(['get'], 'ok', out, count=len(out),
                     sources=sorted({n['instance'] for n in out}), calls=session.calls.count())


def _cmd_doctor(name: str, flags: Flags, session: Session) -> dict[str, Any]:
    conns = _selected(session.conns, flags)
    rows: list[dict[str, Any]] = []
    failures: list[str] = []
    for c in conns:
        adapter = _adapter_for(c)
        if adapter is None:
            # `doctor` REPORTS rather than refuses: naming the unsupported source
            # is exactly the diagnosis the command exists to give.
            rows.append({'instance': c.instance, 'source': c.source, 'check': 'FAIL',
                         'detail': 'no adapter for this source yet', 'code': 'unsupported-capability'})
            failures.append('unsupported-capability')
            continue
        try:
            r = adapter.check(session.handle(c))
        except Exception:
            r = Check(False, 'station could not connect this instance', 'source-unavailable')
        row: dict[str, Any] = {'instance': c.instance, 'source': c.source,
                               'check': 'ok' if r.ok else 'FAIL', 'detail': r.detail}
        if not r.ok:
            row['code'] = r.code
            failures.append(str(r.code))
        if r.remedy is not None:
            row['remedy'] = r.remedy
        rows.append(row)
    # The worst row wins: highest exit status, then code name to break a tie.
    codes = sorted(set(failures), key=lambda c: (-exit_for(c), c))
    env = _envelope([name], codes[0] if codes else 'ok', rows, count=len(rows),
                    sources=sorted(c.instance for c in conns), calls=session.calls.count())
    if failures:
        noun = ' connection needs' if 1 == len(failures) else ' connections need'
        return _fails(env, str(len(failures)) + noun + ' attention',
                      'start the application, check the token, and re-run `likeness ' + name + '`')
    return env


def _cmd_version() -> dict[str, Any]:
    return _envelope(['version'], 'ok', {'port': PORT, 'version': VERSION}, count=1)


def _cmd_which(ctx: Ctx) -> dict[str, Any]:
    """Injected rather than probed, so `which` is a corpus entry like any other.
    Absent is the empty answer, not a row claiming to be the only installation."""
    rows = list(ctx.path or [])
    return _envelope(['which'], 'no-match' if 0 == len(rows) else 'ok', rows, count=len(rows))


def _cmd_help(args: list[str]) -> tuple[dict[str, Any], str]:
    name = ' '.join(args)
    text = help_text(name)
    if text is None:
        raise LikenessError('invalid-argument', 'no such command: ' + name,
                            'run `likeness help` for the command list')
    rows = [r for r in help_rows()
            if '' == name or r['command'] == name or r['command'].startswith(name + ' ')]
    return _envelope(['help'], 'ok', rows, count=len(rows)), text


def _replied(name: str, got: Reply) -> tuple[dict[str, Any], str | None]:
    return _envelope([name], 'no-match' if got.empty else 'ok', got.data, count=got.count), got.text


def _cmd_sources(ctx: Ctx, parsed: Parsed, flags: Flags,
                 watch: Callable[[Station], None]) -> tuple[dict[str, Any], str | None]:
    """Every `sources` action but `test`, which runs as doctor does."""
    name = parsed.command
    if 'sources list' == name:
        return _replied(name, list_sources(_open_configured(ctx), ctx.accounts or {}))
    if 'sources add' == name:
        return _replied(name, add(ctx, parsed.flags, flags, watch))
    if 'sources remove' == name:
        return _replied(name, remove(ctx, parsed.args[0]))
    if 'sources rename' == name:
        return _replied(name, rename(ctx, parsed.args[0], parsed.args[1]))
    raise RuntimeError('no such sources action: ' + name)


def _cmd_secrets(ctx: Ctx, name: str, flags: Flags, args: list[str]) -> tuple[dict[str, Any], str]:
    got = secrets(name[len('secrets '):], args, _entry_of(ctx, flags), ctx, flags)
    return _envelope([name], 'no-match' if got.empty else 'ok', got.data, count=got.count), got.text


def _elapsed_ms(started: int) -> int:
    return (time.monotonic_ns() - started) // 1_000_000


def _result(env: dict[str, Any], json: bool, deterministic: bool, started: int, calls: Calls,
            text: str | None = None) -> Result:
    """Measured once, around the whole command; zeroed under --deterministic so
    the declared exception cannot defeat the byte diff."""
    env['meta']['elapsed_ms'] = 0 if deterministic else _elapsed_ms(started)
    if json:
        stdout = serialise(env)
    else:
        stdout = text if text is not None else _human(env)
    return Result(exit_for(env['code']), stdout, '' if json else _narrate(env), calls.all())


def run(ctx: Ctx) -> Result:
    started = time.monotonic_ns()

    # The grammar decides first: a refused argument runs nothing at all.
    try:
        parsed = parse_argv(ctx.argv)
    except Exception as err:
        calls = Calls()
        env = _error_envelope(' '.join(command_words(ctx.argv)), err, calls)
        return _result(env, '--json' in ctx.argv, '--deterministic' in ctx.argv, started, calls)

    name = parsed.command
    flags = _flags_of(parsed)
    calls = Calls()

    def watch(station: Station) -> None:
        nonlocal calls
        calls = Calls(station)

    try:
        definition = command_def(name) or {}
        if not definition.get('ready'):
            raise LikenessError(
                'unsupported-capability',
                '`' + name + '` is not implemented yet - ' + str(definition.get('short')),
                'it arrives in a later stage; run `likeness help` for what works now')
        if 'help' == name:
            env, text = _cmd_help(parsed.args)
            return _result(env, flags.json, flags.deterministic, started, calls, text)
        if 'version' == name:
            return _result(_cmd_version(), flags.json, flags.deterministic, started, calls)
        if 'which' == name:
            return _result(_cmd_which(ctx), flags.json, flags.deterministic, started, calls)
        if name.startswith('secrets '):
            env, text = _cmd_secrets(ctx, name, flags, parsed.args)
            return _result(env, flags.json, flags.deterministic, started, calls, text)
        if name.startswith('sources ') and 'sources test' != name:
            env, maybe = _cmd_sources(ctx, parsed, flags, watch)
            return _result(env, flags.json, flags.deterministic, started, calls, maybe)

        session = Session(ctx, flags)
        calls = session.calls
        if 'list' == name:
            env = _cmd_list(ctx, flags, parsed.args, session)
        elif 'get' == name:
            env = _cmd_get(flags, parsed.args, session)
        elif 'doctor' == name:
            env = _cmd_doctor(name, flags, session)
        elif 'sources test' == name:
            env = _cmd_doctor(name, replace(flags, instance=[*flags.instance, *parsed.args]), session)
        else:
            raise RuntimeError('declared ready and not dispatched: ' + name)
    except Exception as err:
        env = _error_envelope(name, err, calls)
    return _result(env, flags.json, flags.deterministic, started, calls)


def _error_envelope(name: str, err: Exception, calls: Calls) -> dict[str, Any]:
    if isinstance(err, SelectorError):
        return _envelope([name], 'invalid-selector', None, calls=calls.count(), error={
            'message': err.message + ' at byte ' + str(err.offset),
            'remedy': 'check the selector grammar with `likeness describe`',
        })
    if isinstance(err, LikenessError):
        return _envelope([name], err.code, None, calls=calls.count(),
                         error={'message': err.message, 'remedy': err.remedy, **err.detail})
    if 'station_config_invalid' == getattr(err, 'code', None):
        return _envelope([name], 'invalid-project', None, calls=calls.count(), error={
            'message': str(err),
            'remedy': STATION_REMEDY,
        })
    status = getattr(err, 'status', None)
    code = 'auth-failed' if status in (401, 403) else 'rate-limited' if 429 == status \
        else 'source-unavailable'
    # The source's own words are not repeated: they differ per port and embed
    # the URL that was tried. The code carries the meaning.
    return _envelope([name], code, None, calls=calls.count(), error={
        'message': 'the source did not complete the request',
        'remedy': 'run `likeness doctor` to see which connection is failing and why',
    })


def _human(env: dict[str, Any]) -> str:
    d = env['data']
    if d is None:
        return ''
    # Nothing matched prints nothing: a blank line reads as one unnamed result.
    if isinstance(d, list) and 0 == len(d):
        return ''
    if isinstance(d, list) and isinstance(d[0], dict) and 'lid' in d[0]:
        return ''.join(str(i + 1).rjust(3) + '  ' + n['instance'].ljust(8) + '  ' + n['title'] + '\n'
                       for i, n in enumerate(d))
    if isinstance(d, list):
        return '\n'.join(render(r) for r in d) + '\n'
    return render(d) + '\n'


def _narrate(env: dict[str, Any]) -> str:
    out = []
    if env['meta']['incomplete']:
        out.append(', '.join(env['meta']['incomplete']) + ' unavailable - results are incomplete')
    error = env.get('error')
    if error is not None:
        out.append('error: ' + env['code'])
        out.append('  ' + error['message'])
        out.append('  remedy  ' + error['remedy'])
    return '\n'.join(out) + '\n' if out else ''
