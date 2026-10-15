package likeness

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/voxgig/station/go/station"
)

const configRemedy = "fix the file, or point --config at another"

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

func parseJSON(text, path string) (map[string]any, error) {
	if tooDeep(text) {
		return nil, fmt.Errorf("%s is nested more than %d deep", path, configDepth)
	}
	var parsed any
	if err := json.Unmarshal([]byte(wellFormed(text)), &parsed); nil != err {
		return nil, fmt.Errorf("%s is not valid JSON", path)
	}
	doc, ok := parsed.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s is not a JSON object", path)
	}
	return doc, nil
}

// parseStation reads station.json, which station validates against its own
// shape. Its secret chain is likeness's to check, and is checked when used.
func parseStation(text, path string) (map[string]any, error) {
	doc, err := parseJSON(text, path)
	if nil != err {
		return nil, err
	}
	if _, err := openStation(withChain(doc, []any{}), nil); nil != err {
		if se, ok := err.(*station.Error); ok {
			return nil, fmt.Errorf("%s: %s", path, se.Error())
		}
		return nil, err
	}
	return doc, nil
}

// parseAccounts reads the account each instance ref of one station profile
// belongs to. A profile reads only its own: none is inherited.
func parseAccounts(text, path, profile string) (map[string]string, error) {
	doc, err := parseJSON(text, path)
	if nil != err {
		return nil, err
	}
	profiles, _ := doc["profiles"].(map[string]any)
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
		return "", false, fmt.Errorf("%s cannot be read", path)
	}
	return string(raw), true, nil
}

func loadConfig(path, profile string) (map[string]any, map[string]string, error) {
	text, found, err := readConfig(path)
	if nil != err || !found {
		return nil, map[string]string{}, err
	}
	doc, err := parseStation(text, path)
	if nil != err {
		return nil, nil, err
	}
	lpath := filepath.Join(filepath.Dir(path), "likeness.json")
	ltext, found, err := readConfig(lpath)
	if nil != err {
		return nil, nil, err
	}
	if !found {
		return doc, map[string]string{}, nil
	}
	accounts, err := parseAccounts(ltext, lpath, profile)
	if nil != err {
		return nil, nil, err
	}
	return doc, accounts, nil
}
