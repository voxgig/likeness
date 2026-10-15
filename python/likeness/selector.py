"""The selector grammar: a tokeniser with byte offsets, and a precedence parser."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, NoReturn, TypedDict

from likeness.identity import days_in
from likeness.text import byte_len

FIELDS = (
    'assignee', 'author', 'body', 'created', 'has', 'instance', 'source',
    'space', 'state', 'status', 'tag', 'title', 'updated',
)

OPS = (':', '=', '!=', '>', '<', '>=', '<=')

ORDERING_OPS = ('>', '<', '>=', '<=')


class Value(TypedDict, total=False):
    k: Literal['word', 'date', 'dur']
    v: str
    n: int
    unit: str


class Node(TypedDict, total=False):
    t: Literal['or', 'and', 'not', 'cmp', 'text']
    kids: list[Node]
    kid: Node
    field: str
    op: str
    value: Value
    v: str


def fields_of(n: Node) -> list[str]:
    seen: set[str] = set()

    def walk(x: Node) -> None:
        if x['t'] in ('or', 'and'):
            for k in x['kids']:
                walk(k)
        elif 'not' == x['t']:
            walk(x['kid'])
        elif 'cmp' == x['t']:
            seen.add(x['field'])
        else:
            seen.update(('title', 'body'))

    walk(n)
    return sorted(seen)


class SelectorError(Exception):
    code = 'invalid-selector'

    def __init__(self, message: str, offset: int, token: str) -> None:
        super().__init__(message)
        self.message = message
        self.offset = offset
        self.token = token

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class Tok:
    kind: Literal['word', 'quoted', 'lparen', 'rparen', 'op', 'dash']
    text: str
    offset: int


_SPACE = ' \t\n\r'
_WORD_STOP = _SPACE + '():=!><"'
_KEYWORDS = ('AND', 'and', 'OR', 'or', 'NOT', 'not')


def tokenise(source: str) -> list[Tok]:
    """Offsets are BYTES into the UTF-8 encoding of the input."""
    chars = list(source)
    toks: list[Tok] = []
    i = 0
    off = 0

    def advance(n: int) -> None:
        nonlocal i, off
        for _ in range(n):
            off += byte_len(chars[i])
            i += 1

    while i < len(chars):
        ch = chars[i]

        if ch in _SPACE:
            advance(1)
            continue

        if '(' == ch or ')' == ch:
            toks.append(Tok('lparen' if '(' == ch else 'rparen', ch, off))
            advance(1)
            continue

        if '"' == ch:
            start = off
            advance(1)
            value: list[str] = []
            closed = False
            while i < len(chars):
                c = chars[i]
                if '\\' == c:
                    advance(1)
                    if len(chars) <= i:
                        break
                    value.append(chars[i])
                    advance(1)
                    continue
                if '"' == c:
                    advance(1)
                    closed = True
                    break
                value.append(c)
                advance(1)
            if not closed:
                raise SelectorError('unterminated quoted value', start, '"' + ''.join(value))
            toks.append(Tok('quoted', ''.join(value), start))
            continue

        if '!' == ch:
            if i + 1 < len(chars) and '=' == chars[i + 1]:
                toks.append(Tok('op', '!=', off))
                advance(2)
                continue
            raise SelectorError("'!' must be part of '!='", off, '!')

        if '>' == ch or '<' == ch:
            if i + 1 < len(chars) and '=' == chars[i + 1]:
                toks.append(Tok('op', ch + '=', off))
                advance(2)
                continue
            toks.append(Tok('op', ch, off))
            advance(1)
            continue

        if ':' == ch or '=' == ch:
            toks.append(Tok('op', ch, off))
            advance(1)
            continue

        # '-' negates only where it opens an atom; anywhere else a word absorbs
        # it, so `rate-limit` is one word while `-tag:x` is a negation.
        if '-' == ch:
            opens = 0 == i or chars[i - 1] in _SPACE
            if not opens:
                prev = toks[-1]
                opens = prev.kind in ('lparen', 'op', 'dash') or \
                    ('word' == prev.kind and prev.text in _KEYWORDS)
            if opens:
                toks.append(Tok('dash', '-', off))
                advance(1)
                continue

        start = off
        word: list[str] = []
        while i < len(chars) and chars[i] not in _WORD_STOP:
            word.append(chars[i])
            advance(1)
        if 0 == len(word):
            raise SelectorError('unexpected character', start, chars[i])
        toks.append(Tok('word', ''.join(word), start))

    return toks


def _is_word(t: Tok | None, *texts: str) -> bool:
    return t is not None and 'word' == t.kind and t.text in texts


_DATE = re.compile('([0-9]{4})-([0-9]{2})-([0-9]{2})')
_DURATION = re.compile('([0-9]+)(mo|d|w|y)')


def classify(tok: Tok) -> Value:
    if 'quoted' == tok.kind:
        return {'k': 'word', 'v': tok.text}
    t = tok.text
    if t in ('today', 'yesterday'):
        return {'k': 'date', 'v': t}
    m = _DATE.fullmatch(t)
    if m is not None:
        y, mo, d = (int(g) for g in m.groups())
        if mo < 1 or 12 < mo or d < 1 or days_in(y, mo) < d:
            raise SelectorError('date is out of range', tok.offset, t)
        return {'k': 'date', 'v': t}
    m = _DURATION.fullmatch(t)
    if m is not None:
        # The cap keeps every port's arithmetic exact, in years as in days.
        if 8 < len(m.group(1)):
            raise SelectorError('duration is out of range', tok.offset, t)
        return {'k': 'dur', 'n': int(m.group(1)), 'unit': m.group(2)}
    return {'k': 'word', 'v': t}


class _Parser:
    def __init__(self, toks: list[Tok], end: int) -> None:
        self.toks = toks
        self.pos = 0
        self.end = end

    def peek(self) -> Tok | None:
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def next(self) -> Tok | None:
        t = self.peek()
        self.pos += 1
        return t

    def at_end(self) -> bool:
        return len(self.toks) <= self.pos

    def fail(self, message: str, tok: Tok | None = None) -> NoReturn:
        """With no token the fault is at the END of the input, where a dangling operator went wrong."""
        if tok is None:
            raise SelectorError(message, self.end, '')
        raise SelectorError(message, tok.offset, tok.text)

    def parse_or(self) -> Node:
        kids = [self.parse_and()]
        while _is_word(self.peek(), 'OR', 'or'):
            self.next()
            if self.at_end():
                self.fail('OR must be followed by a term')
            kids.append(self.parse_and())
        return kids[0] if 1 == len(kids) else {'t': 'or', 'kids': kids}

    def parse_and(self) -> Node:
        kids = [self.parse_not()]
        while True:
            t = self.peek()
            if t is None or 'rparen' == t.kind or _is_word(t, 'OR', 'or'):
                break
            if _is_word(t, 'AND', 'and'):
                self.next()
                if self.at_end():
                    self.fail('AND must be followed by a term')
            kids.append(self.parse_not())
        return kids[0] if 1 == len(kids) else {'t': 'and', 'kids': kids}

    def parse_not(self) -> Node:
        t = self.peek()
        if _is_word(t, 'NOT', 'not') or (t is not None and 'dash' == t.kind):
            self.next()
            if self.at_end():
                self.fail('NOT must be followed by a term')
            return {'t': 'not', 'kid': self.parse_not()}
        return self.parse_atom()

    def parse_atom(self) -> Node:
        t = self.next()
        if t is None:
            self.fail('unexpected end of selector')

        if 'lparen' == t.kind:
            inner = self.parse_or()
            close = self.next()
            if close is None:
                self.fail('unclosed group')
            if 'rparen' != close.kind:
                self.fail('expected )', close)
            return inner
        if 'rparen' == t.kind:
            self.fail('unmatched )', t)
        if 'op' == t.kind:
            self.fail('operator with no field', t)
        if 'dash' == t.kind:
            self.fail('dangling -', t)

        if 'quoted' == t.kind:
            return {'t': 'text', 'v': t.text}

        op = self.peek()
        if op is not None and 'op' == op.kind:
            self.next()
            if t.text not in FIELDS:
                self.fail('unknown field "' + t.text + '"', t)
            if op.text in ORDERING_OPS and t.text not in ('created', 'updated'):
                self.fail('"' + op.text + '" compares dates, which only created and updated hold', op)
            vtok = self.next()
            if vtok is None:
                self.fail('"' + t.text + op.text + '" has no value')
            if vtok.kind in ('op', 'lparen', 'rparen', 'dash'):
                self.fail('expected a value', vtok)
            value = classify(vtok)
            if op.text in ORDERING_OPS and 'word' == value['k']:
                self.fail('"' + op.text + '" needs a date or a duration, not a bareword', vtok)
            return {'t': 'cmp', 'field': t.text, 'op': op.text, 'value': value}

        return {'t': 'text', 'v': t.text}


def parse_selector(source: str) -> Node:
    toks = tokenise(source)
    if 0 == len(toks):
        raise SelectorError('empty selector', 0, '')
    p = _Parser(toks, byte_len(source))
    node = p.parse_or()
    if not p.at_end():
        t = p.peek()
        assert t is not None
        raise SelectorError('unexpected token', t.offset, t.text)
    return node
