/* The common entity shape, as the envelope carries it.
 *
 * A projection loses things, so the rules are in the shape rather than left to
 * an adapter's judgement: `raw` is a STRING carrying the source payload
 * verbatim, `version` is absent where a source has no concurrency token rather
 * than invented, and `tags` is absent where the adapter did not fetch them
 * rather than reported as empty.
 */

package likeness

import "sort"

// Note is the projected entity. Every pointer and slice field here is optional
// in the envelope: nil means ABSENT, and absent is not the same answer as
// empty.
type Note struct {
	Lid      string
	Source   string
	Instance string
	ID       string
	Title    string
	Body     *string
	Space    *string
	// Absent means NOT FETCHED, an empty slice means fetched and empty. An
	// adapter that does not read tag associations leaves this nil.
	Tags    []string
	Status  *string
	State   *string
	URL     string
	Created string
	Updated string
	Version *string
	Raw     *string
}

// Value renders the note as the envelope's own value model, omitting every
// absent field. Building a map by hand rather than tagging a struct is
// deliberate: `omitempty` cannot tell an empty list from a missing one, which
// is the exact distinction this shape exists to keep.
func (n Note) Value() map[string]any {
	m := map[string]any{
		"lid":      n.Lid,
		"source":   n.Source,
		"instance": n.Instance,
		"id":       n.ID,
		"title":    n.Title,
		"url":      n.URL,
		"created":  n.Created,
		"updated":  n.Updated,
	}
	if nil != n.Body {
		m["body"] = *n.Body
	}
	if nil != n.Space {
		m["space"] = *n.Space
	}
	if nil != n.Tags {
		tags := make([]any, len(n.Tags))
		for i, t := range n.Tags {
			tags[i] = t
		}
		m["tags"] = tags
	}
	if nil != n.Status {
		m["status"] = *n.Status
	}
	if nil != n.State {
		m["state"] = *n.State
	}
	if nil != n.Version {
		m["version"] = *n.Version
	}
	if nil != n.Raw {
		m["raw"] = *n.Raw
	}
	return m
}

/* The total sort order (SPEC 14.2), written out rather than inherited.
 *
 * Requested key, then `updated` DESCENDING, then `lid` ASCENDING. The
 * tiebreakers are what make concurrent fetches unobservable in the output and
 * the byte diff possible at all: a key plus two tiebreakers is not a total
 * order while the primary comparison is undefined.
 *
 * sort.SliceStable is not enough on its own - a stable sort preserves the
 * order notes arrived in, which is fetch order, which is exactly the thing
 * that must not reach stdout.
 */
func SortNotes(notes []Note, key string) []Note {
	out := make([]Note, len(notes))
	copy(out, notes)

	// The key is read through Value(), which omits absent fields. That is what
	// makes "the note has no such field" and "the note has that field set to
	// something" distinguishable here, exactly as in the canonical port.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if "" != key {
			if c := compareField(fieldOf(a, key), fieldOf(b, key)); 0 != c {
				return c < 0
			}
		}
		// updated DESCENDING
		if c := CompareCodePoints(a.Updated, b.Updated); 0 != c {
			return 0 < c
		}
		// lid ASCENDING
		return CompareCodePoints(a.Lid, b.Lid) < 0
	})
	return out
}

// fieldOf reads one field of a note by name, or reports it absent.
func fieldOf(n Note, key string) any {
	if v, ok := n.Value()[key]; ok {
		return v
	}
	return absent{}
}

// absent is the "this note has no such field" marker. A distinct type rather
// than nil, because nil is the JSON null that a field may legitimately hold,
// and the two sort differently on purpose.
type absent struct{}

/*
Type precedence for the primary comparison, so that a requested key which is
absent in one row and present in another still yields a total order. ABSENT
SORTS AFTER NULL, AND NEITHER INVERTS UNDER A DESCENDING SORT - which is
arbitrary, and an arbitrary rule written down beats a natural-looking one that
differs per port.
*/
func rank(v any) int {
	switch v.(type) {
	case absent:
		return 4
	case nil:
		return 3
	case bool:
		return 0
	case int, int64, float64:
		return 1
	case string:
		return 2
	}
	return 5
}

func compareField(a, b any) int {
	ra, rb := rank(a), rank(b)
	if ra != rb {
		if ra < rb {
			return -1
		}
		return 1
	}
	if as, ok := a.(string); ok {
		if bs, ok := b.(string); ok {
			return CompareCodePoints(as, bs)
		}
	}
	if ab, ok := a.(bool); ok {
		if bb, ok := b.(bool); ok {
			switch {
			case ab == bb:
				return 0
			case ab:
				return 1
			}
			return -1
		}
	}
	an, aok := asFloat(a)
	bn, bok := asFloat(b)
	if aok && bok {
		switch {
		case an == bn:
			return 0
		case an < bn:
			return -1
		}
		return 1
	}
	return 0
}

func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}
