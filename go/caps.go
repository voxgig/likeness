package likeness

import (
	_ "embed"
	"encoding/json"
	"sort"
	"sync"
)

//go:embed spec/caps.json
var capsJSON []byte

// SourceLimit is the `limit` block of one source's capability row.
type SourceLimit struct {
	PageMax      int    `json:"page_max"`
	Rate         int    `json:"rate"`
	Search       string `json:"search"`
	Body         string `json:"body"`
	VersionToken bool   `json:"version_token"`
}

type EntityCaps struct {
	Kind string         `json:"kind"`
	SDK  string         `json:"sdk"`
	Term string         `json:"term"`
	Op   map[string]any `json:"op"`
}

type ConnectAccount struct {
	Term     string  `json:"term"`
	Discover bool    `json:"discover"`
	Why      *string `json:"why"`
}

// Connect is how `sources add` connects a source.
type Connect struct {
	Default map[string]string `json:"default"`
	Flag    []string          `json:"flag"`
	Account ConnectAccount    `json:"account"`
}

// SourceCaps is one source's row.
type SourceCaps struct {
	Name    string                `json:"name"`
	Limit   SourceLimit           `json:"limit"`
	Entity  map[string]EntityCaps `json:"entity"`
	Connect Connect               `json:"connect"`
}

var (
	capsOnce sync.Once
	capsData map[string]SourceCaps
	capsErr  error
)

// Caps returns the matrix, loading it once.
func Caps() (map[string]SourceCaps, error) {
	capsOnce.Do(func() {
		var doc struct {
			Capability map[string]SourceCaps `json:"capability"`
		}
		if err := json.Unmarshal(capsJSON, &doc); nil != err {
			capsErr = err
			return
		}
		capsData = doc.Capability
	})
	return capsData, capsErr
}

/*
PageMax is the largest page a source will return. Zero means "not declared",
which the caller must treat as "cannot tell", never as "no limit".
*/
func PageMax(source string) int {
	c, err := Caps()
	if nil != err {
		return 0
	}
	return c[source].Limit.PageMax
}

// An operation is refused where it is false or absent, and offered otherwise.
func supports(source, entity, op string) bool {
	c, err := Caps()
	if nil != err {
		return false
	}
	v, ok := c[source].Entity[entity].Op[op]
	return ok && false != v
}

func termOf(source, entity string) string {
	c, _ := Caps()
	if e, ok := c[source].Entity[entity]; ok && "" != e.Term {
		return e.Term
	}
	return entity
}

// connectOf is how `sources add` connects a source, or false for one not registered.
func connectOf(source string) (*Connect, bool) {
	c, err := Caps()
	if nil != err {
		return nil, false
	}
	row, ok := c[source]
	return &row.Connect, ok
}

// sourceFlags is the flags of `sources add` that some source alone reads, in code-point order.
func sourceFlags() []string {
	c, _ := Caps()
	seen := map[string]bool{}
	out := []string{}
	for _, row := range c {
		for _, f := range row.Connect.Flag {
			if !seen[f] {
				seen[f] = true
				out = append(out, f)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return CompareCodePoints(out[i], out[j]) < 0 })
	return out
}
