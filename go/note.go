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

type absent struct{}

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
