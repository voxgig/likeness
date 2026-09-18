/* The corpus harness: the one place a corpus entry becomes a verdict.
 *
 * THE HARNESS IS ITSELF TESTED. meta_test.go mutates a passing entry - wrong
 * exit code, one byte of stdout, a missing call, an extra call - and requires
 * each mutation to be reported. A harness nobody has seen go red is a harness
 * that might be reporting nothing at all.
 *
 * `Check` RETURNS failures rather than failing the test, which is what makes
 * that possible.
 */

package likeness

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Root is the repository root, found the same way the registry is found.
func Root(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if nil != err {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "spec", "errors.json")); nil == err {
			return dir
		}
		up := filepath.Dir(dir)
		if up == dir {
			break
		}
		dir = up
	}
	t.Fatal("repository root not found - run `make spec-build` first")
	return ""
}

// corpusDoc reads spec/<name>.json with numbers kept EXACT. Decoding into
// float64 would turn an int64 corpus value into an approximation and a
// serialiser test into a coin toss.
func corpusDoc(t *testing.T, root, name string) map[string]any {
	t.Helper()
	f, err := os.Open(filepath.Join(root, "spec", name+".json"))
	if nil != err {
		t.Fatal(err)
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); nil != err {
		t.Fatal(err)
	}
	primary, _ := doc["primary"].(map[string]any)
	groups, _ := primary[name].(map[string]any)
	if nil == groups {
		t.Fatalf("spec/%s.json has no primary.%s", name, name)
	}
	return groups
}

// corpusEntries flattens the groups, sorted by group name so two runs report
// in the same order.
func corpusEntries(t *testing.T, root, name string) []map[string]any {
	t.Helper()
	groups := corpusDoc(t, root, name)
	names := make([]string, 0, len(groups))
	for k := range groups {
		names = append(names, k)
	}
	sort.Strings(names)
	out := []map[string]any{}
	for _, g := range names {
		set, _ := groups[g].(map[string]any)["set"].([]any)
		for _, e := range set {
			out = append(out, e.(map[string]any))
		}
	}
	return out
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func mustNum(t *testing.T, v any) int64 {
	t.Helper()
	n, ok := num(v)
	if !ok {
		t.Fatalf("not a number: %v (%T)", v, v)
	}
	return n
}

// canon renders any value through the port's own writer, so two structures can
// be compared as the bytes they would become. Comparing bytes rather than
// reflect.DeepEqual is the point: DeepEqual would call json.Number("1") and
// int64(1) different, and would call two maps with different key order equal.
func canon(t *testing.T, v any) string {
	t.Helper()
	s, err := Serialise(v)
	if nil != err {
		t.Fatalf("cannot serialise expected value %v: %v", v, err)
	}
	return s
}

func fmtCalls(cs []Call) string {
	out := "["
	for i, c := range cs {
		if 0 < i {
			out += " "
		}
		out += fmt.Sprintf("%s %s %s", c.Instance, c.Method, c.Path)
	}
	return out + "]"
}

// -- the transcript harness -------------------------------------------------

/*
buildCtx builds the runtime context from an entry's declared, impure inputs.

The seed handed to each connection is the fixture file plus that connection's
own `net` conditions. That is how "one source answered and the other is down"
is expressed without a network, a sleep, or a second fixture that has to be
kept in step with the first.
*/
func buildCtx(t *testing.T, root string, e map[string]any) Ctx {
	t.Helper()
	ectx, _ := e["ctx"].(map[string]any)

	f, err := os.Open(filepath.Join(root, "fixtures", "sources", str(ectx, "fixture"), "seed.json"))
	if nil != err {
		t.Fatal(err)
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	dec.UseNumber()
	var seed map[string]any
	if err := dec.Decode(&seed); nil != err {
		t.Fatal(err)
	}
	delete(seed, "_doc")

	ctx := Ctx{
		Argv:    strs(e["args"]),
		Clock:   str(ectx, "clock"),
		Fixture: map[string]map[string]any{},
	}
	if n, ok := num(ectx["seed"]); ok {
		ctx.Seed = int(n)
	}
	if env, ok := ectx["env"].(map[string]any); ok {
		ctx.Env = map[string]string{}
		for k, v := range env {
			ctx.Env[k], _ = v.(string)
		}
	}

	if ps, ok := ectx["path"].([]any); ok {
		// Absent stays absent: an entry that declares no PATH is asserting what
		// `which` does when it was told about nothing, which is a different
		// case from being told about an empty list.
		for _, p := range ps {
			pm, _ := p.(map[string]any)
			ctx.Path = append(ctx.Path, map[string]any{
				"path": str(pm, "path"), "port": str(pm, "port"), "version": str(pm, "version"),
			})
		}
	}

	conns, _ := ectx["connections"].([]any)
	for _, c := range conns {
		cm := c.(map[string]any)
		inst := str(cm, "instance")
		ctx.Connections = append(ctx.Connections, Connection{
			Instance: inst,
			Source:   str(cm, "source"),
			Account:  str(cm, "account"),
		})
		own := cloneMap(seed)
		if net, ok := cm["net"]; ok {
			// NUMBERS NORMALISED TO int FIRST. The corpus is decoded with
			// UseNumber so that large integers stay exact, but the generated
			// SDK's netsim accepts int and float64 and SILENTLY IGNORES a
			// json.Number: `failTimes` set that way does nothing, the request
			// succeeds, and an entry that believes it is exercising a failure
			// is exercising a success. Two transcript entries caught it, which
			// is the only reason it is not still there.
			//
			// Reported upstream; see upstream/. Normalising here rather than
			// dropping UseNumber keeps the exactness everything else needs.
			own["net"] = numbersToInt(net)
		}
		ctx.Fixture[inst] = own
	}
	return ctx
}

func strs(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, s := range list {
		x, _ := s.(string)
		out = append(out, x)
	}
	return out
}

// numbersToInt rewrites every json.Number in a value as an int, recursively.
func numbersToInt(v any) any {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); nil == err {
			return int(i)
		}
		f, err := t.Float64()
		if nil != err {
			return t
		}
		return f
	case map[string]any:
		out := map[string]any{}
		for k, e := range t {
			out[k] = numbersToInt(e)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = numbersToInt(e)
		}
		return out
	}
	return v
}

func cloneMap(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		if sub, ok := v.(map[string]any); ok {
			out[k] = cloneMap(sub)
			continue
		}
		out[k] = v
	}
	return out
}

/*
checkStdout compares stdout.

A `.json` expectation is an ENVELOPE: parsed, stripped of the declared
non-parity fields by name and recursively, and re-rendered before the byte
comparison, so that one committed file serves five ports. A `.txt` expectation
is human output, which carries no envelope and so is compared with no
transformation at all.

The stripping is not a hole in the serialiser's coverage: the unit corpus pins
Serialise against bytes no port produced. This compares CONTENT, given a writer
already proved correct.
*/
func checkStdout(t *testing.T, root, path, actual string, fail func(string)) {
	t.Helper()
	// A MISSING EXPECTATION IS A FAILURE, NOT AN EMPTY COMPARISON. Reported
	// rather than fatal, so that a meta-test can drive this path and see it
	// reported - which is the only evidence the check is here at all.
	raw, err := os.ReadFile(filepath.Join(root, path))
	if nil != err {
		fail("cannot read expectation " + path + ": " + err.Error())
		return
	}
	want := string(raw)

	if !strings.HasSuffix(path, ".json") {
		if actual != want {
			fail("stdout bytes differ from " + path)
		}
		return
	}

	dec := json.NewDecoder(strings.NewReader(actual))
	dec.UseNumber()
	var parsed map[string]any
	if err := dec.Decode(&parsed); nil != err {
		fail("stdout is not JSON, and " + path + " says it should be")
		return
	}

	// Removed from the comparison, so asserted here instead - otherwise a port
	// could report someone else's name and no check would notice.
	if p, _ := parsed["port"].(string); Port != p {
		fail("envelope port is \"" + p + "\", expected \"" + Port + "\"")
	}

	got, err := Serialise(StripParityExceptions(parsed))
	if nil != err {
		fail("stdout cannot be re-rendered: " + err.Error())
		return
	}
	if got != want {
		fail("stdout differs from " + path + "\n  want " + strings.TrimRight(want, "\n") +
			"\n  got  " + strings.TrimRight(got, "\n"))
	}
}

func wantCalls(e map[string]any) []Call {
	out, _ := e["out"].(map[string]any)
	list, _ := out["calls"].([]any)
	cs := make([]Call, 0, len(list))
	for _, c := range list {
		cm := c.(map[string]any)
		cs = append(cs, Call{str(cm, "instance"), str(cm, "method"), str(cm, "path")})
	}
	return cs
}

func sameCalls(want, got []Call) bool {
	if len(want) != len(got) {
		return false
	}
	for i := range want {
		if want[i] != got[i] {
			return false
		}
	}
	return true
}

/*
Check runs one transcript entry and returns every way it failed. An empty slice
is a pass; it is not short-circuited, because seeing all four failures at once
is the difference between one fix and four rounds.
*/
func Check(t *testing.T, root string, e map[string]any) []string {
	t.Helper()
	failures := []string{}
	fail := func(s string) { failures = append(failures, s) }

	out, _ := e["out"].(map[string]any)
	r := Run(buildCtx(t, root, e))

	if want := int(mustNum(t, out["exit"])); r.Exit != want {
		fail(fmt.Sprintf("exit %d, expected %d", r.Exit, want))
	}

	checkStdout(t, root, str(out, "stdout"), r.Stdout, fail)

	wantErr := ""
	if s, ok := out["stderr"].(string); ok {
		wantErr = s
	}
	if r.Stderr != wantErr {
		fail(fmt.Sprintf("stderr %q, expected %q", r.Stderr, wantErr))
	}

	// ASSERTING CALLS IS THE POINT: without it an entry passes for a command
	// that produced the right answer by making forty requests, and "a refusal
	// never reaches the network" could not be written down at all.
	if wc := wantCalls(e); !sameCalls(wc, r.Calls) {
		fail("calls " + fmtCalls(r.Calls) + ", expected " + fmtCalls(wc))
	}

	return failures
}
