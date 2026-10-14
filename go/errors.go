package likeness

import (
	_ "embed"
	"encoding/json"
	"sort"
	"sync"
)

//go:embed spec/errors.json
var errorsJSON []byte

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

func Errors() (map[string]ErrorDef, error) {
	registryOnce.Do(func() {
		var doc struct {
			Error map[string]ErrorDef `json:"error"`
		}
		if err := json.Unmarshal(errorsJSON, &doc); nil != err {
			registryErr = err
			return
		}
		registry = doc.Error
	})
	return registry, registryErr
}

// ExitFor maps a code to its exit status. An unknown code is a programming
// error - every code a port can emit is in the registry - so this panics.
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

// PartialCodes is the closed set of codes permitted to carry data on failure;
// a caller that branches on `ok` alone stays correct and discards less.
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
// that fixes it; one without a remedy sends the reader to a search engine.
type LikenessError struct {
	Code   string
	Msg    string
	Remedy string
	Detail map[string]string
}

func (e *LikenessError) Error() string { return e.Msg }
