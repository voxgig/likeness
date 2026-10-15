package likeness

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	obsidian "github.com/voxgig-sdk/obsidian-sdk/go"
	ocore "github.com/voxgig-sdk/obsidian-sdk/go/core"
	"github.com/voxgig/station/go/station"
)

const obsidianSource = "obsidian"

var ObsidianSupplies = []string{
	"source", "instance", "space", "title", "body", "tag", "created", "updated",
}

// The one representation of a note that carries its frontmatter, tags and stat.
const noteJSON = "application/vnd.olrapi.note+json"

type obsidianAdapter struct{}

func (obsidianAdapter) source() string     { return obsidianSource }
func (obsidianAdapter) supplies() []string { return ObsidianSupplies }

// vaultTransport is how a connection reaches the plugin: HTTPS trusted by its
// pinned certificate, or plain HTTP.
type vaultTransport struct {
	pinned bool
	pin    string
}

func (t vaultTransport) value() map[string]any {
	if t.pinned {
		return map[string]any{"tls": "pinned", "pin": t.pin}
	}
	return map[string]any{"tls": "off"}
}

// transport reads a connection's block in station.json. HTTPS, the plugin's
// default, is trusted only with a pinned certificate; plain HTTP only where
// the block says so.
func (obsidianAdapter) transport(instance string, block map[string]any) (vaultTransport, error) {
	pin := "pin its certificate under sdk." + instance + " in station.json: " +
		`"options": { "tls": { "fingerprint": "sha256:<hex>" } }`
	refuse := func(what, remedy string) (vaultTransport, error) {
		return vaultTransport{}, refusedBlock(obsidianSource, instance, what, remedy)
	}

	var options any = map[string]any{}
	if v, ok := present(block, "options"); ok {
		options = v
	}
	opts, ok := options.(map[string]any)
	if !ok {
		return refuse("has options that are not a map", "its options take tls alone")
	}
	if extra := otherKeys(opts, "tls"); 0 < len(extra) {
		return refuse("has an option likeness does not read: \""+extra[0]+"\"", "its options take tls alone")
	}

	base := "https://"
	if v, ok := present(block, "base"); ok {
		base = foldCase(textOf(v))
	}
	secure := strings.HasPrefix(base, "https://")
	if !secure && !strings.HasPrefix(base, "http://") {
		return refuse("has a base that is neither https nor http", "name the plugin's address, as https://127.0.0.1:27124")
	}

	tls, declared := opts["tls"]
	if declared && false == tls {
		if secure {
			return refuse("turns TLS off on an https base, and verification is never turned off", pin)
		}
		return vaultTransport{}, nil
	}
	if !secure {
		what := "pins a certificate on a plain HTTP base"
		if !declared {
			what = "is plain HTTP and does not declare it"
		}
		return refuse(what, `declare plain HTTP with "options": { "tls": false }, or use the plugin's HTTPS base with a pinned certificate`)
	}
	if !declared {
		return refuse("pins no certificate, and the plugin's certificate is self-signed", pin)
	}
	fingerprint, ok := tls.(map[string]any)
	if _, has := fingerprint["fingerprint"]; !ok || !has || 1 != len(fingerprint) {
		return refuse("has a tls option that is neither a pinned fingerprint nor false", pin)
	}
	parsed, err := parsePin(fingerprint["fingerprint"])
	if nil != err {
		return refuse("pins a fingerprint that is not sha256 and 64 hex digits", pin)
	}
	return vaultTransport{pinned: true, pin: parsed}, nil
}

func (a obsidianAdapter) configure(instance string, block map[string]any) (any, error) {
	return a.transport(instance, block)
}

type vaultHandle struct {
	sdk      *obsidian.ObsidianSDK
	plain    bool
	instance string
	pinned   *pinnedTransport
}

// fetcherOf serves the SDK's `utility.fetcher` seam from a pinned transport.
func fetcherOf(p *pinnedTransport) ocore.FetcherFunc {
	return func(_ *ocore.Context, fullurl string, fetchdef map[string]any) (any, error) {
		res, err := p.fetch(fullurl, fetchdef)
		if nil != err {
			return nil, err
		}
		return res, nil
	}
}

func (obsidianAdapter) connect(st *station.Station, conn Connection, config any, seed map[string]any) any {
	how, _ := config.(vaultTransport)
	h := &vaultHandle{plain: !how.pinned, instance: conn.Instance}
	extra := map[string]any{"headers": map[string]any{"accept": noteJSON}}
	if nil == seed && how.pinned {
		h.pinned = &pinnedTransport{pin: how.pin}
		extra["utility"] = map[string]any{"fetcher": fetcherOf(h.pinned)}
	}
	opts := st.OptionsFor(conn.Instance, extra)
	if nil != seed {
		h.sdk = obsidian.TestSDK(seed, opts)
	} else {
		h.sdk = obsidian.NewObsidianSDK(opts)
	}
	return h
}

// refusal is the certificate refusal behind an SDK error, if there was one.
func (h *vaultHandle) refusal() *certificateError {
	if nil == h.pinned {
		return nil
	}
	return h.pinned.takeRefusal()
}

var certificateRefusals = map[string]string{
	refusedChanged:     "presented a certificate whose fingerprint is not the one its connection pins",
	refusedExpired:     "presented its pinned certificate, which has expired",
	refusedNotYetValid: "presented its pinned certificate, which is not valid yet",
	refusedWrongHost:   "presented its pinned certificate, which does not name the host connected to",
	refusedInvalid:     "presented a certificate that failed verification",
}

func (h *vaultHandle) rejected(r *certificateError) *LikenessError {
	return &LikenessError{Code: "certificate-rejected",
		Msg:    obsidianSource + " connection \"" + h.instance + "\" " + certificateRefusals[r.refusal],
		Remedy: "if the plugin's certificate was regenerated, pin its new fingerprint in station.json; if not, do not connect",
		Detail: map[string]string{"source": obsidianSource, "instance": h.instance}}
}

func (h *vaultHandle) failed(err error) error {
	if r := h.refusal(); nil != r {
		return h.rejected(r)
	}
	return err
}

// percentEncode encodes every byte but the unreserved characters of RFC 3986,
// hex in capitals.
func percentEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || 0 <= strings.IndexByte("._~-", c) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// obsidianURL is Obsidian's own URI: the vault by its id, which is the
// connection's account.
func obsidianURL(vault, path string) string {
	return "obsidian://open?vault=" + percentEncode(vault) + "&file=" + percentEncode(path)
}

// belowRoot holds where no segment of a vault path is . or .., and only the
// last may be empty.
func belowRoot(segs []string) bool {
	for i, g := range segs {
		if "." == g || ".." == g || ("" == g && i != len(segs)-1) {
			return false
		}
	}
	return true
}

// vaultEntries are a listing's entries, as the plugin lists one directory: by
// first segment, a directory with its slash, each once, in code-point order.
// The plugin names one level as text; the SDK's offline transport lists every
// record of the entity by id, and the same rule walks both to the same tree.
func vaultEntries(listed []any) ([]string, error) {
	seen := map[string]bool{}
	out := []string{}
	for _, e := range listed {
		name, ok := e.(string)
		if m, isRecord := e.(map[string]any); isRecord {
			name, ok = m["id"].(string)
		}
		segs := strings.Split(name, "/")
		if !ok || "" == name || !belowRoot(segs) {
			return nil, &LikenessError{Code: "source-unavailable",
				Msg: obsidianSource + " returned a vault listing with an entry that names no path below it", Remedy: sourceBug}
		}
		first := segs[0]
		if 1 < len(segs) {
			first += "/"
		}
		if !seen[first] {
			seen[first] = true
			out = append(out, first)
		}
	}
	sort.Slice(out, func(i, j int) bool { return CompareCodePoints(out[i], out[j]) < 0 })
	return out, nil
}

// A note is a `.md` file, by its path from the vault root.
func isNote(path string) bool { return strings.HasSuffix(path, ".md") }

// vaultStep lists a directory or reads a note: its kind is `list` or `read`.
type vaultStep struct{ kind, path string }

func (s vaultStep) value() map[string]any { return map[string]any{s.kind: s.path} }

// vaultWalk walks a vault as the plugin lets one be walked: one directory at
// a time, depth first, each directory's entries in code-point order, and each
// note read as it is met. visit answers a list step with that directory's
// entries.
func vaultWalk(dir string, visit func(vaultStep) ([]string, error)) error {
	names, err := visit(vaultStep{"list", dir})
	if nil != err {
		return err
	}
	for _, name := range names {
		path := dir + name
		if strings.HasSuffix(name, "/") {
			err = vaultWalk(path, visit)
		} else if isNote(path) {
			_, err = visit(vaultStep{"read", path})
		}
		if nil != err {
			return err
		}
	}
	return nil
}

// integral is a number's value where it has no fractional part, at any
// magnitude, as Number.isInteger reads one.
func integral(v any) (float64, bool) {
	var f float64
	switch n := v.(type) {
	case json.Number:
		parsed, err := strconv.ParseFloat(n.String(), 64)
		if nil != err {
			return 0, false
		}
		f = parsed
	case float64:
		f = n
	case int64:
		f = float64(n)
	case int:
		f = float64(n)
	default:
		return 0, false
	}
	return f, !math.IsInf(f, 0) && f == math.Trunc(f)
}

func (obsidianAdapter) stamp(v any, field string) (string, error) {
	ms, ok := integral(v)
	if !ok {
		ms = 0
	}
	if ms < rfc3339Min || rfc3339Max < ms {
		return "", &LikenessError{Code: "source-unavailable",
			Msg: obsidianSource + " returned a note whose " + field + " is outside the years 0000 to 9999", Remedy: sourceBug}
	}
	return Rfc3339(int64(ms))
}

// tagsOf reads absent as fetched and empty; a null entry is dropped, any
// other is its text.
func tagsOf(v any) []string {
	out := []string{}
	if nil == v {
		return out
	}
	list, ok := v.([]any)
	if !ok {
		list = []any{v}
	}
	for _, t := range list {
		if nil != t {
			out = append(out, textOf(t))
		}
	}
	return out
}

func (a obsidianAdapter) project(raw any, path, instance, account string, withRaw bool) (Note, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return Note{}, &LikenessError{Code: "source-unavailable",
			Msg: obsidianSource + " returned a note that is not a record", Remedy: sourceBug}
	}
	stat, _ := m["stat"].(map[string]any)
	created, err := a.stamp(stat["ctime"], "stat.ctime")
	if nil != err {
		return Note{}, err
	}
	updated, err := a.stamp(stat["mtime"], "stat.mtime")
	if nil != err {
		return Note{}, err
	}
	at := strings.LastIndex(path, "/")
	n := Note{
		Lid:      Lid(obsidianSource, account, "note", path),
		Source:   obsidianSource,
		Instance: instance,
		ID:       path,
		Title:    strings.TrimSuffix(path[at+1:], ".md"),
		URL:      obsidianURL(account, path),
		Created:  created,
		Updated:  updated,
		Tags:     tagsOf(m["tags"]),
	}
	if 0 < at {
		space := path[:at]
		n.Space = &space
	}
	if v, ok := present(m, "content"); ok {
		body := textOf(v)
		n.Body = &body
	}
	if withRaw {
		if s, err := RenderRaw(m); nil == err {
			n.Raw = &s
		}
	}
	return n, nil
}

func (obsidianAdapter) listing(h *vaultHandle, dir string) ([]string, error) {
	if "" == dir {
		found, err := h.sdk.Vault(nil).List(nil, nil)
		if nil != err {
			if notFound(err) {
				return []string{}, nil
			}
			return nil, h.failed(err)
		}
		items, _ := found.([]any)
		listed := make([]any, len(items))
		for i, e := range items {
			listed[i] = dataOf(e)
		}
		return vaultEntries(listed)
	}
	got, err := h.sdk.Vault(nil).Load(map[string]any{"id": dir}, nil)
	if nil != err {
		if notFound(err) {
			return []string{}, nil
		}
		return nil, h.failed(err)
	}
	m, _ := dataOf(got).(map[string]any)
	files, ok := m["files"].([]any)
	if !ok {
		return nil, &LikenessError{Code: "source-unavailable",
			Msg: obsidianSource + " returned a directory with no list of files", Remedy: sourceBug}
	}
	return vaultEntries(files)
}

func (a obsidianAdapter) read(h *vaultHandle, conn Connection, path string, withRaw bool) (*Note, error) {
	got, err := h.sdk.Vault(nil).Load(map[string]any{"id": path}, nil)
	if nil != err {
		if notFound(err) {
			return nil, nil
		}
		return nil, h.failed(err)
	}
	n, err := a.project(dataOf(got), path, conn.Instance, conn.Account, withRaw)
	if nil != err {
		return nil, err
	}
	return &n, nil
}

var errPageFull = errors.New("the page is full")

// walkNotes skips a directory or a note gone since its parent was listed.
func (a obsidianAdapter) walkNotes(h *vaultHandle, conn Connection, withRaw bool, limit int) ([]Note, bool, error) {
	notes := []Note{}
	err := vaultWalk("", func(step vaultStep) ([]string, error) {
		if "list" == step.kind {
			return a.listing(h, step.path)
		}
		if 0 < limit && limit <= len(notes) {
			return nil, errPageFull
		}
		note, err := a.read(h, conn, step.path, withRaw)
		if nil != note {
			notes = append(notes, *note)
		}
		return nil, err
	})
	if errors.Is(err, errPageFull) {
		return notes, true, nil
	}
	if nil != err {
		return nil, false, err
	}
	return notes, false, nil
}

func (a obsidianAdapter) listNotes(handle any, conn Connection, withRaw bool) ([]Note, bool, error) {
	return a.walkNotes(handle.(*vaultHandle), conn, withRaw, PageMax(obsidianSource))
}

func (a obsidianAdapter) loadNote(handle any, conn Connection, id string, withRaw bool) (*Note, error) {
	if !belowRoot(strings.Split(id, "/")) {
		return nil, &LikenessError{Code: "invalid-ref",
			Msg:    "not a ref: " + conn.Instance + ":" + id + " (a vault path has no empty, . or .. segment)",
			Remedy: "a ref is <instance>:<id>, a lid, #n or @alias"}
	}
	if !isNote(id) {
		return nil, &LikenessError{Code: "not-found",
			Msg:    conn.Instance + ":" + id + " is not a note, which is a .md file",
			Remedy: "check the ref, or run `likeness list` to see what is there"}
	}
	return a.read(handle.(*vaultHandle), conn, id, withRaw)
}

func (obsidianAdapter) check(handle any) checkResult {
	h := handle.(*vaultHandle)
	how := ""
	if h.plain {
		how = ", over plain HTTP as the connection declares"
	}
	_, err := h.sdk.Vault(nil).List(nil, nil)
	if nil == err {
		return checkResult{OK: true, Detail: "ok" + how}
	}
	if r := h.refusal(); nil != r {
		le := h.rejected(r)
		return checkResult{Code: le.Code, Detail: certificateRefusals[r.refusal], Remedy: le.Remedy}
	}
	// An empty vault lists as not found, which only a token the plugin accepted can reach.
	if notFound(err) {
		return checkResult{OK: true, Detail: "ok" + how}
	}
	switch statusOf(err) {
	case 401, 403:
		return checkResult{Code: "auth-failed", Detail: "the token was rejected" + how}
	case 429:
		return checkResult{Code: "rate-limited", Detail: "the source is rate limiting this client" + how}
	}
	return checkResult{Code: "source-unavailable", Detail: "the application did not answer" + how,
		Remedy: "start Obsidian with the Local REST API community plugin enabled"}
}
