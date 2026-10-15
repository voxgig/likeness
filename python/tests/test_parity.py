"""The raw transcript output `make parity` compares across ports."""

from __future__ import annotations

import unittest
from pathlib import Path

from likeness.core import PORT, run
from tests.harness import build_ctx, entries, parity_dir


class EmitParity(unittest.TestCase):
    @unittest.skipIf(parity_dir() is None, 'LIKENESS_PARITY_OUT is not set')
    def test_emit_parity_outputs(self) -> None:
        base = Path(str(parity_dir())) / PORT
        for e in entries('cli'):
            r = run(build_ctx(e))
            dst = base / (e['id'] + '.out')
            dst.parent.mkdir(parents=True, exist_ok=True)
            # exit, stdout and stderr in one file: one comparison rather than three.
            body = 'exit ' + str(r.exit) + '\n--stdout--\n' + r.stdout + '--stderr--\n' + r.stderr
            dst.write_bytes(body.encode('utf-8'))
