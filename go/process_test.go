package likeness

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const badStderr = "error: invalid-project\n  %s is not valid JSON\n  remedy  fix the file, or point --config at another\n"

const unreadableStderr = "error: invalid-project\n  %s cannot be read\n  remedy  fix the file, or point --config at another\n"

const bareStation = `{"station":1,"profiles":{"default":{"sdk":{}}}}`

// runVersion runs `version --json` on the configuration at config.
func runVersion(t *testing.T, bin, home, config string) (int, string, string) {
	t.Helper()
	cmd := exec.Command(bin, "version", "--json", "--config", config)
	cmd.Dir = home
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	_ = cmd.Run()
	return cmd.ProcessState.ExitCode(), out.String(), errb.String()
}

func TestProcessUnreadableConfigIsRefusedNotAbsent(t *testing.T) {
	bin := buildBinary(t)
	home := t.TempDir()
	dir := filepath.Join(home, "cfg")
	if err := os.MkdirAll(filepath.Join(dir, "likeness.json"), 0o700); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "station.json"), []byte(bareStation), 0o600); nil != err {
		t.Fatal(err)
	}
	for _, c := range [][2]string{{dir, dir}, {filepath.Join(dir, "station.json"), filepath.Join(dir, "likeness.json")}} {
		code, out, errs := runVersion(t, bin, home, c[0])
		if want := fmt.Sprintf(unreadableStderr, c[1]); 3 != code || "" != out || want != errs {
			t.Fatalf("%s: exit %d, stdout %q, stderr %q, expected %q", c[0], code, out, errs, want)
		}
	}
}

func TestProcessNumberBeyondADoubleIsNotValidJSON(t *testing.T) {
	bin := buildBinary(t)
	home := t.TempDir()
	station := filepath.Join(home, "station.json")
	likeness := filepath.Join(home, "likeness.json")
	write := func(path, text string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0o600); nil != err {
			t.Fatal(err)
		}
	}
	refused := func(named string) {
		t.Helper()
		code, out, errs := runVersion(t, bin, home, station)
		if want := fmt.Sprintf(badStderr, named); 3 != code || "" != out || want != errs {
			t.Fatalf("exit %d, stdout %q, stderr %q, expected %q", code, out, errs, want)
		}
	}
	write(station, `{"station":1,"profiles":{"default":{"sdk":{"joplin":{"options":{"n":1e400}}}}}}`)
	refused(station)
	write(station, `{"station":1,"profiles":{"default":{"sdk":{"joplin":{}}}}}`)
	for _, account := range []string{"-1e400", "1" + strings.Repeat("0", 400)} {
		write(likeness, `{"likeness":1,"profiles":{"default":{"instances":{"joplin":{"account":`+account+`}}}}}`)
		refused(likeness)
	}
	// Too small to hold is zero, which is a number.
	write(likeness, `{"likeness":1,"profiles":{"default":{"instances":{"joplin":{"account":1e-400}}}}}`)
	if code, _, errs := runVersion(t, bin, home, station); 0 != code {
		t.Fatalf("exit %d, stderr %q", code, errs)
	}
}

func TestProcessConfigWithoutPermissionIsRefused(t *testing.T) {
	home := t.TempDir()
	config := filepath.Join(home, "station.json")
	if err := os.WriteFile(config, []byte(bareStation), 0o000); nil != err {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(config); nil == err {
		t.Skip("this process reads a file without permission to, so the refusal cannot be shown here")
	}
	code, out, errs := runVersion(t, buildBinary(t), home, config)
	if want := fmt.Sprintf(unreadableStderr, config); 3 != code || "" != out || want != errs {
		t.Fatalf("exit %d, stdout %q, stderr %q, expected %q", code, out, errs, want)
	}
}

func TestProcessMalformedConfigBothFlagForms(t *testing.T) {
	bin := buildBinary(t)
	home := t.TempDir()
	bad := filepath.Join(home, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); nil != err {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"list", "--json", "--config=" + bad}, {"list", "--json", "--config", bad}} {
		cmd := exec.Command(bin, args...)
		cmd.Dir = home
		cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		_ = cmd.Run()
		if code := cmd.ProcessState.ExitCode(); 3 != code {
			t.Fatalf("%v: exit %d\n%s", args, code, errb.String())
		}
		if "" != out.String() {
			t.Fatalf("%v: stdout %q", args, out.String())
		}
		if want := fmt.Sprintf(badStderr, bad); want != errb.String() {
			t.Fatalf("%v: stderr %q, expected %q", args, errb.String(), want)
		}
	}
}

func TestProcessBrokenPipeExitsQuietly(t *testing.T) {
	bin := buildBinary(t)
	home := t.TempDir()
	// The reader is gone before the port starts.
	r, w, err := os.Pipe()
	if nil != err {
		t.Fatal(err)
	}
	r.Close()
	cmd := exec.Command(bin, "version", "--json")
	cmd.Dir = home
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	cmd.Stdout = w
	var errb bytes.Buffer
	cmd.Stderr = &errb
	_ = cmd.Run()
	w.Close()
	if code := cmd.ProcessState.ExitCode(); 0 != code || "" != errb.String() {
		t.Fatalf("exit %d (%v), stderr %q", code, cmd.ProcessState, errb.String())
	}
}

func TestProcessIllFormedArgvDecodesAsNodeDoes(t *testing.T) {
	bin := buildBinary(t)
	home := t.TempDir()
	// One replacement per maximal ill-formed subsequence: the truncated
	// three-byte sequence is one, the stray byte another.
	cmd := exec.Command(bin, "help", "a\xe2\x82b\xff")
	cmd.Dir = home
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	_ = cmd.Run()
	want := "error: invalid-argument\n  <command> takes a name ([a-z][a-z0-9-]*), not \"a�b�\"\n" +
		"  remedy  run `likeness help help` for its arguments\n"
	if code := cmd.ProcessState.ExitCode(); 3 != code || want != errb.String() {
		t.Fatalf("exit %d, stderr %q, expected %q", code, errb.String(), want)
	}
}
