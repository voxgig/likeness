"""The requests a run made, as station observed them at the transport."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Call:
    instance: str
    method: str
    path: str

    def value(self) -> dict[str, str]:
        return asdict(self)


class Calls:
    """One per attempt. Tapped rather than read back, because the event ring drops its oldest."""

    def __init__(self, station: Any = None) -> None:
        self._list: list[Call] = []
        if station is not None:
            station.tap(self._observe)

    def _observe(self, event: dict[str, Any]) -> None:
        http = event.get('http')
        if 'http' == event.get('kind') and http is not None:
            self._list.append(Call(str(event.get('plugin')), http['method'], http['path']))

    def all(self) -> list[Call]:
        return list(self._list)

    def count(self) -> int:
        return len(self._list)
