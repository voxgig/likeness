"""The binary as a process: configuration refusals and a reader that goes away."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.harness import binary


STATION = '{"station":1,"profiles":{"default":{"sdk":{}}}}'


def refusal(path: str, why: str) -> str:
    return ('error: invalid-project\n  ' + path + ' ' + why + '\n'
            '  remedy  fix the file, or point --config at another\n')


def bad_stderr(path: str) -> str:
    return refusal(path, 'is not valid JSON')


def env(home: str) -> dict[str, str]:
    return {'HOME': home, 'PATH': os.environ.get('PATH', '')}


class Process(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix='likeness-')

    def version(self, config: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(binary()), 'version', '--json', '--config', config], cwd=self.home,
                              env=env(self.home), capture_output=True, text=True, check=False)

    def test_a_configuration_that_cannot_be_read_as_a_file_is_refused_not_taken_for_absent(self) -> None:
        cfg = Path(self.home) / 'cfg'
        (cfg / 'likeness.json').mkdir(parents=True)
        (cfg / 'station.json').write_text(STATION, encoding='utf-8')
        for config, named in ((cfg, cfg), (cfg / 'station.json', cfg / 'likeness.json')):
            r = self.version(str(config))
            self.assertEqual(3, r.returncode, str(config) + '\n' + r.stderr)
            self.assertEqual('', r.stdout)
            self.assertEqual(refusal(str(named), 'cannot be read'), r.stderr)

    def test_a_number_no_double_can_hold_is_not_valid_json_in_either_file(self) -> None:
        station = Path(self.home) / 'station.json'
        likeness = Path(self.home) / 'likeness.json'
        station.write_text('{"station":1,"profiles":{"default":{"sdk":{"joplin":{"options":{"n":1e400}}}}}}',
                           encoding='utf-8')
        r = self.version(str(station))
        self.assertEqual(3, r.returncode, r.stderr)
        self.assertEqual(bad_stderr(str(station)), r.stderr)
        station.write_text('{"station":1,"profiles":{"default":{"sdk":{"joplin":{}}}}}', encoding='utf-8')
        for account in ('-1e400', '1' + '0' * 400):
            likeness.write_text('{"likeness":1,"profiles":{"default":{"instances":{"joplin":{"account":' +
                                account + '}}}}}', encoding='utf-8')
            r = self.version(str(station))
            self.assertEqual(3, r.returncode, account[:8] + '\n' + r.stderr)
            self.assertEqual('', r.stdout)
            self.assertEqual(bad_stderr(str(likeness)), r.stderr)
        # Too small to hold is zero, which is a number.
        likeness.write_text('{"likeness":1,"profiles":{"default":{"instances":{"joplin":{"account":1e-400}}}}}',
                            encoding='utf-8')
        r = self.version(str(station))
        self.assertEqual(0, r.returncode, r.stderr)

    def test_a_configuration_this_process_has_no_permission_to_read_is_refused(self) -> None:
        config = Path(self.home) / 'station.json'
        config.write_text(STATION, encoding='utf-8')
        config.chmod(0)
        try:
            config.read_bytes()
        except PermissionError:
            pass
        else:
            self.skipTest('this process reads a file without permission to, so the refusal cannot be shown here')
        r = self.version(str(config))
        self.assertEqual(3, r.returncode, r.stderr)
        self.assertEqual('', r.stdout)
        self.assertEqual(refusal(str(config), 'cannot be read'), r.stderr)

    def test_a_malformed_configuration_is_refused_the_same_way_through_both_flag_forms(self) -> None:
        bad = str(Path(self.home) / 'bad.json')
        Path(bad).write_text('{not json', encoding='utf-8')
        for args in (['list', '--json', '--config=' + bad], ['list', '--json', '--config', bad]):
            r = subprocess.run([str(binary()), *args], cwd=self.home, env=env(self.home),
                               capture_output=True, text=True, check=False)
            self.assertEqual(3, r.returncode, ' '.join(args) + '\n' + r.stderr)
            self.assertEqual('', r.stdout)
            self.assertEqual(bad_stderr(bad), r.stderr)

    def test_a_broken_pipe_exits_quietly_with_0(self) -> None:
        # The reader is gone before the port starts.
        read, write = os.pipe()
        os.close(read)
        try:
            r = subprocess.run([str(binary()), 'version', '--json'], cwd=self.home, env=env(self.home),
                               stdout=write, stderr=subprocess.PIPE, check=False)
        finally:
            os.close(write)
        self.assertEqual(b'', r.stderr)
        self.assertEqual(0, r.returncode)
