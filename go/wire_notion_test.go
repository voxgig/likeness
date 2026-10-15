package likeness

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	notion "github.com/voxgig-sdk/notion-sdk/go"
)

// The integration token, as the mock reads it from its seed.
const pageToken = "secret_TOKEN"
const pageAccount = "wireworkspace01"
const pageVersion = "2022-06-28"
const page = "2a9e0000-0000-4000-8000-000000000002"

func TestWireNotion(t *testing.T) {
	server := serveMock(t, []string{"notion"}, nil)

	block := func() map[string]any {
		return map[string]any{"base": server.base + "/notion/v1",
			"options": map[string]any{"headers": map[string]any{"notion-version": pageVersion}}}
	}

	// A client bound through station, its token resolved from the vault.
	bound := func(t *testing.T, token string) (liveStation, Connection, any) {
		t.Helper()
		l := live(t, map[string]any{"notion": block()},
			map[string]string{"notion.apikey": token}, map[string]string{"notion": pageAccount})
		conn := l.conns[0]
		config, err := notionAdapter{}.configure(conn.Instance, block())
		if nil != err {
			t.Fatal(err)
		}
		return l, conn, notionAdapter{}.connect(l.st, conn, config, nil)
	}

	t.Run("a page is read with the pinned Notion-Version and the vault's token", func(t *testing.T) {
		server.clear(t)
		l, conn, h := bound(t, pageToken)
		n, err := notionAdapter{}.loadNote(h, conn, page, false)
		if nil != err || nil == n || nil == n.Space {
			t.Fatalf("load: %+v %v", n, err)
		}
		got := []string{n.ID, n.Title, *n.Space, n.URL}
		want := []string{page, "Ship the SDK", "7b3d0000-0000-4000-8000-000000000001",
			"https://www.notion.so/Ship-the-SDK-2a9e0000000040008000000000000002"}
		if !reflect.DeepEqual(want, got) {
			t.Fatalf("note %q, expected %q", got, want)
		}
		seen := server.rows(t, "notion")
		if 1 != len(seen) || "GET" != seen[0].Method || "/notion/v1/pages/"+page != seen[0].URL ||
			200 != seen[0].Status || "ok" != seen[0].Auth || pageVersion != seen[0].Headers["notion-version"] {
			t.Fatalf("rows %+v", seen)
		}
		if a, b := l.asked(), received(seen); !reflect.DeepEqual(a, b) {
			t.Fatalf("station observed %q, the mock received %q", a, b)
		}
		if l.leaks(t, pageToken) {
			t.Fatal("the token reached an event")
		}
	})

	t.Run("doctor's check reaches a page no workspace holds, which only an accepted request finds missing", func(t *testing.T) {
		server.clear(t)
		_, _, h := bound(t, pageToken)
		if r := (notionAdapter{}).check(h); (checkResult{OK: true, Detail: "ok"}) != r {
			t.Fatalf("check: %+v", r)
		}
		seen := server.rows(t, "notion")
		if 1 != len(seen) || "/notion/v1/pages/"+noPage != seen[0].URL || 404 != seen[0].Status ||
			"ok" != seen[0].Auth || pageVersion != seen[0].Headers["notion-version"] {
			t.Fatalf("rows %+v", seen)
		}
	})

	t.Run("a client that sends no Notion-Version is refused, as Notion refuses it", func(t *testing.T) {
		server.clear(t)
		l := live(t, map[string]any{"notion": block()},
			map[string]string{"notion.apikey": pageToken}, map[string]string{"notion": pageAccount})
		bare := notion.NewNotionSDK(l.st.OptionsFor("notion", nil))
		if _, err := bare.Page(nil).Load(map[string]any{"id": page}, nil); 400 != statusOf(err) {
			t.Fatalf("load: status %d, %v", statusOf(err), err)
		}
		seen := server.rows(t, "notion")
		if 1 != len(seen) || 400 != seen[0].Status || "ok" != seen[0].Auth {
			t.Fatalf("rows %+v", seen)
		}
		if v, sent := seen[0].Headers["notion-version"]; sent {
			t.Fatalf("the bare client sent Notion-Version %q", v)
		}
	})

	t.Run("a wrong token is auth-failed", func(t *testing.T) {
		_, _, h := bound(t, "not-the-token")
		if r := (notionAdapter{}).check(h); "auth-failed" != r.Code {
			t.Fatalf("check: %+v", r)
		}
	})

	t.Run("a connection that pins no version is refused before a client exists", func(t *testing.T) {
		_, err := notionAdapter{}.configure("notion", map[string]any{"base": server.base + "/notion/v1"})
		var le *LikenessError
		if !errors.As(err, &le) || "invalid-project" != le.Code || !strings.Contains(le.Msg, "pins no Notion-Version") {
			t.Fatalf("configure: %v", err)
		}
	})
}
