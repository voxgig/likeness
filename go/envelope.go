package likeness

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

const Port = "go"

const Version = "0.1.0"

// The declared non-parity fields, as PATHS: StripParityExceptions removes
// exactly these and nothing deeper.
var ParityExceptions = []string{"port", "meta.elapsed_ms", "data.port"}

type SerialiseError struct {
	Msg  string
	Path string
}

func (e *SerialiseError) Error() string {
	p := e.Path
	if "" == p {
		p = "$"
	}
	return e.Msg + " at " + p
}

func EscapeString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case '"' == r:
			b.WriteString("\\\"")
		case '\\' == r:
			b.WriteString("\\\\")
		case r < 0x20:
			b.WriteString(fmt.Sprintf("\\u%04x", r))
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func CompareCodePoints(a, b string) int {
	ar := []rune(a)
	br := []rune(b)
	n := len(ar)
	if len(br) < n {
		n = len(br)
	}
	for i := 0; i < n; i++ {
		if ar[i] != br[i] {
			if ar[i] < br[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(ar) < len(br):
		return -1
	case len(br) < len(ar):
		return 1
	}
	return 0
}

func num(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); nil == err {
			return i, true
		}
		// `1.0` is still an integer, and a port that sees the text must agree
		// with one that only ever sees the number.
		f, err := n.Float64()
		if nil != err || f != math.Trunc(f) || 9007199254740991 < math.Abs(f) {
			return 0, false
		}
		return int64(f), true
	case float64:
		if n != math.Trunc(n) {
			return 0, false
		}
		return int64(n), true
	case int:
		return int64(n), true
	case int64:
		return n, true
	}
	return 0, false
}

// jsNumber renders a float as ECMAScript Number::toString does: plain digits
// between 1e-7 and 1e21, an exponent without leading zeros outside that.
func jsNumber(f float64) string {
	if 0 == f {
		return "0"
	}
	if abs := math.Abs(f); 1e-7 <= abs && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	mant, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.TrimLeft(exp[1:], "0")
	if "" == digits {
		digits = "0"
	}
	return mant + "e" + exp[:1] + digits
}

func renderNumber(v any, path string, loose bool) (string, error) {
	switch n := v.(type) {
	case int:
		return strconv.FormatInt(int64(n), 10), nil
	case int64:
		return strconv.FormatInt(n, 10), nil
	case json.Number:
		// Held to a double's exact range, as the canonical port's parse is.
		if i, err := strconv.ParseInt(n.String(), 10, 64); nil == err {
			if 9007199254740991 < i || i < -9007199254740991 {
				if loose {
					return jsNumber(float64(i)), nil
				}
				return "", &SerialiseError{"integer beyond exact double precision - use a bigint", path}
			}
			return strconv.FormatInt(i, 10), nil
		}
		if f, err := strconv.ParseFloat(n.String(), 64); nil == err {
			if loose {
				return jsNumber(f), nil
			}
			return "", &SerialiseError{"floating point is not representable in the envelope", path}
		}
		return "", &SerialiseError{"integer beyond int64", path}
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return "", &SerialiseError{"not a finite number", path}
		}
		if loose {
			return jsNumber(n), nil
		}
		if n != math.Trunc(n) {
			return "", &SerialiseError{"floating point is not representable in the envelope", path}
		}
		// 2^53, not 2^63: beyond it a float64 cannot name consecutive
		// integers, so a value that looks like an int64 has already lost
		// digits and rendering it would publish the loss as fact.
		if math.Abs(n) > 9007199254740991 {
			return "", &SerialiseError{"integer beyond exact double precision - use a bigint", path}
		}
		return strconv.FormatInt(int64(n), 10), nil
	}
	return "", &SerialiseError{fmt.Sprintf("value of unsupported type %T", v), path}
}

// Render turns a value into the envelope's bytes, with no trailing newline.
//
// Exported so that human output can use it too: encoding/json would emit map
// keys sorted but structs in declaration order, and would escape differently.
// One writer, one set of rules.
func Render(v any, path string) (string, error) {
	return renderValue(v, path, false)
}

// RenderRaw writes a source payload: the same rules with floating point
// permitted, in the form every port reproduces.
func RenderRaw(v any) (string, error) {
	return renderValue(v, "", true)
}

func renderValue(v any, path string, loose bool) (string, error) {
	if nil == v {
		return "null", nil
	}
	switch t := v.(type) {
	case bool:
		if t {
			return "true", nil
		}
		return "false", nil
	case string:
		return EscapeString(t), nil
	case int, int64, float64, json.Number:
		return renderNumber(v, path, loose)
	case []any:
		if 0 == len(t) {
			return "[]", nil
		}
		parts := make([]string, len(t))
		for i, e := range t {
			s, err := renderValue(e, path+"["+strconv.Itoa(i)+"]", loose)
			if nil != err {
				return "", err
			}
			parts[i] = s
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case []string:
		// A convenience for the envelope's own string lists. Rendered exactly
		// as []any would be, never as a Go-specific shorthand.
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = EscapeString(e)
		}
		if 0 == len(parts) {
			return "[]", nil
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		// Go map iteration is RANDOMISED. Sorting is not a tidiness choice
		// here; without it this port produces different bytes on every run.
		sort.Slice(keys, func(i, j int) bool { return CompareCodePoints(keys[i], keys[j]) < 0 })
		if 0 == len(keys) {
			return "{}", nil
		}
		parts := make([]string, len(keys))
		for i, k := range keys {
			s, err := renderValue(t[k], path+"."+k, loose)
			if nil != err {
				return "", err
			}
			parts[i] = EscapeString(k) + ":" + s
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	}
	return "", &SerialiseError{fmt.Sprintf("value of unsupported type %T", v), path}
}

// Serialise is the whole point of the file: a value in, the envelope's bytes
// out, terminated by exactly one LF.
func Serialise(v any) (string, error) {
	s, err := Render(v, "")
	if nil != err {
		return "", err
	}
	return s + "\n", nil
}

// StripParityExceptions removes the declared exceptions BY PATH, never by
// name: the envelope's own `port`, `meta.elapsed_ms`, and the `port` that
// `version` repeats inside an object-valued `data`. A `port` inside a `which`
// row is compared like any other value. Used by the corpus runner; exported so
// the runner and any parity tooling cannot drift apart.
func StripParityExceptions(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	out := map[string]any{}
	for k, e := range m {
		if "port" == k {
			continue
		}
		if inner, ok := e.(map[string]any); ok && ("meta" == k || "data" == k) {
			drop := "port"
			if "meta" == k {
				drop = "elapsed_ms"
			}
			kept := map[string]any{}
			for ik, ie := range inner {
				if drop != ik {
					kept[ik] = ie
				}
			}
			out[k] = kept
			continue
		}
		out[k] = e
	}
	return out
}
