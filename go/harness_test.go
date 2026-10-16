package likeness

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	omni "github.com/voxgig/omni/go"
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

// decodeExact reads JSON with numbers kept EXACT. Decoding into float64 would
// turn an int64 corpus value into an approximation and a serialiser test into
// a coin toss.
func decodeExact(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); nil != err {
		return nil, err
	}
	return v, nil
}

func readExact(path string) (any, error) {
	raw, err := os.ReadFile(path)
	if nil != err {
		return nil, err
	}
	return decodeExact(string(raw))
}

// cloneExact is a deep copy, numbers still exact.
func cloneExact(v any) (any, error) {
	raw, err := json.Marshal(v)
	if nil != err {
		return nil, err
	}
	return decodeExact(string(raw))
}

// corpusDoc is spec/<name>.json as omni is handed it. omni's Go port reads
// OMNI.version only as a Go number, so that one value is converted.
func corpusDoc(t *testing.T, root, name string) map[string]any {
	t.Helper()
	v, err := readExact(filepath.Join(root, "spec", name+".json"))
	if nil != err {
		t.Fatal(err)
	}
	doc, _ := v.(map[string]any)
	if meta, ok := doc["OMNI"].(map[string]any); ok {
		if n, ok := num(meta["version"]); ok {
			meta["version"] = n
		}
	}
	return doc
}

func corpusGroups(t *testing.T, root, name string) map[string]any {
	t.Helper()
	primary, _ := corpusDoc(t, root, name)["primary"].(map[string]any)
	groups, _ := primary[name].(map[string]any)
	if nil == groups {
		t.Fatalf("spec/%s.json has no primary.%s", name, name)
	}
	return groups
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func groupSet(groups map[string]any, name string) []any {
	group, _ := groups[name].(map[string]any)
	set, _ := group["set"].([]any)
	return set
}

func corpusEntries(t *testing.T, root, name string) []map[string]any {
	t.Helper()
	groups := corpusGroups(t, root, name)
	out := []map[string]any{}
	for _, g := range sortedKeys(groups) {
		for _, e := range groupSet(groups, g) {
			out = append(out, e.(map[string]any))
		}
	}
	return out
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
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

func callValues(cs []Call) []any {
	out := make([]any, 0, len(cs))
	for _, c := range cs {
		out = append(out, map[string]any{"instance": c.Instance, "method": c.Method, "path": c.Path})
	}
	return out
}

// -- the transcript corpus's subject ----------------------------------------

// readSeed reads one fixture's seed with numbers kept exact, as the corpus is.
func readSeed(root, name string) (map[string]any, error) {
	v, err := readExact(filepath.Join(root, "fixtures", "sources", name, "seed.json"))
	if nil != err {
		return nil, err
	}
	seed, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("the %s seed is not an object", name)
	}
	delete(seed, "_doc")
	return seed, nil
}

func seedOf(t *testing.T, root, name string) map[string]any {
	t.Helper()
	seed, err := readSeed(root, name)
	if nil != err {
		t.Fatal(err)
	}
	return seed
}

func buildCtx(t *testing.T, root string, e map[string]any) Ctx {
	t.Helper()
	ctx, err := newCtx(root, t.TempDir(), e)
	if nil != err {
		t.Fatal(err)
	}
	return ctx
}

// newCtx is the run an entry describes, in a home of its own holding the
// entry's files.
func newCtx(root, home string, e map[string]any) (Ctx, error) {
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
		own, err := readSeed(root, fixture)
		if nil != err {
			return Ctx{}, err
		}
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

	ctx.Home = home
	ctx.Dir = filepath.Join(ctx.Home, ".config", "likeness")
	if err := os.MkdirAll(ctx.Dir, 0o700); nil != err {
		return Ctx{}, err
	}
	files, _ := ectx["files"].(map[string]any)
	for name, src := range files {
		dst := runPath(ctx, name)
		raw, err := os.ReadFile(filepath.Join(root, src.(string)))
		if nil != err {
			return Ctx{}, err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); nil != err {
			return Ctx{}, err
		}
		if err := os.WriteFile(dst, raw, 0o600); nil != err {
			return Ctx{}, err
		}
	}
	// One that brings station.json or likeness.json is configured by them
	// alone, read as the argv shell reads them.
	for name := range files {
		if "station.json" != name && "likeness.json" != name {
			continue
		}
		if _, given := ectx["secrets"]; 0 < len(conns) || given {
			return Ctx{}, fmt.Errorf("%s: an entry that brings its configuration declares no connections or secrets", str(e, "id"))
		}
		var err error
		if ctx.Station, ctx.Accounts, err = loadConfig(filepath.Join(ctx.Dir, "station.json"), profileOf(ctx.Env)); nil != err {
			return Ctx{}, fmt.Errorf("%s: %w", str(e, "id"), err)
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
	return ctx, nil
}

func runPath(ctx Ctx, name string) string {
	if strings.HasPrefix(name, "~/") {
		return filepath.Join(ctx.Home, name[2:])
	}
	return filepath.Join(ctx.Dir, name)
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

// vaultSeen is the vault afterwards, as much of it as the entry asserts: its
// names, its keys if the entry gives them, and the values it names.
func vaultSeen(ctx Ctx, look map[string]any, fault func(string)) any {
	file := str(look, "file")
	if "" == file {
		file = "likeness.skmv"
	}
	key := str(look, "key")
	if "" == key {
		key = "master"
	}
	vault, err := minivault.Open(&minivault.Options{File: runPath(ctx, file), Key: key, Passphrase: str(look, "passphrase")})
	if nil != err {
		fault("the vault does not open afterwards: " + err.Error())
		return nil
	}
	defer vault.Close()
	names, err := vault.List()
	if nil != err {
		fault("the vault does not open afterwards: " + err.Error())
		return nil
	}
	seen := map[string]any{"names": strList(names)}
	if asserted, _ := look["keys"].(bool); asserted {
		keys, err := vault.Keys()
		if nil != err {
			fault("the vault keys do not read: " + err.Error())
			return seen
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i].Key < keys[j].Key })
		list := []any{}
		for _, k := range keys {
			list = append(list, map[string]any{"key": k.Key, "master": k.Master, "write": k.Write, "grants": strList(k.Grants)})
		}
		seen["keys"] = list
	}
	if named, ok := look["values"].([]any); ok {
		values := map[string]any{}
		for _, name := range strs(named) {
			values[name] = nil
			if v, found, err := vault.Get(name); nil == err && found {
				values[name] = v
			}
		}
		seen["values"] = values
	}
	return seen
}

// seenStdout is the stdout to compare: as printed, or for JSON the canonical
// bytes less the fields that may differ by port, each of those asserted here
// instead.
func seenStdout(asJSON bool, actual string, fault func(string)) string {
	if !asJSON {
		return actual
	}

	dec := json.NewDecoder(strings.NewReader(actual))
	dec.UseNumber()
	var parsed map[string]any
	if err := dec.Decode(&parsed); nil != err {
		fault("stdout is not JSON, and the entry says it should be")
		return actual
	}

	// Raw bytes first: indented or CRLF output carries the right values in
	// the wrong bytes, and a value comparison alone let that through.
	canonical, err := Serialise(parsed)
	if nil != err {
		fault("stdout cannot be re-rendered: " + err.Error())
		return actual
	}
	if actual != canonical {
		fault(fmt.Sprintf("stdout is not in canonical form (sorted keys, one line, one trailing newline): %q", head(actual, 80)))
	}

	if p, _ := parsed["port"].(string); Port != p {
		fault("envelope port is \"" + p + "\", expected \"" + Port + "\"")
	}
	if data, ok := parsed["data"].(map[string]any); ok {
		if p, has := data["port"]; has && Port != p {
			fault(fmt.Sprintf("data.port is %v, expected %q", p, Port))
		}
	}
	meta, _ := parsed["meta"].(map[string]any)
	if n, ok := meta["elapsed_ms"].(json.Number); !ok || !isNonNegativeInteger(n) {
		fault(fmt.Sprintf("meta.elapsed_ms is %v, expected a non-negative integer", meta["elapsed_ms"]))
	}

	got, err := Serialise(StripParityExceptions(parsed))
	if nil != err {
		fault("stdout cannot be re-rendered: " + err.Error())
		return actual
	}
	return got
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

// expectation is a file an entry names by path. A MISSING EXPECTATION IS AN
// ERROR, NOT AN EMPTY COMPARISON.
func expectation(root, rel string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(root, rel))
	if nil != err {
		return "", fmt.Errorf("cannot read expectation %s: %w", rel, err)
	}
	return string(raw), nil
}

// resolved is the entry as omni runs it. What its out names by path becomes
// the bytes, and what the subject must look at to answer it rides in ctx.
func resolved(root string, e map[string]any) (map[string]any, error) {
	o := outOf(e)
	rel := str(o, "stdout")
	stdout, err := expectation(root, rel)
	if nil != err {
		return nil, err
	}
	exit, ok := num(o["exit"])
	if !ok {
		return nil, fmt.Errorf("%s: exit %v is not an integer", str(e, "id"), o["exit"])
	}
	stderr, _ := o["stderr"].(string)
	prompts, ok := o["prompts"].([]any)
	if !ok {
		prompts = []any{}
	}
	calls := []Call{}
	listed, _ := o["calls"].([]any)
	for _, c := range listed {
		cm, _ := c.(map[string]any)
		calls = append(calls, Call{str(cm, "instance"), str(cm, "method"), str(cm, "path")})
	}

	observe := map[string]any{"id": e["id"], "json": strings.HasSuffix(rel, ".json")}
	want := map[string]any{
		"exit":    exit,
		"stdout":  stdout,
		"stderr":  stderr,
		"calls":   callValues(calls),
		"prompts": prompts,
		"faults":  []any{},
	}
	if v, ok := o["vault"].(map[string]any); ok {
		_, keyed := v["keys"]
		look := map[string]any{"keys": keyed}
		for _, k := range []string{"file", "key", "passphrase"} {
			if x, has := v[k]; has {
				look[k] = x
			}
		}
		held := map[string]any{"names": v["names"]}
		if keys, ok := v["keys"].([]any); ok {
			list := []any{}
			for _, k := range keys {
				km, _ := k.(map[string]any)
				list = append(list, map[string]any{"key": km["key"], "master": km["master"], "write": km["write"], "grants": km["grants"]})
			}
			held["keys"] = list
		}
		if values, ok := v["values"].(map[string]any); ok {
			look["values"] = strList(sortedKeys(values))
			held["values"] = values
		}
		observe["vault"] = look
		want["vault"] = held
	}
	if files, ok := o["files"].(map[string]any); ok {
		texts := map[string]any{}
		for name, f := range files {
			path, _ := f.(string)
			text, err := expectation(root, path)
			if nil != err {
				return nil, err
			}
			texts[name] = text
		}
		observe["files"] = strList(sortedKeys(files))
		want["files"] = texts
	}
	if absent, ok := o["absent"].([]any); ok {
		observe["absent"] = absent
		want["absent"] = absent
	}

	ctx := map[string]any{}
	ectx, _ := e["ctx"].(map[string]any)
	for k, v := range ectx {
		ctx[k] = v
	}
	ctx["observe"] = observe
	return map[string]any{"id": e["id"], "args": e["args"], "ctx": ctx, "out": want}, nil
}

// transcript is omni's subject for the transcript corpus: one command,
// in-process, in a home under t.
func transcript(t *testing.T, root string) omni.Subject {
	return func(args ...any) (any, error) {
		given, _ := args[0].(map[string]any)
		observe, _ := given["observe"].(map[string]any)
		ectx := map[string]any{}
		for k, v := range given {
			if "observe" != k && "client" != k {
				ectx[k] = v
			}
		}
		ctx, err := newCtx(root, t.TempDir(), map[string]any{"id": observe["id"], "args": args[1:], "ctx": ectx})
		if nil != err {
			return nil, err
		}
		r := Run(ctx)

		faults := []any{}
		fault := func(s string) { faults = append(faults, s) }
		asJSON, _ := observe["json"].(bool)
		seen := map[string]any{
			"exit":    r.Exit,
			"stdout":  seenStdout(asJSON, r.Stdout, fault),
			"stderr":  r.Stderr,
			"calls":   callValues(r.Calls),
			"prompts": []any{},
		}
		if log, ok := promptLogs[ctx.Home]; ok {
			seen["prompts"] = strList(*log)
		}
		if look, ok := observe["vault"].(map[string]any); ok {
			seen["vault"] = vaultSeen(ctx, look, fault)
		}
		if names, ok := observe["files"].([]any); ok {
			files := map[string]any{}
			for _, name := range strs(names) {
				files[name] = nil
				if raw, err := os.ReadFile(runPath(ctx, name)); nil == err {
					files[name] = string(raw)
				}
			}
			seen["files"] = files
		}
		if names, ok := observe["absent"].([]any); ok {
			gone := []any{}
			for _, name := range strs(names) {
				if !exists(runPath(ctx, name)) {
					gone = append(gone, name)
				}
			}
			seen["absent"] = gone
		}
		seen["faults"] = faults
		return seen, nil
	}
}

// cliOmni is the format header spec/cli.json carries.
var cliOmni = map[string]any{"version": 1, "requires": []any{"ctxargs"}}

// cliRun runs resolved transcript entries through omni as one group.
func cliRun(t *testing.T, root, name string, set []any, flags omni.Flags) error {
	t.Helper()
	subject := transcript(t, root)
	runner, err := omni.MakeRunner(
		map[string]any{"OMNI": cliOmni, "cli": map[string]any{name: map[string]any{"set": set}}},
		&omni.Provider{Subject: func(section string) omni.Subject {
			if "cli" == section {
				return subject
			}
			return nil
		}})
	if nil != err {
		t.Fatal(err)
	}
	R, err := runner("cli", nil)
	if nil != err {
		t.Fatal(err)
	}
	return R.RunSetFlags(R.Set(name), flags, nil)
}

// checkFlags runs one resolved entry through omni: no failures, or the one
// omni reports.
func checkFlags(t *testing.T, root string, r map[string]any, flags omni.Flags) []string {
	t.Helper()
	err := cliRun(t, root, "one", []any{r}, flags)
	if nil == err {
		return []string{}
	}
	if !omni.IsOmniError(err) {
		t.Fatal(err)
	}
	return []string{err.Error()}
}

func Check(t *testing.T, root string, e map[string]any) []string {
	t.Helper()
	r, err := resolved(root, e)
	if nil != err {
		return []string{err.Error()}
	}
	return checkFlags(t, root, r, omni.Flags{"null": false})
}
