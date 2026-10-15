package likeness

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
	"github.com/voxgig/sekreto/go/plugins/minivault"
)

const (
	fixtureMaster = "fixture master passphrase"
	fixtureNote   = "a0e50000000000000000000000000001"
)

// failing is the disk's own file operations, but for the nth rename, which
// fails as a full disk would.
func failing(nth int) *Fs {
	renames := 0
	fs := osFs
	fs.Rename = func(from, to string) error {
		renames++
		if nth == renames {
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: syscall.ENOSPC}
		}
		return os.Rename(from, to)
	}
	return &fs
}

func folder(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600); nil != err {
			t.Fatal(err)
		}
	}
	return dir
}

func heldAt(t *testing.T, path string) *heldFile {
	t.Helper()
	h, err := held(path, path)
	if nil != err || nil == h {
		t.Fatalf("%s is not held: %v", path, err)
	}
	return h
}

func listing(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if nil != err {
		t.Fatal(err)
	}
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

func readAt(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if nil != err {
		t.Fatal(err)
	}
	return string(raw)
}

func bothFiles(t *testing.T, ctx Ctx) []string {
	t.Helper()
	return []string{readAt(t, runPath(ctx, "station.json")), readAt(t, runPath(ctx, "likeness.json"))}
}

func vaultNamesOf(t *testing.T, ctx Ctx, file string) []string {
	t.Helper()
	vault, err := minivault.Open(&minivault.Options{File: runPath(ctx, file), Key: "master", Passphrase: fixtureMaster})
	if nil != err {
		t.Fatal(err)
	}
	defer vault.Close()
	names, err := vault.List()
	if nil != err {
		t.Fatal(err)
	}
	sort.Strings(names)
	return names
}

func counted(n []int) []any {
	out := []any{}
	for _, b := range n {
		out = append(out, b)
	}
	return out
}

func same(t *testing.T, what string, got, want any) {
	t.Helper()
	if a, b := canon(t, got), canon(t, want); a != b {
		t.Fatalf("%s: %s, expected %s", what, strings.TrimSpace(a), strings.TrimSpace(b))
	}
}

func TestWriteAllPutsTheFirstFileBackWhenTheSecondRenameFails(t *testing.T) {
	dir := folder(t, map[string]string{"likeness.json": "old likeness\n", "station.json": "old station\n"})
	likeness, station := filepath.Join(dir, "likeness.json"), filepath.Join(dir, "station.json")
	err := writeAll([]fileWrite{
		{path: likeness, text: "new likeness\n", was: heldAt(t, likeness)},
		{path: station, text: "new station\n", was: heldAt(t, station)},
	}, *failing(2))
	var we *writeError
	if !errors.As(err, &we) || !we.restored || station != we.path {
		t.Fatalf("not a restored failure at %s: %#v", station, err)
	}
	same(t, "files", []any{readAt(t, likeness), readAt(t, station)}, []any{"old likeness\n", "old station\n"})
	same(t, "directory", strList(listing(t, dir)), []any{"likeness.json", "station.json"})
}

func TestWriteAllTakesAFileNotThereBeforeAwayWhenTheRenameAfterItFails(t *testing.T) {
	dir := folder(t, map[string]string{"station.json": "old station\n"})
	station := filepath.Join(dir, "station.json")
	err := writeAll([]fileWrite{
		{path: filepath.Join(dir, "likeness.json"), text: "new likeness\n"},
		{path: station, text: "new station\n", was: heldAt(t, station)},
	}, *failing(2))
	var we *writeError
	if !errors.As(err, &we) || !we.restored {
		t.Fatalf("not a restored failure: %#v", err)
	}
	same(t, "directory", strList(listing(t, dir)), []any{"station.json"})
	same(t, "station.json", readAt(t, station), "old station\n")
}

func TestWriteAllChangesNothingWhenTheFirstRenameFailsAndKeepsEachMode(t *testing.T) {
	dir := folder(t, map[string]string{"likeness.json": "old likeness\n", "station.json": "old station\n"})
	likeness, station := filepath.Join(dir, "likeness.json"), filepath.Join(dir, "station.json")
	writes := func() []fileWrite {
		was := heldAt(t, station)
		was.mode = 0o640
		return []fileWrite{
			{path: likeness, text: "new likeness\n", was: heldAt(t, likeness)},
			{path: station, text: "new station\n", was: was},
		}
	}
	var we *writeError
	if err := writeAll(writes(), *failing(1)); !errors.As(err, &we) {
		t.Fatalf("not a write failure: %#v", err)
	}
	same(t, "files", []any{readAt(t, likeness), readAt(t, station)}, []any{"old likeness\n", "old station\n"})
	if err := writeAll(writes(), osFs); nil != err {
		t.Fatal(err)
	}
	same(t, "files", []any{readAt(t, likeness), readAt(t, station)}, []any{"new likeness\n", "new station\n"})
	if info, err := os.Stat(station); nil != err || 0o640 != info.Mode().Perm() {
		t.Fatalf("station.json's mode is not kept: %v %v", info.Mode(), err)
	}
	same(t, "directory", strList(listing(t, dir)), []any{"likeness.json", "station.json"})
}

func TestSourcesAddWhoseSecondRenameFailsChangesNeitherFileAndTakesItsTokenOut(t *testing.T) {
	root := Root(t)
	ctx := buildCtx(t, root, entryByID(t, root, "connections/add-keeps-the-file"))
	before := bothFiles(t, ctx)
	ctx.FS = failing(2)
	r := Run(ctx)
	if 3 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	env := mustDecode(t, r.Stdout)
	same(t, "code", env["code"], "invalid-project")
	same(t, "message", env["error"].(map[string]any)["message"],
		"~/.config/likeness/station.json could not be written, and nothing was changed")
	same(t, "files", strList(bothFiles(t, ctx)), strList(before))
	same(t, "directory", strList(listing(t, ctx.Dir)), []any{"likeness.json", "likeness.skmv", "station.json"})
	same(t, "vault", strList(vaultNamesOf(t, ctx, "likeness.skmv")), []any{"joplin.apikey", "notion.apikey"})
}

func TestSourcesAddIntoAnEmptyHomeLeavesNeitherFileWhenTheSecondRenameFails(t *testing.T) {
	root := Root(t)
	ctx := buildCtx(t, root, entryByID(t, root, "connections/add-joplin"))
	ctx.FS = failing(2)
	if r := Run(ctx); 3 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	same(t, "directory", strList(listing(t, ctx.Dir)), []any{"likeness.skmv"})
	same(t, "vault", strList(vaultNamesOf(t, ctx, "likeness.skmv")), []any{"joplin.apikey", "notion.apikey"})
}

func TestSourcesRemoveOrRenameWhoseSecondRenameFailsChangesNeitherFile(t *testing.T) {
	root := Root(t)
	for _, id := range []string{"connections/remove", "connections/rename"} {
		ctx := buildCtx(t, root, entryByID(t, root, id))
		before := bothFiles(t, ctx)
		ctx.FS = failing(2)
		if r := Run(ctx); 3 != r.Exit {
			t.Fatalf("%s: exit %d: %s", id, r.Exit, r.Stdout)
		}
		same(t, id+" files", strList(bothFiles(t, ctx)), strList(before))
		same(t, id+" directory", strList(listing(t, ctx.Dir)), []any{"likeness.json", "station.json"})
	}
}

func TestSourcesAddWritesASymlinkedFileWhereItPointsAndKeepsTheLink(t *testing.T) {
	root := Root(t)
	ctx := buildCtx(t, root, entryByID(t, root, "connections/add-keeps-the-file"))
	dotfiles := t.TempDir()
	for _, name := range []string{"station.json", "likeness.json"} {
		if err := os.Rename(runPath(ctx, name), filepath.Join(dotfiles, name)); nil != err {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(dotfiles, name), runPath(ctx, name)); nil != err {
			t.Fatal(err)
		}
	}
	if r := Run(ctx); 0 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	for _, name := range []string{"station.json", "likeness.json"} {
		if info, err := os.Lstat(runPath(ctx, name)); nil != err || 0 == info.Mode()&os.ModeSymlink {
			t.Fatalf("%s is no longer a link: %v", name, err)
		}
		want := readAt(t, filepath.Join(root, "spec", "written", "connections", "add-keeps-the-file", name))
		if got := readAt(t, filepath.Join(dotfiles, name)); got != want {
			t.Fatalf("%s where the link points:\n%s\nexpected\n%s", name, got, want)
		}
	}
	same(t, "dotfiles", strList(listing(t, dotfiles)), []any{"likeness.json", "station.json"})
}

// next runs a command over what the files now say, with the SDK's offline transport seeded.
func next(t *testing.T, root string, ctx Ctx, argv []string, seeded string) (int, map[string]any) {
	t.Helper()
	station, accounts, err := loadConfig(runPath(ctx, "station.json"), "default")
	if nil != err {
		t.Fatal(err)
	}
	r := Run(Ctx{Argv: argv, Clock: "2026-10-15T00:00:00Z", Station: station, Accounts: accounts,
		Fixture: map[string]map[string]any{seeded: seedOf(t, root, "joplin")}, Home: ctx.Home, Dir: ctx.Dir})
	return r.Exit, mustDecode(t, r.Stdout)
}

func TestSourcesAddWritesAConnectionTheNextCommandsReadAndReach(t *testing.T) {
	root := Root(t)
	ctx := buildCtx(t, root, entryByID(t, root, "connections/add-joplin"))
	if r := Run(ctx); 0 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	exit, listed := next(t, root, ctx, []string{"list", "--json"}, "joplin$work")
	rows, _ := listed["data"].([]any)
	if 0 != exit || 0 == len(rows) {
		t.Fatalf("exit %d, %d notes", exit, len(rows))
	}
	for _, row := range rows {
		n := row.(map[string]any)
		same(t, "instance", n["instance"], "joplin$work")
		same(t, "lid", n["lid"], Lid("joplin", "local", "note", n["id"].(string)))
	}
	exit, checked := next(t, root, ctx, []string{"doctor", "--json"}, "joplin$work")
	same(t, "doctor", []any{exit, checked["code"], len(checked["data"].([]any))}, []any{0, "ok", 1})
}

func TestSourcesRenameChangesNoLidSinceTheAccountMovesWithTheRef(t *testing.T) {
	root := Root(t)
	ctx := buildCtx(t, root, entryByID(t, root, "connections/rename"))
	exit, before := next(t, root, ctx, []string{"get", "joplin$work:" + fixtureNote, "--json"}, "joplin$work")
	if 0 != exit {
		t.Fatalf("get before: exit %d", exit)
	}
	if r := Run(ctx); 0 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	exit, after := next(t, root, ctx, []string{"get", "joplin$office:" + fixtureNote, "--json"}, "joplin$office")
	if 0 != exit {
		t.Fatalf("get after: exit %d", exit)
	}
	lid := func(env map[string]any) any { return env["data"].([]any)[0].(map[string]any)["lid"] }
	same(t, "lid", lid(after), lid(before))
	same(t, "lid", lid(before), Lid("joplin", "office", "note", fixtureNote))
}

func TestSourcesRemoveLeavesNoAccountAndAConfigurationTheNextCommandReads(t *testing.T) {
	root := Root(t)
	ctx := buildCtx(t, root, entryByID(t, root, "connections/remove"))
	if r := Run(ctx); 0 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	accounts, err := parseAccounts(readAt(t, runPath(ctx, "likeness.json")), "likeness.json", "default")
	if nil != err {
		t.Fatal(err)
	}
	if _, has := accounts["joplin$work"]; has {
		t.Fatal("joplin$work's account is still there")
	}
	_, listed := next(t, root, ctx, []string{"sources", "list", "--json"}, "joplin")
	refs := []any{}
	for _, row := range listed["data"].([]any) {
		refs = append(refs, row.(map[string]any)["instance"])
	}
	same(t, "connections", refs, []any{"joplin", "joplin$a-b", "notion$docs"})
}

func TestSourcesAddPinsTheCertificateAProbeThatWritesNothingReads(t *testing.T) {
	root := Root(t)
	cert := selfSigned(t, -1, 2)
	srv := countingServer(t, cert, nil)
	base := strings.TrimSuffix(srv.url, "/vault/")
	e := entryByID(t, root, "connections/add-obsidian-confirmed")
	e["args"] = []any{"sources", "add", "--source", "obsidian", "--account", "wirevault", "--base", base, "--json"}
	ctx := buildCtx(t, root, e)
	ctx.Presented = presentedFingerprint
	r := Run(ctx)
	if 0 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	var written map[string]any
	if err := json.Unmarshal([]byte(readAt(t, runPath(ctx, "station.json"))), &written); nil != err {
		t.Fatal(err)
	}
	pinned := written["profiles"].(map[string]any)["default"].(map[string]any)["sdk"].(map[string]any)["obsidian"]
	same(t, "block", pinned, map[string]any{"base": base,
		"options": map[string]any{"tls": map[string]any{"fingerprint": fingerprintOf(cert.der)}}})
	same(t, "prompt", (*promptLogs[ctx.Home])[0], "obsidian at "+base+" presents "+fingerprintOf(cert.der)+"; type yes to pin it")
	same(t, "bytes written", counted(srv.bytes()), []any{0})
}

func TestSourcesAddRefusesAFingerprintThePluginDoesNotPresentAndWritesNothing(t *testing.T) {
	root := Root(t)
	srv := countingServer(t, selfSigned(t, -1, 2), nil)
	base := strings.TrimSuffix(srv.url, "/vault/")
	e := entryByID(t, root, "connections/add-obsidian-fingerprint-differs")
	e["args"] = []any{"sources", "add", "--source", "obsidian", "--account", "wirevault", "--base", base,
		"--fingerprint", fingerprintOf(selfSigned(t, -1, 2).der), "--json"}
	ctx := buildCtx(t, root, e)
	ctx.Presented = presentedFingerprint
	r := Run(ctx)
	same(t, "refusal", []any{r.Exit, mustDecode(t, r.Stdout)["code"]}, []any{4, "certificate-rejected"})
	if exists(runPath(ctx, "station.json")) {
		t.Fatal("station.json was written")
	}
	same(t, "bytes written", counted(srv.bytes()), []any{0})
}

// discoveringJoplin is Joplin's adapter as it would be if its SDK named the account.
type discoveringJoplin struct{ joplinAdapter }

func (discoveringJoplin) account(h any) (string, error) {
	if _, err := h.(*joplin.JoplinSDK).Note(nil).List(map[string]any{}, nil); nil != err {
		return "", err
	}
	return "discovered-profile", nil
}

func TestSourcesAddAsksASourceThatNamesItsAccountAndRefusesAccount(t *testing.T) {
	root := Root(t)
	caps, err := Caps()
	if nil != err {
		t.Fatal(err)
	}
	row, adapter := caps["joplin"], adapters["joplin"]
	defer func() { caps["joplin"], adapters["joplin"] = row, adapter }()
	asked := row
	asked.Connect.Account.Discover = true
	caps["joplin"], adapters["joplin"] = asked, discoveringJoplin{}

	e := entryByID(t, root, "connections/add-joplin")
	e["args"] = []any{"sources", "add", "--source", "joplin", "--instance", "work", "--json"}
	ctx := buildCtx(t, root, e)
	ctx.Fixture = map[string]map[string]any{"joplin$work": seedOf(t, root, "joplin")}
	r := Run(ctx)
	if 0 != r.Exit {
		t.Fatalf("exit %d: %s", r.Exit, r.Stdout)
	}
	same(t, "calls", fmtCalls(r.Calls), fmtCalls([]Call{{"joplin$work", "GET", "/notes"}}))
	accounts, err := parseAccounts(readAt(t, runPath(ctx, "likeness.json")), "likeness.json", "default")
	if nil != err {
		t.Fatal(err)
	}
	same(t, "accounts", map[string]any{"joplin$work": accounts["joplin$work"]}, map[string]any{"joplin$work": "discovered-profile"})
	if 1 != len(accounts) {
		t.Fatalf("accounts %v", accounts)
	}

	refused := Run(buildCtx(t, root, entryByID(t, root, "connections/add-joplin")))
	same(t, "refusal", []any{refused.Exit, mustDecode(t, refused.Stdout)["code"]}, []any{3, "invalid-argument"})
}

func TestBinaryWritesStationJSONWhereConfigNamesItAndLikenessJSONBeside(t *testing.T) {
	root := Root(t)
	bin := buildBinary(t)
	home := t.TempDir()
	dir := filepath.Join(home, "elsewhere")
	if err := os.MkdirAll(dir, 0o700); nil != err {
		t.Fatal(err)
	}
	vault := readAt(t, filepath.Join(root, "fixtures", "vault", "likeness.skmv"))
	if err := os.WriteFile(filepath.Join(dir, "likeness.skmv"), []byte(vault), 0o600); nil != err {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "my-station.json")
	run := func(args ...string) (int, string) {
		cmd := exec.Command(bin, args...)
		cmd.Dir = home
		cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "LIKENESS_PASSPHRASE=" + fixtureMaster}
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		_ = cmd.Run()
		if "" != errb.String() {
			t.Fatalf("%v: stderr %q", args, errb.String())
		}
		return cmd.ProcessState.ExitCode(), out.String()
	}

	if code, out := run("sources", "add", "--source", "joplin", "--account", "local", "--secret", "joplin.apikey",
		"--json", "--config", config); 0 != code {
		t.Fatalf("add: exit %d: %s", code, out)
	}
	at := func(text string, path ...string) any {
		var v any = mustDecode(t, text)
		for _, k := range path {
			v = v.(map[string]any)[k]
		}
		return v
	}
	same(t, "station.json", at(readAt(t, config), "profiles", "default", "sdk"),
		map[string]any{"joplin": map[string]any{"base": "http://127.0.0.1:41184"}})
	same(t, "likeness.json", at(readAt(t, filepath.Join(dir, "likeness.json")), "profiles", "default", "instances"),
		map[string]any{"joplin": map[string]any{"account": "local"}})

	code, out := run("sources", "list", "--json", "--config", config)
	if 0 != code {
		t.Fatalf("list: exit %d: %s", code, out)
	}
	same(t, "listed", at(out, "data"), []any{map[string]any{"account": "local", "base": "http://127.0.0.1:41184",
		"instance": "joplin", "secret": "joplin.apikey", "source": "joplin"}})
}
