package likeness

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"unicode/utf16"

	"github.com/voxgig/station/go/station"
)

const configRemedy = "fix the file, or point --config at another"

// ConfigError is a configuration file refused, in words that name the file.
type ConfigError struct{ Msg string }

func (e *ConfigError) Error() string { return e.Msg }

const configDepth = 64

// tooDeep counts nesting on the text before it is parsed: each port's parser,
// and the copy made of station.json, recurse, and each would give out at its
// own depth.
func tooDeep(text string) bool {
	depth := 0
	quoted := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case quoted && '\\' == c:
			i++
		case quoted:
			quoted = '"' != c
		case '"' == c:
			quoted = true
		case '[' == c || '{' == c:
			depth++
			if configDepth < depth {
				return true
			}
		case (']' == c || '}' == c) && 0 < depth:
			depth--
		}
	}
	return false
}

func nestedTooDeep(path string) error {
	return &ConfigError{fmt.Sprintf("%s is nested more than %d deep", path, configDepth)}
}

func parseJSON(text, path string) (map[string]any, error) {
	if tooDeep(text) {
		return nil, nestedTooDeep(path)
	}
	var parsed any
	if err := json.Unmarshal([]byte(wellFormed(text)), &parsed); nil != err {
		return nil, &ConfigError{path + " is not valid JSON"}
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return nil, &ConfigError{path + " is not a JSON object"}
	}
	return object, nil
}

// parseStation reads station.json, which station validates against its own
// shape. Its secret chain is likeness's to check, and is checked when used.
func parseStation(text, path string) (map[string]any, error) {
	config, err := parseJSON(text, path)
	if nil != err {
		return nil, err
	}
	if _, err := openStation(withChain(config, []any{}), nil); nil != err {
		if se, ok := err.(*station.Error); ok {
			return nil, &ConfigError{path + ": " + se.Error()}
		}
		return nil, err
	}
	return config, nil
}

// parseAccounts reads the account each instance ref of one station profile
// belongs to. A profile reads only its own: none is inherited.
func parseAccounts(text, path, profile string) (map[string]string, error) {
	config, err := parseJSON(text, path)
	if nil != err {
		return nil, err
	}
	profiles, _ := config["profiles"].(map[string]any)
	scoped, _ := profiles[profile].(map[string]any)
	instances, _ := scoped["instances"].(map[string]any)
	out := map[string]string{}
	for ref, v := range instances {
		e, _ := v.(map[string]any)
		if a, ok := present(e, "account"); ok {
			out[ref] = textOf(a)
		}
	}
	return out, nil
}

// readConfig reads one configuration file. A file that is not there is absent;
// one that is there and cannot be read as a file, such as a directory, is
// refused rather than taken for absent.
func readConfig(path string) (string, bool, error) {
	if _, err := os.Stat(path); nil != err {
		return "", false, nil
	}
	raw, err := os.ReadFile(path)
	if nil != err {
		return "", false, &ConfigError{path + " cannot be read"}
	}
	return string(raw), true, nil
}

func loadConfig(path, profile string) (map[string]any, map[string]string, error) {
	text, found, err := readConfig(path)
	if nil != err || !found {
		return nil, map[string]string{}, err
	}
	config, err := parseStation(text, path)
	if nil != err {
		return nil, nil, err
	}
	lpath := filepath.Join(filepath.Dir(path), "likeness.json")
	ltext, found, err := readConfig(lpath)
	if nil != err {
		return nil, nil, err
	}
	if !found {
		return config, map[string]string{}, nil
	}
	accounts, err := parseAccounts(ltext, lpath, profile)
	if nil != err {
		return nil, nil, err
	}
	return config, accounts, nil
}

// heldFile is a file's text, with the bytes and mode it would be put back with.
type heldFile struct {
	text  string
	bytes []byte
	mode  os.FileMode
}

func held(path, named string) (*heldFile, error) {
	if !exists(path) {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if nil != err {
		return nil, &ConfigError{named + " cannot be read"}
	}
	info, err := os.Stat(path)
	if nil != err {
		return nil, &ConfigError{named + " cannot be read"}
	}
	return &heldFile{text: wellFormed(string(raw)), bytes: raw, mode: info.Mode().Perm()}, nil
}

type docKind int

const (
	docLit docKind = iota
	docObj
	docArr
)

/*
doc is a configuration file as it is written: each object's keys in the file's
order, and each key and scalar as its own text, so a file written back after one
change differs from what was read only by that change and by renderDoc's layout.
*/
type doc struct {
	kind   docKind
	raw    string
	fields []*docField
	items  []*doc
}

type docField struct {
	k, raw string
	v      *doc
}

// pairs is an object whose keys keep the order they are given in.
type pairs []pair

type pair struct {
	k string
	v any
}

var errSyntax = errors.New("not valid JSON")

type docScanner struct {
	s  string
	at int
}

func (p *docScanner) skip() {
	for p.at < len(p.s) && 0 <= strings.IndexByte(" \t\n\r", p.s[p.at]) {
		p.at++
	}
}

func (p *docScanner) next(c byte) bool {
	p.skip()
	if p.at < len(p.s) && c == p.s[p.at] {
		p.at++
		return true
	}
	return false
}

func isDigit(c byte) bool { return '0' <= c && c <= '9' }

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i] | 0x20; !isDigit(s[i]) && (c < 'a' || 'f' < c) {
			return false
		}
	}
	return true
}

func digitsFrom(s string, i int) int {
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	return i
}

func (p *docScanner) str() (string, bool) {
	s := p.s
	if len(s) <= p.at || '"' != s[p.at] {
		return "", false
	}
	for i := p.at + 1; i < len(s); i++ {
		switch c := s[i]; {
		case '"' == c:
			raw := s[p.at : i+1]
			p.at = i + 1
			return raw, true
		case c < 0x20:
			return "", false
		case '\\' == c && i+1 < len(s) && 0 <= strings.IndexByte(`"\/bfnrt`, s[i+1]):
			i++
		case '\\' == c && i+5 < len(s) && 'u' == s[i+1] && isHex(s[i+2:i+6]):
			i += 5
		case '\\' == c:
			return "", false
		}
	}
	return "", false
}

func (p *docScanner) scalar() (string, bool) {
	rest := p.s[p.at:]
	for _, word := range []string{"true", "false", "null"} {
		if strings.HasPrefix(rest, word) {
			p.at += len(word)
			return word, true
		}
	}
	i := 0
	if strings.HasPrefix(rest, "-") {
		i++
	}
	switch {
	case i < len(rest) && '0' == rest[i]:
		i++
	case i < len(rest) && isDigit(rest[i]):
		i = digitsFrom(rest, i)
	default:
		return "", false
	}
	if i+1 < len(rest) && '.' == rest[i] && isDigit(rest[i+1]) {
		i = digitsFrom(rest, i+1)
	}
	if i < len(rest) && ('e' == rest[i] || 'E' == rest[i]) {
		j := i + 1
		if j < len(rest) && ('+' == rest[j] || '-' == rest[j]) {
			j++
		}
		if j < len(rest) && isDigit(rest[j]) {
			i = digitsFrom(rest, j)
		}
	}
	p.at += i
	return rest[:i], true
}

func (p *docScanner) value() (*doc, error) {
	if p.next('{') {
		o := &doc{kind: docObj}
		if p.next('}') {
			return o, nil
		}
		for {
			p.skip()
			raw, ok := p.str()
			if !ok || !p.next(':') {
				return nil, errSyntax
			}
			v, err := p.value()
			if nil != err {
				return nil, err
			}
			k := keyOf(raw)
			if same := docFieldOf(o, k); nil != same {
				same.v = v
			} else {
				o.fields = append(o.fields, &docField{k: k, raw: raw, v: v})
			}
			if !p.next(',') {
				break
			}
		}
		if !p.next('}') {
			return nil, errSyntax
		}
		return o, nil
	}
	if p.next('[') {
		a := &doc{kind: docArr}
		if p.next(']') {
			return a, nil
		}
		for {
			v, err := p.value()
			if nil != err {
				return nil, err
			}
			a.items = append(a.items, v)
			if !p.next(',') {
				break
			}
		}
		if !p.next(']') {
			return nil, errSyntax
		}
		return a, nil
	}
	p.skip()
	raw, ok := p.str()
	if !ok {
		raw, ok = p.scalar()
	}
	if !ok {
		return nil, errSyntax
	}
	if '-' == raw[0] || isDigit(raw[0]) {
		if _, err := strconv.ParseFloat(raw, 64); nil != err {
			return nil, errSyntax
		}
	}
	return &doc{kind: docLit, raw: raw}, nil
}

var unescaped = map[byte]byte{'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}

func unitOf(hex string) rune {
	n, _ := strconv.ParseUint(hex, 16, 16)
	return rune(n)
}

// keyOf is a key as JSON.parse reads it. A lone surrogate is written out as
// itself rather than as U+FFFD, so keys compare as the canonical port's do.
func keyOf(raw string) string {
	s := raw[1 : len(raw)-1]
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if '\\' != s[i] {
			b.WriteByte(s[i])
			continue
		}
		i++
		if 'u' != s[i] {
			b.WriteByte(unescaped[s[i]])
			continue
		}
		r := unitOf(s[i+1 : i+5])
		i += 4
		if utf16.IsSurrogate(r) && r < 0xDC00 && strings.HasPrefix(s[i+1:], `\u`) {
			if low := unitOf(s[i+3 : i+7]); utf16.IsSurrogate(low) && 0xDC00 <= low {
				b.WriteRune(utf16.DecodeRune(r, low))
				i += 6
				continue
			}
		}
		if utf16.IsSurrogate(r) {
			b.Write([]byte{0xED, byte(0x80 | r>>6&0x3F), byte(0x80 | r&0x3F)})
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// readDoc reads JSON as JSON.parse does, a key given twice keeping its first
// place and its last value.
func readDoc(s string) (*doc, error) {
	p := &docScanner{s: s}
	d, err := p.value()
	if nil != err {
		return nil, err
	}
	p.skip()
	if p.at != len(s) {
		return nil, errSyntax
	}
	return d, nil
}

// parseDoc refuses a file as the readers above do, and in their words.
func parseDoc(source, path string) (*doc, error) {
	if tooDeep(source) {
		return nil, nestedTooDeep(path)
	}
	d, err := readDoc(source)
	if nil != err {
		return nil, &ConfigError{path + " is not valid JSON"}
	}
	if docObj != d.kind {
		return nil, &ConfigError{path + " is not a JSON object"}
	}
	return d, nil
}

// renderDoc is JSON.stringify's layout at an indent of 2, over the text each
// key and scalar had.
func renderDoc(d *doc) string {
	var b strings.Builder
	renderAt(&b, d, "")
	b.WriteByte('\n')
	return b.String()
}

func renderAt(b *strings.Builder, d *doc, at string) {
	inner := at + "  "
	switch {
	case docLit == d.kind:
		b.WriteString(d.raw)
	case docArr == d.kind && 0 == len(d.items):
		b.WriteString("[]")
	case docArr == d.kind:
		b.WriteString("[\n")
		for i, x := range d.items {
			if 0 < i {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			renderAt(b, x, inner)
		}
		b.WriteString("\n" + at + "]")
	case 0 == len(d.fields):
		b.WriteString("{}")
	default:
		b.WriteString("{\n")
		for i, f := range d.fields {
			if 0 < i {
				b.WriteString(",\n")
			}
			b.WriteString(inner + f.raw + ": ")
			renderAt(b, f.v, inner)
		}
		b.WriteString("\n" + at + "}")
	}
}

// plainOf is what the next reader of the file sees, which is what station validates.
func plainOf(d *doc) map[string]any {
	var out map[string]any
	_ = json.Unmarshal([]byte(renderDoc(d)), &out)
	return out
}

func docOf(v any) *doc {
	switch t := v.(type) {
	case pairs:
		o := &doc{kind: docObj}
		for _, p := range t {
			o.fields = append(o.fields, &docField{k: p.k, raw: EscapeString(p.k), v: docOf(p.v)})
		}
		return o
	case []any:
		a := &doc{kind: docArr}
		for _, x := range t {
			a.items = append(a.items, docOf(x))
		}
		return a
	case string:
		return &doc{kind: docLit, raw: EscapeString(t)}
	}
	raw, _ := RenderRaw(v)
	return &doc{kind: docLit, raw: raw}
}

func docFieldOf(o *doc, k string) *docField {
	if nil == o {
		return nil
	}
	for _, f := range o.fields {
		if k == f.k {
			return f
		}
	}
	return nil
}

func member(o *doc, k string) *doc {
	if f := docFieldOf(o, k); nil != f {
		return f.v
	}
	return nil
}

// put replaces a member where it stands, or adds it last.
func put(o *doc, k string, v *doc) {
	if f := docFieldOf(o, k); nil != f {
		f.v = v
		return
	}
	o.fields = append(o.fields, &docField{k: k, raw: EscapeString(k), v: v})
}

func drop(o *doc, k string) bool {
	if nil == o {
		return false
	}
	for i, f := range o.fields {
		if k == f.k {
			o.fields = append(o.fields[:i], o.fields[i+1:]...)
			return true
		}
	}
	return false
}

func rekey(o *doc, from, to string) {
	if f := docFieldOf(o, from); nil != f {
		f.k, f.raw = to, EscapeString(to)
	}
}

// Fs is the file operations a configuration write goes through.
type Fs struct {
	WriteFile func(path string, data []byte, mode os.FileMode) error
	Rename    func(from, to string) error
	Remove    func(path string) error
}

var osFs = Fs{WriteFile: writeNew, Rename: os.Rename, Remove: os.Remove}

// writeNew creates path, which must not exist yet.
func writeNew(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if nil != err {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); nil == err {
		err = cerr
	}
	return err
}

// fileWrite is one file to replace: its new text, and what it held, nil for a
// file not there yet.
type fileWrite struct {
	path string
	text string
	was  *heldFile
}

type writeError struct {
	path     string
	restored bool
}

func (e *writeError) Error() string { return "could not write " + e.path }

var tempCount atomic.Int64

func tempOf(path string) string {
	return filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+strconv.Itoa(os.Getpid())+"."+
		strconv.FormatInt(tempCount.Add(1), 10)+".tmp")
}

// writeAll replaces every file, or none. Each new text, and each file's old
// bytes, is written beside it before anything is renamed into place, so a
// rename that fails is undone by renames alone. A symlink is replaced where it
// points, so the link survives.
func writeAll(writes []fileWrite, fs Fs) error {
	target := make([]string, len(writes))
	for i, w := range writes {
		target[i] = w.path
		if nil == w.was {
			continue
		}
		info, err := os.Lstat(w.path)
		if nil == err && 0 != info.Mode()&os.ModeSymlink {
			target[i], err = filepath.EvalSymlinks(w.path)
		}
		if nil != err {
			return err
		}
	}

	temps := []string{}
	place := func(path string, data []byte, mode os.FileMode) (string, error) {
		t := tempOf(path)
		if err := fs.WriteFile(t, data, mode); nil != err {
			// A write that fails leaves the file the exclusive open made; EEXIST means it made none.
			if !errors.Is(err, os.ErrExist) {
				_ = fs.Remove(t)
			}
			return "", err
		}
		temps = append(temps, t)
		return t, nil
	}
	tidy := func() {
		for _, t := range temps {
			_ = fs.Remove(t)
		}
	}

	fresh := make([]string, len(writes))
	old := make([]string, len(writes))
	for i, w := range writes {
		mode := os.FileMode(0o600)
		if nil != w.was {
			mode = w.was.mode
		}
		t, err := place(target[i], []byte(w.text), mode)
		if nil != err {
			tidy()
			return &writeError{path: w.path, restored: true}
		}
		fresh[i] = t
	}
	for i, w := range writes {
		if nil == w.was {
			continue
		}
		t, err := place(target[i], w.was.bytes, w.was.mode)
		if nil != err {
			tidy()
			return &writeError{path: w.path, restored: true}
		}
		old[i] = t
	}

	for i, w := range writes {
		if err := fs.Rename(fresh[i], target[i]); nil == err {
			continue
		}
		restored := true
		for j := i - 1; 0 <= j; j-- {
			var err error
			if "" == old[j] {
				err = fs.Remove(target[j])
			} else {
				err = fs.Rename(old[j], target[j])
			}
			if nil != err {
				restored = false
			}
		}
		tidy()
		return &writeError{path: w.path, restored: restored}
	}
	tidy()
	return nil
}
