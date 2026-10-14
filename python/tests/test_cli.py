"""The transcript corpus, spec/cli.json: whole commands in-process."""

from __future__ import annotations

import unittest
from collections.abc import Callable
from typing import Any

from tests.harness import ROOT, check, entries

ALL = entries('cli')


class CliCorpus(unittest.TestCase):
    def test_the_transcript_corpus_is_not_empty(self) -> None:
        self.assertLess(0, len(ALL), 'spec/cli.json has no entries - did `make spec-build` run?')

    def test_every_corpus_id_is_unique(self) -> None:
        ids = [e['id'] for e in ALL]
        self.assertEqual(sorted(set(ids)), sorted(ids), 'duplicate corpus ids')

    def test_no_expectation_file_is_unreferenced(self) -> None:
        base = ROOT / 'spec' / 'expect'
        found = sorted(
            p.relative_to(ROOT).as_posix() for p in base.rglob('*')
            if p.is_file() and not any(part.startswith('.') for part in p.relative_to(base).parts))
        used = {e['out']['stdout'] for e in ALL}
        self.assertEqual([], [f for f in found if f not in used], 'expectation files no entry refers to')


def _case(e: dict[str, Any]) -> Callable[[CliCorpus], None]:
    def test(self: CliCorpus) -> None:
        failures = check(e)
        self.assertEqual([], failures, e['id'] + ':\n  ' + '\n  '.join(failures))
    return test


for _e in ALL:
    setattr(CliCorpus, 'test cli ' + _e['id'], _case(_e))
