package likeness

import (
	"sort"
	"strconv"
	"strings"
	"time"
)

// Connection is one configured source, as the station file describes it.
type Connection struct {
	Instance string
	Source   string
	Account  string
	APIKey   string
	Base     string
}

// Ctx is every impure input, named.
type Ctx struct {
	Argv []string
	Env  map[string]string
	// RFC 3339. Injected always: a command that read the wall clock could not
	// be a corpus entry.
	Clock       string
	Seed        int
	Connections []Connection
	// Seed maps for the SDKs' offline test mode, by instance. Present in every
	// test and absent in production.
	Fixture map[string]map[string]any
	// Every likeness on PATH, for `which`. Injected rather than probed so the
	// command is testable.
	Path []map[string]any
}

// Result is what a command produced.
type Result struct {
	Exit   int
	Stdout string
	Stderr string
	Calls  []Call
}

type flags struct {
	json          bool
	raw           bool
	limit         int
	hasLimit      bool
	sort          string
	strict        bool
	deterministic bool
	instance      []string
	source        []string
}

func parseFlags(args []string) (flags, []string, error) {
	f := flags{}
	rest := []string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "--json":
			f.json = true
		case "--raw":
			f.raw = true
		case "--strict":
			f.strict = true
		case "--deterministic":
			f.deterministic = true
		case "--limit":
			i++
			raw := ""
			if i < len(args) {
				raw = args[i]
			}
			n, err := strconv.Atoi(raw)
			if nil != err || n < 1 {
				return f, rest, &LikenessError{
					Code:   "invalid-selector",
					Msg:    "--limit needs a whole number of at least 1, not \"" + raw + "\"",
					Remedy: "try `--limit 20`",
				}
			}
			f.limit, f.hasLimit = n, true
		case "--sort":
			i++
			if i < len(args) {
				f.sort = args[i]
			}
		case "--instance":
			i++
			if i < len(args) {
				f.instance = append(f.instance, args[i])
			}
		case "--source":
			i++
			if i < len(args) {
				f.source = append(f.source, args[i])
			}
		default:
			rest = append(rest, a)
		}
	}
	return f, rest, nil
}

type envelope struct {
	m map[string]any
}

func strList(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

type meta struct {
	count      int
	truncated  bool
	sources    []string
	incomplete []string
	calls      int
}

func newEnvelope(cmd []string, code string, data any, mt meta, errBody map[string]any) *envelope {
	m := map[string]any{
		"ok":   nil == errBody,
		"code": code,
		"cmd":  strList(cmd),
		"data": data,
		"meta": map[string]any{
			"count":      mt.count,
			"truncated":  mt.truncated,
			"sources":    strList(mt.sources),
			"incomplete": strList(mt.incomplete),
			"calls":      mt.calls,
			"elapsed_ms": 0,
		},
		"port":    Port,
		"version": Version,
	}
	if nil != errBody {
		m["error"] = errBody
	}
	return &envelope{m}
}

func (e *envelope) code() string { s, _ := e.m["code"].(string); return s }
func (e *envelope) data() any    { return e.m["data"] }

func (e *envelope) fails(message, remedy string) *envelope {
	e.m["error"] = map[string]any{"message": message, "remedy": remedy}
	e.m["ok"] = false
	return e
}

func (c Ctx) selected(f flags) ([]Connection, error) {
	var unknownInstance []string
	for _, want := range f.instance {
		found := false
		for _, conn := range c.Connections {
			if conn.Instance == want {
				found = true
				break
			}
		}
		if !found {
			unknownInstance = append(unknownInstance, "\""+want+"\"")
		}
	}
	if 0 < len(unknownInstance) {
		sort.Strings(unknownInstance)
		return nil, &LikenessError{
			Code:   "no-such-source",
			Msg:    "no connection named " + strings.Join(unknownInstance, ", "),
			Remedy: "run `likeness doctor` to see the configured connections",
		}
	}

	var unknownSource []string
	for _, want := range f.source {
		found := false
		for _, conn := range c.Connections {
			if conn.Source == want {
				found = true
				break
			}
		}
		if !found {
			unknownSource = append(unknownSource, "\""+want+"\"")
		}
	}
	if 0 < len(unknownSource) {
		sort.Strings(unknownSource)
		return nil, &LikenessError{
			Code:   "no-such-source",
			Msg:    "no connection uses source " + strings.Join(unknownSource, ", "),
			Remedy: "run `likeness doctor` to see the configured connections",
		}
	}

	out := []Connection{}
	for _, conn := range c.Connections {
		if 0 < len(f.instance) && !contains(f.instance, conn.Instance) {
			continue
		}
		if 0 < len(f.source) && !contains(f.source, conn.Source) {
			continue
		}
		out = append(out, conn)
	}
	return out, nil
}

func hasAdapter(c Connection) bool { return joplinSource == c.Source }

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func (c Ctx) optsFor(conn Connection) SourceOpts {
	return SourceOpts{
		Instance: conn.Instance,
		Account:  conn.Account,
		Seed:     c.Fixture[conn.Instance],
		APIKey:   conn.APIKey,
		Base:     conn.Base,
	}
}

var universalFields = []string{
	"lid", "id", "title", "url", "created", "updated", "source", "instance",
}

func supplies(conn Connection) map[string]bool {
	// ONE adapter in Stage 1. The lookup is by the connection's declared
	// source rather than by a conditional on its name, so adding the second
	// adapter adds a row here and changes nothing else.
	bySource := map[string][]string{joplinSource: JoplinSupplies}
	out := map[string]bool{}
	for _, f := range universalFields {
		out[f] = true
	}
	for _, f := range bySource[conn.Source] {
		out[f] = true
	}
	return out
}

// unanswerable lists the asked-about fields no selected source can answer.
func unanswerable(conns []Connection, fields []string) []string {
	if 0 == len(conns) {
		return nil
	}
	sets := make([]map[string]bool, len(conns))
	for i, c := range conns {
		sets[i] = supplies(c)
	}
	out := []string{}
	for _, f := range fields {
		all := true
		for _, s := range sets {
			if !s[f] {
				all = false
				break
			}
		}
		if !all {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}

func gather(c Ctx, conns []Connection, calls *Calls, withRaw, strict bool) (
	notes []Note, ok []string, failed []string, short []string, err error) {
	for _, conn := range conns {
		if !hasAdapter(conn) {
			// A source with no adapter is refused BEFORE the network, not sent
			// through whichever adapter happened to be linked in.
			return nil, nil, nil, nil, &LikenessError{
				Code:   "unsupported-capability",
				Msg:    "no adapter for source \"" + conn.Source + "\" (connection \"" + conn.Instance + "\")",
				Remedy: "drop that connection, or narrow to one that is supported with --source",
			}
		}
		rows, more, lerr := JoplinList(c.optsFor(conn), calls, withRaw)
		if nil != lerr {
			if le, isLik := lerr.(*LikenessError); isLik && "source-unavailable" == le.Code {
				// A malformed record is the source's fault and is reported as
				// that connection failing, not as the whole command dying.
				failed = append(failed, conn.Instance)
			} else {
				failed = append(failed, conn.Instance)
			}
			// `--strict` HALTS. `fanout-halted` means the fan-out stopped after
			// a member failed; continuing through every remaining connection
			// and only then choosing that code made the name a lie and spent
			// requests the caller had asked not to spend.
			if strict {
				break
			}
			continue
		}
		notes = append(notes, rows...)
		ok = append(ok, conn.Instance)
		if more {
			short = append(short, conn.Instance)
		}
	}
	sort.Strings(ok)
	sort.Strings(failed)
	sort.Strings(short)
	return
}

// -- commands ---------------------------------------------------------------

func cmdList(c Ctx, f flags, rest []string, calls *Calls) (*envelope, error) {
	conns, err := c.selected(f)
	if nil != err {
		return nil, err
	}
	clockMs, _ := parseRfc3339(c.Clock)

	var filter *Node
	if 0 < len(rest) && "" != rest[0] {
		n, err := ParseSelector(rest[0])
		if nil != err {
			return nil, err
		}
		filter = n
		if bad := unanswerable(conns, FieldsOf(filter)); 0 < len(bad) {
			return nil, &LikenessError{
				Code:   "unsupported-capability",
				Msg:    "no source can answer a question about " + strings.Join(bad, ", "),
				Remedy: "drop that term, or narrow to a source that supplies it with --source",
			}
		}
	}

	notes, okSources, failed, short, gerr := gather(c, conns, calls, f.raw, f.strict)
	if nil != gerr {
		return nil, gerr
	}
	if nil != filter {
		kept := notes[:0]
		for _, n := range notes {
			if Evaluate(filter, n, clockMs) {
				kept = append(kept, n)
			}
		}
		notes = kept
	}
	notes = SortNotes(notes, f.sort)

	truncated := false
	if f.hasLimit && f.limit < len(notes) {
		notes = notes[:f.limit]
		truncated = true
	}

	// A source that filled its page may have more. Marked truncated and NAMED
	// in `meta.incomplete`, because a silently short list makes every selector
	// result computed from it wrong with nothing to say so.
	if 0 < len(short) {
		truncated = true
	}
	incomplete := append(append([]string{}, failed...), short...)
	sort.Strings(incomplete)

	noneAnswered := 0 < len(failed) && 0 == len(okSources)

	code := "ok"
	switch {
	case 0 < len(failed) && f.strict:
		code = "fanout-halted"
	case noneAnswered:
		code = "source-unavailable"
	case 0 < len(incomplete):
		code = "partial"
	case 0 == len(notes):
		// EXIT 1 IS NOT AN ERROR - it is the answer "none", and it has its own
		// code so that a script can tell "nothing matched" from "the query was
		// wrong" without reading English.
		code = "no-match"
	}

	rows := make([]any, len(notes))
	for i, n := range notes {
		rows[i] = n.Value()
	}

	env := newEnvelope([]string{"list"}, code, rows, meta{
		count: len(notes), truncated: truncated,
		sources: okSources, incomplete: incomplete, calls: calls.Count(),
	}, nil)

	if "fanout-halted" == code {
		return env.fails(
			strings.Join(failed, ", ")+" did not answer and --strict was given",
			"drop --strict to accept a partial answer, or fix the named connection"), nil
	}
	if "source-unavailable" == code {
		// `data` IS NULL, not `[]`. The registry does not mark this code as one
		// permitted to carry results, and the distinction is the honest one:
		// `[]` means the sources were asked and held nothing, null means they
		// could not be asked at all.
		env.m["data"] = nil
		return env.fails(
			"no source answered: "+strings.Join(failed, ", "),
			"run `likeness doctor` to see which connection is failing and why"), nil
	}
	return env, nil
}

func cmdGet(c Ctx, f flags, rest []string, calls *Calls) (*envelope, error) {
	if 0 == len(rest) {
		return nil, &LikenessError{"invalid-ref", "get needs a ref", "try `likeness get plan:CORE-412`", nil}
	}
	out := []Note{}
	for _, ref := range rest {
		idx := strings.Index(ref, ":")
		if idx < 1 {
			return nil, &LikenessError{"invalid-ref", "not a ref: " + ref,
				"a ref is <instance>:<id>, a lid, #n or @alias", nil}
		}
		instance, id := ref[:idx], ref[idx+1:]
		if "" == id {
			return nil, &LikenessError{"invalid-ref", "not a ref: " + ref + " (no id after the colon)",
				"a ref is <instance>:<id>, a lid, #n or @alias", nil}
		}
		var conn *Connection
		for i := range c.Connections {
			if c.Connections[i].Instance == instance {
				conn = &c.Connections[i]
				break
			}
		}
		if nil == conn {
			return nil, &LikenessError{"no-such-source", "no connection named \"" + instance + "\"",
				"run `likeness doctor` to see the configured connections", nil}
		}
		if !hasAdapter(*conn) {
			return nil, &LikenessError{"unsupported-capability",
				"no adapter for source \"" + conn.Source + "\" (connection \"" + conn.Instance + "\")",
				"this source arrives in a later stage", nil}
		}
		note, err := JoplinLoad(c.optsFor(*conn), calls, id, f.raw)
		if nil != err {
			return nil, err
		}
		if nil == note {
			return nil, &LikenessError{"not-found", ref + " does not exist",
				"check the ref, or run `likeness list` to see what is there", nil}
		}
		out = append(out, *note)
	}

	seen := map[string]bool{}
	sources := []string{}
	rows := make([]any, len(out))
	for i, n := range out {
		rows[i] = n.Value()
		if !seen[n.Instance] {
			seen[n.Instance] = true
			sources = append(sources, n.Instance)
		}
	}
	sort.Strings(sources)
	return newEnvelope([]string{"get"}, "ok", rows, meta{
		count: len(out), sources: sources, calls: calls.Count(),
	}, nil), nil
}

func cmdDoctor(c Ctx, f flags, calls *Calls) (*envelope, error) {
	conns, err := c.selected(f)
	if nil != err {
		return nil, err
	}
	rows := []any{}
	failures := []string{}
	instances := []string{}
	for _, conn := range conns {
		if !hasAdapter(conn) {
			// `doctor` REPORTS rather than refuses: naming the unsupported
			// source is exactly the diagnosis the command exists to give.
			rows = append(rows, map[string]any{
				"instance": conn.Instance, "source": conn.Source, "check": "FAIL",
				"detail": "no adapter for this source yet", "code": "unsupported-capability",
			})
			failures = append(failures, "unsupported-capability")
			instances = append(instances, conn.Instance)
			continue
		}
		ok, code, detail := JoplinCheck(c.optsFor(conn), calls)
		row := map[string]any{
			"instance": conn.Instance, "source": conn.Source, "detail": detail,
			"check": "ok",
		}
		if !ok {
			row["check"] = "FAIL"
			row["code"] = code
			failures = append(failures, code)
		}
		rows = append(rows, row)
		instances = append(instances, conn.Instance)
	}
	sort.Strings(instances)

	// THE WORST ROW WINS, and "worst" is defined rather than felt: highest
	// exit status first, then code name ascending to break a tie. A fixed
	// `source-unavailable` for every kind of failure told a user whose token
	// had expired to go and start an application that was already running.
	code := "ok"
	if 0 < len(failures) {
		distinct := []string{}
		seen := map[string]bool{}
		for _, f := range failures {
			if !seen[f] {
				seen[f] = true
				distinct = append(distinct, f)
			}
		}
		sort.Slice(distinct, func(i, j int) bool {
			a, b := distinct[i], distinct[j]
			if ExitFor(a) != ExitFor(b) {
				return ExitFor(b) < ExitFor(a)
			}
			return a < b
		})
		code = distinct[0]
	}

	env := newEnvelope([]string{"doctor"}, code, rows, meta{
		count: len(rows), sources: instances, calls: calls.Count(),
	}, nil)
	if n := len(failures); 0 < n {
		word := " connections need"
		if 1 == n {
			word = " connection needs"
		}
		return env.fails(strconv.Itoa(n)+word+" attention",
			"start the application, check the token, and re-run `likeness doctor`"), nil
	}
	return env, nil
}

func cmdVersion() *envelope {
	return newEnvelope([]string{"version"}, "ok",
		map[string]any{"port": Port, "version": Version}, meta{count: 1}, nil)
}

func cmdWhich(c Ctx) *envelope {
	// Injected rather than probed: `which` is a corpus entry like everything
	// else, and a command that read the real PATH could not be one. The argv
	// shell does the probing; see main_entry.go. An absent list means the
	// caller supplied none, which is the empty answer, NOT a placeholder row
	// claiming to be the only installation.
	rows := []any{}
	for _, p := range c.Path {
		rows = append(rows, p)
	}
	code := "ok"
	if 0 == len(rows) {
		code = "no-match"
	}
	return newEnvelope([]string{"which"}, code, rows, meta{count: len(rows)}, nil)
}

func cmdHelp() *envelope {
	commands := []any{
		map[string]any{"command": "list", "takes": "[selector]", "does": "list notes across the configured sources"},
		map[string]any{"command": "get", "takes": "<ref>...", "does": "fetch one note by <instance>:<id>"},
		map[string]any{"command": "doctor", "takes": "", "does": "check every configured connection"},
		map[string]any{"command": "version", "takes": "", "does": "this port and its version"},
		map[string]any{"command": "which", "takes": "", "does": "every likeness on PATH"},
		map[string]any{"command": "help", "takes": "", "does": "this"},
	}
	for _, name := range StubNames() {
		commands = append(commands, map[string]any{
			"command": name, "takes": "", "does": stubs[name] + " (not implemented yet)",
		})
	}
	return newEnvelope([]string{"help"}, "ok", commands, meta{count: len(commands)}, nil)
}

// stubs exist and say they do not work yet, so that neither this nor packaging
// is a surprise at the stage that needs it.
var stubs = map[string]string{
	"describe": "the machine-readable surface document",
	"mcp":      "the tool-protocol server",
	"project":  "project files and composition",
	"search":   "cross-source search",
	"caps":     "the capability matrix, printed",
	"sources":  "connection management",
}

// StubNames lists them, for the packaging check and for `--help`.
func StubNames() []string {
	out := make([]string, 0, len(stubs))
	for k := range stubs {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// -- the entry point --------------------------------------------------------

// Run executes one whole command and returns everything it produced.
func Run(c Ctx) Result {
	calls := &Calls{}
	started := time.Now()
	name := ""
	var args []string
	if 0 < len(c.Argv) {
		name, args = c.Argv[0], c.Argv[1:]
	}
	f, rest, ferr := parseFlags(args)

	var env *envelope
	if nil != ferr {
		// A bad flag is reported through the envelope too. `f` carries whatever
		// was parsed before the failure, which is enough to know whether the
		// caller asked for JSON.
		f.json = contains(args, "--json")
		f.deterministic = contains(args, "--deterministic")
		env = errEnvelope(name, ferr, calls)
	} else {
		var err error
		env, err = dispatch(c, f, rest, calls, name)
		if nil != err {
			env = errEnvelope(name, err, calls)
		}
	}

	// Measured here, once, around the whole command. Zeroed under
	// --deterministic so the declared exception cannot defeat the byte diff. A
	// field that always reported zero was worse than no field, because it
	// looked like an answer.
	if mt, ok := env.m["meta"].(map[string]any); ok {
		if f.deterministic {
			mt["elapsed_ms"] = 0
		} else {
			mt["elapsed_ms"] = int(time.Since(started).Milliseconds())
		}
	}

	stdout, serr := render(env, f)
	if nil != serr {
		// A value the writer refuses is a bug in the port, not a user error:
		// there is no envelope it could print instead that would be true.
		panic(serr)
	}
	stderr := ""
	if !f.json {
		stderr = narrate(env)
	}
	return Result{Exit: ExitFor(env.code()), Stdout: stdout, Stderr: stderr, Calls: calls.All()}
}

func dispatch(c Ctx, f flags, rest []string, calls *Calls, name string) (*envelope, error) {
	switch {
	case "" == name:
		return nil, &LikenessError{"invalid-selector", "no command given",
			"try `likeness list`, or `likeness help` for the command list", nil}
	case "--help" == name || "-h" == name || "help" == name:
		return cmdHelp(), nil
	case "list" == name:
		return cmdList(c, f, rest, calls)
	case "get" == name:
		return cmdGet(c, f, rest, calls)
	case "doctor" == name:
		return cmdDoctor(c, f, calls)
	case "version" == name:
		return cmdVersion(), nil
	case "which" == name:
		return cmdWhich(c), nil
	}
	if what, ok := stubs[name]; ok {
		return nil, &LikenessError{"unsupported-capability",
			"`" + name + "` is not implemented yet - " + what,
			"it arrives in a later stage; run `likeness help` for what works now", nil}
	}
	return nil, &LikenessError{"invalid-selector", "no such command: " + name,
		"run `likeness help` for the command list", nil}
}

func errEnvelope(name string, err error, calls *Calls) *envelope {
	if se, ok := err.(*SelectorError); ok {
		return newEnvelope([]string{name}, "invalid-selector", nil,
			meta{calls: calls.Count()},
			map[string]any{
				"message": se.Msg + " at byte " + strconv.Itoa(se.Offset),
				"remedy":  "check the selector grammar with `likeness describe`",
			})
	}
	if le, ok := err.(*LikenessError); ok {
		body := map[string]any{"message": le.Msg, "remedy": le.Remedy}
		for k, v := range le.Detail {
			body[k] = v
		}
		return newEnvelope([]string{name}, le.Code, nil, meta{calls: calls.Count()}, body)
	}
	// An error no layer claimed is still the user's problem to see, and it is
	// reported under a code the registry knows rather than a new one invented
	// at the point of failure. The source's own words are NOT repeated: they
	// differ per port and embed the URL that was tried.
	code := "source-unavailable"
	switch statusOf(err) {
	case 401, 403:
		code = "auth-failed"
	case 429:
		code = "rate-limited"
	}
	return newEnvelope([]string{name}, code, nil, meta{calls: calls.Count()},
		map[string]any{
			"message": "the source did not complete the request",
			"remedy":  "run `likeness doctor` to see which connection is failing and why",
		})
}

func render(env *envelope, f flags) (string, error) {
	// --json puts NOTHING else on stdout. Narration, progress and warnings go
	// to stderr, always.
	if f.json {
		return Serialise(env.m)
	}
	return human(env)
}

// -- human output -----------------------------------------------------------

func human(env *envelope) (string, error) {
	d := env.data()
	if nil == d {
		return "", nil
	}
	rows, ok := d.([]any)
	if !ok {
		// `Render`, never the host's JSON writer: key order there is
		// declaration or insertion order, which differs per port and would put
		// the parity gap straight onto stdout.
		s, err := Render(d, "")
		return s + "\n", err
	}
	// Nothing matched: print nothing. An empty list joined by newlines is a
	// blank line, which reads as one unnamed result and breaks `wc -l`.
	if 0 == len(rows) {
		return "", nil
	}
	if m, ok := rows[0].(map[string]any); ok {
		if _, isNote := m["lid"]; isNote {
			var b strings.Builder
			for i, r := range rows {
				n := r.(map[string]any)
				b.WriteString(pad(strconv.Itoa(i+1), 3, true))
				b.WriteString("  ")
				b.WriteString(pad(n["instance"].(string), 8, false))
				b.WriteString("  ")
				b.WriteString(n["title"].(string))
				b.WriteString("\n")
			}
			return b.String(), nil
		}
	}
	var b strings.Builder
	for _, r := range rows {
		s, err := Render(r, "")
		if nil != err {
			return "", err
		}
		b.WriteString(s)
		b.WriteString("\n")
	}
	return b.String(), nil
}

// pad measures in RUNES, not bytes: a title in a language that is not English
// would otherwise shift the column by the number of continuation bytes in it.
func pad(s string, w int, left bool) string {
	n := len([]rune(s))
	if w <= n {
		return s
	}
	fill := strings.Repeat(" ", w-n)
	if left {
		return fill + s
	}
	return s + fill
}

func narrate(env *envelope) string {
	out := []string{}
	mt, _ := env.m["meta"].(map[string]any)
	if inc, _ := mt["incomplete"].([]any); 0 < len(inc) {
		names := make([]string, len(inc))
		for i, v := range inc {
			names[i], _ = v.(string)
		}
		out = append(out, strings.Join(names, ", ")+" unavailable - results are incomplete")
	}
	if eb, ok := env.m["error"].(map[string]any); ok {
		out = append(out, "error: "+env.code())
		out = append(out, "  "+eb["message"].(string))
		out = append(out, "  remedy  "+eb["remedy"].(string))
	}
	if 0 == len(out) {
		return ""
	}
	return strings.Join(out, "\n") + "\n"
}
