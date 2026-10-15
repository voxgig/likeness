"""Obsidian, through its Local REST API plugin, by voxgig-sdk/obsidian-sdk bound to station."""

from __future__ import annotations

import math
from collections.abc import Generator
from dataclasses import dataclass
from typing import Any

from likeness.adapter import Check
from likeness.caps import page_max
from likeness.envelope import render_raw
from likeness.errors import LikenessError
from likeness.identity import lid, rfc3339
from likeness.note import Note
from likeness.pin import CertificateError, PinError, parse_pin, pinned_fetcher
from likeness.text import utf8

SOURCE = 'obsidian'

SUPPLIES = ['source', 'instance', 'space', 'title', 'body', 'tag', 'created', 'updated']

# The one representation of a note that carries its frontmatter, tags and stat.
NOTE_JSON = 'application/vnd.olrapi.note+json'

BUG = 'this is a bug in the source or its SDK; run with --raw to capture the payload'

_UNRESERVED = frozenset(b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-')

_ABSENT = object()


def _text(v: Any) -> str:
    return v if isinstance(v, str) else render_raw(v)


def _ms(v: Any) -> int:
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return v
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    return 0


def transport(instance: str, block: dict[str, Any]) -> dict[str, str]:
    """How a connection reaches the plugin, from its block in station.json.
    HTTPS, the plugin's default, is trusted only with a pinned certificate;
    plain HTTP only where the block says so. Anything else is refused before
    any call."""
    named = SOURCE + ' connection "' + instance + '"'
    pin = ('pin its certificate under sdk.' + instance + ' in station.json: '
           '"options": { "tls": { "fingerprint": "sha256:<hex>" } }')

    def refuse(what: str, remedy: str = pin) -> LikenessError:
        return LikenessError('invalid-project', named + ' ' + what, remedy)

    options = block.get('options')
    options = {} if options is None else options
    if not isinstance(options, dict):
        raise refuse('has options that are not a map', 'its options take tls alone')
    extra = sorted(k for k in options if 'tls' != k)
    if extra:
        raise refuse('has an option likeness does not read: "' + extra[0] + '"', 'its options take tls alone')

    base = block.get('base')
    base = 'https://' if base is None else _text(base).lower()
    secure = base.startswith('https://')
    if not secure and not base.startswith('http://'):
        raise refuse('has a base that is neither https nor http',
                     "name the plugin's address, as https://127.0.0.1:27124")

    tls = options.get('tls', _ABSENT)
    if tls is False:
        if secure:
            raise refuse('turns TLS off on an https base, and verification is never turned off')
        return {'tls': 'off'}
    if not secure:
        raise refuse('is plain HTTP and does not declare it' if tls is _ABSENT
                     else 'pins a certificate on a plain HTTP base',
                     'declare plain HTTP with "options": { "tls": false }, '
                     "or use the plugin's HTTPS base with a pinned certificate")
    if tls is _ABSENT:
        raise refuse("pins no certificate, and the plugin's certificate is self-signed")
    if not isinstance(tls, dict) or 1 != len(tls) or 'fingerprint' not in tls:
        raise refuse('has a tls option that is neither a pinned fingerprint nor false')
    try:
        return {'tls': 'pinned', 'pin': parse_pin(tls['fingerprint'])}
    except PinError:
        raise refuse('pins a fingerprint that is not sha256 and 64 hex digits') from None


def configure(instance: str, block: dict[str, Any]) -> dict[str, str]:
    return transport(instance, block)


PLAIN = 'http://127.0.0.1:27123'


def _bad(message: str, remedy: str) -> LikenessError:
    return LikenessError('invalid-argument', message, remedy)


def setup(instance: str, given: dict[str, Any], ask: Any) -> dict[str, Any]:
    """The block `sources add` writes. An https base is pinned to the
    certificate it presents, which --fingerprint names or a terminal confirms:
    never one taken on trust because it answered first."""
    base = str(given.get('base'))
    fingerprint = given.get('fingerprint')
    if given.get('plain-http') is True:
        if fingerprint is not None:
            raise _bad('--plain-http and --fingerprint contradict each other: plain HTTP pins no certificate',
                       'give one of them')
        if not base.startswith('http://'):
            raise _bad('--plain-http needs an http base',
                       "give the plugin's HTTP address with --base, such as " + PLAIN)
        return {'base': base, 'options': {'tls': False}}
    if not base.startswith('https://'):
        raise _bad('an http base is plain HTTP, which only --plain-http declares',
                   "add --plain-http, or give the plugin's HTTPS address with --base")

    pin = None
    if fingerprint is not None:
        try:
            pin = parse_pin(fingerprint)
        except PinError:
            raise _bad('--fingerprint is not sha256: and 64 hex digits',
                       "give the certificate's SHA-256, as sha256:<hex>") from None
    elif not ask.tty:
        raise _bad("pinning the plugin's certificate needs --fingerprint, or a terminal to confirm it on",
                   'pass --fingerprint sha256:<hex>; '
                   '`openssl x509 -noout -fingerprint -sha256 -in obsidian-local-rest-api.crt` prints it')

    named = SOURCE + ' at ' + base
    detail = {'source': SOURCE, 'instance': instance}
    try:
        presented = ask.presented(base)
    except Exception:
        raise LikenessError('source-unavailable', 'nothing at ' + base + ' presented a certificate',
                            'start Obsidian with the Local REST API community plugin enabled, '
                            'or give its address with --base', detail) from None
    if pin is not None and pin != presented:
        raise LikenessError('certificate-rejected',
                            named + ' presents ' + presented + ', not the certificate --fingerprint names',
                            "check the fingerprint against the plugin's certificate; "
                            'if it was regenerated, pass the new one', detail)
    if pin is None and not ask.confirm(named + ' presents ' + presented + '; type yes to pin it'):
        raise LikenessError('certificate-rejected', 'the certificate ' + named + ' presents was not confirmed',
                            "check it against the plugin's certificate, and run it again to pin it", detail)
    return {'base': base, 'options': {'tls': {'fingerprint': presented}}}


@dataclass(frozen=True)
class Handle:
    sdk: Any
    plain: bool
    instance: str


def connect(station: Any, conn: Any, config: dict[str, str], seed: dict[str, Any] | None = None) -> Handle:
    from obsidian_sdk import ObsidianSDK
    feature: dict[str, Any] = {'station': {'instance': conn.instance}}
    options: dict[str, Any] = {'headers': {'accept': NOTE_JSON}, 'feature': feature}
    if seed is not None:
        feature['test'] = {**seed, 'active': True}
    elif 'pinned' == config['tls']:
        options['utility'] = {'fetcher': pinned_fetcher(config['pin'])}
    return Handle(station.connect(ObsidianSDK, options), 'off' == config['tls'], conn.instance)


def percent_encode(s: str) -> str:
    """Every byte but the unreserved characters of RFC 3986 percent-encoded, hex in capitals."""
    return ''.join(chr(b) if b in _UNRESERVED else '%%%02X' % b for b in utf8(s))


def note_url(vault: str, path: str) -> str:
    """Obsidian's own URI: the vault by its id, which is the connection's account."""
    return 'obsidian://open?vault=' + percent_encode(vault) + '&file=' + percent_encode(path)


def entries(listed: list[Any]) -> list[str]:
    """A listing's entries, as the plugin lists one directory: by first segment,
    a directory with its slash, each once, in code-point order. The plugin names
    one level as text; the SDK's offline transport lists every record of the
    entity by id, and the same rule walks both to the same tree."""
    out: set[str] = set()
    for e in listed:
        name = e if isinstance(e, str) else \
            e['id'] if isinstance(e, dict) and isinstance(e.get('id'), str) else None
        segs = [] if name is None else name.split('/')
        last = len(segs) - 1
        if name is None or '' == name or \
                any(g in ('.', '..') or ('' == g and i != last) for i, g in enumerate(segs)):
            raise LikenessError(
                'source-unavailable',
                SOURCE + ' returned a vault listing with an entry that names no path below it', BUG)
        out.add(segs[0] if 1 == len(segs) else segs[0] + '/')
    return sorted(out)


def _stamp(v: Any, field: str) -> str:
    try:
        return rfc3339(_ms(v))
    except ValueError:
        raise LikenessError('source-unavailable',
                            SOURCE + ' returned a note whose ' + field + ' is outside the years 0000 to 9999',
                            BUG) from None


def _tags_of(v: Any) -> list[str]:
    """Absent is fetched and empty; a null entry is dropped, any other is its text."""
    if v is None:
        return []
    return [_text(t) for t in (v if isinstance(v, list) else [v]) if t is not None]


def project(raw: Any, path: str, instance: str, account: str, with_raw: bool) -> Note:
    if not isinstance(raw, dict):
        raise LikenessError('source-unavailable', SOURCE + ' returned a note that is not a record', BUG)
    at = path.rfind('/')
    stat = raw.get('stat') if isinstance(raw.get('stat'), dict) else {}
    note: Note = {
        'lid': lid(SOURCE, account, 'note', path),
        'source': SOURCE,
        'instance': instance,
        'id': path,
        'title': path[at + 1:len(path) - len('.md')],
        'url': note_url(account, path),
        'created': _stamp(stat.get('ctime'), 'stat.ctime'),
        'updated': _stamp(stat.get('mtime'), 'stat.mtime'),
        'tags': _tags_of(raw.get('tags')),
    }
    if 0 < at:
        note['space'] = path[:at]
    if raw.get('content') is not None:
        note['body'] = _text(raw['content'])
    if with_raw:
        note['raw'] = render_raw(raw)
    return note


def _data(entity: Any) -> Any:
    getter = getattr(entity, 'data_get', None)
    return getter() if callable(getter) else entity


def _not_found(err: Exception) -> bool:
    return getattr(err, 'not_found', None) is True or 404 == getattr(err, 'status', None)


_REFUSED = {
    'changed': 'presented a certificate whose fingerprint is not the one its connection pins',
    'expired': 'presented its pinned certificate, which has expired',
    'not-yet-valid': 'presented its pinned certificate, which is not valid yet',
    'wrong-host': 'presented its pinned certificate, which does not name the host connected to',
    'invalid': 'presented a certificate that failed verification',
}


def _rejected(instance: str, err: CertificateError) -> LikenessError:
    return LikenessError(
        'certificate-rejected', SOURCE + ' connection "' + instance + '" ' + _REFUSED[err.refusal],
        "if the plugin's certificate was regenerated, pin its new fingerprint in station.json; "
        'if not, do not connect',
        {'source': SOURCE, 'instance': instance})


def _is_note(path: str) -> bool:
    """A note is a `.md` file, by its path from the vault root."""
    return path.endswith('.md')


def _listing(h: Handle, dir: str) -> list[str]:
    try:
        if '' == dir:
            return entries([_data(e) for e in (h.sdk.Vault().list() or [])])
        got = _data(h.sdk.Vault().load({'id': dir}))
        if not isinstance(got, dict) or not isinstance(got.get('files'), list):
            raise LikenessError('source-unavailable',
                                SOURCE + ' returned a directory with no list of files', BUG)
        return entries(got['files'])
    except CertificateError as err:
        raise _rejected(h.instance, err) from None
    except Exception as err:
        if _not_found(err):
            return []
        raise


def _read(h: Handle, conn: Any, path: str, with_raw: bool) -> Note | None:
    try:
        return project(_data(h.sdk.Vault().load({'id': path})), path, conn.instance, conn.account, with_raw)
    except CertificateError as err:
        raise _rejected(h.instance, err) from None
    except Exception as err:
        if _not_found(err):
            return None
        raise


Step = dict[str, str]


def walk_steps(dir: str = '') -> Generator[Step, list[str] | None, None]:
    """The walk, as the plugin lets a vault be walked: one directory at a time,
    depth first, each directory's entries in code-point order, and each note
    read as it is met. A list step is answered with that directory's entries."""
    for name in (yield {'list': dir}) or []:
        path = dir + name
        if name.endswith('/'):
            yield from walk_steps(path)
        elif _is_note(path):
            yield {'read': path}


def walk_notes(h: Handle, conn: Any, with_raw: bool, limit: int) -> tuple[list[Note], bool]:
    """A directory or a note gone since its parent was listed is skipped."""
    notes: list[Note] = []
    steps = walk_steps()
    try:
        at = next(steps)
        while True:
            if 'list' in at:
                at = steps.send(_listing(h, at['list']))
                continue
            if 0 < limit and limit <= len(notes):
                return notes, True
            note = _read(h, conn, at['read'], with_raw)
            if note is not None:
                notes.append(note)
            at = steps.send(None)
    except StopIteration:
        return notes, False
    finally:
        steps.close()


def list_notes(h: Handle, conn: Any, with_raw: bool) -> tuple[list[Note], bool]:
    return walk_notes(h, conn, with_raw, page_max(SOURCE))


def load_note(h: Handle, conn: Any, id: str, with_raw: bool) -> Note | None:
    segs = id.split('/')
    if any(g in ('.', '..') or ('' == g and i != len(segs) - 1) for i, g in enumerate(segs)):
        raise LikenessError(
            'invalid-ref',
            'not a ref: ' + conn.instance + ':' + id + ' (a vault path has no empty, . or .. segment)',
            'a ref is <instance>:<id>, a lid, #n or @alias')
    if not _is_note(id):
        raise LikenessError('not-found', conn.instance + ':' + id + ' is not a note, which is a .md file',
                            'check the ref, or run `likeness list` to see what is there')
    return _read(h, conn, id, with_raw)


def check(h: Handle) -> Check:
    how = ', over plain HTTP as the connection declares' if h.plain else ''
    try:
        h.sdk.Vault().list()
        return Check(True, 'ok' + how)
    except CertificateError as err:
        r = _rejected(h.instance, err)
        return Check(False, _REFUSED[err.refusal], r.code, r.remedy)
    except Exception as err:
        # An empty vault lists as not found, which only a token the plugin accepted can reach.
        if _not_found(err):
            return Check(True, 'ok' + how)
        status = getattr(err, 'status', None)
        if status in (401, 403):
            return Check(False, 'the token was rejected' + how, 'auth-failed')
        if 429 == status:
            return Check(False, 'the source is rate limiting this client' + how, 'rate-limited')
        return Check(False, 'the application did not answer' + how, 'source-unavailable',
                     'start Obsidian with the Local REST API community plugin enabled')
