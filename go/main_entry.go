package likeness

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

const configRemedy = "fix the file, or point --config at another"

// takeConfigOption takes `--config PATH` or `--config=PATH` out of argv, one
// flag either way, before the command's own argv is parsed.
func takeConfigOption(argv []string) (rest []string, value string, found bool) {
	rest = []string{}
	for i := 0; i < len(argv); i++ {
		if "--config" == argv[i] {
			if i+1 < len(argv) {
				i++
				value, found = argv[i], true
			}
			continue
		}
		if strings.HasPrefix(argv[i], "--config=") {
			value, found = argv[i][len("--config="):], true
			continue
		}
		rest = append(rest, argv[i])
	}
	return rest, value, found
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
			if nil != err || info.IsDir() {
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
	var doc map[string]any
	if err := json.Unmarshal([]byte(text), &doc); nil != err {
		return nil, fmt.Errorf("%s is not valid JSON", path)
	}
	return doc, nil
}

// parseAccounts reads the account each instance ref belongs to.
func parseAccounts(text, path string) (map[string]string, error) {
	doc, err := parseJSON(text, path)
	if nil != err {
		return nil, err
	}
	instances, _ := doc["instances"].(map[string]any)
	out := map[string]string{}
	for ref, v := range instances {
		e, _ := v.(map[string]any)
		if a, ok := present(e, "account"); ok {
			out[ref] = textOf(a)
		}
	}
	return out, nil
}

func profileOf(env map[string]string) string {
	if p := env["VOXGIG_STATION_PROFILE"]; "" != p {
		return p
	}
	return "default"
}

// connectionsOf lists the profile's active instances in ref order. An instance
// with no account is refused: identity may not be derived from the ref.
func connectionsOf(station map[string]any, accounts map[string]string, profile string) ([]Connection, error) {
	profiles, _ := station["profiles"].(map[string]any)
	prof, _ := profiles[profile].(map[string]any)
	sdk, _ := prof["sdk"].(map[string]any)
	refs := make([]string, 0, len(sdk))
	for ref := range sdk {
		refs = append(refs, ref)
	}
	sort.Strings(refs)

	out := []Connection{}
	for _, ref := range refs {
		block, _ := sdk[ref].(map[string]any)
		if false == block["active"] {
			continue
		}
		account := accounts[ref]
		if "" == account {
			return nil, &LikenessError{
				Code:   "invalid-project",
				Msg:    "instance \"" + ref + "\" has no account in likeness.json",
				Remedy: "add `\"" + ref + "\": { \"account\": \"<id>\" }` under `instances` in likeness.json",
			}
		}
		out = append(out, Connection{
			Instance: ref, Source: strings.SplitN(ref, "$", 2)[0], Account: account, Base: optText(block, "base"),
		})
	}
	return out, nil
}

var envTokenRe = regexp.MustCompile(`[^A-Z0-9]+`)

// apikeyEnv is the variable station's env provider reads for a ref's key.
func apikeyEnv(ref string) string {
	return strings.Trim(envTokenRe.ReplaceAllString(strings.ToUpper(ref), "_"), "_") + "_APIKEY"
}

func loadConfig(configPath string) (map[string]any, map[string]string, error) {
	path := configPath
	if "" == path {
		home, err := os.UserHomeDir()
		if nil != err {
			return nil, nil, err
		}
		path = filepath.Join(home, ".config", "likeness", "station.json")
	}
	raw, err := os.ReadFile(path)
	if nil != err {
		return nil, map[string]string{}, nil
	}
	station, err := parseJSON(string(raw), path)
	if nil != err {
		return nil, nil, err
	}
	lpath := filepath.Join(filepath.Dir(path), "likeness.json")
	lraw, err := os.ReadFile(lpath)
	if nil != err {
		return station, map[string]string{}, nil
	}
	accounts, err := parseAccounts(string(lraw), lpath)
	if nil != err {
		return nil, nil, err
	}
	return station, accounts, nil
}

// Main is the whole process: build the context, run, write, return the status.
func Main(argv []string) int {
	// With SIGPIPE ignored a write to a departed reader reports EPIPE instead
	// of killing the process, and the port exits quietly with 0.
	signal.Ignore(syscall.SIGPIPE)

	rest, configPath, _ := takeConfigOption(argv)

	env := map[string]string{}
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if '=' == kv[i] {
				env[kv[:i]] = kv[i+1:]
				break
			}
		}
	}

	station, accounts, cerr := loadConfig(configPath)
	if nil != cerr {
		fmt.Fprint(os.Stderr, "error: invalid-project\n  "+cerr.Error()+"\n  remedy  "+configRemedy+"\n")
		return 3
	}

	res := Run(Ctx{
		Argv:     rest,
		Env:      env,
		Clock:    Rfc3339(time.Now().UnixMilli()),
		Station:  station,
		Accounts: accounts,
		Path:     probePath(env),
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
