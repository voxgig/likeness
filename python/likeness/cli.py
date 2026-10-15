"""The thin argv shell: read the configuration, probe PATH, run, write."""

from __future__ import annotations

import os
import re
import sys
import termios
import time
from typing import Any, BinaryIO

from likeness.config import ConfigError, homedir, join, load_config
from likeness.core import PORT, VERSION, Ctx, run
from likeness.identity import rfc3339
from likeness.station import profile_of
from likeness.text import utf8

REMEDY = 'fix the file, or point --config at another'


_BINARY = re.compile('likeness(?:-([a-z]+))?')


def probe_path(env: dict[str, str]) -> list[dict[str, str]]:
    """The port is read from the file name, never by running it: `which` must
    not execute whatever is on PATH under a matching name."""
    seen: set[str] = set()
    rows: list[dict[str, str]] = []
    for directory in env.get('PATH', '').split(os.pathsep):
        if '' == directory:
            continue
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            m = _BINARY.fullmatch(name)
            if m is None:
                continue
            full = os.path.normpath(os.path.join(directory, name))
            if full in seen or not os.path.isfile(full):
                continue
            seen.add(full)
            rows.append({'path': full, 'port': m.group(1) or '', 'version': ''})
    if 0 == len(rows):
        rows.append({'path': '(this port, not on PATH)', 'port': PORT, 'version': VERSION})
    return rows


def take_config_option(argv: list[str]) -> tuple[list[str], str | None]:
    """`--config PATH` or `--config=PATH`, taken out before the command runs.
    Only a single well-formed one after the command and before `--` is taken;
    anything else is left in place for the grammar to refuse."""
    found: list[tuple[int, int, str]] = []
    bad = False
    i = 1
    while i < len(argv):
        a = argv[i]
        if '--' == a:
            break
        if '--config' == a:
            following = argv[i + 1] if i + 1 < len(argv) else None
            if following is None or (following.startswith('-') and '-' != following):
                bad = True
            else:
                found.append((i, 2, following))
            i += 1
        elif a.startswith('--config='):
            value = a[len('--config='):]
            if '' == value:
                bad = True
            else:
                found.append((i, 1, value))
        i += 1
    if bad or 1 != len(found):
        return list(argv), None
    at, width, value = found[0]
    return argv[:at] + argv[at + width:], value


_INTERRUPTED = object()


def _raw(mode: list[Any]) -> list[Any]:
    """The terminal mode the canonical port's runtime calls raw."""
    raw = [*mode[:6], list(mode[6])]
    raw[0] &= ~(termios.BRKINT | termios.ICRNL | termios.INPCK | termios.ISTRIP | termios.IXON)
    raw[1] |= termios.ONLCR
    raw[2] |= termios.CS8
    raw[3] &= ~(termios.ECHO | termios.ICANON | termios.IEXTEN | termios.ISIG)
    raw[6][termios.VMIN] = 1
    raw[6][termios.VTIME] = 0
    return raw


class _Ahead:
    """What was typed past a line end, kept for the prompt that follows. A line
    typed ahead arrives ending in \\n; Enter in raw mode is \\r, so \\r\\n is one end."""
    text = ''
    after_cr = False


def _typed(fd: int) -> Any:
    typed = ''
    text, _Ahead.text = _Ahead.text, ''
    while True:
        chars = list(text)
        for i, ch in enumerate(chars):
            lf = _Ahead.after_cr and '\n' == ch
            _Ahead.after_cr = False
            if lf:
                continue
            if ch in ('\r', '\n'):
                _Ahead.after_cr = '\r' == ch
                _Ahead.text = ''.join(chars[i + 1:])
                return typed
            if '\x04' == ch:
                _Ahead.text = ''.join(chars[i + 1:])
                return typed or None
            if '\x03' == ch:
                return _INTERRUPTED
            typed = typed[:-1] if ch in ('\x7f', '\b') else typed + ch
        chunk = os.read(fd, 65536)
        if not chunk:
            return typed or None
        text = chunk.decode('utf-8', errors='replace')


def prompt(label: str) -> str | None:
    """One line from the terminal with echo off; None at end of input. Read
    raw, so what was typed ahead of the prompt is kept: getpass flushes it."""
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    # Echo goes off before the label shows, or an answer typed the moment it
    # appears is echoed.
    termios.tcsetattr(fd, termios.TCSADRAIN, _raw(saved))
    try:
        _write(sys.stderr.buffer, label + ': ')
        answer = _typed(fd)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        _write(sys.stderr.buffer, '\n')
    if answer is _INTERRUPTED:
        sys.exit(130)
    return answer


def read_stdin() -> str:
    return sys.stdin.buffer.read().decode('utf-8', errors='replace')


def _write(stream: BinaryIO, text: str) -> bool:
    """False when the reader has gone away."""
    try:
        stream.write(utf8(text))
        stream.flush()
        return True
    except BrokenPipeError:
        # Point the descriptor at /dev/null, so the flush at exit stays quiet too.
        os.dup2(os.open(os.devnull, os.O_WRONLY), stream.fileno())
        return False


def main(argv: list[str]) -> int:
    rest, config_path = take_config_option(argv)
    env = dict(os.environ)
    home = homedir()
    path = config_path if config_path is not None else join(home, '.config', 'likeness', 'station.json')

    try:
        station, accounts = load_config(path, profile_of(env))
    except ConfigError as err:
        quiet = not _write(sys.stderr.buffer,
                           'error: invalid-project\n  ' + str(err) + '\n  remedy  ' + REMEDY + '\n')
        return 0 if quiet else 3

    res = run(Ctx(
        argv=rest,
        env=env,
        clock=rfc3339(time.time_ns() // 1_000_000),
        station=station,
        accounts=accounts,
        path=probe_path(env),
        home=home,
        dir=os.path.dirname(path) or '.',
        stdin=read_stdin,
        tty=sys.stdin is not None and sys.stdin.isatty(),
        prompt=prompt,
    ))

    # A reader that went away is not the port's failure: exit quietly with 0.
    delivered = True
    if '' != res.stdout:
        delivered = _write(sys.stdout.buffer, res.stdout)
    if '' != res.stderr:
        delivered = _write(sys.stderr.buffer, res.stderr) and delivered
    return res.exit if delivered else 0


def entry() -> None:
    sys.exit(main(sys.argv[1:]))
