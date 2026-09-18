package likeness

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

type ErrorDef struct {
	Code      string `json:"code"`
	Exit      int    `json:"exit"`
	Means     string `json:"means"`
	Partial   bool   `json:"partial"`
	Retryable bool   `json:"retryable"`
}

var (
	registryOnce sync.Once
	registry     map[string]ErrorDef
	registryErr  error
)

func specDir() (string, error) {
	dir, err := os.Getwd()
	if nil != err {
		return "", err
	}
	for i := 0; i < 8; i++ {
		p := filepath.Join(dir, "spec", "errors.json")
		if _, err := os.Stat(p); nil == err {
			return filepath.Join(dir, "spec"), nil
		}
		up := filepath.Dir(dir)
		if up == dir {
			break
		}
		dir = up
	}
	return "", fmt.Errorf("spec/errors.json not found above the working directory - run `make spec-build` from the repository root")
}

func Errors() (map[string]ErrorDef, error) {
	registryOnce.Do(func() {
		dir, err := specDir()
		if nil != err {
			registryErr = err
			return
		}
		raw, err := os.ReadFile(filepath.Join(dir, "errors.json"))
		if nil != err {
			registryErr = err
			return
		}
		var doc struct {
			Error map[string]ErrorDef `json:"error"`
		}
		if err := json.Unmarshal(raw, &doc); nil != err {
			registryErr = err
			return
		}
		registry = doc.Error
	})
	return registry, registryErr
}

// ExitFor maps a code to its process exit status. An unknown code is a
// programming error, not a runtime condition: every code a port can emit is in
// the registry by construction, so this panics rather than inventing a status.
func ExitFor(code string) int {
	reg, err := Errors()
	if nil != err {
		panic(err)
	}
	def, ok := reg[code]
	if !ok {
		panic("no such error code: " + code)
	}
	return def.Exit
}

/*
PartialCodes is the closed set of codes permitted to carry data on failure. A
caller that branches on `ok` alone stays correct; it just discards results it
could have kept.
*/
func PartialCodes() []string {
	reg, err := Errors()
	if nil != err {
		panic(err)
	}
	out := []string{}
	for _, d := range reg {
		if d.Partial {
			out = append(out, d.Code)
		}
	}
	sort.Strings(out)
	return out
}

// LikenessError is a refusal carrying the code that names it and the remedy
// that fixes it. Every error names a remedy: one without sends the reader to a
// search engine.
type LikenessError struct {
	Code   string
	Msg    string
	Remedy string
	Detail map[string]string
}

func (e *LikenessError) Error() string { return e.Msg }
