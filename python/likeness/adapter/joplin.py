"""Joplin, through voxgig-sdk/joplin-sdk bound to station."""

from __future__ import annotations

import math
from typing import Any

from likeness.adapter import Check
from likeness.caps import page_max
from likeness.envelope import render_raw
from likeness.errors import LikenessError
from likeness.identity import lid, rfc3339
from likeness.note import Note

SOURCE = 'joplin'

SUPPLIES = ['source', 'instance', 'space', 'title', 'body', 'created', 'updated']

# Joplin answers id, parent_id and title unless asked. The wire name is
# `fields`; the client declares `field`, which Joplin ignores.
FIELDS = 'id,parent_id,title,body,created_time,updated_time'


def _text(v: Any) -> str:
    """A non-string value projects as its canonical JSON text."""
    return v if isinstance(v, str) else render_raw(v)


def _ms(v: Any) -> int:
    """A timestamp that is not an integral number is the epoch."""
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return v
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    return 0


def connect(station: Any, conn: Any, _config: Any, seed: dict[str, Any] | None = None) -> Any:
    """The ref rides the station feature's options: beside them the SDK would refuse it."""
    from joplin_sdk import JoplinSDK
    feature: dict[str, Any] = {'station': {'instance': conn.instance}}
    if seed is not None:
        feature['test'] = {**seed, 'active': True}
    return station.connect(JoplinSDK, {'feature': feature})


def _stamp(v: Any, field: str) -> str:
    try:
        return rfc3339(_ms(v))
    except ValueError:
        raise LikenessError(
            'source-unavailable',
            'the source returned a ' + SOURCE + ' record whose ' + field + ' is outside the years 0000 to 9999',
            'this is a bug in the source or its SDK; run with --raw to capture the payload') from None


def project(raw: dict[str, Any], instance: str, account: str, with_raw: bool) -> Note:
    id = _text(raw['id']) if raw.get('id') is not None else ''
    # Refused, not fabricated: an empty id gives every such row one valid-looking lid.
    if '' == id:
        raise LikenessError(
            'source-unavailable', 'the source returned a ' + SOURCE + ' record with no id',
            'this is a bug in the source or its SDK; run with --raw to capture the payload')
    note: Note = {
        'lid': lid(SOURCE, account, 'note', id),
        'source': SOURCE,
        'instance': instance,
        'id': id,
        'title': _text(raw['title']) if raw.get('title') is not None else '',
        'url': 'joplin://x-callback-url/openNote?id=' + id,
        'created': _stamp(raw.get('created_time'), 'created_time'),
        'updated': _stamp(raw.get('updated_time'), 'updated_time'),
    }
    if raw.get('parent_id') is not None:
        space = _text(raw['parent_id'])
        if '' != space:
            note['space'] = space
    if raw.get('body') is not None:
        note['body'] = _text(raw['body'])
    if with_raw:
        # A STRING, never nested structure: the envelope forbids floating point
        # and a real payload has it. The client keeps no bytes, so re-rendered.
        note['raw'] = render_raw(raw)
    return note


def _data(entity: Any) -> Any:
    getter = getattr(entity, 'data_get', None)
    return getter() if callable(getter) else entity


def list_notes(client: Any, conn: Any, with_raw: bool) -> tuple[list[Note], bool]:
    found = client.Note().list({'fields': FIELDS})
    rows = [_data(e) for e in (found or [])]
    limit = page_max(SOURCE)
    notes = [project(r, conn.instance, conn.account, with_raw) for r in rows]
    return notes, 0 < limit <= len(rows)


def load_note(client: Any, conn: Any, id: str, with_raw: bool) -> Note | None:
    try:
        row = _data(client.Note().load({'id': id, 'fields': FIELDS}))
    except Exception as err:
        if getattr(err, 'not_found', None) is True or 404 == getattr(err, 'status', None):
            return None
        raise
    if not isinstance(row, dict) or 'id' not in row:
        return None
    return project(row, conn.instance, conn.account, with_raw)


def check(client: Any) -> Check:
    """Reachability for `doctor`, telling apart the failures whose remedies differ."""
    try:
        client.Note().list({'fields': FIELDS})
        return Check(True, 'ok')
    except Exception as err:
        status = getattr(err, 'status', None)
        if status in (401, 403):
            return Check(False, 'the token was rejected', 'auth-failed')
        if 429 == status:
            return Check(False, 'the source is rate limiting this client', 'rate-limited')
        return Check(False, 'the application did not answer', 'source-unavailable')
