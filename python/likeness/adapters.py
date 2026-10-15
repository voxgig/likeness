"""The adapters the core can reach a source through, by each one's own SOURCE."""

from __future__ import annotations

from types import ModuleType

from likeness.adapter import joplin

ADAPTERS: dict[str, ModuleType] = {a.SOURCE: a for a in (joplin,)}
