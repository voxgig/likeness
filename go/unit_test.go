package likeness

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"

	omni "github.com/voxgig/omni/go"
)

type unitFn func(in any) (any, error)

func unitRegistry() map[string]unitFn {
	return map[string]unitFn{
		"serialise": func(in any) (any, error) {
			return Serialise(in)
		},

		"parseSelector": func(in any) (any, error) {
			n, err := ParseSelector(in.(string))
			if nil != err {
				return nil, err
			}
			return n.Model(), nil
		},

		// The error itself is the answer. An entry asserts the BYTE OFFSET it
		// reports and the token it blames, because an error without them sends
		// the reader to count characters by hand.
		"parseSelectorError": func(in any) (any, error) {
			_, err := ParseSelector(in.(string))
			if nil == err {
				return nil, fmt.Errorf("expected a SelectorError and %q parsed cleanly", in)
			}
			se, ok := err.(*SelectorError)
			if !ok {
				return nil, fmt.Errorf("expected a *SelectorError, got %T: %v", err, err)
			}
			return map[string]any{"offset": se.Offset, "token": se.Token}, nil
		},

		"compareCodePoints": func(in any) (any, error) {
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

		"lid": func(in any) (any, error) {
			a := in.([]any)
			return Lid(a[0].(string), a[1].(string), a[2].(string), a[3].(string)), nil
		},

		"rfc3339": func(in any) (any, error) {
			n, ok := num(in)
			if !ok {
				return nil, fmt.Errorf("not an integer: %v (%T)", in, in)
			}
			return Rfc3339(n)
		},

		"crockfordAlphabet": func(in any) (any, error) { return Crockford, nil },
		"foldCase":          func(in any) (any, error) { return foldCase(in.(string)), nil },
		"takeConfigOption": func(in any) (any, error) {
			rest, value, found := takeConfigOption(strs(in))
			out := map[string]any{"rest": strList(rest)}
			if found {
				out["value"] = value
			}
			return out, nil
		},
		"parseArgv": func(in any) (any, error) {
			p, err := ParseArgv(strs(in))
			if nil != err {
				return nil, err
			}
			return map[string]any{"command": p.Command, "flags": p.Flags, "args": strList(p.Args)}, nil
		},
		"connections": func(in any) (any, error) {
			m := in.(map[string]any)
			config, err := parseStation(str(m, "station"), "station.json")
			if nil != err {
				return nil, err
			}
			env := map[string]string{}
			if p, ok := m["profile"].(string); ok {
				env["VOXGIG_STATION_PROFILE"] = p
			}
			accounts, err := parseAccounts(str(m, "likeness"), "likeness.json", profileOf(env))
			if nil != err {
				return nil, err
			}
			st, err := openStation(config, env)
			if nil != err {
				return nil, err
			}
			conns, err := connectionsOf(st, accounts, profileOf(env))
			if nil != err {
				return nil, err
			}
			out := make([]any, 0, len(conns))
			for _, c := range conns {
				out = append(out, map[string]any{"instance": c.Instance, "source": c.Source, "account": c.Account})
			}
			return out, nil
		},
		"projectJoplin": func(in any) (any, error) {
			m := in.(map[string]any)
			raw, _ := m["raw"].(map[string]any)
			n, err := joplinAdapter{}.project(raw, str(m, "instance"), str(m, "account"), false)
			if nil != err {
				return nil, err
			}
			return n.Value(), nil
		},
		"vaultEntry": func(in any) (any, error) {
			m := in.(map[string]any)
			config, _ := m["station"].(map[string]any)
			profile := str(m, "profile")
			if "" == profile {
				profile = "default"
			}
			e, err := vaultEntry(config, profile, "/home/u", "/home/u/.config/likeness", str(m, "key"))
			if nil != err {
				return nil, err
			}
			return map[string]any{"file": e.File, "key": e.Key, "shown": e.Shown}, nil
		},
		"obsidianUrl": func(in any) (any, error) {
			m := in.(map[string]any)
			return obsidianURL(str(m, "vault"), str(m, "path")), nil
		},
		"vaultEntries": func(in any) (any, error) {
			got, err := vaultEntries(in.([]any))
			return strList(got), err
		},
		"vaultWalk": func(in any) (any, error) {
			listings, _ := in.(map[string]any)["listings"].(map[string]any)
			steps := []any{}
			err := vaultWalk("", func(step vaultStep) ([]string, error) {
				steps = append(steps, step.value())
				if "list" != step.kind {
					return nil, nil
				}
				listed, _ := listings[step.path].([]any)
				return vaultEntries(listed)
			})
			return steps, err
		},
		"obsidianTransport": func(in any) (any, error) {
			m := in.(map[string]any)
			block, _ := m["block"].(map[string]any)
			got, err := obsidianAdapter{}.transport(str(m, "instance"), block)
			return got.value(), err
		},
		"projectObsidian": func(in any) (any, error) {
			m := in.(map[string]any)
			n, err := obsidianAdapter{}.project(m["raw"], str(m, "path"), str(m, "instance"), str(m, "account"), false)
			if nil != err {
				return nil, err
			}
			return n.Value(), nil
		},
		"notionVersion": func(in any) (any, error) {
			m := in.(map[string]any)
			block, _ := m["block"].(map[string]any)
			got, err := notionAdapter{}.configure(str(m, "instance"), block)
			if nil != err {
				return nil, err
			}
			return map[string]any{"version": got.(pinnedVersion).version}, nil
		},
		"notionTitle": func(in any) (any, error) { return titleOf(in), nil },
		// Absent is `{}`: the corpus has no way to say "no value" but an empty record.
		"notionSpace": func(in any) (any, error) {
			if space, ok := spaceOf(in); ok {
				return map[string]any{"space": space}, nil
			}
			return map[string]any{}, nil
		},
		"notionTime": func(in any) (any, error) { return notionStamp(in, "created_time") },
		"projectNotion": func(in any) (any, error) {
			m := in.(map[string]any)
			n, err := notionAdapter{}.project(m["raw"], str(m, "instance"), str(m, "account"), false)
			if nil != err {
				return nil, err
			}
			return n.Value(), nil
		},
		"parsePin": func(in any) (any, error) {
			return parsePin(in)
		},
		"fingerprintOf": func(in any) (any, error) {
			der, err := hex.DecodeString(in.(string))
			if nil != err {
				return nil, err
			}
			return fingerprintOf(der), nil
		},
		"secretName": func(in any) (any, error) { return secretName(in.(string)), nil },
		"refFor": func(in any) (any, error) {
			m := in.(map[string]any)
			if instance, ok := m["instance"].(string); ok {
				return refFor(str(m, "source"), instance)
			}
			return refFor(str(m, "source"))
		},
		"partialCodes": func(in any) (any, error) {
			codes := PartialCodes()
			out := make([]any, len(codes))
			for i, c := range codes {
				out[i] = c
			}
			return out, nil
		},
	}
}

// plain is fn's answer as canonical JSON reads it back, so `true` and `1`
// stay different answers and a Go value compares as the JSON it prints as.
func plain(fn unitFn) omni.Subject {
	return func(args ...any) (any, error) {
		got, err := fn(args[0])
		if nil != err {
			return nil, err
		}
		text, err := Serialise(got)
		if nil != err {
			return nil, err
		}
		return decodeExact(text)
	}
}

func unitRunner(t *testing.T, root string, subject func(fn string) omni.Subject) *omni.RunPack {
	t.Helper()
	runner, err := omni.MakeRunner(corpusDoc(t, root, "unit"), &omni.Provider{Subject: subject})
	if nil != err {
		t.Fatal(err)
	}
	R, err := runner("unit", nil)
	if nil != err {
		t.Fatal(err)
	}
	return R
}

func registered(reg map[string]unitFn) func(fn string) omni.Subject {
	return func(fn string) omni.Subject {
		if f, ok := reg[fn]; ok {
			return plain(f)
		}
		return nil
	}
}

func TestUnitCorpusIsNotEmpty(t *testing.T) {
	if 0 == len(corpusEntries(t, Root(t), "unit")) {
		t.Fatal("spec/unit.json has no entries - did `make spec-build` run?")
	}
}

func TestUnitCorpusIdsAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, e := range corpusEntries(t, Root(t), "unit") {
		if id := str(e, "id"); seen[id] {
			t.Errorf("duplicate corpus id: %s", id)
		} else {
			seen[id] = true
		}
	}
}

func TestEveryFunctionTheUnitCorpusNamesIsRegistered(t *testing.T) {
	reg := unitRegistry()
	for _, e := range corpusEntries(t, Root(t), "unit") {
		if _, ok := reg[str(e, "fn")]; !ok {
			t.Errorf("%s: no such function in the registry: %s", str(e, "id"), str(e, "fn"))
		}
	}
}

func TestUnitCorpus(t *testing.T) {
	R := unitRunner(t, Root(t), registered(unitRegistry()))
	groups, _ := R.Spec.(map[string]any)
	for _, name := range sortedKeys(groups) {
		t.Run(name, func(t *testing.T) {
			if err := R.RunSetFlags(R.Set(name), omni.Flags{"null": false, "all": true}, nil); nil != err {
				t.Fatal(err)
			}
		})
	}
}

// A guard on the guard: what omni hands a subject must be the corpus's
// numbers exact, and a regression to float64 decoding, here or in omni, would
// quietly turn large integers into approximations that still compare equal to
// themselves.
func TestCorpusNumbersAreExact(t *testing.T) {
	reg := unitRegistry()
	handed := []any{}
	R := unitRunner(t, Root(t), func(fn string) omni.Subject {
		inner := registered(reg)(fn)
		if nil == inner {
			return nil
		}
		return func(args ...any) (any, error) {
			handed = append(handed, args[0])
			return inner(args...)
		}
	})
	groups, _ := R.Spec.(map[string]any)
	set := []any{}
	for _, name := range sortedKeys(groups) {
		for _, e := range groupSet(groups, name) {
			if "rfc3339" == str(e.(map[string]any), "fn") {
				set = append(set, e)
			}
		}
	}
	if 0 == len(set) {
		t.Fatal("the unit corpus has no rfc3339 entry to read")
	}
	if err := R.RunSetFlags(map[string]any{"set": set}, omni.Flags{"null": false, "all": true}, nil); nil != err {
		t.Fatal(err)
	}
	if len(set) != len(handed) {
		t.Fatalf("%d rfc3339 entries, %d inputs handed over", len(set), len(handed))
	}
	for i, in := range handed {
		if _, ok := in.(json.Number); !ok {
			t.Fatalf("%s: omni handed the subject a %T, expected json.Number", str(set[i].(map[string]any), "id"), in)
		}
	}
}
