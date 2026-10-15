package likeness

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/voxgig/station/go/station"
	"golang.org/x/term"
)

const configRemedy = "fix the file, or point --config at another"

// takeConfigOption takes `--config PATH` or `--config=PATH` out before the
// command runs. Only a single well-formed one after the command and before `--`
// is taken; anything else is left in place for the grammar to refuse.
func takeConfigOption(argv []string) (rest []string, value string, found bool) {
	at, width, count, bad := -1, 0, 0, false
	for i := 1; i < len(argv); i++ {
		a := argv[i]
		if "--" == a {
			break
		}
		if "--config" == a {
			if i+1 >= len(argv) || flagShaped(argv[i+1]) {
				bad = true
			} else {
				at, width, value = i, 2, argv[i+1]
				count++
			}
			i++
		} else if strings.HasPrefix(a, "--config=") {
			if "" == a[len("--config="):] {
				bad = true
			} else {
				at, width, value = i, 1, a[len("--config="):]
				count++
			}
		}
	}
	rest = append([]string{}, argv...)
	if bad || 1 != count {
		return rest, "", false
	}
	return append(append([]string{}, argv[:at]...), argv[at+width:]...), value, true
}

func probePath(env map[string]string) []map[string]any {
	nameRe := regexp.MustCompile(`^likeness(?:-([a-z]+))?$`)
	seen := map[string]bool{}
	rows := []map[string]any{}
	for _, dir := range filepath.SplitList(env["PATH"]) {
		if "" == dir {
			continue
		}
		names, err := os.ReadDir(dir)
		if nil != err {
			continue
		}
		sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
		for _, e := range names {
			m := nameRe.FindStringSubmatch(e.Name())
			if nil == m {
				continue
			}
			full := filepath.Join(dir, e.Name())
			if seen[full] {
				continue
			}
			info, err := os.Stat(full)
			if nil != err || !info.Mode().IsRegular() {
				continue
			}
			seen[full] = true
			// The port is read from the file NAME, not by running it: `which`
			// must not execute whatever happens to be on PATH under a matching
			// name. A bare `likeness` names no port, and says so.
			rows = append(rows, map[string]any{"path": full, "port": m[1], "version": ""})
		}
	}
	if 0 == len(rows) {
		rows = append(rows, map[string]any{
			"path": "(this port, not on PATH)", "port": Port, "version": Version,
		})
	}
	return rows
}

func optText(m map[string]any, k string) string {
	if v, ok := present(m, k); ok {
		return textOf(v)
	}
	return ""
}

func parseJSON(text, path string) (map[string]any, error) {
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

// prompt reads one line from the terminal with echo off; false at end of
// input.
func prompt(label string) (string, bool) {
	fmt.Fprint(os.Stderr, label+": ")
	typed, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprint(os.Stderr, "\n")
	if nil != err {
		return "", false
	}
	return string(typed), true
}

func readStdin() (string, error) {
	raw, err := io.ReadAll(os.Stdin)
	return wellFormed(string(raw)), err
}

// wellFormed replaces each maximal ill-formed subsequence with one U+FFFD, as
// the WHATWG decoder Node reads argv, the environment and files with does.
// Go's own decoding replaces every byte of one.
func wellFormed(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if r, n := utf8.DecodeRuneInString(s[i:]); utf8.RuneError != r || 1 != n {
			b.WriteString(s[i : i+n])
			i += n
			continue
		}
		b.WriteRune(utf8.RuneError)
		i += maximalSubpart(s[i:])
	}
	return b.String()
}

// maximalSubpart is the length of the ill-formed sequence starting s: its lead
// byte and the continuation bytes that could still have completed it.
func maximalSubpart(s string) int {
	need, lo, hi := 0, byte(0x80), byte(0xBF)
	switch b := s[0]; {
	case 0xC2 <= b && b <= 0xDF:
		need = 1
	case 0xE0 == b:
		need, lo = 2, 0xA0
	case 0xE1 <= b && b <= 0xEC, 0xEE <= b && b <= 0xEF:
		need = 2
	case 0xED == b:
		need, hi = 2, 0x9F
	case 0xF0 == b:
		need, lo = 3, 0x90
	case 0xF1 <= b && b <= 0xF3:
		need = 3
	case 0xF4 == b:
		need, hi = 3, 0x8F
	}
	n := 1
	for n <= need && n < len(s) && lo <= s[n] && s[n] <= hi {
		n++
		lo, hi = 0x80, 0xBF
	}
	return n
}

// Main is the whole process: build the context, run, write, return the status.
func Main(argv []string) int {
	// With SIGPIPE ignored a write to a departed reader reports EPIPE instead
	// of killing the process, and the port exits quietly with 0.
	signal.Ignore(syscall.SIGPIPE)

	for i, a := range argv {
		argv[i] = wellFormed(a)
	}
	rest, configPath, _ := takeConfigOption(argv)

	env := map[string]string{}
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if '=' == kv[i] {
				env[wellFormed(kv[:i])] = wellFormed(kv[i+1:])
				break
			}
		}
	}

	home, _ := os.UserHomeDir()
	path := configPath
	if "" == path {
		path = filepath.Join(home, ".config", "likeness", "station.json")
	}

	config, accounts, cerr := loadConfig(path, profileOf(env))
	if nil != cerr {
		fmt.Fprint(os.Stderr, "error: invalid-project\n  "+cerr.Error()+"\n  remedy  "+configRemedy+"\n")
		return 3
	}

	clock, _ := Rfc3339(time.Now().UnixMilli())
	res := Run(Ctx{
		Argv:     rest,
		Env:      env,
		Clock:    clock,
		Station:  config,
		Accounts: accounts,
		Path:     probePath(env),
		Home:     home,
		Dir:      filepath.Dir(path),
		Stdin:    readStdin,
		TTY:      term.IsTerminal(int(os.Stdin.Fd())),
		Prompt:   prompt,
	})

	if "" != res.Stdout {
		if _, err := fmt.Fprint(os.Stdout, res.Stdout); nil != err && errors.Is(err, syscall.EPIPE) {
			return 0
		}
	}
	if "" != res.Stderr {
		fmt.Fprint(os.Stderr, res.Stderr)
	}
	return res.Exit
}
