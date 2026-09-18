/* The process boundary: argv and the environment in, bytes and a status out.
 *
 * Both binaries call this, so `likeness` and `likeness-go` cannot drift into
 * two programs that merely look alike.
 */

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

/*
loadConnections reads the station file.

Identity is bound to the source's OWN account key, never to the user-chosen
instance name, so renaming a connection from `work` to `plan` does not silently
change the identity of every note in it.
*/
/*
stripOption removes an option and its value from argv.

`--config` is read here and must NOT reach the core: left in place it is parsed
as a selector term, so `likeness list --config x.json` matched nothing, and
`likeness --config x.json list` took `--config` as the command.
*/
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

/*
probePath finds every `likeness` and `likeness-<port>` on PATH.

Probed HERE and injected, never in the core: `which` is a corpus entry like
everything else, and a command that read the real PATH could not be one. The
core used to carry a placeholder row for production, which meant `which` could
never answer the question it exists to answer.
*/
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
		// REFUSED rather than defaulted. An earlier version fell back to the
		// instance name, which contradicted the invariant above: renaming such
		// a connection changed every lid it had ever produced, and nothing said
		// so. Saying it once at startup is cheaper than discovering it when
		// stored references stop resolving.
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
