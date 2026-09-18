/* The Joplin adapter: the only file in the port that may name Joplin.
 *
 * NO SOURCE IDENTIFIER APPEARS IN CORE CODE. What a source can and cannot do
 * is a row in spec/caps.aon, read by both the runtime and the tests; a
 * conditional on a source name in the core is the beginning of the rot.
 *
 * Every call goes through the generated SDK from voxgig-sdk, pinned by
 * revision in spec/sources.aon. Nothing here hand-writes an HTTP request: the
 * point of the project is that a generated SDK can carry a real application in
 * five languages, and a hand-rolled client here would put that in doubt.
 */

package likeness

import (
	"encoding/json"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
	jcore "github.com/voxgig-sdk/joplin-sdk/go/core"
)

const joplinSource = "joplin"

/*
JoplinSupplies is the set of Note fields this adapter actually populates.

DECLARED, not inferred. The core asks an adapter what it supplies and refuses a
selector that asks about anything else, so `tag:x` against this source is a
refusal rather than a confident "no matches" computed from a field nobody
fetched. `status` and `state` are absent because Joplin has no status concept,
and `version` because its Data API has no concurrency token - the same reason
the capability matrix records `version_token` false for it.
*/
var JoplinSupplies = []string{
	"source", "instance", "space", "title", "body", "created", "updated",
}

// SourceOpts is what an adapter needs to answer for one connection.
type SourceOpts struct {
	Instance string
	Account  string
	// Seed for the SDK's offline test mode. Present in every test and absent
	// in production, which is the whole of the difference between them.
	Seed   map[string]any
	APIKey string
	Base   string
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

// msval reads an epoch-millisecond field, which arrives as an int from the
// SDK's own map and as a float64 or json.Number from a seed read off disk.
func msval(m map[string]any, k string) int64 {
	if n, ok := num(m[k]); ok {
		return n
	}
	return 0
}

/*
projectNote maps a Joplin note onto the common shape.

`status` is absent rather than invented: Joplin has no status concept, the
capability matrix says so, and a three-value normalisation of nothing would be
a lie the envelope carries. `version` is absent for the same reason. `tags` is
absent because this adapter does not read tag associations - and absent is not
the same answer as empty.
*/
func projectNote(raw map[string]any, instance, account string, withRaw bool) Note {
	id := sval(raw, "id")
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
		// A STRING, never nested structure. The envelope sorts keys
		// recursively and forbids floating point; a real source payload
		// violates both, and canonicalising it would stop it being verbatim.
		b, err := json.Marshal(raw)
		if nil == err {
			s := string(b)
			n.Raw = &s
		}
	}
	return n
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

// JoplinList fetches every note from one connection.
func JoplinList(o SourceOpts, calls *Calls, withRaw bool) ([]Note, error) {
	client := joplinClient(o)
	calls.Record(o.Instance, "GET", "/notes")
	found, err := client.Note(nil).List(map[string]any{}, nil)
	if nil != err {
		return nil, err
	}
	rows, _ := found.([]any)
	out := make([]Note, 0, len(rows))
	for _, r := range rows {
		out = append(out, projectNote(entData(r), o.Instance, o.Account, withRaw))
	}
	return out, nil
}

// JoplinLoad fetches one note, or reports that it does not exist.
//
// A GraphQL source resolves a missing record to empty data where a REST one
// answers 404; normalising both to the same answer is the adapter's job.
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
	n := projectNote(row, o.Instance, o.Account, withRaw)
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
	// A FIXED SENTENCE, never the underlying message. Each port's generated
	// SDK words its transport failures differently and embeds the URL it
	// tried, so passing the message through would put five different strings
	// on stdout for one condition - and would print the configured base URL to
	// anywhere the output is pasted.
	return false, "source-unavailable", "the application did not answer"
}
