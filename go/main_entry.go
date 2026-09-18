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
	"sort"
	"time"
)

/*
loadConnections reads the station file.

Identity is bound to the source's OWN account key, never to the user-chosen
instance name, so renaming a connection from `work` to `plan` does not silently
change the identity of every note in it.
*/
func loadConnections(configPath string) []Connection {
	path := configPath
	if "" == path {
		home, err := os.UserHomeDir()
		if nil != err {
			return nil
		}
		path = filepath.Join(home, ".config", "likeness", "station.json")
	}
	raw, err := os.ReadFile(path)
	if nil != err {
		return nil
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
		return nil
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
			account = name
		}
		out = append(out, Connection{
			Instance: name, Source: e.API, Account: account,
			APIKey: e.APIKey, Base: e.Base,
		})
	}
	return out
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

	res := Run(Ctx{
		Argv:        argv,
		Env:         env,
		Clock:       Rfc3339(time.Now().UnixMilli()),
		Connections: loadConnections(configPath),
	})

	if "" != res.Stdout {
		fmt.Fprint(os.Stdout, res.Stdout)
	}
	if "" != res.Stderr {
		fmt.Fprint(os.Stderr, res.Stderr)
	}
	return res.Exit
}
