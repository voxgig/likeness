"""UTF-8 as the canonical port encodes it."""

from __future__ import annotations

import re

_SURROGATE = re.compile('[\ud800-\udfff]')


def utf8(s: str) -> bytes:
    """A lone surrogate encodes as U+FFFD, as a JavaScript TextEncoder writes it."""
    try:
        return s.encode('utf-8')
    except UnicodeEncodeError:
        return _SURROGATE.sub('�', s).encode('utf-8')


def byte_len(s: str) -> int:
    return len(utf8(s))
