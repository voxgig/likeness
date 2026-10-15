package likeness

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

const badStderr = "error: invalid-project\n  %s is not valid JSON\n  remedy  fix the file, or point --config at another\n"

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
