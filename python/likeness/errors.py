"""The error and exit code registry, and the refusal that carries a code."""

from __future__ import annotations

from typing import Any

from likeness import spec


def errors() -> dict[str, dict[str, Any]]:
    return spec.load('errors')['error']


def exit_for(code: str) -> int:
    definition = errors().get(code)
    if definition is None:
        raise LookupError('no such error code: ' + code)
    return definition['exit']


def partial_codes() -> list[str]:
    """The closed set of codes permitted to carry data on failure."""
    return sorted(e['code'] for e in errors().values() if e['partial'])


class LikenessError(Exception):
    def __init__(self, code: str, message: str, remedy: str,
                 detail: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.remedy = remedy
        self.detail = detail or {}

    def __str__(self) -> str:
        return self.message
