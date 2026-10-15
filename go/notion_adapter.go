package likeness

import (
	"regexp"
	"strings"

	notion "github.com/voxgig-sdk/notion-sdk/go"
	"github.com/voxgig/station/go/station"
)

const notionSource = "notion"

// A page is read without its blocks, so it brings no body and no tags.
var NotionSupplies = []string{
	"source", "instance", "space", "title", "created", "updated",
}

// A page id no workspace holds: answered as not found once the token and the
// version are accepted.
const noPage = "00000000-0000-0000-0000-000000000000"

var notionVersionShape = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

var webURL = regexp.MustCompile(`^https?://`)

type notionAdapter struct{}

func (notionAdapter) source() string     { return notionSource }
func (notionAdapter) supplies() []string { return NotionSupplies }

// pinnedVersion is the API version every request carries.
type pinnedVersion struct{ version string }

// configure reads the version pinned in the connection's block in
// station.json as its one header. Notion refuses a request without it, so a
// connection that pins none is refused before any call.
func (notionAdapter) configure(instance string, block map[string]any) (any, error) {
	pin := "pin the API version under sdk." + instance + " in station.json: " +
		`"options": { "headers": { "notion-version": "2022-06-28" } }`
	refuse := func(what, remedy string) (any, error) {
		return nil, refusedBlock(notionSource, instance, what, remedy)
	}

	var options any = map[string]any{}
	if v, ok := present(block, "options"); ok {
		options = v
	}
	opts, ok := options.(map[string]any)
	if !ok {
		return refuse("has options that are not a map", "its options take headers alone")
	}
	if extra := otherKeys(opts, "headers"); 0 < len(extra) {
		return refuse("has an option likeness does not read: \""+extra[0]+"\"", "its options take headers alone")
	}

	var given any = map[string]any{}
	if v, ok := present(opts, "headers"); ok {
		given = v
	}
	headers, ok := given.(map[string]any)
	if !ok {
		return refuse("has headers that are not a map", pin)
	}
	names := keysOf(headers)
	for _, name := range names {
		// ASCII alone, as toLowerCase answers here: Go's folding also takes İ for i and ſ for s.
		if "notion-version" != foldCase(name) {
			return refuse("has a header likeness does not send: \""+name+"\"", "its headers take notion-version alone")
		}
	}
	if 0 == len(names) {
		return refuse("pins no Notion-Version, which every request to Notion carries", pin)
	}
	if 1 < len(names) {
		return refuse("pins Notion-Version more than once", pin)
	}
	version, ok := headers[names[0]].(string)
	if !ok || !notionVersionShape.MatchString(version) {
		return refuse("pins a Notion-Version that is not a date such as 2022-06-28", pin)
	}
	return pinnedVersion{version}, nil
}

// The ref goes in the station feature's options: the SDK refuses a top-level instance option.
func (notionAdapter) connect(st *station.Station, conn Connection, config any, seed map[string]any) any {
	pinned, _ := config.(pinnedVersion)
	opts := st.OptionsFor(conn.Instance, map[string]any{
		"headers": map[string]any{"notion-version": pinned.version},
	})
	if nil != seed {
		return notion.TestSDK(seed, opts)
	}
	return notion.NewNotionSDK(opts)
}

// titleOf is a page's property of type `title`, rich text whose parts' plain
// text is joined. A page with more than one takes the first by name, in
// code-point order.
func titleOf(properties any) string {
	props, ok := properties.(map[string]any)
	if !ok {
		return ""
	}
	for _, name := range keysOf(props) {
		p, ok := props[name].(map[string]any)
		if !ok || "title" != p["type"] {
			continue
		}
		parts, ok := p["title"].([]any)
		if !ok {
			if v, has := present(p, "title"); has {
				return textOf(v)
			}
			return ""
		}
		var b strings.Builder
		for _, part := range parts {
			plain := part
			if m, isRecord := part.(map[string]any); isRecord {
				plain = m["plain_text"]
			}
			if nil != plain {
				b.WriteString(textOf(plain))
			}
		}
		return b.String()
	}
	return ""
}

// spaceOf is a page's parent database, or its parent page; a workspace or a
// block is none.
func spaceOf(parent any) (string, bool) {
	p, ok := parent.(map[string]any)
	if !ok {
		return "", false
	}
	kind, typed := p["type"].(string)
	if !typed {
		kind = "page_id"
		if _, has := present(p, "database_id"); has {
			kind = "database_id"
		}
	}
	var id any
	switch kind {
	case "data_source_id":
		id = p["database_id"]
	case "database_id", "page_id":
		id = p[kind]
	}
	if nil == id {
		return "", false
	}
	space := textOf(id)
	return space, "" != space
}

// notionStamp reads text that is not an RFC 3339 date-time, or a value that
// is not text, as the epoch.
func notionStamp(v any, field string) (string, error) {
	ms := int64(0)
	if text, ok := v.(string); ok {
		ms, _ = parseInstant(text)
	}
	s, err := Rfc3339(ms)
	if nil != err {
		return "", &LikenessError{Code: "source-unavailable",
			Msg: notionSource + " returned a page whose " + field + " is outside the years 0000 to 9999", Remedy: sourceBug}
	}
	return s, nil
}

func (notionAdapter) project(raw any, instance, account string, withRaw bool) (Note, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return Note{}, &LikenessError{Code: "source-unavailable",
			Msg: notionSource + " returned a page that is not a record", Remedy: sourceBug}
	}
	id := ""
	if v, ok := present(m, "id"); ok {
		id = textOf(v)
	}
	if "" == id {
		return Note{}, &LikenessError{Code: "source-unavailable",
			Msg: notionSource + " returned a page with no id", Remedy: sourceBug}
	}
	// Refused, not made up: a page's link is the one thing about it no id can stand in for.
	url, ok := m["url"].(string)
	if !ok || !webURL.MatchString(url) {
		return Note{}, &LikenessError{Code: "source-unavailable",
			Msg: notionSource + " returned a page with no http or https url", Remedy: sourceBug}
	}
	created, err := notionStamp(m["created_time"], "created_time")
	if nil != err {
		return Note{}, err
	}
	updated, err := notionStamp(m["last_edited_time"], "last_edited_time")
	if nil != err {
		return Note{}, err
	}
	n := Note{
		Lid:      Lid(notionSource, account, "note", id),
		Source:   notionSource,
		Instance: instance,
		ID:       id,
		Title:    titleOf(m["properties"]),
		URL:      url,
		Created:  created,
		Updated:  updated,
	}
	if space, ok := spaceOf(m["parent"]); ok {
		n.Space = &space
	}
	if withRaw {
		if s, err := RenderRaw(m); nil == err {
			n.Raw = &s
		}
	}
	return n, nil
}

func (a notionAdapter) loadNote(handle any, conn Connection, id string, withRaw bool) (*Note, error) {
	got, err := handle.(*notion.NotionSDK).Page(nil).Load(map[string]any{"id": id}, nil)
	if nil != err {
		if notFound(err) {
			return nil, nil
		}
		return nil, err
	}
	n, err := a.project(dataOf(got), conn.Instance, conn.Account, withRaw)
	if nil != err {
		return nil, err
	}
	return &n, nil
}

func (notionAdapter) check(handle any) checkResult {
	_, err := handle.(*notion.NotionSDK).Page(nil).Load(map[string]any{"id": noPage}, nil)
	if nil == err || notFound(err) {
		return checkResult{OK: true, Detail: "ok"}
	}
	switch statusOf(err) {
	case 401, 403:
		return checkResult{Code: "auth-failed", Detail: "the token was rejected"}
	case 429:
		return checkResult{Code: "rate-limited", Detail: "the source is rate limiting this client"}
	case 400:
		// The one request the check sends that a pinned version can spoil.
		return checkResult{Code: "source-unavailable", Detail: "the service refused the request",
			Remedy: "pin a Notion-Version that Notion publishes, such as 2022-06-28, under its connection in station.json"}
	}
	return checkResult{Code: "source-unavailable", Detail: "the service did not answer"}
}
