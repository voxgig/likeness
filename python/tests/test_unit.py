"""The pure-function corpus, spec/unit.json, by function name."""

from __future__ import annotations

import unittest
from collections.abc import Callable
from dataclasses import asdict
from typing import Any

from likeness.adapter import notion, obsidian
from likeness.adapter.joplin import project
from likeness.args import parse_argv
from likeness.cli import take_config_option
from likeness.config import parse_accounts, parse_station
from likeness.core import connections_of, open_station, profile_of
from likeness.envelope import compare_code_points, serialise
from likeness.errors import partial_codes
from likeness.evaluate import fold_case
from likeness.identity import CROCKFORD, lid, rfc3339
from likeness.pin import fingerprint_of, parse_pin
from likeness.selector import SelectorError, parse_selector
from likeness.sources import ref_for, secret_name
from likeness.vault import vault_entry
from tests.harness import entries


def _selector_error(s: str) -> dict[str, Any]:
    try:
        parse_selector(s)
    except SelectorError as err:
        return {'offset': err.offset, 'token': err.token}
    raise AssertionError('expected a SelectorError and the selector parsed cleanly')


def _config_option(argv: list[str]) -> dict[str, Any]:
    rest, value = take_config_option(argv)
    return {'rest': rest} if value is None else {'rest': rest, 'value': value}


def _argv(argv: list[str]) -> dict[str, Any]:
    p = parse_argv(argv)
    return {'command': p.command, 'flags': p.flags, 'args': p.args}


def _sign(v: list[str]) -> int:
    """The sign is the contract, not the magnitude."""
    n = compare_code_points(v[0], v[1])
    return 0 if 0 == n else (1 if 0 < n else -1)


def _connections(v: dict[str, str]) -> list[dict[str, str]]:
    env = None if v.get('profile') is None else {'VOXGIG_STATION_PROFILE': v['profile']}
    station = open_station(parse_station(v['station'], 'station.json'), env)
    accounts = parse_accounts(v['likeness'], 'likeness.json', profile_of(env))
    return [asdict(c) for c in connections_of(station, accounts, profile_of(env))]


def _vault_walk(v: dict[str, Any]) -> list[dict[str, str]]:
    listings = v['listings']
    out = []
    steps = obsidian.walk_steps()
    try:
        at = next(steps)
        while True:
            out.append(at)
            at = steps.send(obsidian.entries(listings.get(at['list'], [])) if 'list' in at else None)
    except StopIteration:
        return out


def _notion_space(parent: Any) -> dict[str, str]:
    """Absent is `{}`: the corpus has no way to say "no value" but an empty record."""
    space = notion.space_of(parent)
    return {} if space is None else {'space': space}


def _vault_entry(v: dict[str, Any]) -> dict[str, str]:
    profile = v.get('profile')
    return asdict(vault_entry(v['station'], 'default' if profile is None else profile, '/home/u',
                              '/home/u/.config/likeness', v.get('key')))


REGISTRY: dict[str, Callable[[Any], Any]] = {
    'serialise': serialise,
    'parseSelector': parse_selector,
    'parseSelectorError': _selector_error,
    'compareCodePoints': _sign,
    'lid': lambda v: lid(*v),
    'rfc3339': rfc3339,
    'crockfordAlphabet': lambda _: CROCKFORD,
    'foldCase': fold_case,
    'takeConfigOption': _config_option,
    'parseArgv': _argv,
    'connections': _connections,
    'projectJoplin': lambda v: project(v['raw'], v['instance'], v['account'], False),
    'partialCodes': lambda _: partial_codes(),
    'obsidianUrl': lambda v: obsidian.note_url(v['vault'], v['path']),
    'vaultEntries': obsidian.entries,
    'vaultWalk': _vault_walk,
    'obsidianTransport': lambda v: obsidian.transport(v['instance'], v['block']),
    'projectObsidian': lambda v: obsidian.project(v['raw'], v['path'], v['instance'], v['account'], False),
    'notionVersion': lambda v: notion.configure(v['instance'], v['block']),
    'notionTitle': notion.title_of,
    'notionSpace': _notion_space,
    'notionTime': lambda v: notion.stamp(v, 'created_time'),
    'projectNotion': lambda v: notion.project(v['raw'], v['instance'], v['account'], False),
    'parsePin': parse_pin,
    'fingerprintOf': lambda digits: fingerprint_of(bytes.fromhex(digits)),
    'secretName': secret_name,
    'refFor': lambda v: ref_for(v['source'], v.get('instance')),
    'vaultEntry': _vault_entry,
}

ALL = entries('unit')


class UnitCorpus(unittest.TestCase):
    def test_the_unit_corpus_is_not_empty(self) -> None:
        self.assertLess(0, len(ALL), 'spec/unit.json has no entries - did `make spec-build` run?')

    def test_every_corpus_id_is_unique(self) -> None:
        ids = [e['id'] for e in ALL]
        self.assertEqual(sorted(set(ids)), sorted(ids), 'duplicate corpus ids')


def _case(e: dict[str, Any]) -> Callable[[UnitCorpus], None]:
    def test(self: UnitCorpus) -> None:
        fn = REGISTRY.get(e['fn'])
        self.assertIsNotNone(fn, 'no such function in the registry: ' + e['fn'])
        assert fn is not None
        if 'err' in e:
            # `err` INSTEAD OF `out`: the shape refuses an entry carrying both.
            with self.assertRaises(Exception) as raised:
                fn(e['in'])
            self.assertIn(e['err'], str(raised.exception))
            return
        # Compared as canonical bytes, so `true` and `1` stay different answers.
        self.assertEqual(serialise(e['out']), serialise(fn(e['in'])))
    return test


for _e in ALL:
    setattr(UnitCorpus, 'test unit ' + _e['id'], _case(_e))
