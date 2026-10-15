"""Notion, through voxgig-sdk/notion-sdk bound to station."""

from __future__ import annotations

import re
from typing import Any

from likeness.adapter import Check
from likeness.envelope import render_raw
from likeness.errors import LikenessError
from likeness.identity import lid, parse_rfc3339, rfc3339
from likeness.note import Note

SOURCE = 'notion'

# A page is read without its blocks, so it brings no body and no tags.
SUPPLIES = ['source', 'instance', 'space', 'title', 'created', 'updated']

BUG = 'this is a bug in the source or its SDK; run with --raw to capture the payload'

# A page id no workspace holds: answered as not found once the token and the version are accepted.
NO_PAGE = '00000000-0000-0000-0000-000000000000'

_VERSION = re.compile('[0-9]{4}-[0-9]{2}-[0-9]{2}')

_URL = re.compile('https?://')


def _text(v: Any) -> str:
    return v if isinstance(v, str) else render_raw(v)


def configure(instance: str, block: dict[str, Any]) -> dict[str, str]:
    """The API version every request carries, pinned in the connection's block
    in station.json as its one header. Notion refuses a request without it, so
    a connection that does not pin one is refused before any call."""
    named = SOURCE + ' connection "' + instance + '"'
    pin = ('pin the API version under sdk.' + instance + ' in station.json: '
           '"options": { "headers": { "notion-version": "2022-06-28" } }')

    def refuse(what: str, remedy: str = pin) -> LikenessError:
        return LikenessError('invalid-project', named + ' ' + what, remedy)

    options = block.get('options')
    options = {} if options is None else options
    if not isinstance(options, dict):
        raise refuse('has options that are not a map', 'its options take headers alone')
    extra = sorted(k for k in options if 'headers' != k)
    if extra:
        raise refuse('has an option likeness does not read: "' + extra[0] + '"',
                     'its options take headers alone')

    headers = options.get('headers')
    headers = {} if headers is None else headers
    if not isinstance(headers, dict):
        raise refuse('has headers that are not a map')
    names = sorted(headers)
    other = [k for k in names if 'notion-version' != k.lower()]
    if other:
        raise refuse('has a header likeness does not send: "' + other[0] + '"',
                     'its headers take notion-version alone')
    if 0 == len(names):
        raise refuse('pins no Notion-Version, which every request to Notion carries')
    if 1 < len(names):
        raise refuse('pins Notion-Version more than once')
    version = headers[names[0]]
    if not isinstance(version, str) or _VERSION.fullmatch(version) is None:
        raise refuse('pins a Notion-Version that is not a date such as 2022-06-28')
    return {'version': version}


def connect(station: Any, conn: Any, config: dict[str, str], seed: dict[str, Any] | None = None) -> Any:
    """The ref goes in the station feature's options: the SDK refuses a top-level instance option."""
    from notion_sdk import NotionSDK
    feature: dict[str, Any] = {'station': {'instance': conn.instance}}
    if seed is not None:
        feature['test'] = {**seed, 'active': True}
    return station.connect(NotionSDK, {'headers': {'notion-version': config['version']}, 'feature': feature})


def title_of(properties: Any) -> str:
    """A page's title is its property of type `title`, rich text whose parts'
    plain text is joined. A page with more than one takes the first by name,
    in code-point order."""
    if not isinstance(properties, dict):
        return ''
    name = next((k for k in sorted(properties)
                 if isinstance(properties[k], dict) and 'title' == properties[k].get('type')), None)
    if name is None:
        return ''
    value = properties[name].get('title')
    if not isinstance(value, list):
        return '' if value is None else _text(value)
    out = []
    for part in value:
        plain = part.get('plain_text') if isinstance(part, dict) else part
        out.append('' if plain is None else _text(plain))
    return ''.join(out)


def space_of(parent: Any) -> str | None:
    """A page's space is its parent database, or its parent page; a workspace or a block is none."""
    if not isinstance(parent, dict):
        return None
    kind = parent['type'] if isinstance(parent.get('type'), str) else \
        'database_id' if parent.get('database_id') is not None else 'page_id'
    id = parent.get('database_id') if 'data_source_id' == kind else \
        parent.get(kind) if kind in ('database_id', 'page_id') else None
    space = '' if id is None else _text(id)
    return None if '' == space else space


def stamp(v: Any, field: str) -> str:
    """Text that is not an RFC 3339 date-time, or a value that is not text, is the epoch."""
    ms = parse_rfc3339(v) if isinstance(v, str) else None
    try:
        return rfc3339(0 if ms is None else ms)
    except ValueError:
        raise LikenessError('source-unavailable',
                            SOURCE + ' returned a page whose ' + field + ' is outside the years 0000 to 9999',
                            BUG) from None


def project(raw: Any, instance: str, account: str, with_raw: bool) -> Note:
    if not isinstance(raw, dict):
        raise LikenessError('source-unavailable', SOURCE + ' returned a page that is not a record', BUG)
    id = '' if raw.get('id') is None else _text(raw['id'])
    if '' == id:
        raise LikenessError('source-unavailable', SOURCE + ' returned a page with no id', BUG)
    url = raw.get('url')
    # Refused, not made up: a page's link is the one thing about it no id can stand in for.
    if not isinstance(url, str) or _URL.match(url) is None:
        raise LikenessError('source-unavailable', SOURCE + ' returned a page with no http or https url', BUG)
    note: Note = {
        'lid': lid(SOURCE, account, 'note', id),
        'source': SOURCE,
        'instance': instance,
        'id': id,
        'title': title_of(raw.get('properties')),
        'url': url,
        'created': stamp(raw.get('created_time'), 'created_time'),
        'updated': stamp(raw.get('last_edited_time'), 'last_edited_time'),
    }
    space = space_of(raw.get('parent'))
    if space is not None:
        note['space'] = space
    if with_raw:
        note['raw'] = render_raw(raw)
    return note


def _data(entity: Any) -> Any:
    getter = getattr(entity, 'data_get', None)
    return getter() if callable(getter) else entity


def _not_found(err: Exception) -> bool:
    return getattr(err, 'not_found', None) is True or 404 == getattr(err, 'status', None)


def load_note(client: Any, conn: Any, id: str, with_raw: bool) -> Note | None:
    try:
        raw = _data(client.Page().load({'id': id}))
    except Exception as err:
        if _not_found(err):
            return None
        raise
    return project(raw, conn.instance, conn.account, with_raw)


def check(client: Any) -> Check:
    try:
        client.Page().load({'id': NO_PAGE})
        return Check(True, 'ok')
    except Exception as err:
        if _not_found(err):
            return Check(True, 'ok')
        status = getattr(err, 'status', None)
        if status in (401, 403):
            return Check(False, 'the token was rejected', 'auth-failed')
        if 429 == status:
            return Check(False, 'the source is rate limiting this client', 'rate-limited')
        # The one request the check sends that a pinned version can spoil.
        if 400 == status:
            return Check(False, 'the service refused the request', 'source-unavailable',
                         'pin a Notion-Version that Notion publishes, such as 2022-06-28, '
                         'under its connection in station.json')
        return Check(False, 'the service did not answer', 'source-unavailable')
