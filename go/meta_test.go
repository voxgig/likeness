package likeness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
	omni "github.com/voxgig/omni/go"
)

func entryByID(t *testing.T, root, id string) map[string]any {
	t.Helper()
	for _, e := range corpusEntries(t, root, "cli") {
		if id == str(e, "id") {
			// A deep copy, so a mutation here cannot leak into the real runner.
			out, err := cloneExact(e)
			if nil != err {
				t.Fatal(err)
			}
			return out.(map[string]any)
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

// sides is the expected and actual results of omni's one result mismatch.
func sides(t *testing.T, failures []string) (map[string]any, map[string]any) {
	t.Helper()
	if 1 != len(failures) {
		t.Fatalf("expected one failure, got %v", failures)
	}
	lines := strings.Split(failures[0], "\n")
	if !strings.HasSuffix(lines[0], ": result mismatch") {
		t.Fatalf("not a result mismatch: %s", failures[0])
	}
	found := map[string]string{}
	for _, ln := range lines[1:] {
		k, v, _ := strings.Cut(strings.TrimPrefix(ln, "  "), ":")
		found[k] = strings.TrimSpace(v)
	}
	return mustDecode(t, found["expected"]), mustDecode(t, found["actual"])
}

// differs is the fields the expected and actual results disagree on.
func differs(t *testing.T, failures []string) string {
	t.Helper()
	want, got := sides(t, failures)
	keys := map[string]any{}
	for k := range want {
		keys[k] = true
	}
	for k := range got {
		keys[k] = true
	}
	out := []string{}
	for _, k := range sortedKeys(keys) {
		if !reflect.DeepEqual(want[k], got[k]) {
			out = append(out, k)
		}
	}
	return strings.Join(out, " ")
}

func reports(t *testing.T, fields string, failures []string) {
	t.Helper()
	if got := differs(t, failures); fields != got {
		t.Fatalf("omni reports %q differing, expected %q:\n%s", got, fields, strings.Join(failures, "\n"))
	}
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
	reports(t, "exit", Check(t, root, e))
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
	reports(t, "stdout", Check(t, root, e))
}

func TestMetaWrongVaultNamesAreReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "secrets/remove")
	vault := e["out"].(map[string]any)["vault"].(map[string]any)
	vault["names"] = []any{"joplin.apikey", "notion.apikey"}
	reports(t, "vault", Check(t, root, e))
}

func TestMetaWrongVaultValueIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "secrets/set-from-stdin")
	vault := e["out"].(map[string]any)["vault"].(map[string]any)
	vault["values"] = map[string]any{"joplin.apikey": "rotated-token\n"}
	want, got := sides(t, Check(t, root, e))
	wv, gv := want["vault"].(map[string]any), got["vault"].(map[string]any)
	if !reflect.DeepEqual(wv["names"], gv["names"]) || reflect.DeepEqual(wv["values"], gv["values"]) {
		t.Fatalf("expected the values alone to differ: %v against %v", wv, gv)
	}
}

func TestMetaUnexpectedPromptIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "secrets/passphrase-typed")
	e["out"].(map[string]any)["prompts"] = []any{}
	reports(t, "prompts", Check(t, root, e))
}

func TestMetaMissingCallIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["calls"] = []any{}
	reports(t, "calls", Check(t, root, e))
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
	reports(t, "calls", Check(t, root, e))
}

func TestMetaWrongCallPathIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["calls"] = []any{map[string]any{
		"instance": "jot", "method": "GET", "path": "/folders",
	}}
	reports(t, "calls", Check(t, root, e))
}

func TestMetaUnexpectedStderrIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["stderr"] = "something the command never printed\n"
	reports(t, "stderr", Check(t, root, e))
}

func TestMetaEveryFailureIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["exit"] = json.Number("3")
	outOf(e)["calls"] = []any{}
	outOf(e)["stderr"] = "no\n"
	reports(t, "calls exit stderr", Check(t, root, e))
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
	rel := str(outOf(e), "stdout")
	want, err := expectation(root, rel)
	if nil != err {
		t.Fatal(err)
	}
	if seenStdout(strings.HasSuffix(rel, ".json"), actual, func(s string) { failures = append(failures, s) }) != want {
		failures = append(failures, "stdout differs from "+rel)
	}
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

func checkPredicted(t *testing.T, root string, e map[string]any, causes []cause) []string {
	t.Helper()
	r, err := predicted(root, e, causes)
	if nil != err {
		t.Fatal(err)
	}
	return checkFlags(t, root, r, omni.Flags{"null": false})
}

func checkHeld(t *testing.T, root string, e map[string]any, causes []cause) []string {
	t.Helper()
	r, err := resolved(root, e)
	if nil != err {
		t.Fatal(err)
	}
	return checkFlags(t, root, r, omni.Flags{"null": false, "wait": map[string]any{str(e, "id"): waitFor(causes)}})
}

func TestMetaWaitingEntryThatPassesIsReported(t *testing.T) {
	root := Root(t)
	f := checkHeld(t, root, entryByID(t, root, "list/all"), []cause{decodedPaths})
	if 1 != len(f) || !strings.Contains(f[0], "(list/all): stale wait: "+decodedPaths.reason) {
		t.Fatalf("not reported: %v", f)
	}
}

// A call path differing as escaped text decodes, which is what decodedPaths
// declares, waits; one differing otherwise does not.
func TestMetaWaitingCallPathIsHeldToItsCause(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "list/all")
	outOf(e)["calls"].([]any)[0].(map[string]any)["path"] = "/no%74es"
	if f := checkHeld(t, root, e, []cause{decodedPaths}); 0 < len(f) {
		t.Fatalf("a failing entry was not held: %v", f)
	}
	if f := checkPredicted(t, root, e, []cause{decodedPaths}); 0 < len(f) {
		t.Fatalf("a difference the cause predicts was not accepted: %v", f)
	}
	outOf(e)["calls"].([]any)[0].(map[string]any)["path"] = "/folders"
	reports(t, "calls", checkPredicted(t, root, e, []cause{decodedPaths}))
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

	if f := checkPredicted(t, root, e, []cause{droppedNulls}); 0 < len(f) {
		t.Fatalf("a difference the cause predicts was not accepted: %v", f)
	}
	reports(t, "stdout", checkPredicted(t, root, e, []cause{decodedPaths}))
}

func TestMetaWrittenFileThatDiffersIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "connections/add-joplin")
	outOf(e)["files"].(map[string]any)["station.json"] = "fixtures/config/several/station.json"
	f := Check(t, root, e)
	reports(t, "files", f)
	want, got := sides(t, f)
	if reflect.DeepEqual(want["files"].(map[string]any)["station.json"], got["files"].(map[string]any)["station.json"]) {
		t.Fatalf("station.json is not the file reported differing: %v", f)
	}
}

func TestMetaFileSaidAbsentAndWrittenIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "connections/add-joplin")
	outOf(e)["absent"] = []any{"likeness.json"}
	f := Check(t, root, e)
	reports(t, "absent", f)
	if want, got := sides(t, f); !reflect.DeepEqual([]any{"likeness.json"}, want["absent"]) || reflect.DeepEqual(want["absent"], got["absent"]) {
		t.Fatalf("likeness.json is not the name reported there: %v", f)
	}
}

func TestMetaFileNamedAndNeverWrittenIsReported(t *testing.T) {
	root := Root(t)
	e := entryByID(t, root, "connections/add-joplin-needs-an-account")
	outOf(e)["files"] = map[string]any{"station.json": "spec/written/connections/add-joplin/station.json"}
	want, got := sides(t, Check(t, root, e))
	if nil == want["files"].(map[string]any)["station.json"] || nil != got["files"].(map[string]any)["station.json"] {
		t.Fatalf("station.json is not reported missing: %v against %v", want["files"], got["files"])
	}
}
