package likeness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
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

func TestMetaWrongVaultNamesAreReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "secrets/remove")
	vault := e["out"].(map[string]any)["vault"].(map[string]any)
	vault["names"] = []any{"joplin.apikey", "notion.apikey"}
	if f := Check(t, root, e); !anyStarts(f, "vault names ") {
		t.Fatalf("no vault failure in %v", f)
	}
}

func TestMetaWrongVaultValueIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "secrets/set-from-stdin")
	vault := e["out"].(map[string]any)["vault"].(map[string]any)
	vault["values"] = map[string]any{"joplin.apikey": "rotated-token\n"}
	if f := Check(t, root, e); !anyStarts(f, "vault value of ") {
		t.Fatalf("no value failure in %v", f)
	}
}

func TestMetaUnexpectedPromptIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "secrets/passphrase-typed")
	e["out"].(map[string]any)["prompts"] = []any{}
	if f := Check(t, root, e); !anyStarts(f, "prompts ") {
		t.Fatalf("no prompt failure in %v", f)
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
The bytes are the contract. These feed the stdout check output no port
produced: the right values in the wrong form. Before this check existed the
harness parsed stdout and re-rendered it, so every one of these passed.
*/
func stdoutFailures(t *testing.T, root string, e map[string]any, actual string) []string {
	t.Helper()
	failures := []string{}
	checkStdout(t, root, str(outOf(e), "stdout"), actual, nil, func(s string) { failures = append(failures, s) })
	return failures
}

func TestMetaIndentedStdoutIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	r := Run(buildCtx(t, root, e))
	var parsed any
	if err := json.Unmarshal([]byte(r.Stdout), &parsed); nil != err {
		t.Fatal(err)
	}
	indented, err := json.MarshalIndent(parsed, "", "  ")
	if nil != err {
		t.Fatal(err)
	}
	if f := stdoutFailures(t, root, e, string(indented)+"\n"); !anyStarts(f, "stdout is not in canonical form") {
		t.Fatalf("not reported: %v", f)
	}
}

func TestMetaCRLFStdoutIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	r := Run(buildCtx(t, root, e))
	crlf := strings.TrimSuffix(r.Stdout, "\n") + "\r\n"
	if f := stdoutFailures(t, root, e, crlf); !anyStarts(f, "stdout is not in canonical form") {
		t.Fatalf("not reported: %v", f)
	}
}

func TestMetaWrongPortInsideWhichRowIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "meta/which")
	r := Run(buildCtx(t, root, e))
	parsed := mustDecode(t, r.Stdout)
	rows, _ := parsed["data"].([]any)
	if 0 == len(rows) {
		t.Fatal("which produced no rows")
	}
	rows[0].(map[string]any)["port"] = "WRONG"
	actual, err := Serialise(parsed)
	if nil != err {
		t.Fatal(err)
	}
	if f := stdoutFailures(t, root, e, actual); !anyStarts(f, "stdout differs") {
		t.Fatalf("not reported: %v", f)
	}
}

func TestMetaVersionReportingAnotherPortIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "meta/version")
	r := Run(buildCtx(t, root, e))
	parsed := mustDecode(t, r.Stdout)
	parsed["data"].(map[string]any)["port"] = "WRONG"
	actual, err := Serialise(parsed)
	if nil != err {
		t.Fatal(err)
	}
	if f := stdoutFailures(t, root, e, actual); !anyStarts(f, "data.port is") {
		t.Fatalf("not reported: %v", f)
	}
}

func TestMetaNetOptionsReachTheSdk(t *testing.T) {
	seed := map[string]any{
		"entity": map[string]any{"note": map[string]any{"x1": map[string]any{"id": "x1"}}},
		"net":    mustDecode(t, `{"failTimes":1,"failStatus":401}`),
	}
	r := joplinAdapter{}.check(joplin.TestSDK(seed, nil))
	if r.OK || "auth-failed" != r.Code {
		t.Fatalf("net.failStatus did not reach the SDK: ok=%v code=%q", r.OK, r.Code)
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

func TestMetaWaitingEntryThatPassesIsReported(t *testing.T) {
	root := Root(t)
	why := notWaiting(t, root, entryByID(t, root, "list/all"), []cause{decodedPaths})
	if !strings.HasPrefix(why, "list/all now passes: take it out of WAITING") {
		t.Fatalf("not reported: %q", why)
	}
}

// A call path differing as escaped text decodes, which is what decodedPaths
// declares, waits; one differing otherwise does not.
func TestMetaWaitingCallPathIsHeldToItsCause(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["calls"].([]any)[0].(map[string]any)["path"] = "/no%74es"
	if why := notWaiting(t, root, e, []cause{decodedPaths}); "" != why {
		t.Fatalf("a difference the cause predicts was not accepted: %s", why)
	}
	outOf(e)["calls"].([]any)[0].(map[string]any)["path"] = "/folders"
	if why := notWaiting(t, root, e, []cause{decodedPaths}); !strings.Contains(why, "differs other than because") {
		t.Fatalf("a difference the cause does not predict was not reported: %q", why)
	}
}

// A null list element in a raw payload, which droppedNulls declares, waits;
// declared under another cause it does not.
func TestMetaWaitingStdoutIsHeldToItsCause(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "obsidian/get-raw")
	raw, err := os.ReadFile(filepath.Join(root, str(outOf(e), "stdout")))
	if nil != err {
		t.Fatal(err)
	}
	text := strings.Replace(string(raw), `\"tags\":[\"start\"]`, `\"tags\":[\"start\",null]`, 1)
	if text == string(raw) {
		t.Fatal("the mutation did not apply")
	}
	rel := "spec/expect/.meta-go-waiting-null.json"
	tmp := filepath.Join(root, rel)
	if err := os.WriteFile(tmp, []byte(text), 0o644); nil != err {
		t.Fatal(err)
	}
	defer os.Remove(tmp)
	outOf(e)["stdout"] = rel

	if why := notWaiting(t, root, e, []cause{droppedNulls}); "" != why {
		t.Fatalf("a difference the cause predicts was not accepted: %s", why)
	}
	if why := notWaiting(t, root, e, []cause{decodedPaths}); !strings.Contains(why, "differs other than because") {
		t.Fatalf("a difference the cause does not predict was not reported: %q", why)
	}
}

func TestMetaWrittenFileThatDiffersIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "connections/add-joplin")
	outOf(e)["files"].(map[string]any)["station.json"] = "fixtures/config/several/station.json"
	if f := Check(t, root, e); !anyStarts(f, "station.json differs") {
		t.Fatalf("no file failure in %v", f)
	}
}

func TestMetaFileSaidAbsentAndWrittenIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "connections/add-joplin")
	outOf(e)["absent"] = []any{"likeness.json"}
	if f := Check(t, root, e); !anyStarts(f, "likeness.json is there afterwards") {
		t.Fatalf("no absence failure in %v", f)
	}
}

func TestMetaFileNamedAndNeverWrittenIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "connections/add-joplin-needs-an-account")
	outOf(e)["files"] = map[string]any{"station.json": "spec/written/connections/add-joplin/station.json"}
	if f := Check(t, root, e); !anyStarts(f, "station.json is not there afterwards") {
		t.Fatalf("no missing-file failure in %v", f)
	}
}
