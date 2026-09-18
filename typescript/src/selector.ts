
export const FIELDS = [
  'assignee', 'author', 'body', 'created', 'has', 'instance', 'source',
  'space', 'state', 'status', 'tag', 'title', 'updated',
] as const

export const OPS = [':', '=', '!=', '>', '<', '>=', '<='] as const

export const ORDERING_OPS = ['>', '<', '>=', '<=']

export type Field = typeof FIELDS[number]
export type Op = typeof OPS[number]

export type Value =
  | { k: 'word', v: string }
  | { k: 'date', v: string }      // YYYY-MM-DD, 'today' or 'yesterday'
  | { k: 'dur', n: number, unit: 'd' | 'w' | 'mo' | 'y' }

export type Node =
  | { t: 'or', kids: Node[] }
  | { t: 'and', kids: Node[] }
  | { t: 'not', kid: Node }
  | { t: 'cmp', field: Field, op: Op, value: Value }
  | { t: 'text', v: string }

export function fieldsOf (n: Node): string[] {
  const seen = new Set<string>()
  const walk = (x: Node): void => {
    if (x.t === 'or' || x.t === 'and') { x.kids.forEach(walk); return }
    if (x.t === 'not') { walk(x.kid); return }
    if (x.t === 'cmp') { seen.add(x.field); return }
    seen.add('title'); seen.add('body')
  }
  walk(n)
  return [...seen].sort()
}

export class SelectorError extends Error {
  code = 'invalid-selector'
  offset: number
  token: string
  constructor (message: string, offset: number, token: string) {
    super(message)
    this.name = 'SelectorError'
    this.offset = offset
    this.token = token
  }
}

// -- tokeniser --------------------------------------------------------------

type Tok = {
  kind: 'word' | 'quoted' | 'lparen' | 'rparen' | 'op' | 'dash'
  text: string
  offset: number            // BYTE offset into the UTF-8 encoding of the input
}

const utf8 = new TextEncoder()
function byteLen (s: string): number { return utf8.encode(s).length }

function isSpace (ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

// A bareword stops at whitespace, a paren, or an operator character. Note that
// '-' is NOT a stop: it is only a negation marker at the START of an atom, so
// `rate-limit` is one word while `-tag:x` is a negation.
function isWordStop (ch: string): boolean {
  return isSpace(ch) || ch === '(' || ch === ')' || ch === ':' ||
    ch === '=' || ch === '!' || ch === '>' || ch === '<' || ch === '"'
}

export function tokenise (input: string): Tok[] {
  const chars = Array.from(input)
  const toks: Tok[] = []
  let i = 0
  let off = 0

  const advance = (n: number) => {
    for (let k = 0; k < n; k++) { off += byteLen(chars[i]); i++ }
  }

  while (i < chars.length) {
    const ch = chars[i]

    if (isSpace(ch)) { advance(1); continue }

    if (ch === '(') { toks.push({ kind: 'lparen', text: '(', offset: off }); advance(1); continue }
    if (ch === ')') { toks.push({ kind: 'rparen', text: ')', offset: off }); advance(1); continue }

    if (ch === '"') {
      const start = off
      advance(1)
      let v = ''
      let closed = false
      while (i < chars.length) {
        const c = chars[i]
        if (c === '\\') {
          advance(1)
          if (i >= chars.length) break
          v += chars[i]
          advance(1)
          continue
        }
        if (c === '"') { advance(1); closed = true; break }
        v += c
        advance(1)
      }
      if (!closed) {
        throw new SelectorError('unterminated quoted value', start, '"' + v)
      }
      toks.push({ kind: 'quoted', text: v, offset: start })
      continue
    }

    if (ch === '!' ) {
      const start = off
      if (chars[i + 1] === '=') { toks.push({ kind: 'op', text: '!=', offset: start }); advance(2); continue }
      throw new SelectorError("'!' must be part of '!='", start, '!')
    }
    if (ch === '>' || ch === '<') {
      const start = off
      if (chars[i + 1] === '=') { toks.push({ kind: 'op', text: ch + '=', offset: start }); advance(2); continue }
      toks.push({ kind: 'op', text: ch, offset: start }); advance(1); continue
    }
    if (ch === ':' || ch === '=') {
      toks.push({ kind: 'op', text: ch, offset: off }); advance(1); continue
    }

    // '-' negates only when it opens an atom, which the parser decides; the
    // tokeniser marks it and lets a word absorb it otherwise.
    if (ch === '-') {
      const prev = toks[toks.length - 1]
      const opensAtom = undefined === prev || prev.kind === 'lparen' ||
        prev.kind === 'op' || prev.kind === 'dash' ||
        (prev.kind === 'word' && isKeyword(prev.text))
      if (opensAtom) {
        toks.push({ kind: 'dash', text: '-', offset: off }); advance(1); continue
      }
    }

    const start = off
    let w = ''
    while (i < chars.length && !isWordStop(chars[i])) { w += chars[i]; advance(1) }
    if ('' === w) {
      throw new SelectorError('unexpected character', start, chars[i])
    }
    toks.push({ kind: 'word', text: w, offset: start })
  }

  return toks
}

function isKeyword (t: string): boolean {
  return t === 'AND' || t === 'and' || t === 'OR' || t === 'or' ||
    t === 'NOT' || t === 'not'
}
function isOrKeyword (t: Tok | undefined): boolean {
  return undefined !== t && t.kind === 'word' && (t.text === 'OR' || t.text === 'or')
}
function isAndKeyword (t: Tok | undefined): boolean {
  return undefined !== t && t.kind === 'word' && (t.text === 'AND' || t.text === 'and')
}
function isNotKeyword (t: Tok | undefined): boolean {
  return undefined !== t && t.kind === 'word' && (t.text === 'NOT' || t.text === 'not')
}

// -- value classification ---------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export function isLeap (y: number): boolean {
  return (0 === y % 4 && 0 !== y % 100) || 0 === y % 400
}

export function daysIn (y: number, m: number): number {
  if (2 === m) return isLeap(y) ? 29 : 28
  return MONTH_DAYS[m - 1]
}
const DUR_RE = /^(\d+)(mo|d|w|y)$/

export function classify (tok: Tok): Value {
  if (tok.kind === 'quoted') return { k: 'word', v: tok.text }
  const t = tok.text
  if (t === 'today' || t === 'yesterday') return { k: 'date', v: t }
  if (DATE_RE.test(t)) {
    const [y, m, d] = t.split('-').map(Number)
    if (m < 1 || 12 < m || d < 1 || daysIn(y, m) < d) {
      throw new SelectorError('date is out of range', tok.offset, t)
    }
    return { k: 'date', v: t }
  }
  const m = DUR_RE.exec(t)
  if (null !== m) {
    return { k: 'dur', n: Number(m[1]), unit: m[2] as 'd' | 'w' | 'mo' | 'y' }
  }
  return { k: 'word', v: t }
}

// -- parser -----------------------------------------------------------------

class Parser {
  toks: Tok[]
  pos = 0
  end: number
  constructor (toks: Tok[], end: number) { this.toks = toks; this.end = end }

  peek (): Tok | undefined { return this.toks[this.pos] }
  next (): Tok | undefined { return this.toks[this.pos++] }
  atEnd (): boolean { return this.pos >= this.toks.length }

  fail (msg: string, tok?: Tok): never {
    if (undefined === tok) throw new SelectorError(msg, this.end, '')
    throw new SelectorError(msg, tok.offset, tok.text)
  }

  parseOr (): Node {
    const kids = [this.parseAnd()]
    while (isOrKeyword(this.peek())) {
      this.next()
      if (this.atEnd()) this.fail('OR must be followed by a term')
      kids.push(this.parseAnd())
    }
    return 1 === kids.length ? kids[0] : { t: 'or', kids }
  }

  parseAnd (): Node {
    const kids = [this.parseNot()]
    for (;;) {
      const t = this.peek()
      if (undefined === t) break
      if (t.kind === 'rparen') break
      if (isOrKeyword(t)) break
      if (isAndKeyword(t)) {
        this.next()
        if (this.atEnd()) this.fail('AND must be followed by a term')
        kids.push(this.parseNot())
        continue
      }
      // Adjacency implies AND.
      kids.push(this.parseNot())
    }
    return 1 === kids.length ? kids[0] : { t: 'and', kids }
  }

  parseNot (): Node {
    const t = this.peek()
    if (isNotKeyword(t) || (undefined !== t && t.kind === 'dash')) {
      this.next()
      if (this.atEnd()) this.fail('NOT must be followed by a term')
      return { t: 'not', kid: this.parseNot() }
    }
    return this.parseAtom()
  }

  parseAtom (): Node {
    const t = this.next()
    if (undefined === t) this.fail('unexpected end of selector')

    if (t.kind === 'lparen') {
      const inner = this.parseOr()
      const close = this.next()
      if (undefined === close || close.kind !== 'rparen') {
        if (undefined === close) this.fail('unclosed group')
        this.fail('expected )', close)
      }
      return inner
    }
    if (t.kind === 'rparen') this.fail('unmatched )', t)
    if (t.kind === 'op') this.fail('operator with no field', t)
    if (t.kind === 'dash') this.fail('dangling -', t)

    // A quoted token standing alone is full text.
    if (t.kind === 'quoted') return { t: 'text', v: t.text }

    const op = this.peek()
    if (undefined !== op && op.kind === 'op') {
      this.next()
      if (!(FIELDS as readonly string[]).includes(t.text)) {
        this.fail('unknown field "' + t.text + '"', t)
      }
      const vtok = this.next()
      if (undefined === vtok) this.fail('"' + t.text + op.text + '" has no value')
      if (vtok.kind === 'op' || vtok.kind === 'lparen' || vtok.kind === 'rparen' ||
          vtok.kind === 'dash') {
        this.fail('expected a value', vtok)
      }
      const value = classify(vtok)
      if (ORDERING_OPS.includes(op.text) && value.k === 'word') {
        this.fail('"' + op.text + '" needs a date or a duration, not a bareword', vtok)
      }
      return { t: 'cmp', field: t.text as Field, op: op.text as Op, value }
    }

    // A bareword with no field is full text.
    return { t: 'text', v: t.text }
  }
}

export function parseSelector (input: string): Node {
  const toks = tokenise(input)
  if (0 === toks.length) {
    throw new SelectorError('empty selector', 0, '')
  }
  const p = new Parser(toks, byteLen(input))
  const node = p.parseOr()
  if (!p.atEnd()) {
    const t = p.peek() as Tok
    throw new SelectorError('unexpected token', t.offset, t.text)
  }
  return node
}
