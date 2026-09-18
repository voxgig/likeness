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

	if wc := wantCalls(e); !sameCalls(wc, r.Calls) {
		fail("calls " + fmtCalls(r.Calls) + ", expected " + fmtCalls(wc))
	}

	return failures
}
