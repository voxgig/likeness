/* Evaluate a parsed selector against a projected note, locally.
 *
 * Structured terms are evaluated IDENTICALLY EVERYWHERE: pushed down to the
 * source where the capability matrix says it can filter on them, and applied
 * here where it cannot - same answer either way, which is a corpus case rather
 * than a claim. For Stage 1 no source can filter, so everything lands here.
 *
 * Durations are relative to the INJECTED clock, never to the wall clock. An
 * entry that asserted on `now` would pass for one second and fail forever
 * after.
 */

import type { Node, Value } from './selector.js'
import type { Note } from './note.js'

const DAY = 86400000

function durationMs (v: Extract<Value, { k: 'dur' }>): number {
  switch (v.unit) {
    case 'd': return v.n * DAY
    case 'w': return v.n * 7 * DAY
    // A month is 30 days and a year is 365. Calendar arithmetic differs between
    // language standard libraries in ways nobody agrees on, and a selector
    // window is a rough question. Fixed multipliers are pinned in the corpus.
    case 'mo': return v.n * 30 * DAY
    case 'y': return v.n * 365 * DAY
  }
}

function resolveDate (v: Value, clockMs: number): number | null {
  if (v.k === 'date') {
    if (v.v === 'today') return Date.parse(new Date(clockMs).toISOString().slice(0, 10) + 'T00:00:00Z')
    if (v.v === 'yesterday') return Date.parse(new Date(clockMs - DAY).toISOString().slice(0, 10) + 'T00:00:00Z')
    return Date.parse(v.v + 'T00:00:00Z')
  }
  if (v.k === 'dur') return clockMs - durationMs(v)
  return null
}

function fieldValue (n: Note, field: string): unknown {
  switch (field) {
    case 'tag': return n.tags
    case 'space': return n.space
    case 'source': return n.source
    case 'instance': return n.instance
    case 'status': return n.status
    case 'state': return n.state
    case 'title': return n.title
    case 'body': return n.body
    case 'created': return n.created
    case 'updated': return n.updated
    default: return undefined
  }
}

function asText (v: Value): string {
  if (v.k === 'word') return v.v
  if (v.k === 'date') return v.v
  return String(v.n) + v.unit
}

export function evaluate (node: Node, note: Note, clockMs: number): boolean {
  switch (node.t) {
    case 'or': return node.kids.some(k => evaluate(k, note, clockMs))
    case 'and': return node.kids.every(k => evaluate(k, note, clockMs))
    case 'not': return !evaluate(node.kid, note, clockMs)
    case 'text': {
      // A bareword with no field is full text. With no source-side search it is
      // a case-insensitive substring over title and body, and the capability
      // matrix says so rather than implying a relevance score nobody computed.
      const q = node.v.toLowerCase()
      return note.title.toLowerCase().includes(q) ||
        (undefined !== note.body && note.body.toLowerCase().includes(q))
    }
    case 'cmp': {
      const have = fieldValue(note, node.field)
      const want = node.value

      if (node.op === '>' || node.op === '<' || node.op === '>=' || node.op === '<=') {
        if ('string' !== typeof have) return false
        const haveMs = Date.parse(have)
        const wantMs = resolveDate(want, clockMs)
        if (null === wantMs || Number.isNaN(haveMs)) return false
        // `updated>14d` reads as "changed within the last 14 days", so a
        // duration on the right of `>` is a LOWER BOUND ON THE TIMESTAMP.
        switch (node.op) {
          case '>': return haveMs > wantMs
          case '>=': return haveMs >= wantMs
          case '<': return haveMs < wantMs
          case '<=': return haveMs <= wantMs
        }
      }

      const text = asText(want)
      const eq = (h: unknown) => {
        if (undefined === h || null === h) return false
        return String(h).toLowerCase() === text.toLowerCase()
      }
      const contains = (h: unknown) => {
        if (undefined === h || null === h) return false
        return String(h).toLowerCase().includes(text.toLowerCase())
      }

      if (Array.isArray(have)) {
        const hit = have.some(x => String(x).toLowerCase() === text.toLowerCase())
        return node.op === '!=' ? !hit : hit
      }
      if (node.op === '=') return eq(have)
      if (node.op === '!=') return !eq(have)
      // ':' is contains for free-text fields and equality for the rest, which
      // is what people mean by `title:retention` and by `status:done`.
      if (node.field === 'title' || node.field === 'body') return contains(have)
      return eq(have)
    }
  }
}
