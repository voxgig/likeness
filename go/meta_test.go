/* The meta-tests: proof that this port's harness goes red.
 *
 * A HARNESS NOBODY HAS SEEN FAIL MIGHT BE REPORTING NOTHING AT ALL. Every one
 * of these takes an entry that passes, breaks exactly one thing about what is
 * expected of it, and requires the harness to say so.
 *
 * Each port needs its own copy. That is not duplication for its own sake: a
 * port's corpus result means nothing until its runner has been seen to fail,
 * and the runners are five separate pieces of code.
 */

package likeness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func entryByID(t *testing.T, root, id string) map[string]any {
	t.Helper()
	for _, e := range corpusEntries(t, root, "cli") {
		if id == str(e, "id") {
			// A deep copy, so a mutation here cannot leak into the real runner.
			b, err := json.Marshal(e)
			if nil != err {
				t.Fatal(err)
			}
			dec := json.NewDecoder(strings.NewReader(string(b)))
			dec.UseNumber()
			var out map[string]any
			if err := dec.Decode(&out); nil != err {
				t.Fatal(err)
			}
			return out
		}
	}
	t.Fatalf("no corpus entry with id %s", id)
	return nil
}

func outOf(e map[string]any) map[string]any {
	m, _ := e["out"].(map[string]any)
	return m
}

func anyStarts(fs []string, prefix string) bool {
	for _, f := range fs {
		if strings.HasPrefix(f, prefix) {
			return true
		}
	}
	return false
}

/*
The control. If this ever fails, every test below is meaningless: a harness
that reports failures for a correct entry proves nothing by reporting them for
a broken one.
*/
func TestMetaUnmutatedEntryPasses(t *testing.T) {
	root := Root(t)
	if f := Check(t, root, entryByID(t, root, "list/all")); 0 < len(f) {
		t.Fatalf("the control entry failed: %v", f)
	}
}

func TestMetaWrongExitCodeIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["exit"] = json.Number("3")
	if f := Check(t, root, e); !anyStarts(f, "exit ") {
		t.Fatalf("no exit failure in %v", f)
	}
}

func TestMetaOneByteOfStdoutIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")

	real := filepath.Join(root, str(outOf(e), "stdout"))
	raw, err := os.ReadFile(real)
	if nil != err {
		t.Fatal(err)
	}
	// One character of one title, changed. Not a different file and not a
	// reordering: the smallest difference the contract claims to catch.
	text := strings.Replace(string(raw), "Retention", "Retentiom", 1)
	if strings.Contains(text, "Retention policy") {
		t.Fatal("the mutation did not apply")
	}

	rel := "spec/expect/.meta-go-one-byte.json"
	tmp := filepath.Join(root, rel)
	if err := os.WriteFile(tmp, []byte(text), 0o644); nil != err {
		t.Fatal(err)
	}
	defer os.Remove(tmp)

	outOf(e)["stdout"] = rel
	if f := Check(t, root, e); !anyStarts(f, "stdout differs") {
		t.Fatalf("no stdout failure in %v", f)
	}
}

func TestMetaMissingCallIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["calls"] = []any{}
	if f := Check(t, root, e); !anyStarts(f, "calls ") {
		t.Fatalf("no calls failure in %v", f)
	}
}

/*
The failure that matters most: a command producing the right answer by making
more requests than it should. An entry asserting only stdout would pass for it.
*/
func TestMetaExtraCallIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	cs, _ := outOf(e)["calls"].([]any)
	outOf(e)["calls"] = append(cs, map[string]any{
		"instance": "jot", "method": "GET", "path": "/notes",
	})
	if f := Check(t, root, e); !anyStarts(f, "calls ") {
		t.Fatalf("no calls failure in %v", f)
	}
}

func TestMetaWrongCallPathIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["calls"] = []any{map[string]any{
		"instance": "jot", "method": "GET", "path": "/folders",
	}}
	if f := Check(t, root, e); !anyStarts(f, "calls ") {
		t.Fatalf("no calls failure in %v", f)
	}
}

func TestMetaUnexpectedStderrIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["stderr"] = "something the command never printed\n"
	if f := Check(t, root, e); !anyStarts(f, "stderr ") {
		t.Fatalf("no stderr failure in %v", f)
	}
}

// The harness does not short-circuit. Seeing all of them at once is the
// difference between one fix and four rounds.
func TestMetaEveryFailureIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["exit"] = json.Number("3")
	outOf(e)["calls"] = []any{}
	outOf(e)["stderr"] = "no\n"
	if f := Check(t, root, e); 3 != len(f) {
		t.Fatalf("expected three failures, got %v", f)
	}
}

func TestMetaMissingExpectationFileIsReported(t *testing.T) {
	// A path that does not exist must not read as "nothing to compare".
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["stdout"] = "spec/expect/.meta-go-does-not-exist.json"
	if f := Check(t, root, e); !anyStarts(f, "cannot read expectation") {
		t.Fatalf("no missing-expectation failure in %v", f)
	}
}

/*
The netsim guard.

The generated SDK accepts int and float64 for a `net` option and SILENTLY
IGNORES a json.Number, so a `failTimes` set that way does nothing and a request
that should fail succeeds. Two transcript entries caught it once; this states
it directly, so a regression in the normalisation is reported here rather than
as a puzzling `doctor` diff.
*/
func TestMetaNetOptionsReachTheSdk(t *testing.T) {
	seed := map[string]any{
		"entity": map[string]any{"note": map[string]any{"x1": map[string]any{"id": "x1"}}},
		"net":    numbersToInt(mustDecode(t, `{"failTimes":1,"failStatus":401}`)),
	}
	calls := &Calls{}
	ok, code, _ := JoplinCheck(SourceOpts{Instance: "x", Account: "a", Seed: seed}, calls)
	if ok || "auth-failed" != code {
		t.Fatalf("net.failStatus did not reach the SDK: ok=%v code=%q", ok, code)
	}
}

func mustDecode(t *testing.T, s string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); nil != err {
		t.Fatal(err)
	}
	return m
}
