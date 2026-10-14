package likeness

import (
	joplin "github.com/voxgig-sdk/joplin-sdk/go"
	jcore "github.com/voxgig-sdk/joplin-sdk/go/core"
	"github.com/voxgig/station/go/station"
)

const joplinSource = "joplin"

var JoplinSupplies = []string{
	"source", "instance", "space", "title", "body", "created", "updated",
}

// joplinConnect binds a client to station under its instance ref. A seed puts
// the SDK's offline test transport underneath station.
func joplinConnect(st *station.Station, instance string, seed map[string]any) *joplin.JoplinSDK {
	opts := st.OptionsFor(instance, nil)
	if nil != seed {
		return joplin.TestSDK(seed, opts)
	}
	return joplin.NewJoplinSDK(opts)
}

// statusOf digs the HTTP status out of the SDK's error, whose Result is a
// cleaned plain-data copy, rather than matching on the message text, which
// differs between ports and between revisions.
func statusOf(err error) int {
	je, ok := err.(*jcore.JoplinError)
	if !ok {
		return 0
	}
	r, _ := je.Result.(map[string]any)
	if n, ok := num(r["status"]); ok {
		return int(n)
	}
	return 0
}

// textOf renders a non-string value as its canonical JSON text.
func textOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	s, err := RenderRaw(v)
	if nil != err {
		return ""
	}
	return s
}

func present(m map[string]any, k string) (any, bool) {
	v, ok := m[k]
	return v, ok && nil != v
}

// A timestamp that is not an integral number is the epoch.
func msval(m map[string]any, k string) int64 {
	if n, ok := num(m[k]); ok {
		return n
	}
	return 0
}

func projectNote(raw map[string]any, instance, account string, withRaw bool) (Note, error) {
	id := ""
	if v, ok := present(raw, "id"); ok {
		id = textOf(v)
	}
	// Refused, not fabricated: an empty id gives every such row one valid-looking
	// lid, and breaks the schema's non-empty SourceId.
	if "" == id {
		return Note{}, &LikenessError{
			Code:   "source-unavailable",
			Msg:    "the source returned a " + joplinSource + " record with no id",
			Remedy: "this is a bug in the source or its SDK; run with --raw to capture the payload",
		}
	}
	n := Note{
		Lid:      Lid(joplinSource, account, "note", id),
		Source:   joplinSource,
		Instance: instance,
		ID:       id,
		URL:      "joplin://x-callback-url/openNote?id=" + id,
		Created:  Rfc3339(msval(raw, "created_time")),
		Updated:  Rfc3339(msval(raw, "updated_time")),
	}
	if v, ok := present(raw, "title"); ok {
		n.Title = textOf(v)
	}
	if v, ok := present(raw, "parent_id"); ok {
		if s := textOf(v); "" != s {
			n.Space = &s
		}
	}
	if v, ok := present(raw, "body"); ok {
		s := textOf(v)
		n.Body = &s
	}
	if withRaw {
		// The client keeps no bytes (sdkgen#407): the record, re-rendered.
		if s, err := RenderRaw(raw); nil == err {
			n.Raw = &s
		}
	}
	return n, nil
}

func entData(v any) map[string]any {
	type dataer interface{ Data(...any) any }
	if d, ok := v.(dataer); ok {
		if m, ok := d.Data().(map[string]any); ok {
			return m
		}
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// Joplin answers id, parent_id and title unless asked. The wire name is
// `fields`; the client declares `field`, which Joplin ignores (sdkgen#406).
const joplinFields = "id,parent_id,title,body,created_time,updated_time"

func JoplinList(client *joplin.JoplinSDK, conn Connection, withRaw bool) ([]Note, bool, error) {
	found, err := client.Note(nil).List(map[string]any{"fields": joplinFields}, nil)
	if nil != err {
		return nil, false, err
	}
	rows, _ := found.([]any)
	out := make([]Note, 0, len(rows))
	for _, r := range rows {
		n, err := projectNote(entData(r), conn.Instance, conn.Account, withRaw)
		if nil != err {
			return nil, false, err
		}
		out = append(out, n)
	}
	limit := PageMax(joplinSource)
	return out, 0 < limit && limit <= len(rows), nil
}

func JoplinLoad(client *joplin.JoplinSDK, conn Connection, id string, withRaw bool) (*Note, error) {
	ent, err := client.Note(nil).Load(map[string]any{"id": id, "fields": joplinFields}, nil)
	if nil != err {
		if 404 == statusOf(err) {
			return nil, nil
		}
		return nil, err
	}
	row := entData(ent)
	if _, ok := row["id"]; !ok {
		return nil, nil
	}
	n, err := projectNote(row, conn.Instance, conn.Account, withRaw)
	if nil != err {
		return nil, err
	}
	return &n, nil
}

// JoplinCheck reports reachability for `doctor`, telling apart the failure
// modes a user experiences as one, because the remedy differs for each.
func JoplinCheck(client *joplin.JoplinSDK) (ok bool, code, detail string) {
	_, err := client.Note(nil).List(map[string]any{"fields": joplinFields}, nil)
	if nil == err {
		return true, "", "ok"
	}
	if s := statusOf(err); 401 == s || 403 == s {
		return false, "auth-failed", "the token was rejected"
	}
	// Throttling has its own retryable code: "did not answer" sends the user to start a running app.
	if 429 == statusOf(err) {
		return false, "rate-limited", "the source is rate limiting this client"
	}
	return false, "source-unavailable", "the application did not answer"
}
