"""The port outside its checkout: no working-directory reads, and a package that carries its spec."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from tests.harness import ROOT, binary

PACKAGE = ROOT / 'python'


class Outside(unittest.TestCase):
    def test_the_port_runs_from_a_directory_with_no_checkout_and_an_empty_home(self) -> None:
        with tempfile.TemporaryDirectory(prefix='likeness-') as home:
            r = subprocess.run([str(binary()), 'version', '--json'], cwd=home,
                               env={'HOME': home, 'PATH': os.environ.get('PATH', '')},
                               capture_output=True, text=True, check=False)
        self.assertEqual(0, r.returncode, r.stderr)
        envelope = json.loads(r.stdout)
        self.assertIs(True, envelope['ok'])
        self.assertEqual('py', envelope['port'])

    def test_no_port_source_reads_the_working_directory(self) -> None:
        needle = re.compile(r'\bgetcwd\b|\bPath\.cwd\b|\bos\.curdir\b')
        found = [str(p.relative_to(ROOT)) for p in sorted((PACKAGE / 'likeness').rglob('*.py'))
                 if needle.search(p.read_text(encoding='utf-8'))]
        self.assertEqual([], found, 'port source that reads the working directory')

    def test_the_built_package_carries_its_spec_and_its_binary(self) -> None:
        with tempfile.TemporaryDirectory(prefix='likeness-') as tmp:
            src = Path(tmp) / 'src'
            src.mkdir()
            shutil.copy(PACKAGE / 'pyproject.toml', src)
            shutil.copytree(PACKAGE / 'likeness', src / 'likeness',
                            ignore=shutil.ignore_patterns('__pycache__'))
            r = subprocess.run(
                [sys.executable, '-m', 'pip', 'wheel', '--quiet', '--no-deps', '--no-build-isolation',
                 '--disable-pip-version-check', '-w', str(Path(tmp) / 'dist'), str(src)],
                capture_output=True, text=True, check=False)
            self.assertEqual(0, r.returncode, r.stderr)
            wheel = next((Path(tmp) / 'dist').glob('*.whl'))
            with zipfile.ZipFile(wheel) as z:
                names = z.namelist()
                points = next(z.read(n).decode('utf-8') for n in names
                              if n.endswith('/entry_points.txt'))
        for f in ('caps', 'commands', 'errors', 'help'):
            self.assertIn('likeness/spec/' + f + '.json', names)
        # Both names, the plain one and the one that is always this port.
        for script in ('likeness', 'likeness-py'):
            self.assertIn('\n' + script + ' = likeness.cli:entry', '\n' + points)
