"""Whether a note matches a selector, against an injected clock."""

from __future__ import annotations

import math
from typing import Any

from likeness.identity import DAY_MS, days_from_civil, parse_time
from likeness.note import Note
from likeness.selector import Node, Value

_DURATION_DAYS = {'d': 1, 'w': 7, 'mo': 30, 'y': 365}


def fold_case(s: str) -> str:
    """ASCII only, A-Z to a-z: the one folding every port applies identically."""
    return ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in s)


def _resolve_date(v: Value, clock_ms: float) -> float | None:
    if 'date' == v['k']:
        if 'today' == v['v']:
            return clock_ms - clock_ms % DAY_MS
        if 'yesterday' == v['v']:
            day = clock_ms - DAY_MS
            return day - day % DAY_MS
        y, m, d = (int(p) for p in v['v'].split('-'))
        return float(days_from_civil(y, m, d) * DAY_MS)
    if 'dur' == v['k']:
        return clock_ms - v['n'] * _DURATION_DAYS[v['unit']] * DAY_MS
    return None


_FIELD = {
    'tag': 'tags', 'space': 'space', 'source': 'source', 'instance': 'instance',
    'status': 'status', 'state': 'state', 'title': 'title', 'body': 'body',
    'created': 'created', 'updated': 'updated',
}


def _field_value(n: Note, field: str) -> Any:
    key = _FIELD.get(field)
    return None if key is None else n.get(key)


def _as_text(v: Value) -> str:
    if 'dur' == v['k']:
        return str(v['n']) + v['unit']
    return v['v']


def evaluate(node: Node, note: Note, clock_ms: float) -> bool:
    t = node['t']
    if 'or' == t:
        return any(evaluate(k, note, clock_ms) for k in node['kids'])
    if 'and' == t:
        return all(evaluate(k, note, clock_ms) for k in node['kids'])
    if 'not' == t:
        return not evaluate(node['kid'], note, clock_ms)
    if 'text' == t:
        q = fold_case(node['v'])
        body = note.get('body')
        return q in fold_case(note['title']) or (body is not None and q in fold_case(body))

    have = _field_value(note, node['field'])
    want = node['value']
    op = node['op']

    if op in ('>', '<', '>=', '<='):
        if not isinstance(have, str):
            return False
        have_ms = parse_time(have)
        want_ms = _resolve_date(want, clock_ms)
        if want_ms is None or math.isnan(have_ms):
            return False
        if '>' == op:
            return have_ms > want_ms
        if '>=' == op:
            return have_ms >= want_ms
        if '<' == op:
            return have_ms < want_ms
        return have_ms <= want_ms

    text = fold_case(_as_text(want))

    if isinstance(have, list):
        hit = any(fold_case(str(x)) == text for x in have)
        return not hit if '!=' == op else hit

    def eq(h: Any) -> bool:
        return h is not None and fold_case(str(h)) == text

    if '=' == op:
        return eq(have)
    if '!=' == op:
        return not eq(have)
    # ':' is contains for free-text fields and equality for the rest, which is
    # what people mean by `title:retention` and by `status:done`.
    if node['field'] in ('title', 'body'):
        return have is not None and text in fold_case(str(have))
    return eq(have)
