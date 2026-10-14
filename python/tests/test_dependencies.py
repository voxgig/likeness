"""No port takes a third-party run-time dependency: the port's own imports, checked."""

from __future__ import annotations

import ast
import sys
import unittest

from tests.harness import ROOT

# Its own package, station, sekreto for the vault, and the generated SDK each
# adapter reaches its source through.
ALLOWED = {'likeness', 'voxgig_station', 'voxgig_sekreto', 'joplin_sdk'}


def imported(source: str) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            out.update(a.name.split('.')[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and 0 == node.level and node.module is not None:
            out.add(node.module.split('.')[0])
    return out


class Dependencies(unittest.TestCase):
    def test_the_port_imports_only_the_standard_library_station_and_the_sdks(self) -> None:
        found = {}
        for path in sorted((ROOT / 'python' / 'likeness').rglob('*.py')):
            names = imported(path.read_text(encoding='utf-8'))
            outside = sorted(n for n in names if n not in sys.stdlib_module_names and n not in ALLOWED)
            if outside:
                found[str(path.relative_to(ROOT))] = outside
        self.assertEqual({}, found)

    def test_the_check_sees_a_third_party_import(self) -> None:
        self.assertEqual({'requests', 'os'}, imported('import os\nfrom requests.adapters import X\n'))
        self.assertNotIn('requests', sys.stdlib_module_names)
