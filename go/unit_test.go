package likeness

import (
	"encoding/json"
	"strings"
	"testing"
)

type unitFn func(t *testing.T, in any) (any, error)

func unitRegistry() map[string]unitFn {
	return map[string]unitFn{
		"serialise": func(t *testing.T, in any) (any, error) {
			return Serialise(in)
		},

		"parseSelector": func(t *testing.T, in any) (any, error) {
			n, err := ParseSelector(in.(string))
			if nil != err {
				return nil, err
			}
			return n.Model(), nil
		},

		// The error itself is the answer. An entry asserts the BYTE OFFSET it
		// reports and the token it blames, because an error without them sends
		// the reader to count characters by hand.
		"parseSelectorError": func(t *testing.T, in any) (any, error) {
			_, err := ParseSelector(in.(string))
			if nil == err {
				t.Fatalf("expected a SelectorError and %q parsed cleanly", in)
			}
			se, ok := err.(*SelectorError)
			if !ok {
				t.Fatalf("expected a *SelectorError, got %T: %v", err, err)
			}
			return map[string]any{"offset": se.Offset, "token": se.Token}, nil
		},

		"compareCodePoints": func(t *testing.T, in any) (any, error) {
			pair := in.([]any)
			// Normalised to -1/0/1: the SIGN is the contract, the magnitude is
			// not, and a port returning a character difference would otherwise
			// pass here and sort identically anyway.
			n := CompareCodePoints(pair[0].(string), pair[1].(string))
			switch {
			case 0 == n:
				return 0, nil
			case 0 < n:
				return 1, nil
			}
			return -1, nil
		},

		"lid": func(t *testing.T, in any) (any, error) {
			a := in.([]any)
			return Lid(a[0].(string), a[1].(string), a[2].(string), a[3].(string)), nil
		},

		"rfc3339": func(t *testing.T, in any) (any, error) {
			return Rfc3339(mustNum(t, in)), nil
		},

		"crockfordAlphabet": func(t *testing.T, in any) (any, error) { return Crockford, nil },
		"partialCodes": func(t *testing.T, in any) (any, error) {
			codes := PartialCodes()
			out := make([]any, len(codes))
			for i, c := range codes {
				out[i] = c
			}
			return out, nil
		},
	}
}

func TestUnitCorpus(t *testing.T) {
	root := Root(t)
	all := corpusEntries(t, root, "unit")
	if 0 == len(all) {
		t.Fatal("spec/unit.json has no entries - did `make spec-build` run?")
	}

	seen := map[string]bool{}
	reg := unitRegistry()

	for _, e := range all {
		id := str(e, "id")
		if seen[id] {
			t.Errorf("duplicate corpus id: %s", id)
		}
		seen[id] = true

		t.Run(id, func(t *testing.T) {
			fn, ok := reg[str(e, "fn")]
			if !ok {
				t.Fatalf("no such function in the registry: %s", str(e, "fn"))
			}

			got, err := fn(t, e["in"])

			if want, isErr := e["err"]; isErr {
				// `err` INSTEAD OF `out`, never alongside it: the shape refuses
				// an entry carrying both, so there is no case where a throw
				// could also be quietly matched against a value.
				if nil == err {
					t.Fatalf("expected an error containing %q, got %v", want, got)
				}
				if !strings.Contains(err.Error(), want.(string)) {
					t.Fatalf("error %q does not contain %q", err.Error(), want)
				}
				return
			}
			if nil != err {
				t.Fatalf("unexpected error: %v", err)
			}

			if a, b := canon(t, got), canon(t, e["out"]); a != b {
				t.Fatalf("\n  want %s  got  %s", b, a)
			}
		})
	}
}

// A guard on the guard: the corpus is read with numbers kept exact, and a
// regression to float64 decoding would quietly turn large integers into
// approximations that still compare equal to themselves.
func TestCorpusNumbersAreExact(t *testing.T) {
	root := Root(t)
	for _, e := range corpusEntries(t, root, "unit") {
		if "rfc3339" != str(e, "fn") {
			continue
		}
		if _, ok := e["in"].(json.Number); !ok {
			t.Fatalf("%s: corpus input decoded as %T, expected json.Number", str(e, "id"), e["in"])
		}
	}
}
