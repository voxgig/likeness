"""The transcript corpus, spec/cli.json: whole commands in-process."""

from __future__ import annotations

import copy
import unittest
from collections.abc import Callable
from typing import Any

from tests.harness import ROOT, check, entries

ALL = entries('cli')


def _escaped_as_quote(e: dict[str, Any]) -> dict[str, Any]:
    """The entry as this SDK's escaping answers it: each of !'()* in a path percent-encoded."""
    out = copy.deepcopy(e)
    for c in out['out']['calls']:
        c['path'] = ''.join('%%%02X' % ord(ch) if ch in "!'()*" else ch for ch in c['path'])
    return out


_ESCURL = ("voxgig/sdkgen#418: the Python obsidian-sdk's escurl percent-encodes !'()* in a path, "
           "where the canonical port's encodeURIComponent keeps them")

# Entries this port cannot answer yet, each with the upstream cause it waits on.
# Each is reported as skipped and must differ from its expectation only as that
# cause predicts; one that passes outright fails until it is taken out of here.
WAITING: dict[str, tuple[str, Callable[[dict[str, Any]], dict[str, Any]]]] = {
    'obsidian/list-odd-raw': (_ESCURL, _escaped_as_quote),
    'obsidian/list-odd-values': (_ESCURL, _escaped_as_quote),
}


class CliCorpus(unittest.TestCase):
    def test_the_transcript_corpus_is_not_empty(self) -> None:
        self.assertLess(0, len(ALL), 'spec/cli.json has no entries - did `make spec-build` run?')

    def test_every_corpus_id_is_unique(self) -> None:
        ids = [e['id'] for e in ALL]
        self.assertEqual(sorted(set(ids)), sorted(ids), 'duplicate corpus ids')

    def test_no_expectation_file_is_unreferenced(self) -> None:
        # spec/written holds the files a command writes, as spec/expect holds what it prints.
        found = sorted(
            p.relative_to(ROOT).as_posix() for base in (ROOT / 'spec' / 'expect', ROOT / 'spec' / 'written')
            for p in base.rglob('*')
            if p.is_file() and not any(part.startswith('.') for part in p.relative_to(base).parts))
        used = {f for e in ALL for f in [e['out']['stdout'], *e['out'].get('files', {}).values()]}
        self.assertEqual([], [f for f in found if f not in used], 'expectation files no entry refers to')

    def test_every_entry_waiting_upstream_is_in_the_corpus(self) -> None:
        self.assertEqual([], sorted(set(WAITING) - {e['id'] for e in ALL}))


def _case(e: dict[str, Any]) -> Callable[[CliCorpus], None]:
    def test(self: CliCorpus) -> None:
        failures = check(e)
        self.assertEqual([], failures, e['id'] + ':\n  ' + '\n  '.join(failures))
    return test


def _waiting(e: dict[str, Any], why: str,
             predicted: Callable[[dict[str, Any]], dict[str, Any]]) -> Callable[[CliCorpus], None]:
    def test(self: CliCorpus) -> None:
        self.assertNotEqual([], check(e), e['id'] + ' now passes: take it out of WAITING')
        failures = check(predicted(e))
        self.assertEqual([], failures, e['id'] + ' differs other than because ' + why + ':\n  ' +
                         '\n  '.join(failures))
        self.skipTest(why)
    return test


for _e in ALL:
    _waits = WAITING.get(_e['id'])
    setattr(CliCorpus, 'test cli ' + _e['id'], _case(_e) if _waits is None else _waiting(_e, *_waits))
