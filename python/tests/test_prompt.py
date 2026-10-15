"""The passphrase prompt on a real terminal: echo off, and what was typed ahead
of it kept for each prompt in turn, as the canonical port reads it. getpass
discards that type-ahead."""

from __future__ import annotations

import os
import select
import shutil
import tempfile
import time
import unittest

from tests.harness import ROOT, binary

MASTER = b'fixture master passphrase'
PROMPT = b'passphrase for master: '


def _run(argv: list[str], env: dict[str, str], ahead: bytes = b'', after: bytes = b'') -> tuple[bytes, int]:
    import pty
    pid, fd = pty.fork()
    if 0 == pid:
        os.execve(argv[0], argv, env)
    os.write(fd, ahead)
    out = b''
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if after and PROMPT in out:
            # Past the prompt the terminal is raw: give it time to get there.
            time.sleep(0.5)
            os.write(fd, after)
            after = b''
        if not select.select([fd], [], [], 0.2)[0]:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    else:
        os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    return out, os.waitstatus_to_exitcode(status)


@unittest.skipUnless(hasattr(os, 'fork'), 'needs a pseudo-terminal')
class Prompt(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix='likeness-prompt-')
        self.addCleanup(shutil.rmtree, self.dir, True)
        shutil.copyfile(ROOT / 'fixtures' / 'vault' / 'likeness.skmv', os.path.join(self.dir, 'likeness.skmv'))
        self.config = os.path.join(self.dir, 'station.json')
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write('{ "station": 1, "profiles": { "default": { "sdk": {} } } }\n')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('LIKENESS_')}
        self.env['HOME'] = self.dir

    def run_list(self, **typed: bytes) -> tuple[bytes, int]:
        return _run([str(binary()), 'secrets', 'list', '--config', self.config], self.env, **typed)

    def test_a_passphrase_typed_ahead_of_the_prompt_is_kept(self) -> None:
        out, code = self.run_list(ahead=MASTER + b'\r')
        self.assertEqual(0, code, out)
        self.assertTrue(out.endswith(PROMPT + b'\r\njoplin.apikey\r\nnotion.apikey\r\n'), out)

    def test_answers_typed_ahead_together_each_reach_their_prompt(self) -> None:
        config = os.path.join(self.dir, 'fresh.json')
        with open(config, 'w', encoding='utf-8') as f:
            f.write('{ "station": 1, "profiles": { "default": { "sdk": {}, "secrets": '
                    '{ "providers": [{ "kind": "minivault", "file": "fresh.skmv" }] } } } }\n')
        out, code = _run([str(binary()), 'secrets', 'init', '--config', config], self.env,
                         ahead=b'new phrase\rnew phrase\r')
        self.assertEqual(0, code, out)
        self.assertTrue(out.endswith(b'the same passphrase again: \r\n'
                                     b'created the vault ~/fresh.skmv, with the key master\r\n'), out)

    def test_a_passphrase_typed_at_the_prompt_is_not_echoed(self) -> None:
        out, code = self.run_list(after=MASTER + b'\r')
        self.assertEqual(0, code, out)
        self.assertEqual(PROMPT + b'\r\njoplin.apikey\r\nnotion.apikey\r\n', out)
