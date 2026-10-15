package likeness

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/voxgig/sekreto/go/plugins/minivault"
)

// promptLogs holds the prompts each run showed, by the run's home.
var promptLogs = map[string]*[]string{}

// Root is the repository root: the directory holding the compiled corpora,
// which the embedded copies under go/spec/ do not include.
func Root(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if nil != err {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "spec", "cli.json")); nil == err {
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

// seedOf reads one fixture's seed with numbers kept exact, as the corpus is.
func seedOf(t *testing.T, root, name string) map[string]any {
	t.Helper()
	f, err := os.Open(filepath.Join(root, "fixtures", "sources", name, "seed.json"))
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
	return seed
}

func buildCtx(t *testing.T, root string, e map[string]any) Ctx {
	t.Helper()
	ectx, _ := e["ctx"].(map[string]any)

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

	// Each connection becomes a declared station instance, its block the one
	// the entry gives, its account the likeness.json entry beside it, and its
	// seed, its own or the entry's, the SDK's offline transport.
	sdk := map[string]any{}
	ctx.Accounts = map[string]string{}
	conns, _ := ectx["connections"].([]any)
	for _, c := range conns {
		cm := c.(map[string]any)
		inst := str(cm, "instance")
		block, _ := cm["block"].(map[string]any)
		sdk[inst] = cloneMap(block)
		ctx.Accounts[inst] = str(cm, "account")
		fixture := str(cm, "fixture")
		if "" == fixture {
			fixture = str(ectx, "fixture")
		}
		own := seedOf(t, root, fixture)
		if net, ok := cm["net"]; ok {
			own["net"] = net
		}
		ctx.Fixture[inst] = own
	}
	profile := map[string]any{"sdk": sdk}
	if secrets, ok := ectx["secrets"]; ok {
		profile["secrets"] = secrets
	}
	ctx.Station = map[string]any{"station": 1, "profiles": map[string]any{"default": profile}}

	// Every run gets a home of its own, holding the entry's files.
	ctx.Home = t.TempDir()
	ctx.Dir = filepath.Join(ctx.Home, ".config", "likeness")
	if err := os.MkdirAll(ctx.Dir, 0o700); nil != err {
		t.Fatal(err)
	}
	files, _ := ectx["files"].(map[string]any)
	for name, src := range files {
		dst := runPath(ctx, name)
		raw, err := os.ReadFile(filepath.Join(root, src.(string)))
		if nil != err {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); nil != err {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, raw, 0o600); nil != err {
			t.Fatal(err)
		}
	}
	// One that brings station.json or likeness.json is configured by them
	// alone, read as the argv shell reads them.
	for name := range files {
		if "station.json" != name && "likeness.json" != name {
			continue
		}
		if _, given := ectx["secrets"]; 0 < len(conns) || given {
			t.Fatalf("%s: an entry that brings its configuration declares no connections or secrets", str(e, "id"))
		}
		var err error
		if ctx.Station, ctx.Accounts, err = loadConfig(filepath.Join(ctx.Dir, "station.json"), profileOf(ctx.Env)); nil != err {
			t.Fatalf("%s: %v", str(e, "id"), err)
		}
		break
	}
	ctx.Config = filepath.Join(ctx.Dir, "station.json")

	// Keyed by host:port, the port written out even where it is the scheme's.
	presents, _ := ectx["presents"].(map[string]any)
	ctx.Presented = func(base string) (string, error) {
		u, err := url.Parse(base)
		if nil != err {
			return "", err
		}
		host, port := u.Hostname(), u.Port()
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		if "" == port {
			port = "443"
		}
		fingerprint, ok := presents[host+":"+port].(string)
		if !ok {
			return "", fmt.Errorf("nothing answers at %s:%s", host, port)
		}
		return fingerprint, nil
	}

	stdin := str(ectx, "stdin")
	ctx.Stdin = func() (string, error) { return stdin, nil }

	if tty, ok := ectx["tty"].([]any); ok {
		typed := strs(tty)
		shown := []string{}
		promptLogs[ctx.Home] = &shown
		ctx.TTY = true
		ctx.Prompt = func(label string) (string, bool) {
			shown = append(shown, label)
			promptLogs[ctx.Home] = &shown
			if 0 == len(typed) {
				return "", false
			}
			next := typed[0]
			typed = typed[1:]
			return next, true
		}
	}
	return ctx
}

func runPath(ctx Ctx, name string) string {
	if strings.HasPrefix(name, "~/") {
		return filepath.Join(ctx.Home, name[2:])
	}
	return filepath.Join(ctx.Dir, name)
}

func vaultFailures(ctx Ctx, want map[string]any, fail func(string)) {
	file := str(want, "file")
	if "" == file {
		file = "likeness.skmv"
	}
	key := str(want, "key")
	if "" == key {
		key = "master"
	}
	vault, err := minivault.Open(&minivault.Options{File: runPath(ctx, file), Key: key, Passphrase: str(want, "passphrase")})
	if nil != err {
		fail("the vault does not open afterwards: " + err.Error())
		return
	}
	defer vault.Close()
	names, err := vault.List()
	if nil != err {
		fail("the vault does not open afterwards: " + err.Error())
		return
	}
	if a, b := fmt.Sprint(names), fmt.Sprint(strs(want["names"])); a != b {
		fail("vault names " + a + ", expected " + b)
	}
	if wk, ok := want["keys"].([]any); ok {
		keys, err := vault.Keys()
		if nil != err {
			fail("the vault keys do not read: " + err.Error())
			return
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i].Key < keys[j].Key })
		got := []string{}
		for _, k := range keys {
			got = append(got, fmt.Sprint(k.Key, k.Master, k.Write, k.Grants))
		}
		exp := []string{}
		for _, k := range wk {
			km := k.(map[string]any)
			exp = append(exp, fmt.Sprint(str(km, "key"), km["master"], km["write"], strs(km["grants"])))
		}
		if a, b := strings.Join(got, "; "), strings.Join(exp, "; "); a != b {
			fail("vault keys " + a + ", expected " + b)
		}
	}
	values, _ := want["values"].(map[string]any)
	for name, value := range values {
		if got, _, _ := vault.Get(name); got != value {
			fail("vault value of " + name + " is not the one expected")
		}
	}
}

// fileFailures checks the configuration directory afterwards: each named file
// byte for byte, and the absent ones not there.
func fileFailures(root string, ctx Ctx, out map[string]any, fail func(string)) {
	files, _ := out["files"].(map[string]any)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		want := str(files, name)
		got, err := os.ReadFile(runPath(ctx, name))
		if nil != err {
			fail(name + " is not there afterwards, and " + want + " says what it holds")
			continue
		}
		expected, err := os.ReadFile(filepath.Join(root, want))
		if nil != err {
			fail("cannot read expectation " + want + ": " + err.Error())
			continue
		}
		if !bytes.Equal(got, expected) {
			fail(name + " differs from " + want)
		}
	}
	for _, name := range strs(out["absent"]) {
		if exists(runPath(ctx, name)) {
			fail(name + " is there afterwards, and the entry says it is not")
		}
	}
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

// checkStdout compares stdout with the expectation at path, as predict
// rewrites it where one is given.
func checkStdout(t *testing.T, root, path, actual string, predict func(string) string, fail func(string)) {
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
	if nil != predict {
		want = predict(want)
	}

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

	// Raw bytes first: indented or CRLF output carries the right values in
	// the wrong bytes, and a value comparison alone let that through.
	canonical, err := Serialise(parsed)
	if nil != err {
		fail("stdout cannot be re-rendered: " + err.Error())
		return
	}
	if actual != canonical {
		fail(fmt.Sprintf("stdout is not in canonical form (sorted keys, one line, one trailing newline): %q", head(actual, 80)))
	}

	// Removed from the comparison, so asserted here instead - otherwise a port
	// could report someone else's name and no check would notice.
	if p, _ := parsed["port"].(string); Port != p {
		fail("envelope port is \"" + p + "\", expected \"" + Port + "\"")
	}
	if data, ok := parsed["data"].(map[string]any); ok {
		if p, has := data["port"]; has && Port != p {
			fail(fmt.Sprintf("data.port is %v, expected %q", p, Port))
		}
	}
	meta, _ := parsed["meta"].(map[string]any)
	if n, ok := meta["elapsed_ms"].(json.Number); !ok || !isNonNegativeInteger(n) {
		fail(fmt.Sprintf("meta.elapsed_ms is %v, expected a non-negative integer", meta["elapsed_ms"]))
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

func head(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func isNonNegativeInteger(n json.Number) bool {
	s := n.String()
	if "0" == s {
		return true
	}
	if "" == s || s[0] < '1' || '9' < s[0] {
		return false
	}
	for _, c := range s[1:] {
		if c < '0' || '9' < c {
			return false
		}
	}
	return true
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
	return checkWith(t, root, e, nil)
}

// checkWith is Check with the expected stdout as predict rewrites it.
func checkWith(t *testing.T, root string, e map[string]any, predict func(string) string) []string {
	t.Helper()
	failures := []string{}
	fail := func(s string) { failures = append(failures, s) }

	out, _ := e["out"].(map[string]any)
	ctx := buildCtx(t, root, e)
	r := Run(ctx)

	if want := int(mustNum(t, out["exit"])); r.Exit != want {
		fail(fmt.Sprintf("exit %d, expected %d", r.Exit, want))
	}

	checkStdout(t, root, str(out, "stdout"), r.Stdout, predict, fail)

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

	shown := []string{}
	if log, ok := promptLogs[ctx.Home]; ok {
		shown = *log
	}
	if a, b := fmt.Sprintf("%q", shown), fmt.Sprintf("%q", strs(out["prompts"])); a != b {
		fail("prompts " + a + ", expected " + b)
	}

	if want, ok := out["vault"].(map[string]any); ok {
		vaultFailures(ctx, want, fail)
	}
	fileFailures(root, ctx, out, fail)
	return failures
}
