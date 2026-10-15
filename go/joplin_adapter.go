package likeness

import (
	joplin "github.com/voxgig-sdk/joplin-sdk/go"
	"github.com/voxgig/station/go/station"
)

const joplinSource = "joplin"

var JoplinSupplies = []string{
	"source", "instance", "space", "title", "body", "created", "updated",
}

type joplinAdapter struct{}

func (joplinAdapter) source() string     { return joplinSource }
func (joplinAdapter) supplies() []string { return JoplinSupplies }

// connect binds a client to station under its instance ref. A seed puts the
// SDK's offline test transport underneath station.
func (joplinAdapter) connect(st *station.Station, conn Connection, _ any, seed map[string]any) any {
	opts := st.OptionsFor(conn.Instance, nil)
	if nil != seed {
		return joplin.TestSDK(seed, opts)
	}
	return joplin.NewJoplinSDK(opts)
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

func (joplinAdapter) stamp(raw map[string]any, field string) (string, error) {
	s, err := Rfc3339(msval(raw, field))
	if nil != err {
		return "", &LikenessError{
			Code:   "source-unavailable",
			Msg:    "the source returned a " + joplinSource + " record whose " + field + " is outside the years 0000 to 9999",
			Remedy: "this is a bug in the source or its SDK; run with --raw to capture the payload",
		}
	}
	return s, nil
}

func (a joplinAdapter) project(raw map[string]any, instance, account string, withRaw bool) (Note, error) {
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
	created, err := a.stamp(raw, "created_time")
	if nil != err {
		return Note{}, err
	}
	updated, err := a.stamp(raw, "updated_time")
	if nil != err {
		return Note{}, err
	}
	n := Note{
		Lid:      Lid(joplinSource, account, "note", id),
		Source:   joplinSource,
		Instance: instance,
		ID:       id,
		URL:      "joplin://x-callback-url/openNote?id=" + id,
		Created:  created,
		Updated:  updated,
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
	if m, ok := dataOf(v).(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// Joplin answers id, parent_id and title unless asked. The wire name is
// `fields`; the client declares `field`, which Joplin ignores (sdkgen#406).
const joplinFields = "id,parent_id,title,body,created_time,updated_time"

func (a joplinAdapter) listNotes(h any, conn Connection, withRaw bool) ([]Note, bool, error) {
	found, err := h.(*joplin.JoplinSDK).Note(nil).List(map[string]any{"fields": joplinFields}, nil)
	if nil != err {
		return nil, false, err
	}
	rows, _ := found.([]any)
	out := make([]Note, 0, len(rows))
	for _, r := range rows {
		n, err := a.project(entData(r), conn.Instance, conn.Account, withRaw)
		if nil != err {
			return nil, false, err
		}
		out = append(out, n)
	}
	limit := PageMax(joplinSource)
	return out, 0 < limit && limit <= len(rows), nil
}

func (a joplinAdapter) loadNote(h any, conn Connection, id string, withRaw bool) (*Note, error) {
	ent, err := h.(*joplin.JoplinSDK).Note(nil).Load(map[string]any{"id": id, "fields": joplinFields}, nil)
	if nil != err {
		if notFound(err) {
			return nil, nil
		}
		return nil, err
	}
	row := entData(ent)
	if _, ok := row["id"]; !ok {
		return nil, nil
	}
	n, err := a.project(row, conn.Instance, conn.Account, withRaw)
	if nil != err {
		return nil, err
	}
	return &n, nil
}

// check reports reachability for `doctor`, telling apart the failure modes a
// user experiences as one, because the remedy differs for each.
func (joplinAdapter) check(h any) checkResult {
	_, err := h.(*joplin.JoplinSDK).Note(nil).List(map[string]any{"fields": joplinFields}, nil)
	if nil == err {
		return checkResult{OK: true, Detail: "ok"}
	}
	if s := statusOf(err); 401 == s || 403 == s {
		return checkResult{Code: "auth-failed", Detail: "the token was rejected"}
	}
	// Throttling has its own retryable code: "did not answer" sends the user to start a running app.
	if 429 == statusOf(err) {
		return checkResult{Code: "rate-limited", Detail: "the source is rate limiting this client"}
	}
	return checkResult{Code: "source-unavailable", Detail: "the application did not answer"}
}
