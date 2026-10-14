package likeness

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBinaryRunsOutsideTheCheckout(t *testing.T) {
	root := Root(t)
	bin := filepath.Join(t.TempDir(), "likeness-go")
	build := exec.Command("go", "build", "-o", bin, "./cmd/likeness-go")
	build.Dir = filepath.Join(root, "go")
	if out, err := build.CombinedOutput(); nil != err {
		t.Fatalf("build: %v\n%s", err, out)
	}

	// An empty HOME and a working directory holding no spec/ at all.
	home := t.TempDir()
	cmd := exec.Command(bin, "version", "--json")
	cmd.Dir = home
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	out, err := cmd.Output()
	if nil != err {
		t.Fatalf("%v\n%s", err, out)
	}
	var env map[string]any
	if err := json.Unmarshal(out, &env); nil != err {
		t.Fatalf("not an envelope: %v\n%s", err, out)
	}
	if true != env["ok"] || "go" != env["port"] {
		t.Fatalf("unexpected envelope: %s", out)
	}
}

func TestNoPortReadsTheSpecFromTheWorkingDirectory(t *testing.T) {
	root := Root(t)
	scan := map[string]string{
		filepath.Join(root, "go"):                "os.Getwd",
		filepath.Join(root, "typescript", "src"): "process.cwd",
	}
	for dir, needle := range scan {
		err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
			if nil != err || info.IsDir() || strings.HasSuffix(p, "_test.go") {
				return err
			}
			if !strings.HasSuffix(p, ".go") && !strings.HasSuffix(p, ".ts") {
				return nil
			}
			raw, err := os.ReadFile(p)
			if nil != err {
				return err
			}
			if strings.Contains(string(raw), needle) {
				t.Errorf("%s reads the working directory (%s)", p, needle)
			}
			return nil
		})
		if nil != err {
			t.Fatal(err)
		}
	}
}
