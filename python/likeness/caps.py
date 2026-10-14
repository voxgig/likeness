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
