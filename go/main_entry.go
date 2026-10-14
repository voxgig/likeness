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

// parseStation reads the connections a station file declares, in instance
// order. Pure, so the unit corpus holds both ports to it.
func parseStation(text, path string) ([]Connection, error) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(text), &doc); nil != err {
		return nil, fmt.Errorf("%s is not valid JSON", path)
	}
	sdk, _ := doc["sdk"].(map[string]any)
	names := make([]string, 0, len(sdk))
	for k := range sdk {
		names = append(names, k)
	}
	sort.Strings(names)

	out := make([]Connection, 0, len(names))
	for _, name := range names {
		e, _ := sdk[name].(map[string]any)
		account := optText(e, "account")
		if "" == account {
			account = optText(e, "org")
		}
		if "" == account {
			return nil, fmt.Errorf(
				"connection %q has no `account` or `org`, and identity may not be "+
					"derived from the instance name - see %s", name, path)
		}
		out = append(out, Connection{
			Instance: name, Source: optText(e, "api"), Account: account,
			APIKey: optText(e, "apikey"), Base: optText(e, "base"),
		})
	}
	return out, nil
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
	return parseStation(string(raw), path)
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

	conns, cerr := loadConnections(configPath)
	if nil != cerr {
		fmt.Fprint(os.Stderr, "error: invalid-project\n  "+cerr.Error()+"\n  remedy  "+configRemedy+"\n")
		return 3
	}

	res := Run(Ctx{
		Argv:        rest,
		Env:         env,
		Clock:       Rfc3339(time.Now().UnixMilli()),
		Connections: conns,
		Path:        probePath(env),
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
