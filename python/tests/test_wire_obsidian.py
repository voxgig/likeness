"""The Obsidian adapter's real transport, against mock/ over TLS with a certificate made here."""

from __future__ import annotations

import ast
import json
import socket
import ssl
import threading
import time
import unittest
from typing import Any

from obsidian_sdk import ObsidianSDK

from likeness.adapter import Check, obsidian
from likeness.errors import LikenessError
from likeness.pin import CertificateError, fingerprint_of, pinned_fetcher
from tests.cert import Throwaway, self_signed
from tests.harness import ROOT
from tests.live import Live, Mock, live, scratch
from tests.test_dependencies import imported

# The plugin's credential, as the mock reads it from its seed.
TOKEN = 'obsidian-local-rest-api-key-0001'
ACCOUNT = 'wirevault000001'

# The notes the mock's vault holds.
NOTES = ['mydocument.md', 'projects/nested/deep-note.md', 'somedirectory/meeting-notes.md',
         'somedirectory/roadmap.md', 'welcome.md']

CERT = self_signed()
OTHER = self_signed()


class Bound:
    """A client bound through station, its token resolved from the vault."""

    def __init__(self, block: dict[str, Any], token: str = TOKEN) -> None:
        self.live: Live = live({'obsidian': block}, {'obsidian.apikey': token}, {'obsidian': ACCOUNT})
        self.conn = self.live.conns[0]
        self.h = obsidian.connect(self.live.station, self.conn, obsidian.configure(self.conn.instance, block))


class WireObsidian(unittest.TestCase):
    secure: Mock
    plain: Mock

    @classmethod
    def setUpClass(cls) -> None:
        cls.secure = Mock(['obsidian'], https=CERT)
        try:
            cls.plain = Mock(['obsidian'])
        except BaseException:
            cls.secure.close()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        cls.secure.close()
        cls.plain.close()

    def pinned(self, to: Throwaway) -> dict[str, Any]:
        return {'base': self.secure.base + '/obsidian',
                'options': {'tls': {'fingerprint': fingerprint_of(to.der)}}}

    def test_a_pinned_connection_reads_each_note_as_note_json_with_the_vaults_token(self) -> None:
        self.secure.clear()
        b = Bound(self.pinned(CERT))
        notes = [obsidian.load_note(b.h, b.conn, path, False) for path in NOTES]
        self.assertEqual(NOTES, [n['id'] if n is not None else None for n in notes])
        seen = self.secure.rows('obsidian')
        self.assertEqual(len(NOTES), len(seen))
        for r in seen:
            self.assertEqual(obsidian.NOTE_JSON, r['headers']['accept'], r['url'])
            self.assertEqual('ok', r['auth'], r['url'])
        # What station observed is what the mock received, in order.
        self.assertEqual([r['method'] + ' ' + r['url'] for r in seen],
                         [c.method + ' ' + c.path for c in b.live.calls.all()])
        self.assertNotIn(TOKEN, json.dumps(b.live.station.events(), default=str), 'the token reached an event')

    def test_the_walk_refuses_a_root_listing_the_sdk_hands_over_without_its_names(self) -> None:
        # The plugin lists a directory as names, and this SDK keeps a listed
        # item only when it is a record. When it keeps names, this fails, and
        # the walk is asserted here as the canonical port's suite asserts it.
        self.secure.clear()
        b = Bound(self.pinned(CERT))
        self.assertEqual([{}, {}, {}, {}], [e.data_get() for e in b.h.sdk.Vault().list()])
        with self.assertRaises(LikenessError) as raised:
            obsidian.list_notes(b.h, b.conn, False)
        self.assertEqual(
            ('source-unavailable', 'obsidian returned a vault listing with an entry that names no path below it'),
            (raised.exception.code, raised.exception.message))
        self.assertEqual(['GET /obsidian/vault/'] * 2,
                         [r['method'] + ' ' + r['url'] for r in self.secure.rows('obsidian')])

    def test_a_note_read_without_the_note_json_accept_is_markdown_which_the_client_cannot_read(self) -> None:
        self.secure.clear()
        lv = live({'obsidian': self.pinned(CERT)}, {'obsidian.apikey': TOKEN}, {'obsidian': ACCOUNT})
        bare = lv.station.connect(ObsidianSDK, {
            'utility': {'fetcher': pinned_fetcher(fingerprint_of(CERT.der))},
            'feature': {'station': {'instance': 'obsidian'}},
        })
        with self.assertRaises(Exception):
            bare.Vault().load({'id': 'welcome.md'})
        [row] = self.secure.rows('obsidian')
        self.assertEqual([200, 'ok', 'application/json'], [row['status'], row['auth'], row['headers']['accept']])

        b = Bound(self.pinned(CERT))
        note = obsidian.load_note(b.h, b.conn, 'welcome.md', False)
        self.assertEqual('welcome', None if note is None else note['title'])

    def test_a_changed_certificate_is_refused_before_any_request_reaches_the_plugin(self) -> None:
        self.secure.clear()
        b = Bound(self.pinned(OTHER))
        with self.assertRaises(LikenessError) as listed:
            obsidian.list_notes(b.h, b.conn, False)
        self.assertEqual('certificate-rejected', listed.exception.code)
        with self.assertRaises(LikenessError) as loaded:
            obsidian.load_note(b.h, b.conn, 'welcome.md', False)
        self.assertEqual('certificate-rejected', loaded.exception.code)
        self.assertEqual('certificate-rejected', obsidian.check(b.h).code)
        self.assertEqual([], self.secure.rows('obsidian'))

    def test_plain_http_is_used_where_the_connection_declares_it_and_doctor_says_so(self) -> None:
        self.plain.clear()
        b = Bound({'base': self.plain.base + '/obsidian', 'options': {'tls': False}})
        self.assertEqual(Check(True, 'ok, over plain HTTP as the connection declares'), obsidian.check(b.h))
        self.assertEqual(['ok'], [r['auth'] for r in self.plain.rows('obsidian')])

    def test_a_wrong_token_is_auth_failed_and_an_absent_plugin_is_source_unavailable_with_its_remedy(
            self) -> None:
        self.assertEqual('auth-failed', obsidian.check(Bound(self.pinned(CERT), 'not-the-token').h).code)

        gone = {'base': 'https://127.0.0.1:1/obsidian',
                'options': {'tls': {'fingerprint': fingerprint_of(CERT.der)}}}
        r = obsidian.check(Bound(gone).h)
        self.assertEqual('source-unavailable', r.code)
        self.assertRegex(str(r.remedy), 'start Obsidian with the Local REST API')

    def test_no_request_byte_is_written_before_the_certificate_has_matched_the_pin(self) -> None:
        # The probe that learns the certificate writes nothing; the request
        # goes on the connection that verified it.
        right = _served(CERT, None, fingerprint_of(CERT.der))
        self.assertEqual(200, right['status'])
        self.assertEqual(2, len(right['bytes']))
        self.assertEqual(0, right['bytes'][0])
        self.assertLess(0, right['bytes'][1])

        self.assertEqual({'bytes': [0], 'refusal': 'changed'}, _served(CERT, None, fingerprint_of(OTHER.der)))

        # A certificate swapped after the probe is caught by the verified connection.
        self.assertEqual({'bytes': [0, 0], 'refusal': 'changed'}, _served(CERT, OTHER, fingerprint_of(CERT.der)))

        old = self_signed((-3, -1))
        self.assertEqual({'bytes': [0, 0], 'refusal': 'expired'}, _served(old, None, fingerprint_of(old.der)))

    def test_a_pinned_request_closes_its_connection_once_the_response_is_read(self) -> None:
        server = KeepAlive(CERT)
        try:
            r, err = pinned_fetcher(fingerprint_of(CERT.der))(
                {}, server.url, {'method': 'GET', 'headers': {'connection': 'keep-alive'}})
            self.assertIsNone(err)
            assert r is not None
            self.assertEqual('{}', r['body'])
            self.assertTrue(server.all_closed(5), 'a connection was left open')
        finally:
            server.close()

    def test_the_adapter_reaches_a_vault_through_the_plugin_alone_never_its_files(self) -> None:
        for file in ('python/likeness/adapter/obsidian.py', 'python/likeness/pin.py'):
            source = (ROOT / file).read_text(encoding='utf-8')
            self.assertEqual(set(), imported(source) & {'glob', 'io', 'os', 'pathlib', 'shutil', 'tempfile'},
                             file)
            opens = [n for n in ast.walk(ast.parse(source))
                     if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and 'open' == n.func.id]
            self.assertEqual([], opens, file)


def _server_context(cert: Throwaway) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(*cert.files(scratch()))
    return ctx


class _Server:
    """A TLS server on 127.0.0.1, each connection answered in a thread of its
    own with the context `context_for` gives its index."""

    def __init__(self) -> None:
        self._listener = socket.create_server(('127.0.0.1', 0))
        self.url = 'https://127.0.0.1:%d/vault/' % self._listener.getsockname()[1]
        self._accepted = 0
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                raw, _ = self._listener.accept()
            except OSError:
                return
            raw.settimeout(30)
            at = self._accepted
            self._accepted += 1
            self.opened(at)
            threading.Thread(target=self._one, args=(raw, at), daemon=True).start()

    def _one(self, raw: socket.socket, at: int) -> None:
        try:
            with self.context_for(at).wrap_socket(raw, server_side=True) as tls:
                self.serve(tls, at)
        except OSError:
            pass
        finally:
            raw.close()
            self.ended(at)

    def opened(self, at: int) -> None:
        pass

    def ended(self, at: int) -> None:
        pass

    def context_for(self, at: int) -> ssl.SSLContext:
        raise NotImplementedError

    def serve(self, tls: ssl.SSLSocket, at: int) -> None:
        raise NotImplementedError

    def close(self) -> None:
        # Shut down as well as closed, so the accept blocked on it returns.
        try:
            self._listener.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._listener.close()


class Counting(_Server):
    """Counts the application bytes each connection receives, presenting
    `then` from its second connection on."""

    def __init__(self, first: Throwaway, then: Throwaway | None) -> None:
        self.bytes: list[int] = []
        self._contexts = [_server_context(first)] + ([] if then is None else [_server_context(then)])
        super().__init__()

    def opened(self, at: int) -> None:
        self.bytes.append(0)

    def context_for(self, at: int) -> ssl.SSLContext:
        return self._contexts[min(at, len(self._contexts) - 1)]

    def serve(self, tls: ssl.SSLSocket, at: int) -> None:
        while data := tls.recv(65536):
            first = 0 == self.bytes[at]
            self.bytes[at] += len(data)
            if first:
                tls.sendall(b'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n'
                            b'content-length: 2\r\nconnection: close\r\n\r\n{}')


class KeepAlive(_Server):
    """Holds each connection open for its next request, as the plugin's server
    does, and notes when the client closes it."""

    def __init__(self, cert: Throwaway) -> None:
        self._context = _server_context(cert)
        self._closed: list[threading.Event] = []
        super().__init__()

    def opened(self, at: int) -> None:
        self._closed.append(threading.Event())

    def ended(self, at: int) -> None:
        self._closed[at].set()

    def context_for(self, at: int) -> ssl.SSLContext:
        return self._context

    def serve(self, tls: ssl.SSLSocket, at: int) -> None:
        pending = b''
        while data := tls.recv(65536):
            pending += data
            while b'\r\n\r\n' in pending:
                _, pending = pending.split(b'\r\n\r\n', 1)
                tls.sendall(b'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}')

    def all_closed(self, seconds: float) -> bool:
        """Bounded, so a connection left open fails the test rather than hanging it."""
        deadline = time.monotonic() + seconds
        return 0 < len(self._closed) and all(e.wait(max(0.0, deadline - time.monotonic())) for e in self._closed)


GET = {'method': 'GET', 'headers': {'authorization': 'Bearer ' + TOKEN}}


def _served(first: Throwaway, then: Throwaway | None, pin: str) -> dict[str, Any]:
    server = Counting(first, then)
    try:
        r, err = pinned_fetcher(pin)({}, server.url, GET)
        if err is not None or r is None:
            raise AssertionError('the pinned request failed: ' + str(err))
        return {'bytes': list(server.bytes), 'status': r['status']}
    except CertificateError as refused:
        return {'bytes': list(server.bytes), 'refusal': refused.refusal}
    finally:
        server.close()
