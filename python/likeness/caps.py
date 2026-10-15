"""The capability matrix."""

from __future__ import annotations

from typing import Any

from likeness import spec


def caps() -> dict[str, Any]:
    return spec.load('caps')['capability']


def page_max(source: str) -> int:
    """The largest page a source returns. Zero is "not declared", which a caller
    treats as "cannot tell", never as "no limit"."""
    row = caps().get(source)
    if row is None:
        return 0
    return int((row.get('limit') or {}).get('page_max') or 0)


_ABSENT = object()


def _entity(source: str, entity: str) -> dict[str, Any]:
    return ((caps().get(source) or {}).get('entity') or {}).get(entity) or {}


def supports(source: str, entity: str, op: str) -> bool:
    """A capability is `false` or absent when refused, and anything else when offered."""
    v = (_entity(source, entity).get('op') or {}).get(op, _ABSENT)
    return v is not _ABSENT and v is not False


def term_of(source: str, entity: str) -> str:
    """The source's own word for one of likeness's entities, or the entity's name."""
    term = _entity(source, entity).get('term')
    return entity if term is None else term
