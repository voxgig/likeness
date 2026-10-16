package likeness

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	omni "github.com/voxgig/omni/go"
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

// Entries this port cannot answer yet, each with the causes it waits on. omni
// holds each while it fails and fails its group once it passes; each must also
// pass once its causes' predictions are applied.
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

// predicted is the entry resolved as its causes have it: each call path
// rewritten in the entry, and the expected stdout once resolved, since the
// entry names that only by path.
func predicted(root string, e map[string]any, causes []cause) (map[string]any, error) {
	copied, err := cloneExact(e)
	if nil != err {
		return nil, err
	}
	entry, _ := copied.(map[string]any)
	calls, _ := outOf(entry)["calls"].([]any)
	for _, c := range causes {
		if nil == c.path {
			continue
		}
		for _, call := range calls {
			m := call.(map[string]any)
			m["path"] = c.path(str(m, "path"))
		}
	}
	r, err := resolved(root, entry)
	if nil != err {
		return nil, err
	}
	want := outOf(r)
	for _, c := range causes {
		if nil != c.stdout {
			want["stdout"] = c.stdout(str(want, "stdout"))
		}
	}
	return r, nil
}

func reasons(causes []cause) string {
	out := []string{}
	for _, c := range causes {
		out = append(out, c.reason)
	}
	return strings.Join(out, "; ")
}

// waitFor is omni's wait declaration for an entry waiting on causes.
func waitFor(causes []cause) map[string]any {
	return map[string]any{"cause": reasons(causes)}
}

func TestCliCorpusIsNotEmpty(t *testing.T) {
	if 0 == len(corpusEntries(t, Root(t), "cli")) {
		t.Fatal("spec/cli.json has no entries - did `make spec-build` run?")
	}
}

func TestCliCorpusIdsAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, e := range corpusEntries(t, Root(t), "cli") {
		if id := str(e, "id"); seen[id] {
			t.Errorf("duplicate corpus id: %s", id)
		} else {
			seen[id] = true
		}
	}
}

func TestCliCorpus(t *testing.T) {
	root := Root(t)
	groups := corpusGroups(t, root, "cli")
	for _, name := range sortedKeys(groups) {
		t.Run(name, func(t *testing.T) {
			set := []any{}
			waits := map[string]any{}
			for _, raw := range groupSet(groups, name) {
				e := raw.(map[string]any)
				r, err := resolved(root, e)
				if nil != err {
					t.Fatal(err)
				}
				set = append(set, r)
				if causes, ok := WAITING[str(e, "id")]; ok {
					waits[str(e, "id")] = waitFor(causes)
				}
			}
			flags := omni.Flags{"null": false, "all": true, "wait": waits}
			if err := cliRun(t, root, name, set, flags); nil != err {
				t.Fatal(err)
			}
		})
	}
}

// A wait holds an entry only while it fails; this holds it to failing for its
// declared causes alone, so a declaration cannot hide a second difference.
func TestCliWaitingEntriesDifferOnlyAsTheirCausesPredict(t *testing.T) {
	root := Root(t)
	set := []any{}
	for _, e := range corpusEntries(t, root, "cli") {
		if causes, ok := WAITING[str(e, "id")]; ok {
			r, err := predicted(root, e, causes)
			if nil != err {
				t.Fatal(err)
			}
			set = append(set, r)
		}
	}
	if 0 == len(set) {
		t.Skip("no entry is waiting")
	}
	if err := cliRun(t, root, "predicted", set, omni.Flags{"null": false, "all": true}); nil != err {
		t.Fatal(err)
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
		files, _ := out["files"].(map[string]any)
		for _, f := range files {
			used[f.(string)] = true
		}
	}

	// spec/written holds the files a command writes, as spec/expect holds what it prints.
	for _, dir := range []string{"expect", "written"} {
		base := filepath.Join(root, "spec", dir)
		if !exists(base) {
			continue
		}
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
}
