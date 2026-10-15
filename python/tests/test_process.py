"""The binary as a process: configuration refusals and a reader that goes away."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.harness import binary


def bad_stderr(path: str) -> str:
    return ('error: invalid-project\n  ' + path + ' is not valid JSON\n'
            '  remedy  fix the file, or point --config at another\n')


def env(home: str) -> dict[str, str]:
    return {'HOME': home, 'PATH': os.environ.get('PATH', '')}


class Process(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix='likeness-')

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
