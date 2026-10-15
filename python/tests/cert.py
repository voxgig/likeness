"""A throwaway certificate, made at test time.

DER by hand and ECDSA P-256 by hand: the standard library signs nothing and
writes no certificate, and a test may not depend on an openssl being installed.
"""

from __future__ import annotations

import base64
import hashlib
import itertools
import os
import secrets
import ssl
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

# P-256, from SEC 2.
_P = 2**256 - 2**224 + 2**192 + 2**96 - 1
_A = _P - 3
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
      0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)

Point = tuple[int, int] | None


def _add(p: Point, q: Point) -> Point:
    if p is None:
        return q
    if q is None:
        return p
    (x1, y1), (x2, y2) = p, q
    if x1 == x2 and 0 == (y1 + y2) % _P:
        return None
    if p == q:
        slope = (3 * x1 * x1 + _A) * pow(2 * y1, -1, _P) % _P
    else:
        slope = (y2 - y1) * pow(x2 - x1, -1, _P) % _P
    x3 = (slope * slope - x1 - x2) % _P
    return x3, (slope * (x1 - x3) - y1) % _P


def _mul(k: int, p: Point) -> Point:
    out: Point = None
    while k:
        if k & 1:
            out = _add(out, p)
        p = _add(p, p)
        k >>= 1
    return out


def _len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    out = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(out)]) + out


def _tlv(tag: int, *parts: bytes) -> bytes:
    body = b''.join(parts)
    return bytes([tag]) + _len(len(body)) + body


def _seq(*parts: bytes) -> bytes:
    return _tlv(0x30, *parts)


def _int(n: int) -> bytes:
    return _tlv(0x02, n.to_bytes((n.bit_length() + 8) // 8, 'big'))


def _oid(dotted: str) -> bytes:
    a, b, *rest = (int(x) for x in dotted.split('.'))
    out = [40 * a + b]
    for n in rest:
        enc = [n & 0x7F]
        n >>= 7
        while n:
            enc.insert(0, 0x80 | (n & 0x7F))
            n >>= 7
        out.extend(enc)
    return _tlv(0x06, bytes(out))


def _utc(t: datetime) -> bytes:
    return _tlv(0x17, t.strftime('%y%m%d%H%M%SZ').encode('ascii'))


def _sign(d: int, message: bytes) -> bytes:
    e = int.from_bytes(hashlib.sha256(message).digest(), 'big')
    while True:
        k = secrets.randbelow(_N - 1) + 1
        point = _mul(k, _G)
        assert point is not None
        r = point[0] % _N
        s = pow(k, -1, _N) * (e + r * d) % _N
        if 0 != r and 0 != s:
            return _seq(_int(r), _int(s))


def _pem(label: str, der: bytes) -> str:
    text = base64.b64encode(der).decode('ascii')
    lines = [text[i:i + 64] for i in range(0, len(text), 64)]
    return '-----BEGIN ' + label + '-----\n' + '\n'.join(lines) + '\n-----END ' + label + '-----\n'


_TRUE = _tlv(0x01, b'\xff')
_EC = _seq(_oid('1.2.840.10045.2.1'), _oid('1.2.840.10045.3.1.7'))
_ALG = _seq(_oid('1.2.840.10045.4.3.2'))
_serial = itertools.count(1)


@dataclass(frozen=True)
class Throwaway:
    key: str
    cert: str
    der: bytes

    def files(self, dir: str) -> tuple[str, str]:
        """The certificate and key as files, which is the only way the
        standard library's TLS server will take them."""
        name = hashlib.sha256(self.der).hexdigest()[:16]
        cert, key = os.path.join(dir, name + '.crt'), os.path.join(dir, name + '.key')
        for path, text in ((cert, self.cert), (key, self.key)):
            with open(path, 'w', encoding='ascii') as f:
                f.write(text)
        return cert, key


def self_signed(days: tuple[int, int] = (-1, 2)) -> Throwaway:
    """A self-signed certificate for 127.0.0.1, as the Obsidian plugin makes
    one: its own authority, naming the address it serves. `days` places its
    validity around now: (-1, 2) is current, (-3, -1) has expired."""
    d = secrets.randbelow(_N - 1) + 1
    point = _mul(d, _G)
    assert point is not None
    public = b'\x04' + point[0].to_bytes(32, 'big') + point[1].to_bytes(32, 'big')
    name = _seq(_tlv(0x31, _seq(_oid('2.5.4.3'), _tlv(0x0C, b'127.0.0.1'))))
    now = datetime.now(timezone.utc)
    extensions = _tlv(0xA3, _seq(
        _seq(_oid('2.5.29.19'), _TRUE, _tlv(0x04, _seq(_TRUE))),
        _seq(_oid('2.5.29.17'), _tlv(0x04, _seq(_tlv(0x87, bytes([127, 0, 0, 1]))))),
    ))
    tbs = _seq(
        _tlv(0xA0, _int(2)),
        _int(1 + next(_serial) % 127),
        _ALG,
        name,
        _seq(_utc(now + timedelta(days=days[0])), _utc(now + timedelta(days=days[1]))),
        name,
        _seq(_EC, _tlv(0x03, b'\x00' + public)),
        extensions,
    )
    der = _seq(tbs, _ALG, _tlv(0x03, b'\x00' + _sign(d, tbs)))
    sec1 = _seq(_int(1), _tlv(0x04, d.to_bytes(32, 'big')), _tlv(0xA1, _tlv(0x03, b'\x00' + public)))
    pkcs8 = _seq(_int(0), _EC, _tlv(0x04, sec1))
    return Throwaway(_pem('PRIVATE KEY', pkcs8), ssl.DER_cert_to_PEM_cert(der), der)
