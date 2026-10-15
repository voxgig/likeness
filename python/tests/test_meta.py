"""The harness proves it can fail: every check, fed an entry it must refuse."""

from __future__ import annotations

import copy
import json
import unittest
from typing import Any

from joplin_sdk import JoplinSDK

from likeness.adapter.joplin import check as joplin_check
from likeness.core import run
from likeness.envelope import serialise
from tests.harness import ROOT, build_ctx, check, entries, stdout_failures

ALL = entries('cli')


def entry(id: str) -> dict[str, Any]:
    """A deep copy, so a mutation here cannot leak into the real runner."""
    found = [e for e in ALL if e['id'] == id]
    assert found, 'no corpus entry with id ' + id
    return copy.deepcopy(found[0])


def starts(failures: list[str], prefix: str) -> bool:
    return any(f.startswith(prefix) for f in failures)


class Meta(unittest.TestCase):
    def test_the_unmutated_entry_passes(self) -> None:
        # The control: a harness that fails a correct entry proves nothing by
        # failing a broken one.
        self.assertEqual([], check(entry('list/all')))

    def test_a_wrong_exit_code_is_reported(self) -> None:
        e = entry('list/all')
        e['out']['exit'] = 3
        f = check(e)
        self.assertTrue(starts(f, 'exit '), f)

    def test_stdout_differing_by_one_byte_is_reported(self) -> None:
        e = entry('list/all')
        text = (ROOT / e['out']['stdout']).read_text(encoding='utf-8')
        text = text.replace('Retention', 'Retentiom', 1)
        self.assertNotIn('Retention policy', text, 'the mutation did not apply')
        rel = 'spec/expect/.meta-py-one-byte.json'
        tmp = ROOT / rel
        tmp.write_text(text, encoding='utf-8')
        try:
            e['out']['stdout'] = rel
            f = check(e)
            self.assertTrue(starts(f, 'stdout differs'), f)
        finally:
            tmp.unlink()

    def test_a_vault_left_holding_the_wrong_names_is_reported(self) -> None:
        e = entry('secrets/remove')
        self.assertIn('vault', e['out'], 'secrets/remove asserts no vault state')
        e['out']['vault']['names'] = ['joplin.apikey', 'notion.apikey']
        f = check(e)
        self.assertTrue(starts(f, 'vault names '), f)

    def test_a_vault_value_that_differs_is_reported(self) -> None:
        e = entry('secrets/set-from-stdin')
        self.assertIn('values', e['out'].get('vault', {}), 'secrets/set-from-stdin asserts no values')
        e['out']['vault']['values'] = {'joplin.apikey': 'rotated-token\n'}
        f = check(e)
        self.assertTrue(starts(f, 'vault value of '), f)

    def test_a_prompt_that_was_not_expected_is_reported(self) -> None:
        e = entry('secrets/passphrase-typed')
        e['out']['prompts'] = []
        f = check(e)
        self.assertTrue(starts(f, 'prompts '), f)

    def test_a_missing_call_is_reported(self) -> None:
        e = entry('list/all')
        e['out']['calls'] = []
        f = check(e)
        self.assertTrue(starts(f, 'calls '), f)

    def test_an_extra_call_is_reported(self) -> None:
        e = entry('list/all')
        e['out']['calls'].append({'instance': 'joplin', 'method': 'GET', 'path': '/notes'})
        f = check(e)
        self.assertTrue(starts(f, 'calls '), f)

    def test_a_call_with_the_right_count_and_the_wrong_path_is_reported(self) -> None:
        e = entry('list/all')
        e['out']['calls'] = [{'instance': 'joplin', 'method': 'GET', 'path': '/folders'}]
        f = check(e)
        self.assertTrue(starts(f, 'calls '), f)

    def test_unexpected_stderr_is_reported(self) -> None:
        e = entry('list/all')
        e['out']['stderr'] = 'something the command never printed\n'
        f = check(e)
        self.assertTrue(starts(f, 'stderr '), f)

    def test_a_missing_expectation_file_is_an_error_not_a_pass(self) -> None:
        e = entry('list/all')
        e['out']['stdout'] = 'spec/expect/.meta-py-does-not-exist.json'
        with self.assertRaises(FileNotFoundError):
            check(e)

    def test_every_failure_is_reported_not_just_the_first(self) -> None:
        e = entry('list/all')
        e['out']['exit'] = 3
        e['out']['calls'] = []
        e['out']['stderr'] = 'no\n'
        f = check(e)
        self.assertEqual(3, len(f), f)

    # The bytes are the contract: the right values in the wrong form.

    def test_the_right_values_indented_are_reported(self) -> None:
        e = entry('list/all')
        r = run(build_ctx(e))
        indented = json.dumps(json.loads(r.stdout), indent=2, ensure_ascii=False) + '\n'
        f = stdout_failures(e, indented)
        self.assertTrue(starts(f, 'stdout is not in canonical form'), f)

    def test_the_right_values_with_a_crlf_ending_are_reported(self) -> None:
        e = entry('list/all')
        r = run(build_ctx(e))
        f = stdout_failures(e, r.stdout[:-1] + '\r\n')
        self.assertTrue(starts(f, 'stdout is not in canonical form'), f)

    def test_an_envelope_naming_another_port_is_reported(self) -> None:
        e = entry('list/all')
        parsed = json.loads(run(build_ctx(e)).stdout)
        parsed['port'] = 'ts'
        f = stdout_failures(e, serialise(parsed))
        self.assertTrue(starts(f, 'envelope port is'), f)

    def test_a_wrong_port_inside_a_which_row_is_reported(self) -> None:
        e = entry('meta/which')
        parsed = json.loads(run(build_ctx(e)).stdout)
        self.assertTrue(isinstance(parsed['data'], list) and parsed['data'], 'which produced no rows')
        parsed['data'][0]['port'] = 'WRONG'
        f = stdout_failures(e, serialise(parsed))
        self.assertTrue(starts(f, 'stdout differs'), f)

    def test_version_reporting_another_port_in_its_data_is_reported(self) -> None:
        e = entry('meta/version')
        parsed = json.loads(run(build_ctx(e)).stdout)
        parsed['data']['port'] = 'WRONG'
        f = stdout_failures(e, serialise(parsed))
        self.assertTrue(starts(f, 'data.port is'), f)

    def test_a_written_file_that_differs_is_reported(self) -> None:
        e = entry('connections/add-joplin')
        e['out']['files']['station.json'] = 'fixtures/config/several/station.json'
        f = check(e)
        self.assertTrue(starts(f, 'station.json differs'), f)

    def test_a_file_the_entry_says_is_not_there_written_is_reported(self) -> None:
        e = entry('connections/add-joplin')
        e['out']['absent'] = ['likeness.json']
        f = check(e)
        self.assertTrue(starts(f, 'likeness.json is there afterwards'), f)

    def test_a_file_the_entry_names_never_written_is_reported(self) -> None:
        e = entry('connections/add-joplin-needs-an-account')
        e['out']['files'] = {'station.json': 'spec/written/connections/add-joplin/station.json'}
        f = check(e)
        self.assertTrue(starts(f, 'station.json is not there afterwards'), f)

    def test_net_options_reach_the_sdk(self) -> None:
        seed = {'entity': {'note': {'x1': {'id': 'x1'}}}, 'net': {'failTimes': 1, 'failStatus': 401}}
        r = joplin_check(JoplinSDK.test(seed))
        self.assertEqual((False, 'auth-failed'), (r.ok, r.code))
