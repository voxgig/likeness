"""The envelope's bytes: sorted keys by code point, exact escaping, no floats, one LF."""

from __future__ import annotations

import math
from typing import Any

# Every value is held to what the canonical port can hold: a JSON number there
# is a double, so an integer is exact only up to 2^53 - 1.
SAFE_INTEGER_MAX = 2**53 - 1

PARITY_EXCEPTIONS = ['port', 'meta.elapsed_ms', 'data.port']


class SerialiseError(Exception):
    def __init__(self, message: str, path: str) -> None:
        super().__init__(message + ' at ' + ('$' if '' == path else path))
        self.path = path


def escape_string(s: str) -> str:
    out = ['"']
    for ch in s:
        if '"' == ch:
            out.append('\\"')
        elif '\\' == ch:
            out.append('\\\\')
        elif ord(ch) < 0x20:
            out.append('\\u%04x' % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def compare_code_points(a: str, b: str) -> int:
    """-1, 0 or 1: str ordering is code point ordering, shorter prefix first."""
    if a == b:
        return 0
    return -1 if a < b else 1


def js_number(f: float) -> str:
    """ECMAScript Number::toString, from the shortest round-trip digits."""
    if f != f:
        return 'NaN'
    if 0 == f:
        return '0'
    if f < 0:
        return '-' + js_number(-f)
    if math.isinf(f):
        return 'Infinity'
    mantissa, _, exponent = repr(f).partition('e')
    whole, _, fraction = mantissa.partition('.')
    digits = whole + fraction
    point = len(whole) + (int(exponent) if exponent else 0)
    stripped = digits.lstrip('0')
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip('0')
    k, n = len(digits), point
    if k <= n <= 21:
        return digits + '0' * (n - k)
    if 0 < n <= 21:
        return digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return '0.' + '0' * -n + digits
    e = n - 1
    sign = '+' if 0 <= e else '-'
    head = digits if 1 == k else digits[0] + '.' + digits[1:]
    return head + 'e' + sign + str(abs(e))


def _double(v: int | float) -> float:
    if isinstance(v, float):
        return v
    try:
        return float(v)
    except OverflowError:
        return math.inf if 0 < v else -math.inf


def _render_number(v: int | float, path: str, loose: bool) -> str:
    d = _double(v)
    if not math.isfinite(d):
        raise SerialiseError('non-finite number', path)
    if loose:
        return js_number(d)
    if not d.is_integer():
        raise SerialiseError('floating point is not representable in the envelope', path)
    if SAFE_INTEGER_MAX < abs(d):
        raise SerialiseError('integer beyond exact double precision - use a bigint', path)
    return str(int(d))


def render(v: Any, path: str = '', loose: bool = False) -> str:
    """The one writer, human output included: a host JSON writer escapes and
    orders differently in every port, which would put the parity gap on stdout."""
    if v is None:
        return 'null'
    # bool is an int in Python, and must not render as one.
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return _render_number(v, path, loose)
    if isinstance(v, str):
        return escape_string(v)
    if isinstance(v, (list, tuple)):
        if 0 == len(v):
            return '[]'
        return '[' + ','.join(
            render(e, path + '[' + str(i) + ']', loose) for i, e in enumerate(v)) + ']'
    if isinstance(v, dict):
        if not all(isinstance(k, str) for k in v):
            raise SerialiseError('object key of unsupported type', path)
        if 0 == len(v):
            return '{}'
        return '{' + ','.join(
            escape_string(k) + ':' + render(v[k], path + '.' + k, loose) for k in sorted(v)) + '}'
    raise SerialiseError('value of unsupported type ' + type(v).__name__, path)


def render_raw(v: Any) -> str:
    """A source payload: floating point permitted, numbers as ECMAScript prints them."""
    return render(v, '', True)


def serialise(v: Any) -> str:
    return render(v, '') + '\n'


def strip_parity_exceptions(v: Any) -> Any:
    """By PATH, never by name: a `port` inside a `which` row is compared like any value."""
    if not isinstance(v, dict):
        return v
    out: dict[str, Any] = {}
    for k, e in v.items():
        if 'port' == k:
            continue
        if k in ('meta', 'data') and isinstance(e, dict):
            drop = 'elapsed_ms' if 'meta' == k else 'port'
            out[k] = {ik: ie for ik, ie in e.items() if drop != ik}
            continue
        out[k] = e
    return out
