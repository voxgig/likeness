package likeness

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestEmitParity(t *testing.T) {
	out := os.Getenv("LIKENESS_PARITY_OUT")
	if "" == out {
		t.Skip("LIKENESS_PARITY_OUT is not set")
	}
	root := Root(t)
	for _, e := range corpusEntries(t, root, "cli") {
		r := Run(buildCtx(t, root, e))
		dst := filepath.Join(out, Port, str(e, "id")+".out")
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); nil != err {
			t.Fatal(err)
		}
		body := fmt.Sprintf("exit %d\n--stdout--\n%s--stderr--\n%s", r.Exit, r.Stdout, r.Stderr)
		if err := os.WriteFile(dst, []byte(body), 0o644); nil != err {
			t.Fatal(err)
		}
	}
}
