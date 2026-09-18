package likeness

import (
	"encoding/json"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
	jcore "github.com/voxgig-sdk/joplin-sdk/go/core"
)

const joplinSource = "joplin"

var JoplinSupplies = []string{
	"source", "instance", "space", "title", "body", "created", "updated",
}

type SourceOpts struct {
	Instance string
	Account  string
	Seed     map[string]any
	APIKey   string
	Base     string
}

func joplinClient(o SourceOpts) *joplin.JoplinSDK {
	if nil != o.Seed {
		return joplin.TestSDK(o.Seed, nil)
	}
	opts := map[string]any{}
	if "" != o.APIKey {
		opts["apikey"] = o.APIKey
	}
	if "" != o.Base {
		opts["base"] = o.Base
	}
	return joplin.NewJoplinSDK(opts)
}

// statusOf digs the HTTP status out of the SDK's error. The generated client
// carries the whole Result, so this reads the status rather than matching on
// the message text, which differs between ports and between revisions.
func statusOf(err error) int {
	je, ok := err.(*jcore.JoplinError)
	if !ok {
		return 0
	}
	r, ok := je.Result.(*jcore.Result)
	if !ok {
		return 0
	}
	return r.Status
}

func sval(m map[string]any, k string) string {
	switch v := m[k].(type) {
	case string:
		return v
	case nil:
		return ""
	}
	return ""
}

func msval(m map[string]any, k string) int64 {
	if n, ok := num(m[k]); ok {
		return n
	}
	return 0
}

func projectNote(raw map[string]any, instance, account string, withRaw bool) (Note, error) {
	id := sval(raw, "id")
	// REFUSED, not fabricated. An empty id derives a valid-LOOKING lid from the
	// empty string, so every such row shares one identity and the note violates
	// the schema's non-empty SourceId invariant. A source that returned a
	// record with no id has returned nothing usable, and the adapter says so.
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
		Title:    sval(raw, "title"),
		URL:      "joplin://x-callback-url/openNote?id=" + id,
		Created:  Rfc3339(msval(raw, "created_time")),
		Updated:  Rfc3339(msval(raw, "updated_time")),
	}
	if p := sval(raw, "parent_id"); "" != p {
		s := p
		n.Space = &s
	}
	if _, ok := raw["body"]; ok {
		s := sval(raw, "body")
		n.Body = &s
	}
	if withRaw {
		b, err := json.Marshal(raw)
		if nil == err {
			s := string(b)
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

func JoplinList(o SourceOpts, calls *Calls, withRaw bool) ([]Note, bool, error) {
	client := joplinClient(o)
	calls.Record(o.Instance, "GET", "/notes")
	found, err := client.Note(nil).List(map[string]any{}, nil)
	if nil != err {
		return nil, false, err
	}
	rows, _ := found.([]any)
	out := make([]Note, 0, len(rows))
	for _, r := range rows {
		n, err := projectNote(entData(r), o.Instance, o.Account, withRaw)
		if nil != err {
			return nil, false, err
		}
		out = append(out, n)
	}
	limit := PageMax(joplinSource)
	return out, 0 < limit && limit <= len(rows), nil
}

func JoplinLoad(o SourceOpts, calls *Calls, id string, withRaw bool) (*Note, error) {
	client := joplinClient(o)
	calls.Record(o.Instance, "GET", "/notes/"+id)
	ent, err := client.Note(nil).Load(map[string]any{"id": id}, nil)
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
	n, err := projectNote(row, o.Instance, o.Account, withRaw)
	if nil != err {
		return nil, err
	}
	return &n, nil
}

// JoplinCheck reports reachability for `doctor`.
//
// It distinguishes the failure modes a user experiences as one - the
// application is not running, the credential was rejected - because the remedy
// differs for each.
func JoplinCheck(o SourceOpts, calls *Calls) (ok bool, code, detail string) {
	client := joplinClient(o)
	calls.Record(o.Instance, "GET", "/notes")
	_, err := client.Note(nil).List(map[string]any{}, nil)
	if nil == err {
		return true, "", "ok"
	}
	if s := statusOf(err); 401 == s || 403 == s {
		return false, "auth-failed", "the token was rejected"
	}
	// 429 is a DIFFERENT condition with a different remedy, and the registry
	// has a code for it that is marked retryable. Folding it into "the
	// application did not answer" tells someone whose requests are being
	// throttled to go and start a program that is already running.
	if 429 == statusOf(err) {
		return false, "rate-limited", "the source is rate limiting this client"
	}
	return false, "source-unavailable", "the application did not answer"
}
