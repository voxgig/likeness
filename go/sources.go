package likeness

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/voxgig/station/go/station"
)

var (
	tagRe       = regexp.MustCompile(`^[a-z0-9-]+$`)
	secretRunRe = regexp.MustCompile(`[^A-Z0-9]+`)
	// Scheme, host and port, and a path: no userinfo, query or fragment, which
	// is where a credential would be written.
	baseRe = regexp.MustCompile(`^https?://(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?(?:/[\x21\x22\x24-\x3e\x40-\x7e]*)?$`)
)

const (
	listRemedy = "run `likeness sources list` to see the configured connections"
	flagRemedy = "run `likeness help sources add` for the flags each source reads"
)

// secretName is station's name for an instance's secret when its block names none.
func secretName(ref string) string {
	return strings.ToLower(strings.Trim(secretRunRe.ReplaceAllString(strings.ToUpper(ref), "_"), "_")) + ".apikey"
}

/*
refFor is the ref `sources add` writes: the API alone, the API with --instance
as its tag, or --instance itself where it is a ref to the same API. A `$`-less
value is always a tag, as station reads one.
*/
func refFor(source string, instance ...string) (string, error) {
	if !nameRe.MatchString(source) {
		return "", bad("--source takes a source's name", "run `likeness help sources add`")
	}
	if 0 == len(instance) {
		return source, nil
	}
	given := instance[0]
	tag := given
	if at := strings.Index(given, "$"); -1 != at {
		if given[:at] != source {
			return "", bad("--instance names a connection to another API than --source does",
				"give the tag alone: `--source "+source+" --instance <tag>` adds "+source+"$<tag>")
		}
		tag = given[at+1:]
	}
	if !tagRe.MatchString(tag) {
		return "", bad("--instance takes a tag of lowercase letters, digits and hyphens",
			"write `--instance work` to add "+source+"$work")
	}
	return source + "$" + tag, nil
}

func namesSecret(block map[string]any) bool {
	s, ok := block["secret"].(string)
	return ok && "" != s
}

func secretOf(block map[string]any, ref string) string {
	if namesSecret(block) {
		return block["secret"].(string)
	}
	return secretName(ref)
}

func listed(names []string) string {
	if 1 == len(names) {
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " or " + names[len(names)-1]
}

func rowOf(ref string, block map[string]any, account *string, active bool) map[string]any {
	row := map[string]any{"instance": ref, "source": station.RefApi(ref), "secret": secretOf(block, ref)}
	if base, ok := block["base"].(string); ok {
		row["base"] = base
	}
	if nil != account {
		row["account"] = *account
	}
	if !active {
		row["active"] = false
	}
	return row
}

// sourcesList is every instance the active profile declares, the inactive
// ones marked, and the account of each that likeness.json gives one.
func sourcesList(st *station.Station, accounts map[string]string) answer {
	rows := []any{}
	for _, inst := range st.Instances() {
		var account *string
		if a, ok := accounts[inst.Name]; ok {
			account = &a
		}
		rows = append(rows, rowOf(inst.Name, inst.Block, account, inst.Active))
	}
	return answer{data: rows, count: len(rows), empty: 0 == len(rows)}
}

type configFiles struct {
	home         string
	stationPath  string
	likenessPath string
	station      *heldFile
	likeness     *heldFile
	doc          *doc
	accounts     *doc
}

// configOf reads both files fresh: a write keeps everything in them it does not change.
func configOf(c Ctx) (*configFiles, error) {
	home := c.Home
	if "" == home {
		home, _ = os.UserHomeDir()
	}
	stationPath := c.Config
	if "" == stationPath {
		dir := c.Dir
		if "" == dir {
			dir = filepath.Join(home, ".config", "likeness")
		}
		stationPath = filepath.Join(dir, "station.json")
	}
	config := &configFiles{home: home, stationPath: stationPath,
		likenessPath: filepath.Join(filepath.Dir(stationPath), "likeness.json")}
	err := config.read()
	var ce *ConfigError
	if errors.As(err, &ce) {
		return nil, &LikenessError{Code: "invalid-project", Msg: ce.Msg, Remedy: configRemedy}
	}
	return config, err
}

func (config *configFiles) read() (err error) {
	stationShown, likenessShown := config.shown(config.stationPath), config.shown(config.likenessPath)
	if config.station, err = held(config.stationPath, stationShown); nil != err {
		return err
	}
	if config.likeness, err = held(config.likenessPath, likenessShown); nil != err {
		return err
	}
	if nil == config.station {
		config.doc = docOf(pairs{{"station", 1}, {"profiles", pairs{}}})
	} else if config.doc, err = parseDoc(config.station.text, stationShown); nil != err {
		return err
	}
	if nil != config.likeness {
		config.accounts, err = parseDoc(config.likeness.text, likenessShown)
	}
	return err
}

func (config *configFiles) shown(path string) string { return shownPath(path, config.home) }

func stationOf(c Ctx, config *configFiles, refuse func(code, message string) error) (*station.Station, error) {
	st, err := openStation(withChain(plainOf(config.doc), []any{}), c.Env)
	var se *station.Error
	if errors.As(err, &se) && strings.HasPrefix(se.Code, "station_") {
		return nil, refuse(se.Code, se.Error())
	}
	return st, err
}

func asRead(c Ctx, config *configFiles) (*station.Station, error) {
	return stationOf(c, config, func(_, message string) error {
		return &LikenessError{Code: "invalid-project", Msg: config.shown(config.stationPath) + ": " + message, Remedy: configRemedy}
	})
}

// find is the object at path, or nil where a level is missing or not an object.
func find(o *doc, path []string) *doc {
	at := o
	for _, k := range path {
		next := member(at, k)
		if nil == next || docObj != next.kind {
			return nil
		}
		at = next
	}
	return at
}

// ensure is the object at path, each missing level made; a level that is not
// an object is refused.
func ensure(o *doc, path []string, file string) (*doc, error) {
	at := o
	for i, k := range path {
		next := member(at, k)
		if nil == next {
			next = &doc{kind: docObj}
			put(at, k, next)
		}
		if docObj != next.kind {
			return nil, &LikenessError{Code: "invalid-project",
				Msg: file + "'s " + strings.Join(path[:i+1], ".") + " is not an object", Remedy: configRemedy}
		}
		at = next
	}
	return at, nil
}

func sdkOf(config *configFiles, profile string) *doc {
	return find(config.doc, []string{"profiles", profile, "sdk"})
}

// owned refuses a ref the active profile does not declare itself, or one the
// default profile, which every other inherits, declares as well.
func owned(config *configFiles, profile, ref string) error {
	mine := nil != member(sdkOf(config, profile), ref)
	base := "default" != profile && nil != member(sdkOf(config, "default"), ref)
	if !mine && !base {
		return &LikenessError{Code: "no-such-source", Msg: "no connection named \"" + ref + "\"", Remedy: listRemedy}
	}
	if !mine {
		return bad("connection \""+ref+"\" is the default profile's, which \""+profile+"\" inherits",
			"change it under the default profile, with VOXGIG_STATION_PROFILE unset")
	}
	if base {
		return bad("connection \""+ref+"\" would remain: the default profile declares it too, and \""+profile+"\" inherits it",
			"remove the default profile's first, with VOXGIG_STATION_PROFILE unset")
	}
	return nil
}

func blockOf(st *station.Station, ref string) map[string]any {
	for _, inst := range st.Instances() {
		if ref == inst.Name {
			return inst.Block
		}
	}
	return map[string]any{}
}

// writeConfig writes likeness.json first, so station.json, which makes a connection, changes last.
func writeConfig(c Ctx, config *configFiles, accounts *doc) error {
	writes := []fileWrite{}
	if nil != accounts {
		writes = append(writes, fileWrite{path: config.likenessPath, text: renderDoc(accounts), was: config.likeness})
	}
	writes = append(writes, fileWrite{path: config.stationPath, text: renderDoc(config.doc), was: config.station})
	dir := config.shown(filepath.Dir(config.stationPath))
	remedy := "check that " + dir + " is writable and its disk has space"
	fs := osFs
	if nil != c.FS {
		fs = *c.FS
	}
	err := os.MkdirAll(filepath.Dir(config.stationPath), 0o700)
	if nil == err {
		err = writeAll(writes, fs)
	}
	var we *writeError
	switch {
	case nil == err:
		return nil
	case !errors.As(err, &we):
		return &LikenessError{Code: "invalid-project", Msg: dir + " could not be written, and nothing was changed", Remedy: remedy}
	case we.restored:
		return &LikenessError{Code: "invalid-project", Msg: config.shown(we.path) + " could not be written, and nothing was changed", Remedy: remedy}
	}
	return &LikenessError{Code: "invalid-project",
		Msg: config.shown(we.path) + " could not be written, and a file already replaced could not be put back", Remedy: remedy}
}

// asker is what an adapter's setup may ask of the run.
type asker struct {
	tty       bool
	confirm   func(label string) bool
	presented func(base string) (string, error)
}

// jsSpace is what JavaScript's String.prototype.trim takes off either end.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', 0xFEFF, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

func askOf(c Ctx) asker {
	tty := c.TTY && nil != c.Prompt
	return asker{
		tty: tty,
		confirm: func(label string) bool {
			if !tty {
				return false
			}
			typed, ok := c.Prompt(label)
			answer := foldCase(strings.TrimFunc(typed, jsSpace))
			return ok && ("y" == answer || "yes" == answer)
		},
		presented: func(base string) (string, error) {
			if nil == c.Presented {
				return "", errors.New("no probe for " + base)
			}
			return c.Presented(base)
		},
	}
}

func accountOf(source string, connect *Connect, given map[string]any) (string, bool, error) {
	value, has := given["account"]
	term := connect.Account.Term
	if connect.Account.Discover {
		if has {
			return "", false, bad("--account is for a source that cannot name its account, and "+source+" names its own",
				"drop --account; `sources add` asks "+source+" for it")
		}
		return "", false, nil
	}
	if !has {
		why := ""
		if nil != connect.Account.Why {
			why = ": " + *connect.Account.Why
		}
		return "", false, bad(source+"'s account cannot be discovered"+why,
			"give --account with "+term+"; every note's identity derives from it")
	}
	account, _ := value.(string)
	if "" == account {
		return "", false, bad("--account is empty", "give --account with "+term)
	}
	return account, true, nil
}

// plainBlock is the block of a source whose adapter writes none of its own: the base alone.
func plainBlock(given map[string]any) pairs {
	if base, ok := given["base"]; ok {
		return pairs{{"base", base}}
	}
	return pairs{}
}

// Station refuses a binding by panicking with its own error type, which here
// is the source not naming its account.
func askAccount(st *station.Station, a adapter, conn Connection, seed map[string]any) (account string, err error) {
	defer func() {
		if r := recover(); nil != r {
			se, ok := r.(*station.Error)
			if !ok {
				panic(r)
			}
			account, err = "", se
		}
	}()
	var config any
	if cf, ok := a.(configurer); ok {
		if config, err = cf.configure(conn.Instance, blockOf(st, conn.Instance)); nil != err {
			return "", err
		}
	}
	return a.(accounter).account(a.connect(st, conn, config, seed))
}

// discover is the account the source names, asked through a station on the
// configuration being written.
func discover(c Ctx, a adapter, config *configFiles, ref string, chain []any, watch func(*station.Station)) (string, error) {
	seed := c.Fixture[ref]
	if nil != seed {
		chain = []any{}
	}
	st, err := openStation(withChain(plainOf(config.doc), chain), c.Env)
	if nil != err {
		return "", err
	}
	watch(st)
	api := station.RefApi(ref)
	detail := map[string]string{"source": api, "instance": ref}
	account, err := askAccount(st, a, Connection{Instance: ref, Source: api}, seed)
	if le, ok := err.(*LikenessError); ok {
		return "", le
	}
	if nil != err {
		code := "source-unavailable"
		switch statusOf(err) {
		case 401, 403:
			code = "auth-failed"
		case 429:
			code = "rate-limited"
		}
		return "", &LikenessError{Code: code, Msg: api + " did not name the account " + ref + " reaches",
			Remedy: "run `likeness sources add` again once " + api + " answers, or check its token", Detail: detail}
	}
	if "" == account {
		return "", &LikenessError{Code: "source-unavailable", Msg: api + " named no account for " + ref,
			Remedy: "this is a bug in the source or its SDK", Detail: detail}
	}
	return account, nil
}

func addable() []string {
	out := []string{}
	for source := range adapters {
		if _, ok := connectOf(source); ok {
			out = append(out, source)
		}
	}
	sort.Strings(out)
	return out
}

func flagList(given map[string]any, flag string) []string {
	out := []string{}
	for _, v := range asList(given[flag]) {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

/*
sourcesAdd adds a connection: refused before any prompt where the flags alone
decide it, its token stored in the vault before either file changes, and both
files written together or not at all.
*/
func sourcesAdd(c Ctx, given map[string]any, f vaultFlags, watch func(*station.Station)) (answer, error) {
	choose := "name one of " + listed(addable())
	sources := flagList(given, "source")
	if 0 == len(sources) {
		return answer{}, bad("`sources add` needs --source, the API to connect", choose)
	}
	if 1 < len(sources) {
		return answer{}, bad("--source was given more than once, and `sources add` adds one connection", "give --source once")
	}
	source := sources[0]
	connect, ok := connectOf(source)
	if !ok {
		return answer{}, &LikenessError{Code: "no-such-source", Msg: "likeness reaches no source by the name --source gives", Remedy: choose}
	}
	a, ok := adapters[source]
	if !ok {
		return answer{}, &LikenessError{Code: "unsupported-capability", Msg: "no adapter for source \"" + source + "\" yet",
			Remedy: choose, Detail: map[string]string{"source": source}}
	}
	for _, flag := range sourceFlags() {
		if _, has := given[flag]; has && !contains(connect.Flag, flag) {
			return answer{}, bad("--"+flag+" does not apply to a "+source+" connection", flagRemedy)
		}
	}
	instances := flagList(given, "instance")
	if 1 < len(instances) {
		return answer{}, bad("--instance was given more than once, and `sources add` adds one connection",
			"give --instance once, with the tag")
	}
	ref, err := refFor(source, instances...)
	if nil != err {
		return answer{}, err
	}
	if base, has := given["base"]; has {
		if s, _ := base.(string); !baseRe.MatchString(s) {
			where := ", as scheme, host and port"
			if usual, ok := connect.Default["base"]; ok {
				where = ", such as " + usual
			}
			return answer{}, bad("--base is not an http or https address without credentials, a query or a fragment",
				"give where the application answers"+where)
		}
	}
	account, hasAccount, err := accountOf(source, connect, given)
	if nil != err {
		return answer{}, err
	}
	existing, hasExisting := given["secret"].(string)
	ask := askOf(c)
	if !hasExisting && !ask.tty {
		return answer{}, bad("the token is typed at a prompt, and stdin is not a terminal",
			"store it with `likeness secrets set "+secretName(ref)+" -`, and name it with --secret "+secretName(ref))
	}

	config, err := configOf(c)
	if nil != err {
		return answer{}, err
	}
	profile := profileOf(c.Env)
	current, err := asRead(c, config)
	if nil != err {
		return answer{}, err
	}
	if nil != member(sdkOf(config, profile), ref) {
		under := ""
		if "default" != profile {
			under = " under the profile \"" + profile + "\""
		}
		return answer{}, &LikenessError{Code: "instance-exists",
			Msg:    "a connection named \"" + ref + "\" is already configured" + under,
			Remedy: "choose another tag with --instance, or remove it first with `likeness sources remove " + ref + "`"}
	}
	entry, err := vaultEntry(plainOf(config.doc), profile, config.home, filepath.Dir(config.stationPath), f.vaultKey)
	if nil != err {
		return answer{}, err
	}
	if err := vaultPresent(entry); nil != err {
		return answer{}, err
	}

	chosen := map[string]any{}
	for k, v := range connect.Default {
		chosen[k] = v
	}
	for _, flag := range append([]string{"base"}, connect.Flag...) {
		if v, has := given[flag]; has {
			chosen[flag] = v
		}
	}
	made := plainBlock(chosen)
	if s, ok := a.(setupper); ok {
		if made, err = s.setup(ref, chosen, ask); nil != err {
			return answer{}, err
		}
	}

	sdk, err := ensure(config.doc, []string{"profiles", profile, "sdk"}, config.shown(config.stationPath))
	if nil != err {
		return answer{}, err
	}
	// Station words a shared secret name differently in each of its ports.
	refuse := func(code, message string) error {
		if "station_secret_collision" != code {
			return bad("station refuses the connection this would add: "+message, "give --secret a name `likeness secrets list` shows")
		}
		want := secretName(ref)
		if hasExisting {
			want = existing
		}
		why := ref + "'s secret name is another connection's as well"
		for _, inst := range current.Instances() {
			if want == secretOf(inst.Block, inst.Name) {
				why = ref + " would take its token from " + want + ", as " + inst.Name + " does"
				break
			}
		}
		return bad(why, "choose another tag with --instance, or name a secret of its own with --secret")
	}
	block := docOf(made)
	put(sdk, ref, block)
	st, err := stationOf(c, config, refuse)
	if nil != err {
		return answer{}, err
	}
	found := blockOf(st, ref)
	if hasExisting && existing != secretOf(found, ref) {
		put(block, "secret", docOf(existing))
		if st, err = stationOf(c, config, refuse); nil != err {
			return answer{}, err
		}
		found = blockOf(st, ref)
	}
	if cf, ok := a.(configurer); ok {
		if _, err := cf.configure(ref, found); nil != err {
			if le, ok := err.(*LikenessError); ok {
				return answer{}, bad(le.Msg, flagRemedy)
			}
			return answer{}, err
		}
	}
	secret := secretOf(found, ref)

	phrase, err := passphraseFor(c, f, entry.Key)
	if nil != err {
		return answer{}, err
	}
	vault, info, err := openedVault(entry, phrase)
	if nil != err {
		return answer{}, err
	}
	defer vault.Close()
	stored := ""
	got, err := func() (answer, error) {
		if hasExisting {
			names, err := vault.List()
			if nil != err {
				return answer{}, err
			}
			if !contains(names, secret) {
				return answer{}, &LikenessError{Code: "not-found",
					Msg:    "the vault has no " + secret + " that the key " + entry.Key + " can read",
					Remedy: "store it with `likeness secrets set " + secret + "`, or name another with --secret"}
			}
		} else {
			if !info.Master {
				return answer{}, &LikenessError{Code: "vault-denied",
					Msg:    "only a master key stores a new secret, and the key " + entry.Key + " is restricted",
					Remedy: "run it as the master key, or store the token first and name it with --secret"}
			}
			names, err := vault.List()
			if nil != err {
				return answer{}, err
			}
			if contains(names, secret) {
				return answer{}, &LikenessError{Code: "vault-exists",
					Msg:    "the vault already holds " + secret + ", and `sources add` never overwrites a token",
					Remedy: "use it with --secret " + secret + ", or drop it first with `likeness secrets remove " + secret + "`"}
			}
			token, ok := c.Prompt("token for " + ref)
			if !ok || "" == token {
				return answer{}, bad("no token was given", "run it again, and type the token")
			}
			if err := written(entry, vault.Set(secret, token)); nil != err {
				return answer{}, err
			}
			stored = secret
		}

		id := account
		if !hasAccount {
			chain := []any{map[string]any{"kind": "minivault", "file": entry.File, "vaultkey": entry.Key, "passphrase": phrase}}
			var err error
			if id, err = discover(c, a, config, ref, chain, watch); nil != err {
				return answer{}, err
			}
		}
		accounts := config.accounts
		if nil == accounts {
			accounts = docOf(pairs{{"likeness", 1}, {"profiles", pairs{}}})
		}
		at, err := ensure(accounts, []string{"profiles", profile, "instances"}, config.shown(config.likenessPath))
		if nil != err {
			return answer{}, err
		}
		put(at, ref, docOf(pairs{{"account", id}}))
		if err := writeConfig(c, config, accounts); nil != err {
			return answer{}, err
		}

		to := ""
		if "default" != profile {
			to = " to the profile " + profile
		}
		return answer{data: rowOf(ref, found, &id, true), count: 1,
			text: "added " + ref + to + ", its token in the vault as " + secret + "\n"}, nil
	}()
	if nil != err && "" != stored {
		_ = vault.Remove(stored)
	}
	return got, err
}

// sourcesRemove removes a connection and its account together. The vault is the secrets group's.
func sourcesRemove(c Ctx, ref string) (answer, error) {
	config, err := configOf(c)
	if nil != err {
		return answer{}, err
	}
	profile := profileOf(c.Env)
	st, err := asRead(c, config)
	if nil != err {
		return answer{}, err
	}
	secret := secretOf(blockOf(st, ref), ref)
	if err := owned(config, profile, ref); nil != err {
		return answer{}, err
	}
	drop(sdkOf(config, profile), ref)
	var accounts *doc
	if drop(find(config.accounts, []string{"profiles", profile, "instances"}), ref) {
		accounts = config.accounts
	}
	if err := writeConfig(c, config, accounts); nil != err {
		return answer{}, err
	}
	return answer{data: map[string]any{"instance": ref, "secret": secret}, count: 1,
		text: "removed " + ref + "; the vault still holds " + secret + ", which `likeness secrets` manages\n"}, nil
}

/*
sourcesRename gives a connection a new ref, keeping its place in both files. A
token found by the ref's derived name is named in the block, since that name
changes with the ref.
*/
func sourcesRename(c Ctx, from, to string) (answer, error) {
	if from == to {
		return answer{}, bad(from+" already has that ref", "give the new ref second: `likeness sources rename "+from+" <new-ref>`")
	}
	api := station.RefApi(from)
	if station.RefApi(to) != api {
		return answer{}, bad("a connection keeps its API, so "+from+" cannot become "+to,
			"rename it to "+api+" or "+api+"$<tag>; a connection to another API is added with `likeness sources add`")
	}
	config, err := configOf(c)
	if nil != err {
		return answer{}, err
	}
	profile := profileOf(c.Env)
	st, err := asRead(c, config)
	if nil != err {
		return answer{}, err
	}
	if err := owned(config, profile, from); nil != err {
		return answer{}, err
	}
	for _, inst := range st.Instances() {
		if to == inst.Name {
			return answer{}, &LikenessError{Code: "instance-exists", Msg: "a connection named \"" + to + "\" is already configured",
				Remedy: "choose another ref, or remove that one first with `likeness sources remove " + to + "`"}
		}
	}
	before := blockOf(st, from)
	sdk := sdkOf(config, profile)
	rekey(sdk, from, to)
	if !namesSecret(before) {
		put(member(sdk, to), "secret", docOf(secretName(from)))
	}
	after, err := stationOf(c, config, func(code, _ string) error {
		return bad(from+" cannot become "+to+": station refuses the configuration that would leave, as "+code, "choose another ref")
	})
	if nil != err {
		return answer{}, err
	}

	var moved *doc
	if instances := find(config.accounts, []string{"profiles", profile, "instances"}); nil != instances {
		if drop(instances, to) {
			moved = config.accounts
		}
		if nil != member(instances, from) {
			rekey(instances, from, to)
			moved = config.accounts
		}
	}
	if err := writeConfig(c, config, moved); nil != err {
		return answer{}, err
	}
	secret := secretOf(blockOf(after, to), to)
	return answer{data: map[string]any{"instance": to, "was": from, "secret": secret}, count: 1,
		text: "renamed " + from + " to " + to + "; its token is still " + secret + " in the vault\n"}, nil
}
