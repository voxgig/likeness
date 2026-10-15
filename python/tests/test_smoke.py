from __future__ import annotations

import unittest

from likeness.core import Ctx, run


class Smoke(unittest.TestCase):
    def test_version(self) -> None:
        r = run(Ctx(argv=['version', '--json'], clock='2026-01-01T00:00:00Z'))
        self.assertEqual(0, r.exit)
        self.assertTrue(r.stdout.endswith('\n'))
