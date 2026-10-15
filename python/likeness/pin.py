"""A transport that trusts one certificate, the one its SHA-256 fingerprint names."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import ssl
    from urllib.parse import SplitResult

_PIN = re.compile(r'sha256:(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31})')

Fetcher = Callable[[Any, str, dict[str, Any]], tuple[dict[str, Any] | None, Any]]


class PinError(ValueError):
    pass


def parse_pin(text: Any) -> str:
    """`sha256:` and the hex digest, bare or as colon-joined pairs, either case."""
    if not isinstance(text, str) or _PIN.fullmatch(text) is None:
        raise PinError('not a sha256 certificate fingerprint')
    return 'sha256:' + text[len('sha256:'):].replace(':', '').lower()


def fingerprint_of(der: bytes) -> str:
    return 'sha256:' + hashlib.sha256(der).hexdigest()


class CertificateError(Exception):
    """`refusal` is changed, expired, not-yet-valid, wrong-host or invalid."""

    def __init__(self, refusal: str) -> None:
        super().__init__('the certificate was refused: ' + refusal)
        self.refusal = refusal


# OpenSSL's verification codes. A chain failure Node names with SELF_SIGNED,
# ISSUER, LEAF_SIGNATURE or UNTRUSTED means the anchor is not what was presented.
_NOT_YET_VALID = 9
_EXPIRED = 10
_WRONG_HOST = (62, 64)
_CHAIN = (2, 6, 18, 19, 20, 21, 27)


def _refusal_of(code: int) -> str:
    if _EXPIRED == code:
        return 'expired'
    if _NOT_YET_VALID == code:
        return 'not-yet-valid'
    if code in _WRONG_HOST:
        return 'wrong-host'
    return 'changed' if code in _CHAIN else 'invalid'


def _presented(host: str, port: int, timeout: Any) -> bytes:
    """The certificate a server presents, read from a handshake that trusts
    nothing and on which nothing is written."""
    # Imported with the first pinned connection, like the SDKs: `version` and
    # `help` need none of the TLS stack.
    import socket
    import ssl

    probe = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    probe.check_hostname = False
    probe.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, port), timeout) as raw, \
            probe.wrap_socket(raw, server_hostname=host) as tls:
        der = tls.getpeercert(binary_form=True)
    if der is None:
        raise CertificateError('invalid')
    return der


def presented_fingerprint(base: str) -> str:
    """The fingerprint of the certificate an https base presents, by the same
    probe, so pinning it writes nothing to the server either."""
    import socket
    from urllib.parse import urlsplit

    url = urlsplit(base)
    if 'https' != url.scheme:
        raise CertificateError('invalid')
    return fingerprint_of(_presented(url.hostname or '', url.port or 443, socket.getdefaulttimeout()))


def _verified(host: str, port: int, anchor: bytes, pin: str, timeout: Any) -> ssl.SSLSocket:
    """Verified by OpenSSL against the pinned certificate as the only trust
    anchor, with its own host check, and then against the pin itself."""
    import socket
    import ssl

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(cadata=anchor)
    raw = socket.create_connection((host, port), timeout)
    try:
        tls = ctx.wrap_socket(raw, server_hostname=host)
    except ssl.SSLCertVerificationError as err:
        raise CertificateError(_refusal_of(err.verify_code)) from None
    finally:
        raw.close()
    if pin != fingerprint_of(tls.getpeercert(binary_form=True) or b''):
        tls.close()
        raise CertificateError('changed')
    return tls


def _exchange(tls: ssl.SSLSocket, url: SplitResult, fetchdef: dict[str, Any]) -> dict[str, Any]:
    import http.client

    # Host names the port only where it is not https's own, as the canonical port sends it.
    conn = http.client.HTTPConnection(url.hostname or '', url.port if url.port not in (None, 443) else None)
    conn.sock = tls
    # Never reopened: a new connection would be to a server nobody checked.
    conn.auto_open = 0
    try:
        body = fetchdef.get('body')
        target = (url.path or '/') + ('?' + url.query if url.query else '')
        conn.request(str(fetchdef.get('method') or 'GET'), target,
                     body.encode('utf-8') if isinstance(body, str) else body,
                     dict(fetchdef.get('headers') or {}))
        res = conn.getresponse()
        text = res.read().decode('utf-8')
        status, reason, pairs = res.status, res.reason, res.getheaders()
    finally:
        # One connection per request: one left open would hold the process
        # until the plugin timed it out.
        conn.close()

    headers: dict[str, str] = {}
    for name, value in pairs:
        key = name.lower()
        headers[key] = headers[key] + ', ' + value if key in headers else value
    parsed = None
    unreadable = False
    if text.strip():
        try:
            parsed = json.loads(text)
        except ValueError:
            unreadable = True
    return {
        'status': status,
        'statusText': reason or ('OK' if status < 400 else 'Error'),
        'headers': headers,
        'json': lambda: parsed,
        'body': text,
        'unreadable': unreadable,
    }


def pinned_fetcher(pin: str) -> Fetcher:
    """A transport for the SDK's `utility.fetcher` seam that trusts exactly the
    certificate whose fingerprint is `pin`. No request byte is written before
    the presented certificate has matched it. A refused certificate is raised,
    which the SDK passes through as itself; any other failure is answered as
    the SDK's own transport answers it."""
    import socket
    from urllib.parse import urlsplit

    anchor: list[bytes] = []

    def fetch(_ctx: Any, fullurl: str, fetchdef: dict[str, Any]) -> tuple[dict[str, Any] | None, Any]:
        url = urlsplit(fullurl)
        if 'https' != url.scheme:
            raise CertificateError('invalid')
        timeout = fetchdef.get('timeout') or socket.getdefaulttimeout()
        try:
            host, port = url.hostname or '', url.port or 443
            if not anchor:
                der = _presented(host, port, timeout)
                if pin != fingerprint_of(der):
                    raise CertificateError('changed')
                anchor.append(der)
            try:
                tls = _verified(host, port, anchor[0], pin, timeout)
            except CertificateError:
                anchor.clear()
                raise
            return _exchange(tls, url, fetchdef), None
        except CertificateError:
            raise
        except Exception as err:
            return None, str(err)

    return fetch
