/* The parity emitter.
 *
 * Writes each transcript entry's RAW stdout - unstripped, exactly the bytes
 * this port produced - into a directory, for `make parity` to compare against
 * another port's. It emits nothing unless LIKENESS_PARITY_OUT names a
 * directory, so an ordinary test run leaves no files behind.
 *
 * RAW, not stripped, on purpose. The comparison needs both forms: the stripped
 * bytes must MATCH between ports, and the raw bytes must DIFFER, because every
 * envelope carries its own `port`.
 */

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
