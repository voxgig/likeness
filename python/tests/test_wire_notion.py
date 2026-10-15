"""The Notion adapter's real transport against mock/: the pinned version and the vault's token."""

from __future__ import annotations

import json
import unittest
from typing import Any

from notion_sdk import NotionSDK

from likeness.adapter import Check, notion
from likeness.errors import LikenessError
from tests.live import Live, Mock, live

# The integration token, as the mock reads it from its seed.
TOKEN = 'secret_TOKEN'
ACCOUNT = 'wireworkspace01'
VERSION = '2022-06-28'
PAGE = '2a9e0000-0000-4000-8000-000000000002'


class WireNotion(unittest.TestCase):
    server: Mock

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = Mock(['notion'])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.close()

    def block(self, version: str = VERSION) -> dict[str, Any]:
        return {'base': self.server.base + '/notion/v1', 'options': {'headers': {'notion-version': version}}}

    def bound(self, token: str = TOKEN) -> tuple[Live, Any, Any]:
        """A client bound through station, its token resolved from the vault."""
        lv = live({'notion': self.block()}, {'notion.apikey': token}, {'notion': ACCOUNT})
        conn = lv.conns[0]
        return lv, conn, notion.connect(lv.station, conn, notion.configure(conn.instance, self.block()))

    def test_a_page_is_read_with_the_pinned_notion_version_and_the_vaults_token(self) -> None:
        self.server.clear()
        lv, conn, h = self.bound()
        note = notion.load_note(h, conn, PAGE, False)
        assert note is not None
        self.assertEqual(
            [PAGE, 'Ship the SDK', '7b3d0000-0000-4000-8000-000000000001',
             'https://www.notion.so/Ship-the-SDK-2a9e0000000040008000000000000002'],
            [note['id'], note['title'], note.get('space'), note['url']])
        seen = self.server.rows('notion')
        self.assertEqual([['GET', '/notion/v1/pages/' + PAGE, 200, 'ok', VERSION]],
                         [[r['method'], r['url'], r['status'], r['auth'], r['headers'].get('notion-version')]
                          for r in seen])
        self.assertEqual([r['method'] + ' ' + r['url'] for r in seen],
                         [c.method + ' ' + c.path for c in lv.calls.all()])
        self.assertNotIn(TOKEN, json.dumps(lv.station.events(), default=str), 'the token reached an event')

    def test_doctors_check_reaches_a_page_no_workspace_holds_which_only_an_accepted_request_finds_missing(
            self) -> None:
        self.server.clear()
        _, _, h = self.bound()
        self.assertEqual(Check(True, 'ok'), notion.check(h))
        self.assertEqual([['/notion/v1/pages/' + notion.NO_PAGE, 404, 'ok', VERSION]],
                         [[r['url'], r['status'], r['auth'], r['headers'].get('notion-version')]
                          for r in self.server.rows('notion')])

    def test_a_client_that_sends_no_notion_version_is_refused_as_notion_refuses_it(self) -> None:
        self.server.clear()
        lv = live({'notion': self.block()}, {'notion.apikey': TOKEN}, {'notion': ACCOUNT})
        bare = lv.station.connect(NotionSDK, {'feature': {'station': {'instance': 'notion'}}})
        with self.assertRaises(Exception) as raised:
            bare.Page().load({'id': PAGE})
        self.assertEqual(400, getattr(raised.exception, 'status', None))
        [row] = self.server.rows('notion')
        self.assertEqual([400, 'ok', None], [row['status'], row['auth'], row['headers'].get('notion-version')])

    def test_a_wrong_token_is_auth_failed(self) -> None:
        self.assertEqual('auth-failed', notion.check(self.bound('not-the-token')[2]).code)

    def test_a_connection_that_pins_no_version_is_refused_before_a_client_exists(self) -> None:
        with self.assertRaises(LikenessError) as raised:
            notion.configure('notion', {'base': self.server.base + '/notion/v1'})
        self.assertEqual('invalid-project', raised.exception.code)
        self.assertRegex(raised.exception.message, 'pins no Notion-Version')
