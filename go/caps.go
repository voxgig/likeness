package likeness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// SourceLimit is the `limit` block of one source's capability row.
type SourceLimit struct {
	PageMax      int    `json:"page_max"`
	Rate         int    `json:"rate"`
	Search       string `json:"search"`
	Body         string `json:"body"`
	VersionToken bool   `json:"version_token"`
}

// SourceCaps is one source's row.
type SourceCaps struct {
	Name  string      `json:"name"`
	Limit SourceLimit `json:"limit"`
}

var (
	capsOnce sync.Once
	capsData map[string]SourceCaps
	capsErr  error
)

// Caps returns the matrix, loading it once.
func Caps() (map[string]SourceCaps, error) {
	capsOnce.Do(func() {
		dir, err := specDir()
		if nil != err {
			capsErr = err
			return
		}
		raw, err := os.ReadFile(filepath.Join(dir, "caps.json"))
		if nil != err {
			capsErr = err
			return
		}
		var doc struct {
			Capability map[string]SourceCaps `json:"capability"`
		}
		if err := json.Unmarshal(raw, &doc); nil != err {
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
