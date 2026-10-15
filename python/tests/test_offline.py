"""The SDK's offline test mode, with the real network blocked underneath it."""

from __future__ import annotations

import copy
import socket
import unittest
from typing import Any
from unittest import mock

from joplin_sdk import JoplinSDK

SEED = {
    'entity': {
        'note': {
            'n1': {'id': 'n1', 'title': 'seeded', 'body': 'one', 'parent_id': 'f1',
                   'updated_time': 1},
            'n2': {'id': 'n2', 'title': 'also seeded', 'body': 'two', 'parent_id': 'f1',
                   'updated_time': 2},
        },
    },
}


def data(entity: Any) -> Any:
    return entity.data_get() if callable(getattr(entity, 'data_get', None)) else entity


class Offline(unittest.TestCase):
    def setUp(self) -> None:
        self.reached = 0

        def refuse(*args: Any, **kwargs: Any) -> Any:
            self.reached += 1
            raise OSError('the offline test blocked a real connection: ' + repr(args[1:2]))

        for name in ('connect', 'connect_ex'):
            patcher = mock.patch.object(socket.socket, name, refuse)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_the_offline_cycle_seed_list_load_create_update_with_no_network(self) -> None:
        sdk = JoplinSDK.test(copy.deepcopy(SEED))

        listed = [data(e) for e in sdk.Note().list({})]
        self.assertEqual(['n1', 'n2'], sorted(n['id'] for n in listed), 'the seeded notes are listed')

        self.assertEqual('seeded', data(sdk.Note().load({'id': 'n1'}))['title'])

        # An EXPLICIT id: one the SDK mints is unassertable and shaped differently per port.
        made = data(sdk.Note().create({'id': 'n3', 'title': 'made here', 'parent_id': 'f1'}))
        self.assertEqual('n3', made['id'], 'the explicit identifier is the one that is kept')
        self.assertEqual(3, len(sdk.Note().list({})), 'the created note is visible to a subsequent list')

        self.assertEqual('renamed', data(sdk.Note().update({'id': 'n3', 'title': 'renamed'}))['title'])
        reloaded = data(sdk.Note().load({'id': 'n3'}))
        self.assertEqual('renamed', reloaded['title'], 'the update is visible to a subsequent load')

        self.assertEqual(0, self.reached, 'no real network call was attempted')

    def test_the_blocker_itself_works(self) -> None:
        with socket.socket() as s, self.assertRaisesRegex(OSError, 'blocked a real connection'):
            s.connect(('127.0.0.1', 1))
        self.assertEqual(1, self.reached)
