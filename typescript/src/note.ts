/* The common entity shape, as the envelope carries it.
 *
 * A projection loses things, so two rules are in the shape rather than left to
 * an adapter's judgement: `raw` is a STRING carrying the source payload
 * verbatim, and `version` is absent where a source has no concurrency token
 * rather than invented.
 */

export type Note = {
  lid: string
  source: string
  instance: string
  id: string
  title: string
  body?: string
  space?: string
  /* Absent means NOT FETCHED, `[]` means fetched and empty. An adapter that
   * does not read tag associations omits this rather than emitting `[]`. */
  tags?: string[]
  status?: 'open' | 'done' | 'archived'
  state?: string
  url: string
  created: string
  updated: string
  version?: string
  raw?: string
}

/* The total sort order (SPEC 14.2), written out rather than inherited.
 *
 * Requested key, then `updated` DESCENDING, then `lid` ASCENDING. The
 * tiebreakers are what make four concurrent fetches unobservable in the output
 * and the byte diff possible at all - a key plus two tiebreakers is not a total
 * order while the primary comparison is undefined, so the string comparison is
 * by code point and is pinned here too.
 */
export function compareCodePoints (a: string, b: string): number {
  const ai = Array.from(a); const bi = Array.from(b)
  const n = Math.min(ai.length, bi.length)
  for (let i = 0; i < n; i++) {
    const x = ai[i].codePointAt(0) as number
    const y = bi[i].codePointAt(0) as number
    if (x !== y) return x < y ? -1 : 1
  }
  return ai.length === bi.length ? 0 : (ai.length < bi.length ? -1 : 1)
}

export function sortNotes (notes: Note[], key?: string): Note[] {
  const out = notes.slice()
  out.sort((a, b) => {
    if (undefined !== key && '' !== key) {
      const av = (a as unknown as Record<string, unknown>)[key]
      const bv = (b as unknown as Record<string, unknown>)[key]
      const c = compareField(av, bv)
      if (0 !== c) return c
    }
    // updated descending
    const u = compareCodePoints(a.updated, b.updated)
    if (0 !== u) return -u
    // lid ascending
    return compareCodePoints(a.lid, b.lid)
  })
  return out
}

/* Type precedence for the primary comparison, so that a requested key which is
 * absent in one row and present in another still yields a total order. ABSENT
 * SORTS AFTER NULL, AND NEITHER INVERTS UNDER A DESCENDING SORT - which is
 * arbitrary, and an arbitrary rule written down beats a natural-looking one
 * that differs per port.
 */
function rank (v: unknown): number {
  if (undefined === v) return 4
  if (null === v) return 3
  if ('boolean' === typeof v) return 0
  if ('number' === typeof v) return 1
  if ('string' === typeof v) return 2
  return 5
}

function compareField (a: unknown, b: unknown): number {
  const ra = rank(a); const rb = rank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  if ('string' === typeof a && 'string' === typeof b) return compareCodePoints(a, b)
  if ('number' === typeof a && 'number' === typeof b) return a === b ? 0 : (a < b ? -1 : 1)
  if ('boolean' === typeof a && 'boolean' === typeof b) return a === b ? 0 : (a ? 1 : -1)
  return 0
}
