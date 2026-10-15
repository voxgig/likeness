"""The projected note and its one ordering."""

from __future__ import annotations

from functools import cmp_to_key
from typing import Any, TypedDict

from likeness.envelope import compare_code_points


class _Required(TypedDict):
    lid: str
    source: str
    instance: str
    id: str
    title: str
    url: str
    created: str
    updated: str


class Note(_Required, total=False):
    """An absent key is NOT FETCHED: `tags` absent and `tags: []` are different answers."""
    body: str
    space: str
    tags: list[str]
    status: str
    state: str
    version: str
    raw: str


_ABSENT = object()


def _rank(v: Any) -> int:
    if v is _ABSENT:
        return 4
    if v is None:
        return 3
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        return 1
    if isinstance(v, str):
        return 2
    return 5


def _compare_field(a: Any, b: Any) -> int:
    ra, rb = _rank(a), _rank(b)
    if ra != rb:
        return -1 if ra < rb else 1
    if isinstance(a, bool) and isinstance(b, bool):
        return 0 if a == b else (1 if a else -1)
    if isinstance(a, str) and isinstance(b, str):
        return compare_code_points(a, b)
    if 1 == ra:
        return 0 if a == b else (-1 if a < b else 1)
    return 0


def sort_notes(notes: list[Note], key: str | None = None) -> list[Note]:
    """By `key` when given, then updated descending, then lid ascending."""
    def order(a: Note, b: Note) -> int:
        if key:
            c = _compare_field(a.get(key, _ABSENT), b.get(key, _ABSENT))
            if 0 != c:
                return c
        u = compare_code_points(a['updated'], b['updated'])
        if 0 != u:
            return -u
        return compare_code_points(a['lid'], b['lid'])
    return sorted(notes, key=cmp_to_key(order))
