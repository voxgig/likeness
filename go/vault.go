package likeness

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/voxgig/sekreto/go/plugins/minivault"
)

const (
	defaultVaultFile = "likeness.skmv"
	passphraseEnv    = "LIKENESS_PASSPHRASE"
	newPassphraseEnv = "LIKENESS_NEW_PASSPHRASE"
	vaultRemedy      = `name the vault alone: "providers": [{ "kind": "minivault", "file": "likeness.skmv" }]`
)

var keyRe = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// VaultEntry is the vault station.json names, resolved.
type VaultEntry struct {
	File  string
	Key   string
	Shown string
}

// vaultFlags are the flags a vault command reads.
type vaultFlags struct {
	passphraseEnv    string
	newPassphraseEnv string
	vaultKey         string
	reveal           bool
	write            bool
}

type answer struct {
	data  any
	count int
	text  string
	empty bool
}

func refused(message, remedy string) *LikenessError {
	return &LikenessError{Code: "invalid-project", Msg: message, Remedy: remedy}
}

func shownPath(path, home string) string {
	h := filepath.Clean(home)
	if path == h {
		return "~"
	}
	if strings.HasPrefix(path, h+"/") {
		return "~/" + path[len(h)+1:]
	}
	return path
}

func located(file, home, dir string) string {
	if strings.HasPrefix(file, "~/") {
		return filepath.Join(home, file[2:])
	}
	if filepath.IsAbs(file) {
		return filepath.Clean(file)
	}
	abs, err := filepath.Abs(filepath.Join(dir, file))
	if nil != err {
		return filepath.Join(dir, file)
	}
	return abs
}

func chainOf(profile any) (any, bool) {
	p, _ := profile.(map[string]any)
	secrets, _ := p["secrets"].(map[string]any)
	providers, ok := secrets["providers"]
	return providers, ok && nil != providers
}

// vaultEntry checks station.json's chain against the one store likeness
// allows: a minivault, chosen the way station chooses its profile's chain,
// with no passphrase written beside it.
func vaultEntry(station map[string]any, profile, home, dir, key string) (VaultEntry, error) {
	profiles, _ := station["profiles"].(map[string]any)
	providers, named := any(nil), false
	if "default" != profile {
		providers, named = chainOf(profiles[profile])
	}
	if !named {
		providers, named = chainOf(profiles["default"])
	}

	entry := map[string]any{"kind": "minivault"}
	if named {
		list, isList := providers.([]any)
		if !isList || 1 != len(list) {
			return VaultEntry{}, refused("station.json's secrets.providers must name one store, the vault", vaultRemedy)
		}
		only, isMap := list[0].(map[string]any)
		if _, has := only["kind"]; isMap && !has {
			return VaultEntry{}, refused("the vault entry in station.json does not name its kind", vaultRemedy)
		}
		kind := list[0]
		if isMap {
			kind = only["kind"]
		}
		if k, _ := kind.(string); !isMap || "minivault" != k {
			return VaultEntry{}, refused("likeness reads secrets from its vault alone, and station.json names the store \""+
				textOf(kind)+"\"", vaultRemedy)
		}
		if _, has := only["passphrase"]; has {
			return VaultEntry{}, refused("station.json holds the vault's passphrase, and a passphrase is never written to a file",
				"remove it, and set "+passphraseEnv+" or name a variable with --passphrase-env")
		}
		extra := []string{}
		for k := range only {
			if "file" != k && "kind" != k && "vaultkey" != k {
				extra = append(extra, k)
			}
		}
		if 0 < len(extra) {
			sort.Strings(extra)
			return VaultEntry{}, refused("the vault entry in station.json has no key \""+extra[0]+"\"",
				"the vault entry takes kind, file and vaultkey")
		}
		if f, has := only["file"]; has {
			if s, ok := f.(string); !ok || "" == s {
				return VaultEntry{}, refused("the vault entry's file is not a path", `name the file: "file": "likeness.skmv"`)
			}
		}
		if vk, has := only["vaultkey"]; has {
			if s, ok := vk.(string); !ok || !keyRe.MatchString(s) {
				return VaultEntry{}, refused("the vault entry's vaultkey is not a key name", "a key name is [a-z][a-z0-9-]*")
			}
		}
		entry = only
	}

	file, _ := entry["file"].(string)
	if "" == file {
		file = defaultVaultFile
	}
	abs := located(file, home, dir)
	if "" == key {
		key, _ = entry["vaultkey"].(string)
	}
	if "" == key {
		key = "master"
	}
	return VaultEntry{File: abs, Key: key, Shown: shownPath(abs, home)}, nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return nil == err
}

func vaultPresent(entry VaultEntry) error {
	if !exists(entry.File) {
		return &LikenessError{Code: "secret-backend-unavailable", Msg: "no vault at " + entry.Shown,
			Remedy: "run `likeness secrets init` to create it, or point station.json at the vault"}
	}
	return nil
}

// passphraseFor is the passphrase that opens the vault: from the environment,
// else typed.
func passphraseFor(c Ctx, f vaultFlags, key string) (string, error) {
	name := f.passphraseEnv
	if "" == name {
		name = passphraseEnv
	}
	if v := c.Env[name]; "" != v {
		return v, nil
	}
	if c.TTY && nil != c.Prompt {
		typed, ok := c.Prompt("passphrase for " + key)
		if !ok || "" == typed {
			return "", &LikenessError{Code: "vault-locked", Msg: "no passphrase was given",
				Remedy: "run it again, and type the passphrase"}
		}
		return typed, nil
	}
	// The variable a flag named is not repeated: a passphrase given there by
	// mistake would otherwise be printed.
	if "" == f.passphraseEnv {
		return "", &LikenessError{Code: "vault-locked",
			Msg:    "no passphrase: " + passphraseEnv + " is not set, and stdin is not a terminal to ask on",
			Remedy: "set " + passphraseEnv + ", or name another variable with --passphrase-env"}
	}
	return "", &LikenessError{Code: "vault-locked",
		Msg:    "no passphrase: the variable --passphrase-env names is not set, and stdin is not a terminal to ask on",
		Remedy: "set that variable, or run on a terminal to be asked"}
}

// newPassphrase is a passphrase for a key being made, typed twice when it is
// typed at all.
func newPassphrase(c Ctx, flagged, fallback, flag, label string) (string, error) {
	name := flagged
	if "" == name {
		name = fallback
	}
	if v := c.Env[name]; "" != v {
		return v, nil
	}
	if c.TTY && nil != c.Prompt {
		first, ok := c.Prompt(label)
		if !ok || "" == first {
			return "", &LikenessError{Code: "invalid-argument", Msg: "no passphrase was given",
				Remedy: "run it again, and type one"}
		}
		if again, _ := c.Prompt("the same passphrase again"); first != again {
			return "", &LikenessError{Code: "invalid-argument", Msg: "the two passphrases differ", Remedy: "run it again"}
		}
		return first, nil
	}
	if "" == flagged {
		return "", &LikenessError{Code: "invalid-argument",
			Msg:    "no passphrase for the new key: " + fallback + " is not set, and stdin is not a terminal to ask on",
			Remedy: "set " + fallback + ", or name another variable with --" + flag}
	}
	return "", &LikenessError{Code: "invalid-argument",
		Msg:    "no passphrase for the new key: the variable --" + flag + " names is not set, and stdin is not a terminal to ask on",
		Remedy: "set that variable, or run on a terminal to be asked"}
}

func openedVault(entry VaultEntry, phrase string) (*minivault.Vault, *minivault.KeyInfo, error) {
	locked := &LikenessError{Code: "vault-locked",
		Msg: "the vault does not open as the key " + entry.Key +
			": the passphrase is wrong, the key is not there, or the file is damaged",
		Remedy: "check the passphrase, and the key --vault-key names"}
	vault, err := minivault.Open(&minivault.Options{File: entry.File, Key: entry.Key, Passphrase: phrase})
	if nil != err {
		return nil, nil, locked
	}
	info, err := vault.Info()
	if nil != err {
		return nil, nil, locked
	}
	return vault, info, nil
}

func written(entry VaultEntry, err error) error {
	if nil == err {
		return nil
	}
	return &LikenessError{Code: "secret-backend-unavailable", Msg: "the vault could not be written",
		Remedy: "check that " + filepath.Dir(entry.Shown) + " is writable and its disk has space"}
}

func needsMaster(info *minivault.KeyInfo, action string) error {
	if !info.Master {
		return &LikenessError{Code: "vault-denied",
			Msg:    "`secrets " + action + "` needs a master key, and " + info.Key + " is restricted",
			Remedy: "run it as the master key, with --vault-key"}
	}
	return nil
}

func roleOf(k *minivault.KeyInfo) string {
	switch {
	case k.Master:
		return "master"
	case k.Write:
		return "write"
	}
	return "read"
}

func notReadable(name, key string) error {
	return &LikenessError{Code: "not-found",
		Msg:    "the vault has no " + name + " that the key " + key + " can read",
		Remedy: "run `likeness secrets list` for the names it can read"}
}

// vaultChain is the chain station resolves a live connection's token through.
func vaultChain(c Ctx, entry VaultEntry, f vaultFlags) ([]any, error) {
	if err := vaultPresent(entry); nil != err {
		return nil, err
	}
	phrase, err := passphraseFor(c, f, entry.Key)
	if nil != err {
		return nil, err
	}
	vault, _, err := openedVault(entry, phrase)
	if nil != err {
		return nil, err
	}
	vault.Close()
	return []any{map[string]any{
		"kind": "minivault", "file": entry.File, "vaultkey": entry.Key, "passphrase": phrase,
	}}, nil
}

func keyRows(keys []*minivault.KeyInfo) []any {
	rows := make([]any, 0, len(keys))
	for _, k := range keys {
		rows = append(rows, map[string]any{
			"key": k.Key, "master": k.Master, "write": k.Write, "grants": strList(append([]string{}, k.Grants...)),
		})
	}
	return rows
}

func hasKey(keys []*minivault.KeyInfo, key string) bool {
	for _, k := range keys {
		if key == k.Key {
			return true
		}
	}
	return false
}

func initVault(c Ctx, entry VaultEntry, f vaultFlags) (answer, error) {
	if exists(entry.File) {
		return answer{}, &LikenessError{Code: "vault-exists",
			Msg:    entry.Shown + " already exists, and init never overwrites it",
			Remedy: "use the vault that is there, or name another file in station.json"}
	}
	phrase, err := newPassphrase(c, f.passphraseEnv, passphraseEnv, "passphrase-env", "new passphrase for "+entry.Key)
	if nil != err {
		return answer{}, err
	}
	err = os.MkdirAll(filepath.Dir(entry.File), 0o700)
	if nil == err {
		var vault *minivault.Vault
		vault, err = minivault.Create(&minivault.Options{File: entry.File, Key: entry.Key, Passphrase: phrase})
		if nil == err {
			vault.Close()
		}
	}
	if err := written(entry, err); nil != err {
		return answer{}, err
	}
	return answer{
		data:  map[string]any{"file": entry.Shown, "key": entry.Key},
		count: 1,
		text:  "created the vault " + entry.Shown + ", with the key " + entry.Key + "\n",
	}, nil
}

func secretsAction(c Ctx, action string, args []string, entry VaultEntry, f vaultFlags) (answer, error) {
	if "init" == action {
		return initVault(c, entry, f)
	}
	if err := vaultPresent(entry); nil != err {
		return answer{}, err
	}
	name := ""
	if 0 < len(args) {
		name = args[0]
	}
	fromStdin := 1 < len(args) && "-" == args[1]
	if "set" == action && !fromStdin && !c.TTY {
		return answer{}, &LikenessError{Code: "invalid-argument",
			Msg:    "`secrets set` reads the value from a terminal, or from stdin given as -",
			Remedy: "pipe the value in, with - after the name"}
	}

	phrase, err := passphraseFor(c, f, entry.Key)
	if nil != err {
		return answer{}, err
	}
	vault, info, err := openedVault(entry, phrase)
	if nil != err {
		return answer{}, err
	}
	defer vault.Close()

	switch action {
	case "list":
		names, err := vault.List()
		if nil != err {
			return answer{}, err
		}
		sort.Strings(names)
		text := ""
		for _, n := range names {
			text += n + "\n"
		}
		return answer{data: strList(names), count: len(names), text: text, empty: 0 == len(names)}, nil

	case "get":
		value, found, err := vault.Get(name)
		if nil != err {
			return answer{}, err
		}
		if !found {
			return answer{}, notReadable(name, entry.Key)
		}
		if f.reveal {
			return answer{data: map[string]any{"name": name, "value": value}, count: 1, text: value + "\n"}, nil
		}
		return answer{data: map[string]any{"name": name}, count: 1,
			text: name + " is set; --reveal prints its value\n"}, nil

	case "set":
		if !info.Master {
			if !info.Write {
				return answer{}, &LikenessError{Code: "vault-denied", Msg: "the key " + entry.Key + " is read-only",
					Remedy: "run it as the master key, or as one granted --write"}
			}
			if !contains(info.Grants, name) {
				return answer{}, &LikenessError{Code: "vault-denied",
					Msg:    "the key " + entry.Key + " was not granted " + name,
					Remedy: "run it as the master key, or as a key granted that name"}
			}
			names, err := vault.List()
			if nil != err {
				return answer{}, err
			}
			if !contains(names, name) {
				return answer{}, &LikenessError{Code: "vault-denied",
					Msg:    "only a master key creates a secret, and " + name + " is not in the vault",
					Remedy: "set it once as the master key"}
			}
		}
		given := ""
		if fromStdin {
			if nil != c.Stdin {
				given, _ = c.Stdin()
			}
		} else if nil != c.Prompt {
			given, _ = c.Prompt("value for " + name)
		}
		// One line ending goes: `echo token |` should store the token.
		value := given
		if strings.HasSuffix(value, "\n") {
			value = strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r")
		}
		if "" == value {
			return answer{}, &LikenessError{Code: "invalid-argument", Msg: "the value is empty",
				Remedy: "a secret needs a value; `likeness secrets remove` drops one"}
		}
		if err := written(entry, vault.Set(name, value)); nil != err {
			return answer{}, err
		}
		return answer{data: map[string]any{"name": name}, count: 1, text: "set " + name + "\n"}, nil

	case "remove":
		if err := needsMaster(info, action); nil != err {
			return answer{}, err
		}
		names, err := vault.List()
		if nil != err {
			return answer{}, err
		}
		if !contains(names, name) {
			return answer{}, notReadable(name, entry.Key)
		}
		if err := written(entry, vault.Remove(name)); nil != err {
			return answer{}, err
		}
		return answer{data: map[string]any{"name": name}, count: 1, text: "removed " + name + "\n"}, nil

	case "keys":
		if err := needsMaster(info, action); nil != err {
			return answer{}, err
		}
		keys, err := vault.Keys()
		if nil != err {
			return answer{}, err
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i].Key < keys[j].Key })
		width := 0
		for _, k := range keys {
			if len(k.Key) > width {
				width = len(k.Key)
			}
		}
		text := ""
		for _, k := range keys {
			line := pad(k.Key, width, false) + "  " + pad(roleOf(k), 6, false) + "  " + strings.Join(k.Grants, ", ")
			text += strings.TrimRight(line, " ") + "\n"
		}
		return answer{data: keyRows(keys), count: len(keys), text: text}, nil

	case "grant":
		if err := needsMaster(info, action); nil != err {
			return answer{}, err
		}
		key := args[0]
		names := []string{}
		for _, n := range args[1:] {
			if !contains(names, n) {
				names = append(names, n)
			}
		}
		sort.Strings(names)
		keys, err := vault.Keys()
		if nil != err {
			return answer{}, err
		}
		if hasKey(keys, key) {
			return answer{}, &LikenessError{Code: "vault-exists", Msg: "the vault already has a key " + key,
				Remedy: "revoke it first, or choose another name"}
		}
		phrase, err := newPassphrase(c, f.newPassphraseEnv, newPassphraseEnv, "new-passphrase-env",
			"passphrase for the new key "+key)
		if nil != err {
			return answer{}, err
		}
		if err := written(entry, vault.Grant(&minivault.GrantSpec{
			Key: key, Passphrase: phrase, Names: names, Write: f.write,
		})); nil != err {
			return answer{}, err
		}
		reading := "reading "
		if f.write {
			reading = "reading and writing "
		}
		return answer{
			data:  map[string]any{"grants": strList(names), "key": key, "write": f.write},
			count: 1,
			text:  "granted " + key + ", " + reading + strings.Join(names, ", ") + "\n",
		}, nil

	case "revoke":
		if err := needsMaster(info, action); nil != err {
			return answer{}, err
		}
		key := args[0]
		if key == entry.Key {
			return answer{}, &LikenessError{Code: "vault-denied", Msg: key + " cannot revoke itself",
				Remedy: "`likeness secrets rotate` withdraws every other key"}
		}
		keys, err := vault.Keys()
		if nil != err {
			return answer{}, err
		}
		if !hasKey(keys, key) {
			return answer{}, &LikenessError{Code: "not-found", Msg: "the vault has no key " + key,
				Remedy: "run `likeness secrets keys` for the keys there are"}
		}
		if err := written(entry, vault.Revoke(key)); nil != err {
			return answer{}, err
		}
		return answer{data: map[string]any{"key": key}, count: 1, text: "revoked " + key + "\n"}, nil

	case "rotate":
		if err := needsMaster(info, action); nil != err {
			return answer{}, err
		}
		keys, err := vault.Keys()
		if nil != err {
			return answer{}, err
		}
		dropped := []string{}
		for _, k := range keys {
			if k.Key != entry.Key {
				dropped = append(dropped, k.Key)
			}
		}
		sort.Strings(dropped)
		if err := written(entry, vault.Rotate()); nil != err {
			return answer{}, err
		}
		text := "rotated the vault"
		if 0 < len(dropped) {
			text += "; dropped " + strings.Join(dropped, ", ")
		}
		return answer{data: map[string]any{"dropped": strList(dropped)}, count: 1, text: text + "\n"}, nil
	}
	return answer{}, &LikenessError{Code: "invalid-argument", Msg: "no such command: secrets " + action,
		Remedy: "run `likeness help secrets` for its actions"}
}
