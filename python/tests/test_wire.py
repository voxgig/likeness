"""The adapter's real transport against mock/: what the SDK puts on the wire."""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
import unittest
import urllib.request
from typing import Any
from urllib.parse import parse_qs, urlsplit

from joplin_sdk import JoplinSDK

from likeness.adapter.joplin import FIELDS, check, list_notes, load_note, project
from likeness.core import Connection
from tests.harness import ROOT

APIKEY = 'joplin-mock-token'
EPOCH = '1970-01-01T00:00:00Z'
CONN = Connection('joplin', 'joplin', 'local')


class Wire(unittest.TestCase):
    root = ''
    mock: subprocess.Popen[str]
    drain: threading.Thread

    @classmethod
    def setUpClass(cls) -> None:
        node = shutil.which('node')
        if node is None:
            raise RuntimeError('node is required: the wire tests drive the real transport against mock/')
        cls.mock = subprocess.Popen([node, str(ROOT / 'mock' / 'server.js')],
                                    env={**os.environ, 'LIKENESS_MOCK_PORT': '0'},
                                    stdout=subprocess.PIPE, text=True)
        lines: queue.Queue[str] = queue.Queue()

        def drain() -> None:
            assert cls.mock.stdout is not None
            for line in cls.mock.stdout:
                lines.put(line)

        cls.drain = threading.Thread(target=drain, daemon=True)
        cls.drain.start()
        deadline = time.monotonic() + 30
        while True:
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                if cls.mock.poll() is None and time.monotonic() < deadline:
                    continue
                cls.tearDownClass()
                raise RuntimeError('the mock server did not report its address; '
                                   'is `make mock-deps` done?') from None
            if 'listening on' in line and 'http://' in line:
                cls.root = line[line.index('http://'):].strip()
                return

    @classmethod
    def tearDownClass(cls) -> None:
        cls.mock.terminate()
        cls.mock.wait(timeout=10)
        cls.drain.join(timeout=10)
        if cls.mock.stdout is not None:
            cls.mock.stdout.close()

    def client(self) -> JoplinSDK:
        """Straight to the mock, outside station: these tests assert the query
        the adapter sends, which station's request events do not carry."""
        return JoplinSDK({'apikey': APIKEY, 'base': self.root + '/joplin'})

    def control(self, method: str, path: str) -> Any:
        req = urllib.request.Request(self.root + path, method=method)
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode('utf-8'))

    def fields_sent(self) -> list[str | None]:
        """The `fields` each Joplin request carried, in order, from the mock's request ring."""
        rows = self.control('GET', '/__requests?source=joplin')
        return [(parse_qs(urlsplit(r['url']).query).get('fields') or [None])[-1] for r in rows]

    def test_list_asks_for_the_fields_the_shape_needs_and_gets_real_timestamps_back(self) -> None:
        self.control('DELETE', '/__requests')
        notes, _ = list_notes(self.client(), CONN, False)
        self.assertEqual([FIELDS], self.fields_sent())
        self.assertLess(0, len(notes))
        for n in notes:
            self.assertNotEqual(EPOCH, n['created'], n['id'] + ' created')
            self.assertNotEqual(EPOCH, n['updated'], n['id'] + ' updated')
            self.assertIsInstance(n.get('body'), str, n['id'] + ' body')

    def test_without_fields_the_mock_answers_joplins_three_defaults_projecting_to_the_epoch(
            self) -> None:
        rows = [e.data_get() for e in self.client().Note().list({})]
        self.assertLess(0, len(rows))
        for r in rows:
            self.assertEqual(['id', 'parent_id', 'title'], sorted(r))
            n = project(r, 'joplin', 'local', False)
            self.assertEqual(EPOCH, n['created'])
            self.assertNotIn('body', n)

    def test_load_and_check_ask_for_the_fields_too(self) -> None:
        self.control('DELETE', '/__requests')
        n = load_note(self.client(), CONN, 'a0e50000000000000000000000000001', False)
        assert n is not None
        self.assertIsInstance(n.get('body'), str)
        self.assertNotEqual(EPOCH, n['created'])
        r = check(self.client())
        self.assertTrue(r.ok, r.detail)
        self.assertEqual([FIELDS, FIELDS], self.fields_sent())
