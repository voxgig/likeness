package likeness

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

//go:embed spec/commands.json
var commandsJSON []byte

//go:embed spec/help.json
var helpJSON []byte

// FlagDef is one declared flag.
type FlagDef struct {
	Type   string `json:"type"`
	Short  string `json:"short"`
	Value  string `json:"value"`
	Repeat bool   `json:"repeat"`
	Min    *int64 `json:"min"`
	Max    *int64 `json:"max"`
}

// ArgDef is one declared positional.
type ArgDef struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
	Repeat   bool   `json:"repeat"`
	Short    string `json:"short"`
}

// CommandDef is one declared command.
type CommandDef struct {
	Short  string             `json:"short"`
	Ready  bool               `json:"ready"`
	Writes bool               `json:"writes"`
	Echo   *bool              `json:"echo"`
	Arg    []ArgDef           `json:"arg"`
	Flag   map[string]FlagDef `json:"flag"`
	Exits  []string           `json:"exits"`
}

type helpRow struct {
	Command string `json:"command"`
	Takes   string `json:"takes"`
	Does    string `json:"does"`
}

var (
	tableOnce sync.Once
	table     struct {
		Global  map[string]FlagDef    `json:"global"`
		Command map[string]CommandDef `json:"command"`
	}
	help struct {
		Text map[string]string `json:"text"`
		Rows []helpRow         `json:"rows"`
	}
)

func loadTable() {
	tableOnce.Do(func() {
		if err := json.Unmarshal(commandsJSON, &table); nil != err {
			panic(err)
		}
		if err := json.Unmarshal(helpJSON, &help); nil != err {
			panic(err)
		}
	})
}

func commandDef(name string) (CommandDef, bool) {
	loadTable()
	cmd, ok := table.Command[name]
	return cmd, ok
}

// actionsOf lists a group's actions, `init` in `secrets init`, in code-point
// order.
func actionsOf(group string) []string {
	loadTable()
	out := []string{}
	for name := range table.Command {
		if strings.HasPrefix(name, group+" ") {
			out = append(out, name[len(group)+1:])
		}
	}
	sort.Strings(out)
	return out
}

// commandWords names the command argv starts with, as far as it can be read.
func commandWords(argv []string) []string {
	if 1 < len(argv) {
		if _, one := commandDef(argv[0]); !one {
			if _, two := commandDef(argv[0] + " " + argv[1]); two {
				return []string{argv[0], argv[1]}
			}
		}
	}
	if 0 == len(argv) {
		return []string{""}
	}
	return []string{argv[0]}
}

// Parsed is a command line the grammar accepted.
type Parsed struct {
	Command string
	Flags   map[string]any
	Args    []string
}

var (
	nameRe     = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	integerRe  = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	instanceRe = regexp.MustCompile(`^[a-z][a-z0-9-]*([$][a-z0-9-]+)?$`)
	secretRe   = regexp.MustCompile(`^[a-z0-9_]+(\.[a-z0-9_]+)*$`)
	envvarRe   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

func bad(msg, remedy string) *LikenessError {
	return &LikenessError{Code: "invalid-argument", Msg: msg, Remedy: remedy}
}

func described(typ string, min, max *int64) string {
	switch typ {
	case "integer":
		switch {
		case nil != min && nil != max:
			return "an integer from " + strconv.FormatInt(*min, 10) + " to " + strconv.FormatInt(*max, 10)
		case nil != min:
			return "an integer of at least " + strconv.FormatInt(*min, 10)
		case nil != max:
			return "an integer of at most " + strconv.FormatInt(*max, 10)
		}
		return "an integer"
	case "name":
		return "a name ([a-z][a-z0-9-]*)"
	case "instance":
		return "an instance ref (api or api$tag)"
	case "path":
		return "a path"
	case "secret":
		return "a secret name ([a-z0-9_] words joined by dots)"
	case "envvar":
		return "an environment variable name"
	}
	return "a string"
}

// Within range is decided on the digits, so a value too long for the host's
// number type is refused rather than wrapped.
func inRange(raw string, min, max *int64) (int64, bool) {
	if nil != max && len(raw) > len(strconv.FormatInt(*max, 10)) {
		return 0, false
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if nil != err {
		return 0, false
	}
	return n, (nil == min || *min <= n) && (nil == max || n <= *max)
}

func checked(label, typ string, min, max *int64, raw, remedy string, echo bool) (any, error) {
	var value any = raw
	ok := true
	switch typ {
	case "integer":
		n, within := inRange(raw, min, max)
		ok, value = integerRe.MatchString(raw) && within, n
	case "name":
		ok = nameRe.MatchString(raw)
	case "instance":
		ok = instanceRe.MatchString(raw)
	case "path":
		ok = "" != raw
	case "secret":
		ok = secretRe.MatchString(raw)
	case "envvar":
		ok = envvarRe.MatchString(raw)
	}
	if !ok {
		// Where a secret is most likely to be typed by mistake, never repeated.
		shown := ""
		if echo && "envvar" != typ && "stdin" != typ {
			shown = ", not \"" + raw + "\""
		}
		return nil, bad(label+" takes "+described(typ, min, max)+shown, remedy)
	}
	return value, nil
}

func lookup(cmd CommandDef, name string) (FlagDef, bool) {
	if def, ok := cmd.Flag[name]; ok {
		return def, true
	}
	def, ok := table.Global[name]
	return def, ok
}

func flagShaped(a string) bool {
	return strings.HasPrefix(a, "-") && "-" != a
}

// ParseArgv is the one table-driven parser over the declared command surface
// (SPEC 13.1).
func ParseArgv(argv []string) (Parsed, error) {
	loadTable()
	if 0 == len(argv) {
		return Parsed{}, bad("no command given", "try `likeness list`, or `likeness help` for the command list")
	}
	name := argv[0]
	switch {
	case "--help" == name || "-h" == name:
		name = "help"
	case "--version" == name:
		name = "version"
	case flagShaped(name):
		return Parsed{}, bad("the command comes first, and "+name+" is a flag",
			"put the command first: `likeness list "+name+"`")
	}
	at := 1
	if _, one := table.Command[name]; !one {
		if actions := actionsOf(name); 0 < len(actions) {
			if len(argv) < 2 || strings.HasPrefix(argv[1], "-") {
				return Parsed{}, bad("`"+name+"` needs an action: "+strings.Join(actions[:len(actions)-1], ", ")+
					" or "+actions[len(actions)-1], "run `likeness help "+name+"` for what each does")
			}
			if _, ok := table.Command[name+" "+argv[1]]; !ok {
				return Parsed{}, bad("no such command: "+name+" "+argv[1],
					"run `likeness help "+name+"` for its actions")
			}
			name, at = name+" "+argv[1], 2
		}
	}
	cmd, ok := table.Command[name]
	if !ok {
		return Parsed{}, bad("no such command: "+name, "run `likeness help` for the command list")
	}

	echo := nil == cmd.Echo || *cmd.Echo
	remedy := "run `likeness help " + name + "` for its arguments"
	flags := map[string]any{}
	positional := []string{}
	rest := argv[at:]

	for i := 0; i < len(rest); i++ {
		a := rest[i]
		if "--" == a {
			positional = append(positional, rest[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "--") {
			// A command still being built reads its global flags and nothing else.
			if flagShaped(a) && cmd.Ready {
				if !echo {
					return Parsed{}, bad("an argument begins with - and is not a flag; it is not repeated here, in case it is a secret",
						"a positional that begins with - must follow --")
				}
				return Parsed{}, bad(a+" begins with - and is not a flag; a positional that begins with - must follow --",
					"write `likeness "+name+" -- "+a+"`")
			}
			if !flagShaped(a) {
				positional = append(positional, a)
			}
			continue
		}

		eq := strings.Index(a, "=")
		given := a[2:]
		if -1 != eq {
			given = a[2:eq]
		}
		key := given
		def, found := lookup(cmd, given)
		negated := false
		if !found && strings.HasPrefix(given, "no-") {
			if base, ok := lookup(cmd, given[3:]); ok && "boolean" == base.Type {
				def, found, key, negated = base, true, given[3:], true
			}
		}
		if !found {
			if !cmd.Ready {
				continue
			}
			if !echo {
				return Parsed{}, bad("`"+name+"` has no such flag; it is not repeated here, in case it is a secret", remedy)
			}
			return Parsed{}, bad("`"+name+"` has no flag --"+given, remedy)
		}

		var value any
		if "boolean" == def.Type {
			if -1 != eq {
				return Parsed{}, bad("--"+given+" takes no value", "write --"+key+", or --no-"+key)
			}
			value = !negated
		} else {
			raw, has := "", false
			if -1 != eq {
				raw, has = a[eq+1:], true
			} else if i+1 < len(rest) && !flagShaped(rest[i+1]) {
				i++
				raw, has = rest[i], true
			}
			if !has {
				return Parsed{}, bad("--"+key+" needs a value",
					"write --"+key+" "+def.Value+", or --"+key+"="+def.Value+" for a value that begins with -")
			}
			v, err := checked("--"+key, def.Type, def.Min, def.Max, raw, remedy, echo)
			if nil != err {
				return Parsed{}, err
			}
			value = v
		}

		if def.Repeat {
			list, _ := flags[key].([]any)
			flags[key] = append(list, value)
		} else {
			if _, twice := flags[key]; twice {
				return Parsed{}, bad("--"+key+" was given twice", "give it once")
			}
			flags[key] = value
		}
	}

	if !cmd.Ready {
		return Parsed{Command: name, Flags: flags, Args: []string{}}, nil
	}

	args := []string{}
	p := 0
	for _, def := range cmd.Arg {
		taken := []string{}
		if def.Repeat {
			taken = positional[p:]
		} else if p < len(positional) {
			taken = positional[p : p+1]
		}
		if def.Required && 0 == len(taken) {
			return Parsed{}, bad("`"+name+"` needs <"+def.Name+">", remedy)
		}
		for _, raw := range taken {
			if "stdin" == def.Type && "-" != raw {
				return Parsed{}, bad("`"+name+"` takes - there, never the value itself",
					"pipe the value in, with - after the name")
			}
			if _, err := checked("<"+def.Name+">", def.Type, nil, nil, raw, remedy, echo); nil != err {
				return Parsed{}, err
			}
			args = append(args, raw)
		}
		p += len(taken)
	}
	if p < len(positional) {
		if !echo {
			return Parsed{}, bad("`"+name+"` takes no further argument; it is not repeated here, in case it is a secret", remedy)
		}
		return Parsed{}, bad("`"+name+"` does not take the argument \""+positional[p]+"\"", remedy)
	}
	return Parsed{Command: name, Flags: flags, Args: args}, nil
}
