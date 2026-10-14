"""Note identity (lid) and the one timestamp form likeness emits."""

from __future__ import annotations

import hashlib
import math
import re

from likeness.text import utf8

CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

# The canonical port's Date range: beyond it every field of a timestamp is NaN.
DATE_LIMIT_MS = 8_640_000_000_000_000
INVALID_DATE = '0NaN-NaN-NaNTNaN:NaN:NaNZ'

DAY_MS = 86_400_000

_RFC3339 = re.compile(
    r'([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?'
    r'(Z|[+-][0-9]{2}:[0-9]{2})')


def crockford32(data: bytes, chars: int) -> str:
    """Crockford base32, lowercase, big-endian bit order, no padding, the first `chars` only."""
    out: list[str] = []
    acc = 0
    bits = 0
    for b in data:
        acc = ((acc << 8) | b) & 0xFFFFFFFF
        bits += 8
        while 5 <= bits:
            bits -= 5
            out.append(CROCKFORD[(acc >> bits) & 31])
            if len(out) == chars:
                return ''.join(out)
    if 0 < bits and len(out) < chars:
        out.append(CROCKFORD[(acc << (5 - bits)) & 31])
    return ''.join(out)[:chars]


def lid(source: str, account: str, entity: str, id: str) -> str:
    """The NUL separators are what stop ("ab", "c") and ("a", "bc") colliding."""
    h = hashlib.sha256()
    h.update(utf8(source) + b'\0' + utf8(account) + b'\0' + utf8(entity) + b'\0' + utf8(id))
    return 'lk_' + crockford32(h.digest(), 12)


def civil_from_days(days: int) -> tuple[int, int, int]:
    """The proleptic Gregorian date of a day count from the epoch, year 0 included."""
    z = days + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    month = mp + 3 if mp < 10 else mp - 9
    return yoe + era * 400 + (1 if month <= 2 else 0), month, doy - (153 * mp + 2) // 5 + 1


def days_from_civil(year: int, month: int, day: int) -> int:
    y = year - (1 if month <= 2 else 0)
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (month - 3 if 2 < month else month + 9) + 2) // 5 + day - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468


def _pad(n: int, width: int = 2) -> str:
    return str(n).rjust(width, '0')


def rfc3339(ms: int | float) -> str:
    """RFC 3339, UTC, second precision, Z."""
    if isinstance(ms, float):
        if not math.isfinite(ms):
            return INVALID_DATE
        ms = math.trunc(ms)
    if DATE_LIMIT_MS < abs(ms):
        return INVALID_DATE
    days, rest = divmod(ms // 1000, 86400)
    year, month, day = civil_from_days(days)
    return (_pad(year, 4) + '-' + _pad(month) + '-' + _pad(day) + 'T' + _pad(rest // 3600) +
            ':' + _pad(rest // 60 % 60) + ':' + _pad(rest % 60) + 'Z')


def parse_time(s: str) -> float:
    """Milliseconds for an RFC 3339 timestamp, or NaN for anything else."""
    m = _RFC3339.fullmatch(s)
    if m is None:
        return math.nan
    year, month, day, hour, minute, second = (int(g) for g in m.groups()[:6])
    if not (1 <= month <= 12 and 1 <= day <= days_in(year, month) and hour <= 24 and
            minute <= 59 and second <= 59) or (24 == hour and 0 < minute + second):
        return math.nan
    ms = (days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second) * 1000
    ms += int((m.group(7) or '0').ljust(3, '0')[:3])
    zone = m.group(8)
    if 'Z' != zone:
        offset = (int(zone[1:3]) * 60 + int(zone[4:6])) * 60_000
        ms -= offset if '+' == zone[0] else -offset
    return float(ms)


def is_leap(y: int) -> bool:
    return (0 == y % 4 and 0 != y % 100) or 0 == y % 400


_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def days_in(y: int, m: int) -> int:
    if 2 == m:
        return 29 if is_leap(y) else 28
    return _MONTH_DAYS[m - 1]
