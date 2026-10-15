package likeness

import (
	"errors"
	"sort"

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
	// The block `sources add` writes, from its base and the flags the source
	// reads, each its declared default when none was given.
	setupper interface {
		setup(instance string, given map[string]any, ask asker) (pairs, error)
	}
	// The account a connection reaches, where the capability data says it can be asked.
	accounter interface {
		account(handle any) (string, error)
	}
)

var adapters = bySource(joplinAdapter{}, notionAdapter{}, obsidianAdapter{})

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

const sourceBug = "this is a bug in the source or its SDK; run with --raw to capture the payload"

func refusedBlock(source, instance, what, remedy string) error {
	return &LikenessError{Code: "invalid-project",
		Msg: source + " connection \"" + instance + "\" " + what, Remedy: remedy}
}

// keysOf is a map's keys in code-point order.
func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return CompareCodePoints(out[i], out[j]) < 0 })
	return out
}

func otherKeys(m map[string]any, but string) []string {
	out := []string{}
	for _, k := range keysOf(m) {
		if but != k {
			out = append(out, k)
		}
	}
	return out
}
