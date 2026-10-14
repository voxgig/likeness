package likeness

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
	"github.com/voxgig/station/go/station"
)

// Connection is one declared station instance and the account it belongs to.
type Connection struct {
	Instance string
	Source   string
	Account  string
}

// Ctx is every impure input, named.
type Ctx struct {
	Argv []string
	Env  map[string]string
	// RFC 3339. Injected always: a command that read the wall clock could not
	// be a corpus entry.
	Clock string
	Seed  int
	// station.json in station's own grammar, and each instance's account from
	// likeness.json beside it.
	Station  map[string]any
	Accounts map[string]string
	conns    []Connection
	sess     *session
	// Seed maps for the SDKs' offline test mode, by instance. Present in every
	// test and absent in production.
	Fixture map[string]map[string]any
	// Every likeness on PATH, for `which`. Injected rather than probed so the
	// command is testable.
	Path []map[string]any
	// A path under Home is shown from `~`; a relative vault path is read from
	// Dir, where station.json is.
	Home  string
	Dir   string
	Stdin func() (string, error)
	// Stdin is a terminal, so what the environment lacks may be asked for.
	// Prompt reports false at the end of input.
	TTY    bool
	Prompt func(label string) (string, bool)
}

// Result is what a command produced.
type Result struct {
	Exit   int
	Stdout string
	Stderr string
	Calls  []Call
}

type flags struct {
	vaultFlags
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

func flagsOf(p Parsed) flags {
	f := flags{}
	f.json, _ = p.Flags["json"].(bool)
	f.raw, _ = p.Flags["raw"].(bool)
	f.strict, _ = p.Flags["strict"].(bool)
	f.deterministic, _ = p.Flags["deterministic"].(bool)
	if n, ok := p.Flags["limit"].(int64); ok {
		f.limit, f.hasLimit = int(n), true
	}
	f.sort, _ = p.Flags["sort"].(string)
	for _, v := range asList(p.Flags["instance"]) {
		f.instance = append(f.instance, v.(string))
	}
	for _, v := range asList(p.Flags["source"]) {
		f.source = append(f.source, v.(string))
	}
	f.passphraseEnv, _ = p.Flags["passphrase-env"].(string)
	f.newPassphraseEnv, _ = p.Flags["new-passphrase-env"].(string)
	f.vaultKey, _ = p.Flags["vault-key"].(string)
	f.reveal, _ = p.Flags["reveal"].(bool)
	f.write, _ = p.Flags["write"].(bool)
	return f
}

func asList(v any) []any {
	list, _ := v.([]any)
	return list
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
	words := []string{}
	for _, c := range cmd {
		words = append(words, strings.Split(c, " ")...)
	}
	m := map[string]any{
		"ok":   nil == errBody,
		"code": code,
		"cmd":  strList(words),
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
		for _, conn := range c.conns {
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
		for _, conn := range c.conns {
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
	for _, conn := range c.conns {
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

// session is one run's station, its connections and the clients bound
// through it, each constructed on first use.
type session struct {
	st      *station.Station
	conns   []Connection
	calls   *Calls
	clients map[string]*joplin.JoplinSDK
	fixture map[string]map[string]any
}

// Station refuses a binding by panicking with its own error type; that is one
// connection failing, which the caller reports, so it comes back as an error.
func (s *session) client(conn Connection) (cl *joplin.JoplinSDK, err error) {
	if cl, ok := s.clients[conn.Instance]; ok {
		return cl, nil
	}
	defer func() {
		if r := recover(); nil != r {
			se, ok := r.(*station.Error)
			if !ok {
				panic(r)
			}
			cl, err = nil, se
		}
	}()
	cl = joplinConnect(s.st, conn.Instance, s.fixture[conn.Instance])
	s.clients[conn.Instance] = cl
	return cl, nil
}

func profileOf(env map[string]string) string {
	if p := env["VOXGIG_STATION_PROFILE"]; "" != p {
		return p
	}
	return "default"
}

func openStation(config map[string]any, env map[string]string) (*station.Station, error) {
	load := false
	opts := &station.Options{Profile: profileOf(env), Proxy: "off", Load: &load}
	if nil == config {
		opts.NoConfig = true
	} else {
		opts.Config = config
	}
	return station.New(opts)
}

// connectionsOf lists station's active declared instances in ref order, each
// with its account. An instance with no account is refused: identity may not
// be derived from the ref.
func connectionsOf(st *station.Station, accounts map[string]string) ([]Connection, error) {
	out := []Connection{}
	for _, inst := range st.Instances() {
		if !inst.Active {
			continue
		}
		account := accounts[inst.Name]
		if "" == account {
			return nil, &LikenessError{
				Code:   "invalid-project",
				Msg:    "instance \"" + inst.Name + "\" has no account in likeness.json",
				Remedy: "add `\"" + inst.Name + "\": { \"account\": \"<id>\" }` under `instances` in likeness.json",
			}
		}
		out = append(out, Connection{Instance: inst.Name, Source: inst.API, Account: account})
	}
	return out, nil
}

// withChain is station.json with its secret chain replaced, in every profile,
// by the one likeness decided on. The caller's map is left as it was.
func withChain(config map[string]any, chain []any) map[string]any {
	if nil == config {
		return nil
	}
	copied := map[string]any{}
	for k, v := range config {
		copied[k] = v
	}
	profiles, ok := config["profiles"].(map[string]any)
	if !ok {
		return copied
	}
	each := map[string]any{}
	for name, p := range profiles {
		pm, ok := p.(map[string]any)
		if !ok {
			each[name] = p
			continue
		}
		one := map[string]any{}
		for k, v := range pm {
			one[k] = v
		}
		one["secrets"] = map[string]any{"providers": chain}
		each[name] = one
	}
	copied["profiles"] = each
	return copied
}

func entryOf(c Ctx, f flags) (VaultEntry, error) {
	home := c.Home
	if "" == home {
		home, _ = os.UserHomeDir()
	}
	dir := c.Dir
	if "" == dir {
		dir = filepath.Join(home, ".config", "likeness")
	}
	return vaultEntry(c.Station, profileOf(c.Env), home, dir, f.vaultKey)
}

// openSession opens one station per run: every client is connected through
// it lazily, and the calls a command made are the requests it observed. A live
// run with a connection to make opens it on the vault.
func openSession(c Ctx, f flags) (*session, error) {
	s := &session{calls: NewCalls(nil), clients: map[string]*joplin.JoplinSDK{}, fixture: c.Fixture}
	entry, err := entryOf(c, f)
	if nil != err {
		return s, err
	}
	st, err := openStation(withChain(c.Station, []any{}), c.Env)
	if nil != err {
		return s, err
	}
	conns, err := connectionsOf(st, c.Accounts)
	if nil != err {
		return s, err
	}
	if nil == c.Fixture && 0 < len(conns) {
		chain, err := vaultChain(c, entry, f.vaultFlags)
		if nil != err {
			return s, err
		}
		if st, err = openStation(withChain(c.Station, chain), c.Env); nil != err {
			return s, &LikenessError{Code: "secret-backend-unavailable",
				Msg:    "station could not open the vault as its secret store",
				Remedy: "this port's station must read minivault stores; see \"Secrets\" in the README"}
		}
	}
	s.st = st
	s.calls = NewCalls(st)
	s.conns = conns
	return s, nil
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
		cl, lerr := c.sess.client(conn)
		var rows []Note
		var more bool
		if nil == lerr {
			rows, more, lerr = JoplinList(cl, conn, withRaw)
		}
		if nil != lerr {
			failed = append(failed, conn.Instance)
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
	if selector := strings.Join(rest, " "); "" != selector {
		n, err := ParseSelector(selector)
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
		// A dot segment substituted into a route would name another resource.
		if "." == id || ".." == id {
			return nil, &LikenessError{"invalid-ref", "not a ref: " + ref + " (an id is never . or ..)",
				"a ref is <instance>:<id>, a lid, #n or @alias", nil}
		}
		var conn *Connection
		for i := range c.conns {
			if c.conns[i].Instance == instance {
				conn = &c.conns[i]
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
		cl, err := c.sess.client(*conn)
		if nil != err {
			return nil, err
		}
		note, err := JoplinLoad(cl, *conn, id, f.raw)
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
		ok, code, detail := false, "source-unavailable", "station could not connect this instance"
		if cl, cerr := c.sess.client(conn); nil == cerr {
			ok, code, detail = JoplinCheck(cl)
		}
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

// Help text is rendered from the command table at build time; JSON gets the rows.
func cmdHelp(args []string) (*envelope, string, error) {
	loadTable()
	name := strings.Join(args, " ")
	text, ok := help.Text[name]
	if !ok {
		return nil, "", &LikenessError{Code: "invalid-argument", Msg: "no such command: " + name,
			Remedy: "run `likeness help` for the command list"}
	}
	rows := []any{}
	for _, r := range help.Rows {
		if "" == name || r.Command == name || strings.HasPrefix(r.Command, name+" ") {
			rows = append(rows, map[string]any{"command": r.Command, "takes": r.Takes, "does": r.Does})
		}
	}
	return newEnvelope([]string{"help"}, "ok", rows, meta{count: len(rows)}, nil), text, nil
}

// -- the entry point --------------------------------------------------------

// Run executes one whole command and returns everything it produced.
func Run(c Ctx) Result {
	started := time.Now()
	calls := NewCalls(nil)
	var f flags
	var env *envelope
	text := ""

	// The grammar decides first: a refused argument runs nothing at all.
	parsed, perr := ParseArgv(c.Argv)
	if nil != perr {
		head := strings.Join(commandWords(c.Argv), " ")
		f.json = contains(c.Argv, "--json")
		f.deterministic = contains(c.Argv, "--deterministic")
		env = errEnvelope(head, perr, calls)
	} else {
		f = flagsOf(parsed)
		var err error
		env, text, calls, err = dispatch(c, f, parsed)
		if nil != err {
			env = errEnvelope(parsed.Command, err, calls)
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
	if "" != text && !f.json {
		stdout = text
	}
	stderr := ""
	if !f.json {
		stderr = narrate(env)
	}
	return Result{Exit: ExitFor(env.code()), Stdout: stdout, Stderr: stderr, Calls: calls.All()}
}

func dispatch(c Ctx, f flags, p Parsed) (*envelope, string, *Calls, error) {
	calls := NewCalls(nil)
	if cmd, _ := commandDef(p.Command); !cmd.Ready {
		return nil, "", calls, &LikenessError{"unsupported-capability",
			"`" + p.Command + "` is not implemented yet - " + cmd.Short,
			"it arrives in a later stage; run `likeness help` for what works now", nil}
	}
	switch p.Command {
	case "help":
		env, text, err := cmdHelp(p.Args)
		return env, text, calls, err
	case "version":
		return cmdVersion(), "", calls, nil
	case "which":
		return cmdWhich(c), "", calls, nil
	}
	if strings.HasPrefix(p.Command, "secrets ") {
		entry, err := entryOf(c, f)
		if nil != err {
			return nil, "", calls, err
		}
		got, err := secretsAction(c, p.Command[len("secrets "):], p.Args, entry, f.vaultFlags)
		if nil != err {
			return nil, "", calls, err
		}
		code := "ok"
		if got.empty {
			code = "no-match"
		}
		return newEnvelope([]string{p.Command}, code, got.data, meta{count: got.count}, nil), got.text, calls, nil
	}

	sess, err := openSession(c, f)
	calls = sess.calls
	if nil != err {
		return nil, "", calls, err
	}
	c.sess, c.conns = sess, sess.conns
	var env *envelope
	switch p.Command {
	case "list":
		env, err = cmdList(c, f, p.Args, calls)
	case "get":
		env, err = cmdGet(c, f, p.Args, calls)
	case "doctor":
		env, err = cmdDoctor(c, f, calls)
	default:
		err = errors.New("declared ready and not dispatched: " + p.Command)
	}
	return env, "", calls, err
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
	if se, ok := err.(*station.Error); ok && "station_config_invalid" == se.Code {
		return newEnvelope([]string{name}, "invalid-project", nil, meta{calls: calls.Count()},
			map[string]any{
				"message": se.Error(),
				"remedy":  "fix station.json; station validates it against its own shape",
			})
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
