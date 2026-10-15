"""One adapter per source, each reaching it through its generated SDK.

Every adapter module offers the core the same names: SOURCE, SUPPLIES,
connect(station, conn, config, seed) and check(handle), and where the source
can answer them, configure(instance, block), list_notes(handle, conn, with_raw)
and load_note(handle, conn, id, with_raw). The handle connect returns is the
adapter's own; the core passes it back and never looks inside it. Each imports
its SDK in connect: `version` and `help` need none, and loading one is most of
a cold start.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Check:
    ok: bool
    detail: str
    code: str | None = None
    remedy: str | None = None
