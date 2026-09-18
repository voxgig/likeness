/* The selector grammar: one parser, ported five times, pinned by the corpus.
 *
 *   selector := or
 *   or       := and ( ('OR'|'or') and )*
 *   and      := not ( ('AND'|'and')? not )*      -- adjacency implies AND
 *   not      := ('NOT'|'not'|'-')? atom
 *   atom     := '(' or ')' | field op value | bareword
 *   op       := ':' | '=' | '!=' | '>' | '<' | '>=' | '<='
 *   value    := bareword | '"' escaped '"' | date | duration
 *   date     := YYYY-MM-DD | 'today' | 'yesterday'
 *   duration := <n>('d'|'w'|'mo'|'y')
 *
 * EVERY ERROR CARRIES A BYTE OFFSET AND THE OFFENDING TOKEN. Not a character
 * offset: the ports do not agree on what a character is, and a UTF-16 index
 * would put the caret in the wrong place the first time someone searches in a
 * language that is not English. Go makes this easy and the others do not,
 * which is exactly why the corpus pins it in bytes.
 */

package likeness

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Fields is CLOSED. A selector naming anything else is refused before any
// request is made, which is a corpus entry rather than a claim.
var Fields = []string{
	"assignee", "author", "body", "created", "has", "instance", "source",
	"space", "state", "status", "tag", "title", "updated",
}

// OrderingOps order their operand. A word cannot be ordered against a date in
// a way five ports would agree on, so these demand a date or a duration.
var OrderingOps = []string{">", "<", ">=", "<="}

// Value is a selector's right-hand side: a word, a date or a duration.
type Value struct {
	K    string // "word" | "date" | "dur"
	V    string // word text, or the date
	N    int    // duration magnitude
	Unit string // "d" | "w" | "mo" | "y"
}

// Node is the parsed selector. One struct with a kind tag rather than an
// interface hierarchy: it is what the corpus compares against, and a shape a
// reader can hold in their head is worth more here than Go idiom.
type Node struct {
	T     string // "or" | "and" | "not" | "cmp" | "text"
	Kids  []*Node
	Kid   *Node
	Field string
	Op    string
	Value *Value
	V     string // text
}

// SelectorError is a refusal with a place. The offset is in BYTES.
type SelectorError struct {
	Msg    string
	Offset int
	Token  string
}

func (e *SelectorError) Error() string { return e.Msg }

// Code is the envelope code this refusal produces.
func (e *SelectorError) Code() string { return "invalid-selector" }

/*
FieldsOf lists every field a selector asks about, sorted and deduplicated.

The core uses this to refuse a question no selected source can answer, BEFORE
any request is made. A bare text term asks about title and body, so it
contributes both rather than nothing: a source that supplied neither could not
answer it either.
*/
func FieldsOf(n *Node) []string {
	seen := map[string]bool{}
	var walk func(*Node)
	walk = func(x *Node) {
		switch x.T {
		case "or", "and":
			for _, k := range x.Kids {
				walk(k)
			}
		case "not":
			walk(x.Kid)
		case "cmp":
			seen[x.Field] = true
		default:
			seen["title"] = true
			seen["body"] = true
		}
	}
	walk(n)
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// -- tokeniser --------------------------------------------------------------

type tok struct {
	kind   string // "word" | "quoted" | "lparen" | "rparen" | "op" | "dash"
	text   string
	offset int // BYTE offset into the UTF-8 encoding of the input
}

func isSpace(r rune) bool {
	return ' ' == r || '\t' == r || '\n' == r || '\r' == r
}

// A bareword stops at whitespace, a paren, or an operator character. '-' is
// NOT a stop: it is only a negation marker at the START of an atom, so
// `rate-limit` is one word while `-tag:x` is a negation.
func isWordStop(r rune) bool {
	return isSpace(r) || '(' == r || ')' == r || ':' == r ||
		'=' == r || '!' == r || '>' == r || '<' == r || '"' == r
}

func tokenise(input string) ([]tok, error) {
	rs := []rune(input)
	toks := []tok{}
	i := 0
	off := 0

	advance := func(n int) {
		for k := 0; k < n; k++ {
			off += utf8.RuneLen(rs[i])
			i++
		}
	}

	for i < len(rs) {
		r := rs[i]

		if isSpace(r) {
			advance(1)
			continue
		}
		if '(' == r {
			toks = append(toks, tok{"lparen", "(", off})
			advance(1)
			continue
		}
		if ')' == r {
			toks = append(toks, tok{"rparen", ")", off})
			advance(1)
			continue
		}

		if '"' == r {
			start := off
			advance(1)
			var v strings.Builder
			closed := false
			for i < len(rs) {
				c := rs[i]
				if '\\' == c {
					advance(1)
					if len(rs) <= i {
						break
					}
					v.WriteRune(rs[i])
					advance(1)
					continue
				}
				if '"' == c {
					advance(1)
					closed = true
					break
				}
				v.WriteRune(c)
				advance(1)
			}
			if !closed {
				return nil, &SelectorError{"unterminated quoted value", start, "\"" + v.String()}
			}
			toks = append(toks, tok{"quoted", v.String(), start})
			continue
		}

		if '!' == r {
			start := off
			if i+1 < len(rs) && '=' == rs[i+1] {
				toks = append(toks, tok{"op", "!=", start})
				advance(2)
				continue
			}
			return nil, &SelectorError{"'!' must be part of '!='", start, "!"}
		}
		if '>' == r || '<' == r {
			start := off
			if i+1 < len(rs) && '=' == rs[i+1] {
				toks = append(toks, tok{"op", string(r) + "=", start})
				advance(2)
				continue
			}
			toks = append(toks, tok{"op", string(r), start})
			advance(1)
			continue
		}
		if ':' == r || '=' == r {
			toks = append(toks, tok{"op", string(r), off})
			advance(1)
			continue
		}

		// '-' negates only when it opens an atom, which the parser decides;
		// the tokeniser marks it and lets a word absorb it otherwise.
		if '-' == r {
			opensAtom := 0 == len(toks)
			if !opensAtom {
				prev := toks[len(toks)-1]
				opensAtom = "lparen" == prev.kind || "op" == prev.kind ||
					"dash" == prev.kind || ("word" == prev.kind && isKeyword(prev.text))
			}
			if opensAtom {
				toks = append(toks, tok{"dash", "-", off})
				advance(1)
				continue
			}
		}

		start := off
		var w strings.Builder
		for i < len(rs) && !isWordStop(rs[i]) {
			w.WriteRune(rs[i])
			advance(1)
		}
		if 0 == w.Len() {
			return nil, &SelectorError{"unexpected character", start, string(rs[i])}
		}
		toks = append(toks, tok{"word", w.String(), start})
	}

	return toks, nil
}

func isKeyword(t string) bool {
	return "AND" == t || "and" == t || "OR" == t || "or" == t || "NOT" == t || "not" == t
}
func isOrKeyword(t *tok) bool {
	return nil != t && "word" == t.kind && ("OR" == t.text || "or" == t.text)
}
func isAndKeyword(t *tok) bool {
	return nil != t && "word" == t.kind && ("AND" == t.text || "and" == t.text)
}
func isNotKeyword(t *tok) bool {
	return nil != t && "word" == t.kind && ("NOT" == t.text || "not" == t.text)
}

// -- value classification ---------------------------------------------------

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// `mo` BEFORE `d|w|y`, or `3mo` tokenises as 3 months in one port and as an
// unparseable `3m` in another.
var durRe = regexp.MustCompile(`^(\d+)(mo|d|w|y)$`)

/*
classify decides what a value token means.

A QUOTED value is always a word and is never reinterpreted. That is the escape
hatch: `title:"2026-01-01"` searches for the text, where `title:2026-01-01` is
a date.
*/
func classify(t tok) (*Value, error) {
	if "quoted" == t.kind {
		return &Value{K: "word", V: t.text}, nil
	}
	s := t.text
	if "today" == s || "yesterday" == s {
		return &Value{K: "date", V: s}, nil
	}
	if dateRe.MatchString(s) {
		parts := strings.Split(s, "-")
		m, _ := strconv.Atoi(parts[1])
		d, _ := strconv.Atoi(parts[2])
		if m < 1 || 12 < m || d < 1 || 31 < d {
			return nil, &SelectorError{"date is out of range", t.offset, s}
		}
		return &Value{K: "date", V: s}, nil
	}
	if m := durRe.FindStringSubmatch(s); nil != m {
		n, _ := strconv.Atoi(m[1])
		return &Value{K: "dur", N: n, Unit: m[2]}, nil
	}
	return &Value{K: "word", V: s}, nil
}

// -- parser -----------------------------------------------------------------

type parser struct {
	toks []tok
	pos  int
	end  int
}

func (p *parser) peek() *tok {
	if p.pos < len(p.toks) {
		return &p.toks[p.pos]
	}
	return nil
}
func (p *parser) next() *tok {
	t := p.peek()
	p.pos++
	return t
}
func (p *parser) atEnd() bool { return len(p.toks) <= p.pos }

// fail with no token points at the END of the input, which is where a dangling
// operator actually went wrong.
func (p *parser) fail(msg string, t *tok) error {
	if nil == t {
		return &SelectorError{msg, p.end, ""}
	}
	return &SelectorError{msg, t.offset, t.text}
}

func (p *parser) parseOr() (*Node, error) {
	first, err := p.parseAnd()
	if nil != err {
		return nil, err
	}
	kids := []*Node{first}
	for isOrKeyword(p.peek()) {
		p.next()
		if p.atEnd() {
			return nil, p.fail("OR must be followed by a term", nil)
		}
		k, err := p.parseAnd()
		if nil != err {
			return nil, err
		}
		kids = append(kids, k)
	}
	if 1 == len(kids) {
		return kids[0], nil
	}
	return &Node{T: "or", Kids: kids}, nil
}

func (p *parser) parseAnd() (*Node, error) {
	first, err := p.parseNot()
	if nil != err {
		return nil, err
	}
	kids := []*Node{first}
	for {
		t := p.peek()
		if nil == t || "rparen" == t.kind || isOrKeyword(t) {
			break
		}
		if isAndKeyword(t) {
			p.next()
			if p.atEnd() {
				return nil, p.fail("AND must be followed by a term", nil)
			}
		}
		// Adjacency implies AND.
		k, err := p.parseNot()
		if nil != err {
			return nil, err
		}
		kids = append(kids, k)
	}
	if 1 == len(kids) {
		return kids[0], nil
	}
	return &Node{T: "and", Kids: kids}, nil
}

func (p *parser) parseNot() (*Node, error) {
	t := p.peek()
	if isNotKeyword(t) || (nil != t && "dash" == t.kind) {
		p.next()
		if p.atEnd() {
			return nil, p.fail("NOT must be followed by a term", nil)
		}
		kid, err := p.parseNot()
		if nil != err {
			return nil, err
		}
		return &Node{T: "not", Kid: kid}, nil
	}
	return p.parseAtom()
}

func (p *parser) parseAtom() (*Node, error) {
	t := p.next()
	if nil == t {
		return nil, p.fail("unexpected end of selector", nil)
	}

	if "lparen" == t.kind {
		inner, err := p.parseOr()
		if nil != err {
			return nil, err
		}
		close := p.next()
		if nil == close {
			return nil, p.fail("unclosed group", nil)
		}
		if "rparen" != close.kind {
			return nil, p.fail("expected )", close)
		}
		return inner, nil
	}
	if "rparen" == t.kind {
		return nil, p.fail("unmatched )", t)
	}
	if "op" == t.kind {
		return nil, p.fail("operator with no field", t)
	}
	if "dash" == t.kind {
		return nil, p.fail("dangling -", t)
	}

	// A quoted token standing alone is full text.
	if "quoted" == t.kind {
		return &Node{T: "text", V: t.text}, nil
	}

	if op := p.peek(); nil != op && "op" == op.kind {
		p.next()
		known := false
		for _, f := range Fields {
			if f == t.text {
				known = true
				break
			}
		}
		if !known {
			return nil, p.fail("unknown field \""+t.text+"\"", t)
		}
		vtok := p.next()
		if nil == vtok {
			return nil, p.fail("\""+t.text+op.text+"\" has no value", nil)
		}
		if "op" == vtok.kind || "lparen" == vtok.kind || "rparen" == vtok.kind || "dash" == vtok.kind {
			return nil, p.fail("expected a value", vtok)
		}
		value, err := classify(*vtok)
		if nil != err {
			return nil, err
		}
		for _, o := range OrderingOps {
			if o == op.text && "word" == value.K {
				return nil, p.fail("\""+op.text+"\" needs a date or a duration, not a bareword", vtok)
			}
		}
		return &Node{T: "cmp", Field: t.text, Op: op.text, Value: value}, nil
	}

	// A bareword with no field is full text.
	return &Node{T: "text", V: t.text}, nil
}

// ParseSelector turns a selector string into an AST, or refuses with a byte
// offset and the offending token.
func ParseSelector(input string) (*Node, error) {
	toks, err := tokenise(input)
	if nil != err {
		return nil, err
	}
	if 0 == len(toks) {
		return nil, &SelectorError{"empty selector", 0, ""}
	}
	p := &parser{toks: toks, end: len(input)}
	node, err := p.parseOr()
	if nil != err {
		return nil, err
	}
	if !p.atEnd() {
		t := p.peek()
		return nil, &SelectorError{"unexpected token", t.offset, t.text}
	}
	return node, nil
}

/*
Model renders the AST in the envelope's own value model, which is what the unit
corpus compares against.

The Go Node is one struct with a kind tag, so it carries fields that do not
apply to the kind in hand; this emits only the ones that do. Without it the
corpus would be comparing Go's zero values against a JSON document that never
had those keys, and every entry would fail for the wrong reason.
*/
func (n *Node) Model() any {
	switch n.T {
	case "or", "and":
		kids := make([]any, len(n.Kids))
		for i, k := range n.Kids {
			kids[i] = k.Model()
		}
		return map[string]any{"t": n.T, "kids": kids}
	case "not":
		return map[string]any{"t": n.T, "kid": n.Kid.Model()}
	case "cmp":
		return map[string]any{"t": n.T, "field": n.Field, "op": n.Op, "value": n.Value.Model()}
	}
	return map[string]any{"t": "text", "v": n.V}
}

// Model renders a selector value the same way.
func (v *Value) Model() map[string]any {
	if "dur" == v.K {
		return map[string]any{"k": "dur", "n": v.N, "unit": v.Unit}
	}
	return map[string]any{"k": v.K, "v": v.V}
}
