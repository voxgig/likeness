package likeness

import (
	"crypto/tls"
	"errors"
	goparser "go/parser"
	"go/token"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	obsidian "github.com/voxgig-sdk/obsidian-sdk/go"
)

// The plugin's credential, as the mock reads it from its seed.
const vaultToken = "obsidian-local-rest-api-key-0001"
const vaultAccount = "wirevault000001"

// The notes the mock's vault holds.
var vaultNotes = []string{"mydocument.md", "projects/nested/deep-note.md", "somedirectory/meeting-notes.md",
	"somedirectory/roadmap.md", "welcome.md"}

func certificateRejected(err error) bool {
	var le *LikenessError
	return errors.As(err, &le) && "certificate-rejected" == le.Code
}

func TestWireObsidian(t *testing.T) {
	cert := selfSigned(t, -1, 2)
	other := selfSigned(t, -1, 2)
	secure := serveMock(t, []string{"obsidian"}, &cert)
	plain := serveMock(t, []string{"obsidian"}, nil)

	pinned := func(to throwaway) map[string]any {
		return map[string]any{"base": secure.base + "/obsidian",
			"options": map[string]any{"tls": map[string]any{"fingerprint": fingerprintOf(to.der)}}}
	}

	// A client bound through station, its token resolved from the vault.
	bound := func(t *testing.T, block map[string]any, token string) (liveStation, Connection, any) {
		t.Helper()
		l := live(t, map[string]any{"obsidian": block},
			map[string]string{"obsidian.apikey": token}, map[string]string{"obsidian": vaultAccount})
		conn := l.conns[0]
		config, err := obsidianAdapter{}.configure(conn.Instance, block)
		if nil != err {
			t.Fatal(err)
		}
		return l, conn, obsidianAdapter{}.connect(l.st, conn, config, nil)
	}

	t.Run("a pinned connection reads each note as note JSON with the vault's token", func(t *testing.T) {
		secure.clear(t)
		l, conn, h := bound(t, pinned(cert), vaultToken)
		ids := []string{}
		for _, path := range vaultNotes {
			n, err := obsidianAdapter{}.loadNote(h, conn, path, false)
			if nil != err || nil == n {
				t.Fatalf("%s: %+v %v", path, n, err)
			}
			ids = append(ids, n.ID)
		}
		if !reflect.DeepEqual(vaultNotes, ids) {
			t.Fatalf("notes %q, expected %q", ids, vaultNotes)
		}
		seen := secure.rows(t, "obsidian")
		if len(seen) != len(vaultNotes) {
			t.Fatalf("%d requests for %d notes", len(seen), len(vaultNotes))
		}
		for _, r := range seen {
			if noteJSON != r.Headers["accept"] || "ok" != r.Auth {
				t.Errorf("%s was read with accept %q and a credential the plugin found %s", r.URL, r.Headers["accept"], r.Auth)
			}
		}
		// What station observed is what the mock received, in order, but for
		// how station writes the path.
		asked, sent := l.asked(), received(seen)
		if reflect.DeepEqual(asked, sent) {
			t.Fatal("voxgig/station#50 is fixed: station observed the paths as sent, so compare them as they are")
		}
		decoded := []string{}
		for _, r := range seen {
			decoded = append(decoded, r.Method+" "+decodedPaths.path(r.URL))
		}
		if !reflect.DeepEqual(asked, decoded) {
			t.Fatalf("station observed %q, the mock received %q", asked, sent)
		}
		if l.leaks(t, vaultToken) {
			t.Fatal("the token reached an event")
		}
	})

	t.Run("the walk refuses a root listing the SDK hands over without its names", func(t *testing.T) {
		secure.clear(t)
		_, conn, h := bound(t, pinned(cert), vaultToken)
		listed, err := h.(*vaultHandle).sdk.Vault(nil).List(nil, nil)
		if nil != err {
			t.Fatal(err)
		}
		data := []any{}
		for _, e := range listed.([]any) {
			data = append(data, dataOf(e))
		}
		nameless := map[string]any{}
		if !reflect.DeepEqual([]any{nameless, nameless, nameless, nameless}, data) {
			t.Fatalf("voxgig/sdkgen#419 is fixed: the SDK hands the root listing over as %v, "+
				"so assert the walk as the canonical port's suite does", data)
		}
		_, _, err = obsidianAdapter{}.listNotes(h, conn, false)
		var le *LikenessError
		if !errors.As(err, &le) || "source-unavailable" != le.Code ||
			"obsidian returned a vault listing with an entry that names no path below it" != le.Msg {
			t.Fatalf("list: %v", err)
		}
		if got := received(secure.rows(t, "obsidian")); !reflect.DeepEqual([]string{"GET /obsidian/vault/", "GET /obsidian/vault/"}, got) {
			t.Fatalf("the mock received %q", got)
		}
	})

	t.Run("a note read without the note JSON accept is Markdown, which the client cannot read", func(t *testing.T) {
		secure.clear(t)
		l := live(t, map[string]any{"obsidian": pinned(cert)},
			map[string]string{"obsidian.apikey": vaultToken}, map[string]string{"obsidian": vaultAccount})
		bare := obsidian.NewObsidianSDK(l.st.OptionsFor("obsidian", map[string]any{
			"utility": map[string]any{"fetcher": fetcherOf(&pinnedTransport{pin: fingerprintOf(cert.der)})},
		}))
		if _, err := bare.Vault(nil).Load(map[string]any{"id": "welcome.md"}, nil); nil == err {
			t.Fatal("the client read Markdown as a note")
		}
		rows := secure.rows(t, "obsidian")
		if 1 != len(rows) || 200 != rows[0].Status || "ok" != rows[0].Auth || "application/json" != rows[0].Headers["accept"] {
			t.Fatalf("rows %+v", rows)
		}

		_, conn, h := bound(t, pinned(cert), vaultToken)
		n, err := obsidianAdapter{}.loadNote(h, conn, "welcome.md", false)
		if nil != err || nil == n || "welcome" != n.Title {
			t.Fatalf("load: %+v %v", n, err)
		}
	})

	t.Run("a changed certificate is refused before any request reaches the plugin", func(t *testing.T) {
		secure.clear(t)
		_, conn, h := bound(t, pinned(other), vaultToken)
		if _, _, err := (obsidianAdapter{}).listNotes(h, conn, false); !certificateRejected(err) {
			t.Fatalf("list: %v", err)
		}
		if _, err := (obsidianAdapter{}).loadNote(h, conn, "welcome.md", false); !certificateRejected(err) {
			t.Fatalf("load: %v", err)
		}
		if r := (obsidianAdapter{}).check(h); "certificate-rejected" != r.Code {
			t.Fatalf("check: %+v", r)
		}
		if rows := secure.rows(t, "obsidian"); 0 != len(rows) {
			t.Fatalf("the plugin received %+v", rows)
		}
	})

	t.Run("plain HTTP is used where the connection declares it, and doctor says so", func(t *testing.T) {
		plain.clear(t)
		_, _, h := bound(t, map[string]any{"base": plain.base + "/obsidian", "options": map[string]any{"tls": false}}, vaultToken)
		want := checkResult{OK: true, Detail: "ok, over plain HTTP as the connection declares"}
		if r := (obsidianAdapter{}).check(h); want != r {
			t.Fatalf("check: %+v", r)
		}
		rows := plain.rows(t, "obsidian")
		if 1 != len(rows) || "ok" != rows[0].Auth {
			t.Fatalf("rows %+v", rows)
		}
	})

	t.Run("a wrong token is auth-failed, and an absent plugin is source-unavailable with its remedy", func(t *testing.T) {
		_, _, h := bound(t, pinned(cert), "not-the-token")
		if r := (obsidianAdapter{}).check(h); "auth-failed" != r.Code {
			t.Fatalf("check: %+v", r)
		}
		gone := map[string]any{"base": "https://127.0.0.1:1/obsidian",
			"options": map[string]any{"tls": map[string]any{"fingerprint": fingerprintOf(cert.der)}}}
		_, _, h = bound(t, gone, vaultToken)
		r := obsidianAdapter{}.check(h)
		if "source-unavailable" != r.Code || !strings.Contains(r.Remedy, "start Obsidian with the Local REST API") {
			t.Fatalf("check: %+v", r)
		}
	})
}

// counting is a TLS server that counts the application bytes each connection
// receives, presenting another certificate from its second connection on.
type counting struct {
	url string
	mu  sync.Mutex
	got []int
}

func countingServer(t *testing.T, first throwaway, then *throwaway) *counting {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if nil != err {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	c := &counting{url: "https://" + ln.Addr().String() + "/vault/"}
	go func() {
		for {
			raw, err := ln.Accept()
			if nil != err {
				return
			}
			c.mu.Lock()
			at := len(c.got)
			c.got = append(c.got, 0)
			c.mu.Unlock()
			shown := first
			if nil != then && 0 < at {
				shown = *then
			}
			go c.serve(tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{shown.cert}}), at)
		}
	}()
	return c
}

func (c *counting) serve(conn *tls.Conn, at int) {
	defer conn.Close()
	var head []byte
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		c.mu.Lock()
		c.got[at] += n
		c.mu.Unlock()
		head = append(head, buf[:n]...)
		if strings.Contains(string(head), "\r\n\r\n") {
			_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
			return
		}
		if nil != err {
			return
		}
	}
}

func (c *counting) bytes() []int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]int{}, c.got...)
}

type served struct {
	bytes   []int
	status  int
	refusal string
}

func serve(t *testing.T, first throwaway, then *throwaway, pin string) served {
	t.Helper()
	srv := countingServer(t, first, then)
	res, err := (&pinnedTransport{pin: pin}).fetch(srv.url,
		map[string]any{"method": "GET", "headers": map[string]any{"authorization": "Bearer " + vaultToken}})
	var refused *certificateError
	if errors.As(err, &refused) {
		return served{bytes: srv.bytes(), refusal: refused.refusal}
	}
	if nil != err {
		t.Fatal(err)
	}
	return served{bytes: srv.bytes(), status: res["status"].(int)}
}

func TestWirePinOrder(t *testing.T) {
	cert := selfSigned(t, -1, 2)
	other := selfSigned(t, -1, 2)

	t.Run("no request byte is written before the certificate has matched the pin", func(t *testing.T) {
		// The probe that learns the certificate writes nothing; the request
		// goes on the connection that verified it.
		right := serve(t, cert, nil, fingerprintOf(cert.der))
		if 200 != right.status || 2 != len(right.bytes) || 0 != right.bytes[0] || right.bytes[1] <= 0 {
			t.Fatalf("matched: %+v", right)
		}
		old := selfSigned(t, -3, -1)
		soon := selfSigned(t, 1, 2)
		elsewhere := certFor(t, net.IPv4(127, 0, 0, 2), -1, 2)
		cases := []struct {
			name   string
			first  throwaway
			then   *throwaway
			pinned throwaway
			want   served
		}{
			{"a certificate that is not the pinned one", cert, nil, other, served{bytes: []int{0}, refusal: "changed"}},
			{"a certificate swapped after the probe", cert, &other, cert, served{bytes: []int{0, 0}, refusal: "changed"}},
			{"a pinned certificate that has expired", old, nil, old, served{bytes: []int{0, 0}, refusal: "expired"}},
			{"a pinned certificate not valid yet", soon, nil, soon, served{bytes: []int{0, 0}, refusal: "not-yet-valid"}},
			{"a pinned certificate for another host", elsewhere, nil, elsewhere, served{bytes: []int{0, 0}, refusal: "wrong-host"}},
		}
		for _, c := range cases {
			if got := serve(t, c.first, c.then, fingerprintOf(c.pinned.der)); !reflect.DeepEqual(c.want, got) {
				t.Errorf("%s: %+v, expected %+v", c.name, got, c.want)
			}
		}
	})

	t.Run("a pinned request closes its connection once the response is read", func(t *testing.T) {
		states := make(chan http.ConnState, 64)
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "application/json")
			_, _ = io.WriteString(w, "{}")
		}))
		srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert.cert}}
		srv.Config.ErrorLog = log.New(io.Discard, "", 0)
		srv.Config.ConnState = func(_ net.Conn, s http.ConnState) { states <- s }
		srv.StartTLS()
		defer srv.Close()

		res, err := (&pinnedTransport{pin: fingerprintOf(cert.der)}).fetch(srv.URL+"/vault/",
			map[string]any{"method": "GET", "headers": map[string]any{"connection": "keep-alive"}})
		if nil != err {
			t.Fatal(err)
		}
		if "{}" != res["body"] {
			t.Fatalf("body %q", res["body"])
		}
		// Bounded, so a connection left open fails the test rather than hanging it.
		deadline := time.After(5 * time.Second)
		opened, closed := 0, 0
		for 0 == opened || opened != closed {
			select {
			case s := <-states:
				switch s {
				case http.StateNew:
					opened++
				case http.StateClosed:
					closed++
				}
			case <-deadline:
				t.Fatalf("a connection was left open: %d opened, %d closed", opened, closed)
			}
		}
	})

	t.Run("the adapter reaches a vault through the plugin alone, never its files", func(t *testing.T) {
		for _, file := range []string{"obsidian_adapter.go", "pin.go"} {
			parsed, err := goparser.ParseFile(token.NewFileSet(), filepath.Join(Root(t), "go", file), nil, goparser.ImportsOnly)
			if nil != err {
				t.Fatal(err)
			}
			for _, imp := range parsed.Imports {
				switch path, _ := strconv.Unquote(imp.Path.Value); path {
				case "os", "io/fs", "io/ioutil", "path/filepath":
					t.Errorf("%s imports %s", file, path)
				}
			}
		}
	})
}
