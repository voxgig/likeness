package likeness

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
)

const mockKey = "joplin-mock-token"
const epoch = "1970-01-01T00:00:00Z"

// startMock runs mock/server.js on a free port and returns its root URL.
func startMock(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("node"); nil != err {
		t.Fatal("node is required: the wire tests drive the real transport against mock/")
	}
	cmd := exec.Command("node", filepath.Join(Root(t), "mock", "server.js"))
	cmd.Env = append(os.Environ(), "LIKENESS_MOCK_PORT=0")
	cmd.Stderr = os.Stderr
	out, err := cmd.StdoutPipe()
	if nil != err {
		t.Fatal(err)
	}
	if err := cmd.Start(); nil != err {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	at := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			line := sc.Text()
			if i := strings.Index(line, "http://"); 0 <= i && strings.Contains(line, "listening on") {
				at <- strings.TrimSpace(line[i:])
			}
		}
	}()
	select {
	case root := <-at:
		return root
	case <-time.After(30 * time.Second):
		t.Fatal("the mock server did not report its address in time")
	}
	return ""
}

// fieldsSent reads the `fields` each Joplin request carried from the mock's ring.
func fieldsSent(t *testing.T, root string) []string {
	t.Helper()
	resp, err := http.Get(root + "/__requests?source=joplin")
	if nil != err {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var rows []struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rows); nil != err {
		t.Fatal(err)
	}
	out := []string{}
	for _, r := range rows {
		u, err := url.Parse(r.URL)
		if nil != err {
			t.Fatal(err)
		}
		out = append(out, u.Query().Get("fields"))
	}
	return out
}

func clearRequests(t *testing.T, root string) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", root+"/__requests", nil)
	resp, err := http.DefaultClient.Do(req)
	if nil != err {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func TestWire(t *testing.T) {
	root := startMock(t)
	// A client straight to the mock, outside station: these tests assert the
	// query the adapter sends, which station's request events do not carry.
	conn := Connection{Instance: "joplin", Account: "local"}
	client := func() *joplin.JoplinSDK {
		return joplin.NewJoplinSDK(map[string]any{"apikey": mockKey, "base": root + "/joplin"})
	}

	t.Run("list asks for the fields the shape needs, and gets real timestamps back", func(t *testing.T) {
		clearRequests(t, root)
		notes, _, err := JoplinList(client(), conn, false)
		if nil != err {
			t.Fatal(err)
		}
		if sent := fieldsSent(t, root); 1 != len(sent) || joplinFields != sent[0] {
			t.Fatalf("fields sent: %q, expected [%q]", sent, joplinFields)
		}
		if 0 == len(notes) {
			t.Fatal("no notes")
		}
		for _, n := range notes {
			if epoch == n.Created || epoch == n.Updated || nil == n.Body {
				t.Fatalf("%s projected to the epoch or lost its body: %+v", n.ID, n)
			}
		}
	})

	t.Run("without fields the mock answers the three Joplin defaults, which project to the epoch", func(t *testing.T) {
		found, err := client().Note(nil).List(map[string]any{}, nil)
		if nil != err {
			t.Fatal(err)
		}
		rows, _ := found.([]any)
		if 0 == len(rows) {
			t.Fatal("no rows")
		}
		for _, r := range rows {
			m := entData(r)
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			if "id parent_id title" != strings.Join(keys, " ") {
				t.Fatalf("default fields: %v", keys)
			}
			n, err := projectNote(m, "jot", "local", false)
			if nil != err {
				t.Fatal(err)
			}
			if epoch != n.Created || nil != n.Body {
				t.Fatalf("a default row should project to the epoch with no body: %+v", n)
			}
		}
	})

	t.Run("load and check ask for the fields too", func(t *testing.T) {
		clearRequests(t, root)
		n, err := JoplinLoad(client(), conn, "a0e50000000000000000000000000001", false)
		if nil != err || nil == n {
			t.Fatalf("load: %v %v", n, err)
		}
		if nil == n.Body || epoch == n.Created {
			t.Fatalf("load projected to the epoch or lost its body: %+v", n)
		}
		ok, code, detail := JoplinCheck(client())
		if !ok {
			t.Fatalf("check: %s %s", code, detail)
		}
		if sent := fieldsSent(t, root); 2 != len(sent) || joplinFields != sent[0] || joplinFields != sent[1] {
			t.Fatalf("fields sent: %q", sent)
		}
	})
}
