package likeness

import (
	"encoding/hex"
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
			return Rfc3339(mustNum(t, in))
		},

		"crockfordAlphabet": func(t *testing.T, in any) (any, error) { return Crockford, nil },
		"foldCase":          func(t *testing.T, in any) (any, error) { return foldCase(in.(string)), nil },
		"takeConfigOption": func(t *testing.T, in any) (any, error) {
			rest, value, found := takeConfigOption(strs(in))
			out := map[string]any{"rest": strList(rest)}
			if found {
				out["value"] = value
			}
			return out, nil
		},
		"parseArgv": func(t *testing.T, in any) (any, error) {
			p, err := ParseArgv(strs(in))
			if nil != err {
				return nil, err
			}
			return map[string]any{"command": p.Command, "flags": p.Flags, "args": strList(p.Args)}, nil
		},
		"connections": func(t *testing.T, in any) (any, error) {
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
		"projectJoplin": func(t *testing.T, in any) (any, error) {
			m := in.(map[string]any)
			raw, _ := m["raw"].(map[string]any)
			n, err := joplinAdapter{}.project(raw, str(m, "instance"), str(m, "account"), false)
			if nil != err {
				return nil, err
			}
			return n.Value(), nil
		},
		"vaultEntry": func(t *testing.T, in any) (any, error) {
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
		"obsidianUrl": func(t *testing.T, in any) (any, error) {
			m := in.(map[string]any)
			return obsidianURL(str(m, "vault"), str(m, "path")), nil
		},
		"vaultEntries": func(t *testing.T, in any) (any, error) {
			got, err := vaultEntries(in.([]any))
			return strList(got), err
		},
		"vaultWalk": func(t *testing.T, in any) (any, error) {
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
		"obsidianTransport": func(t *testing.T, in any) (any, error) {
			m := in.(map[string]any)
			block, _ := m["block"].(map[string]any)
			got, err := obsidianAdapter{}.transport(str(m, "instance"), block)
			return got.value(), err
		},
		"projectObsidian": func(t *testing.T, in any) (any, error) {
			m := in.(map[string]any)
			n, err := obsidianAdapter{}.project(m["raw"], str(m, "path"), str(m, "instance"), str(m, "account"), false)
			if nil != err {
				return nil, err
			}
			return n.Value(), nil
		},
		"notionVersion": func(t *testing.T, in any) (any, error) {
			m := in.(map[string]any)
			block, _ := m["block"].(map[string]any)
			got, err := notionAdapter{}.configure(str(m, "instance"), block)
			if nil != err {
				return nil, err
			}
			return map[string]any{"version": got.(pinnedVersion).version}, nil
		},
		"notionTitle": func(t *testing.T, in any) (any, error) { return titleOf(in), nil },
		// Absent is `{}`: the corpus has no way to say "no value" but an empty record.
		"notionSpace": func(t *testing.T, in any) (any, error) {
			if space, ok := spaceOf(in); ok {
				return map[string]any{"space": space}, nil
			}
			return map[string]any{}, nil
		},
		"notionTime": func(t *testing.T, in any) (any, error) { return notionStamp(in, "created_time") },
		"projectNotion": func(t *testing.T, in any) (any, error) {
			m := in.(map[string]any)
			n, err := notionAdapter{}.project(m["raw"], str(m, "instance"), str(m, "account"), false)
			if nil != err {
				return nil, err
			}
			return n.Value(), nil
		},
		"parsePin": func(t *testing.T, in any) (any, error) {
			return parsePin(in)
		},
		"fingerprintOf": func(t *testing.T, in any) (any, error) {
			der, err := hex.DecodeString(in.(string))
			if nil != err {
				t.Fatal(err)
			}
			return fingerprintOf(der), nil
		},
		"secretName": func(t *testing.T, in any) (any, error) { return secretName(in.(string)), nil },
		"refFor": func(t *testing.T, in any) (any, error) {
			m := in.(map[string]any)
			if instance, ok := m["instance"].(string); ok {
				return refFor(str(m, "source"), instance)
			}
			return refFor(str(m, "source"))
		},
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
