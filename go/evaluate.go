package likeness

import (
	"strconv"
	"strings"
	"time"
)

const dayMs = int64(86400000)

func durationMs(v *Value) int64 {
	switch v.Unit {
	case "d":
		return int64(v.N) * dayMs
	case "w":
		return int64(v.N) * 7 * dayMs
	case "mo":
		return int64(v.N) * 30 * dayMs
	case "y":
		return int64(v.N) * 365 * dayMs
	}
	return 0
}

func parseRfc3339(s string) (int64, bool) {
	t, err := time.Parse(time.RFC3339, s)
	if nil != err {
		return 0, false
	}
	return t.UnixMilli(), true
}

func resolveDate(v *Value, clockMs int64) (int64, bool) {
	if "date" == v.K {
		day := v.V
		switch v.V {
		case "today":
			day = time.UnixMilli(clockMs).UTC().Format("2006-01-02")
		case "yesterday":
			day = time.UnixMilli(clockMs - dayMs).UTC().Format("2006-01-02")
		}
		return parseRfc3339(day + "T00:00:00Z")
	}
	if "dur" == v.K {
		return clockMs - durationMs(v), true
	}
	return 0, false
}

func fieldValue(n Note, field string) (any, bool) {
	switch field {
	case "tag":
		if nil == n.Tags {
			return nil, false
		}
		return n.Tags, true
	case "space":
		if nil == n.Space {
			return nil, false
		}
		return *n.Space, true
	case "source":
		return n.Source, true
	case "instance":
		return n.Instance, true
	case "status":
		if nil == n.Status {
			return nil, false
		}
		return *n.Status, true
	case "state":
		if nil == n.State {
			return nil, false
		}
		return *n.State, true
	case "title":
		return n.Title, true
	case "body":
		if nil == n.Body {
			return nil, false
		}
		return *n.Body, true
	case "created":
		return n.Created, true
	case "updated":
		return n.Updated, true
	}
	return nil, false
}

func asText(v *Value) string {
	if "dur" == v.K {
		return strconv.Itoa(v.N) + v.Unit
	}
	return v.V
}

// Evaluate answers whether a note matches a selector, given the injected clock.
func Evaluate(node *Node, note Note, clockMs int64) bool {
	switch node.T {
	case "or":
		for _, k := range node.Kids {
			if Evaluate(k, note, clockMs) {
				return true
			}
		}
		return false
	case "and":
		for _, k := range node.Kids {
			if !Evaluate(k, note, clockMs) {
				return false
			}
		}
		return true
	case "not":
		return !Evaluate(node.Kid, note, clockMs)
	case "text":
		// A bareword with no field is full text. With no source-side search it
		// is a case-insensitive substring over title and body, and the
		// capability matrix says so rather than implying a relevance score
		// nobody computed.
		q := strings.ToLower(node.V)
		if strings.Contains(strings.ToLower(note.Title), q) {
			return true
		}
		return nil != note.Body && strings.Contains(strings.ToLower(*note.Body), q)
	}

	have, present := fieldValue(note, node.Field)
	want := node.Value

	for _, o := range OrderingOps {
		if o != node.Op {
			continue
		}
		s, ok := have.(string)
		if !present || !ok {
			return false
		}
		haveMs, ok := parseRfc3339(s)
		if !ok {
			return false
		}
		wantMs, ok := resolveDate(want, clockMs)
		if !ok {
			return false
		}
		switch node.Op {
		case ">":
			return wantMs < haveMs
		case ">=":
			return wantMs <= haveMs
		case "<":
			return haveMs < wantMs
		case "<=":
			return haveMs <= wantMs
		}
	}

	text := strings.ToLower(asText(want))
	eq := func(h any) bool {
		if !present || nil == h {
			return false
		}
		s, ok := h.(string)
		return ok && strings.ToLower(s) == text
	}

	if list, ok := have.([]string); present && ok {
		hit := false
		for _, x := range list {
			if strings.ToLower(x) == text {
				hit = true
				break
			}
		}
		if "!=" == node.Op {
			return !hit
		}
		return hit
	}
	if "=" == node.Op {
		return eq(have)
	}
	if "!=" == node.Op {
		return !eq(have)
	}
	// ':' is contains for free-text fields and equality for the rest, which is
	// what people mean by `title:retention` and by `status:done`.
	if "title" == node.Field || "body" == node.Field {
		if !present {
			return false
		}
		s, ok := have.(string)
		return ok && strings.Contains(strings.ToLower(s), text)
	}
	return eq(have)
}
