"""A station bound live, its tokens in a throwaway vault, and mock/ as a process."""

from __future__ import annotations

import atexit
import json
import os
import queue
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass
from typing import Any

from likeness.calls import Calls
from likeness.core import Connection, connections_of, open_station
from tests.cert import Throwaway
from tests.harness import ROOT

PASSPHRASE = 'wire suite passphrase'

_DIRS: list[str] = []
atexit.register(lambda: [shutil.rmtree(d, ignore_errors=True) for d in _DIRS])


def scratch() -> str:
    """A directory of its own, removed when the suite exits."""
    d = tempfile.mkdtemp(prefix='likeness-wire-')
    _DIRS.append(d)
    return d


@dataclass
class Live:
    station: Any
    calls: Calls
    conns: list[Connection]


def live(sdk: dict[str, Any], tokens: dict[str, str], accounts: dict[str, str]) -> Live:
    """A station over the given instance blocks, reading its tokens from a vault."""
    from voxgig_sekreto.plugins.minivault import createvault

    file = os.path.join(scratch(), 'likeness.skmv')
    vault = createvault({'file': file, 'passphrase': PASSPHRASE, 'iterations': 1000})
    for name, value in tokens.items():
        vault.set(name, value)
    vault.close()
    station = open_station({'station': 1, 'profiles': {'default': {
        'secrets': {'providers': [{'kind': 'minivault', 'file': file, 'vaultkey': 'master',
                                   'passphrase': PASSPHRASE}]},
        'sdk': sdk,
    }}})
    return Live(station, Calls(station), connections_of(station, accounts, 'default'))


# mock/server.js serves TLS only when it is built in-process, so this script builds it.
_SERVE = '''
const { buildServer } = await import(process.env.LIKENESS_MOCK_URL)
const cert = process.env.LIKENESS_MOCK_CERT
const https = undefined === cert ? undefined : { key: process.env.LIKENESS_MOCK_KEY, cert }
const app = await buildServer({ sources: JSON.parse(process.env.LIKENESS_MOCK_SOURCES), https })
await app.listen({ port: 0, host: '127.0.0.1' })
const scheme = undefined === https ? 'http' : 'https'
process.stdout.write('listening on ' + scheme + '://127.0.0.1:' + app.server.address().port + '\\n')
process.on('SIGTERM', () => { app.close().then(() => process.exit(0)) })
'''


class Mock:
    """mock/ serving the named sources, over TLS with `https` when given."""

    def __init__(self, sources: list[str], https: Throwaway | None = None) -> None:
        node = shutil.which('node')
        if node is None:
            raise RuntimeError('node is required: the wire tests drive the real transport against mock/')
        env = {**os.environ, 'LIKENESS_MOCK_URL': (ROOT / 'mock' / 'server.js').as_uri(),
               'LIKENESS_MOCK_SOURCES': json.dumps(sources)}
        self._context = None
        if https is not None:
            env.update({'LIKENESS_MOCK_CERT': https.cert, 'LIKENESS_MOCK_KEY': https.key})
            self._context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            self._context.load_verify_locations(cadata=https.der)
        self._proc = subprocess.Popen([node, '--input-type=module', '-e', _SERVE], env=env,
                                      stdout=subprocess.PIPE, text=True)
        lines: queue.Queue[str] = queue.Queue()

        def drain() -> None:
            assert self._proc.stdout is not None
            for line in self._proc.stdout:
                lines.put(line)

        self._drain = threading.Thread(target=drain, daemon=True)
        self._drain.start()
        deadline = time.monotonic() + 30
        while True:
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                if self._proc.poll() is None and time.monotonic() < deadline:
                    continue
                self.close()
                raise RuntimeError('the mock server did not report its address; '
                                   'is `make mock-deps` done?') from None
            if line.startswith('listening on '):
                self.base = line[len('listening on '):].strip()
                return

    def control(self, method: str, path: str) -> Any:
        req = urllib.request.Request(self.base + path, method=method)
        with urllib.request.urlopen(req, timeout=10, context=self._context) as res:
            return json.loads(res.read().decode('utf-8'))

    def rows(self, source: str) -> list[dict[str, Any]]:
        """The mock's request ring for one source, in the order the requests came."""
        return self.control('GET', '/__requests?source=' + source)

    def clear(self) -> None:
        self.control('DELETE', '/__requests')

    def close(self) -> None:
        self._proc.terminate()
        self._proc.wait(timeout=10)
        self._drain.join(timeout=10)
        if self._proc.stdout is not None:
            self._proc.stdout.close()
