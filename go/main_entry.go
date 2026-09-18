package likeness

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func stripOption(argv []string, name string) []string {
	out := []string{}
	for i := 0; i < len(argv); i++ {
		if argv[i] == name {
			i++
			continue
		}
		if strings.HasPrefix(argv[i], name+"=") {
			continue
		}
		out = append(out, argv[i])
	}
	return out
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

func loadConnections(configPath string) ([]Connection, error) {
	path := configPath
	if "" == path {
		home, err := os.UserHomeDir()
		if nil != err {
			return nil, err
		}
		path = filepath.Join(home, ".config", "likeness", "station.json")
	}
	raw, err := os.ReadFile(path)
	if nil != err {
		return nil, nil
	}
	var doc struct {
		Sdk map[string]struct {
			API     string `json:"api"`
			Account string `json:"account"`
			Org     string `json:"org"`
			APIKey  string `json:"apikey"`
			Base    string `json:"base"`
		} `json:"sdk"`
	}
	if err := json.Unmarshal(raw, &doc); nil != err {
		return nil, err
	}
	names := make([]string, 0, len(doc.Sdk))
	for k := range doc.Sdk {
		names = append(names, k)
	}
	sort.Strings(names)

	out := make([]Connection, 0, len(names))
	for _, name := range names {
		e := doc.Sdk[name]
		account := e.Account
		if "" == account {
			account = e.Org
		}
		if "" == account {
			return nil, fmt.Errorf(
				"connection %q has no `account` or `org`, and identity may not be "+
					"derived from the instance name - see %s", name, path)
		}
		out = append(out, Connection{
			Instance: name, Source: e.API, Account: account,
			APIKey: e.APIKey, Base: e.Base,
		})
	}
	return out, nil
}

// Main is the whole process: build the context, run, write, return the status.
func Main(argv []string) int {
	configPath := ""
	for i, a := range argv {
		if "--config" == a && i+1 < len(argv) {
			configPath = argv[i+1]
		}
	}

	env := map[string]string{}
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if '=' == kv[i] {
				env[kv[:i]] = kv[i+1:]
				break
			}
		}
	}

	conns, cerr := loadConnections(configPath)
	if nil != cerr {
		fmt.Fprint(os.Stderr, "error: invalid-project\n  "+cerr.Error()+"\n")
		return 3
	}

	res := Run(Ctx{
		Argv:        stripOption(argv, "--config"),
		Env:         env,
		Clock:       Rfc3339(time.Now().UnixMilli()),
		Connections: conns,
		Path:        probePath(env),
	})

	if "" != res.Stdout {
		fmt.Fprint(os.Stdout, res.Stdout)
	}
	if "" != res.Stderr {
		fmt.Fprint(os.Stderr, res.Stderr)
	}
	return res.Exit
}
