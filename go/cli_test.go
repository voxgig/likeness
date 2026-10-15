package likeness

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A cause is an upstream fault an entry waits on, and how the entry's
// expectation reads while it stands: an expected call path, the expected
// stdout, or both.
type cause struct {
	reason string
	path   func(string) string
	stdout func(string) string
}

var decodedPaths = cause{
	reason: "voxgig/station#50: station's Go library records an http event's path decoded, " +
		"where its other ports keep the path as sent",
	path: func(p string) string {
		if decoded, err := url.PathUnescape(p); nil == err {
			return decoded
		}
		return p
	},
}

var droppedNulls = cause{
	reason: "voxgig/sdkgen#418: the struct library the Go SDKs vendor drops a null list element in merge, " +
		"so a record the SDK hands back has lost the nulls in its lists",
	stdout: withoutNullElements,
}

// Entries this port cannot answer yet, each with the causes it waits on. Each
// is reported as skipped once it differs from its expectation only as its
// causes predict; one that passes outright fails until it is taken out of here.
var WAITING = map[string][]cause{
	"obsidian/get-one":                        {decodedPaths},
	"obsidian/list-by-tag":                    {decodedPaths},
	"obsidian/list-human":                     {decodedPaths},
	"obsidian/list-odd-raw":                   {decodedPaths, droppedNulls},
	"obsidian/list-odd-values":                {decodedPaths},
	"obsidian/list-walks-the-vault":           {decodedPaths},
	"sources/list-across-three-sources":       {decodedPaths},
	"sources/list-across-three-sources-human": {decodedPaths},
}

// withoutNullElements is an expected envelope whose notes' raw payloads have
// lost every null list element.
func withoutNullElements(stdout string) string {
	dec := json.NewDecoder(strings.NewReader(stdout))
	dec.UseNumber()
	var env map[string]any
	if err := dec.Decode(&env); nil != err {
		return stdout
	}
	rows, _ := env["data"].([]any)
	for _, r := range rows {
		note, _ := r.(map[string]any)
		raw, ok := note["raw"].(string)
		if !ok {
			continue
		}
		pd := json.NewDecoder(strings.NewReader(raw))
		pd.UseNumber()
		var payload any
		if err := pd.Decode(&payload); nil != err {
			continue
		}
		if s, err := RenderRaw(dropNullElements(payload)); nil == err {
			note["raw"] = s
		}
	}
	out, err := Serialise(env)
	if nil != err {
		return stdout
	}
	return out
}

func dropNullElements(v any) any {
	switch n := v.(type) {
	case []any:
		out := []any{}
		for _, e := range n {
			if nil != e {
				out = append(out, dropNullElements(e))
			}
		}
		return out
	case map[string]any:
		for k, e := range n {
			n[k] = dropNullElements(e)
		}
	}
	return v
}

// predicted is the entry as its causes have it, and its expected stdout likewise.
func predicted(t *testing.T, e map[string]any, causes []cause) (map[string]any, func(string) string) {
	t.Helper()
	raw, err := json.Marshal(e)
	if nil != err {
		t.Fatal(err)
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var out map[string]any
	if err := dec.Decode(&out); nil != err {
		t.Fatal(err)
	}
	calls, _ := outOf(out)["calls"].([]any)
	for _, c := range causes {
		if nil == c.path {
			continue
		}
		for _, call := range calls {
			m := call.(map[string]any)
			m["path"] = c.path(str(m, "path"))
		}
	}
	return out, func(want string) string {
		for _, c := range causes {
			if nil != c.stdout {
				want = c.stdout(want)
			}
		}
		return want
	}
}

// notWaiting is why an entry is not waiting as its causes declare, or "":
// one that passes outright, or differs other than as they predict, is not.
func notWaiting(t *testing.T, root string, e map[string]any, causes []cause) string {
	t.Helper()
	id := str(e, "id")
	if 0 == len(Check(t, root, e)) {
		return id + " now passes: take it out of WAITING"
	}
	entry, predict := predicted(t, e, causes)
	if f := checkWith(t, root, entry, predict); 0 < len(f) {
		return id + " differs other than because " + reasons(causes) + ":\n  " + strings.Join(f, "\n  ")
	}
	return ""
}

func reasons(causes []cause) string {
	out := []string{}
	for _, c := range causes {
		out = append(out, c.reason)
	}
	return strings.Join(out, "; ")
}

func TestCliCorpus(t *testing.T) {
	root := Root(t)
	all := corpusEntries(t, root, "cli")
	if 0 == len(all) {
		t.Fatal("spec/cli.json has no entries - did `make spec-build` run?")
	}

	seen := map[string]bool{}
	for _, e := range all {
		id := str(e, "id")
		if seen[id] {
			t.Errorf("duplicate corpus id: %s", id)
		}
		seen[id] = true

		t.Run(id, func(t *testing.T) {
			causes, waits := WAITING[id]
			if !waits {
				if f := Check(t, root, e); 0 < len(f) {
					t.Fatalf("%s:\n  %s", id, strings.Join(f, "\n  "))
				}
				return
			}
			if why := notWaiting(t, root, e, causes); "" != why {
				t.Fatal(why)
			}
			t.Skip(reasons(causes))
		})
	}
}

func TestEveryEntryWaitingUpstreamIsInTheCorpus(t *testing.T) {
	root := Root(t)
	known := map[string]bool{}
	for _, e := range corpusEntries(t, root, "cli") {
		known[str(e, "id")] = true
	}
	for id := range WAITING {
		if !known[id] {
			t.Errorf("WAITING names %s, which is not in the corpus", id)
		}
	}
}

func TestNoUnreferencedExpectations(t *testing.T) {
	root := Root(t)
	used := map[string]bool{}
	for _, e := range corpusEntries(t, root, "cli") {
		out, _ := e["out"].(map[string]any)
		used[str(out, "stdout")] = true
	}

	base := filepath.Join(root, "spec", "expect")
	err := filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if nil != err {
			return err
		}
		if info.IsDir() || strings.HasPrefix(info.Name(), ".") {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if !used[rel] {
			t.Errorf("expectation file no entry refers to: %s", rel)
		}
		return nil
	})
	if nil != err {
		t.Fatal(err)
	}
}
