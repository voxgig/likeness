"""The transcript corpus, spec/cli.json: whole commands in-process."""

from __future__ import annotations

import copy
import unittest
from collections.abc import Callable
from typing import Any

from tests.harness import CLI_OMNI, ROOT, cli_runner, corpus, entries, resolved

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
# omni holds each while it fails and fails the set once it passes; each must
# also pass once its cause's prediction is applied.
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


SPEC = corpus('cli')


def _group(name: str, entries: list[dict[str, Any]]) -> dict[str, Any]:
    return {'OMNI': CLI_OMNI, 'cli': {name: {'set': [resolved(e) for e in entries]}}}


def _group_case(name: str) -> Callable[[CliCorpus], None]:
    def test(self: CliCorpus) -> None:
        spec = _group(name, SPEC[name]['set'])
        ids = {e['id'] for e in SPEC[name]['set']}
        waits = {i: {'cause': w[0]} for i, w in WAITING.items() if i in ids}
        cli_runner(spec)['runsetflags'](spec['cli'][name], {'null': False, 'all': True, 'wait': waits})
    return test


def _predicted(self: CliCorpus) -> None:
    # A wait holds an entry only while it fails; this holds it to failing for
    # its declared cause alone, so the declaration cannot hide a second
    # difference.
    predicted = [w[1](e) for e in ALL for w in [WAITING.get(e['id'])] if w is not None]
    spec = _group('predicted', predicted)
    cli_runner(spec)['runsetflags'](spec['cli']['predicted'], {'null': False, 'all': True})


for _g in sorted(SPEC):
    setattr(CliCorpus, 'test cli ' + _g, _group_case(_g))
if WAITING:
    setattr(CliCorpus, 'test cli waiting entries differ only as their cause predicts', _predicted)
