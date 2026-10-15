package likeness

import (
	"errors"

	"github.com/voxgig/station/go/station"
)

// An empty Code or Remedy is absent from the doctor row.
type checkResult struct {
	OK     bool
	Code   string
	Detail string
	Remedy string
}

// The handle connect returns is the adapter's own; the core passes it back
// and never looks inside it.
type adapter interface {
	source() string
	supplies() []string
	connect(st *station.Station, conn Connection, config any, seed map[string]any) any
	check(handle any) checkResult
}

// What an adapter offers only where its source can.
type (
	configurer interface {
		configure(instance string, block map[string]any) (any, error)
	}
	lister interface {
		listNotes(handle any, conn Connection, withRaw bool) ([]Note, bool, error)
	}
	loader interface {
		loadNote(handle any, conn Connection, id string, withRaw bool) (*Note, error)
	}
)

var adapters = bySource(joplinAdapter{})

func bySource(all ...adapter) map[string]adapter {
	out := map[string]adapter{}
	for _, a := range all {
		out[a.source()] = a
	}
	return out
}

func adapterFor(c Connection) (adapter, bool) {
	a, ok := adapters[c.Source]
	return a, ok
}

// statusOf is the HTTP status a generated SDK's error carries, read from the
// cleaned record every generated error type gives, or 0 where there is none.
func statusOf(err error) int {
	var rec interface{ Record() map[string]any }
	if !errors.As(err, &rec) {
		return 0
	}
	result, _ := rec.Record()["result"].(map[string]any)
	if n, ok := num(result["status"]); ok {
		return int(n)
	}
	return 0
}

func notFound(err error) bool { return 404 == statusOf(err) }

func dataOf(v any) any {
	if d, ok := v.(interface{ Data(...any) any }); ok {
		return d.Data()
	}
	return v
}

func isMap(v any) bool {
	_, ok := v.(map[string]any)
	return ok
}
