package likeness

import "github.com/voxgig/station/go/station"

// Connection is one declared station instance and the account it belongs to.
type Connection struct {
	Instance string
	Source   string
	Account  string
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
func connectionsOf(st *station.Station, accounts map[string]string, profile string) ([]Connection, error) {
	out := []Connection{}
	for _, inst := range st.Instances() {
		if !inst.Active {
			continue
		}
		account := accounts[inst.Name]
		if "" == account {
			return nil, &LikenessError{
				Code:   "invalid-project",
				Msg:    "instance \"" + inst.Name + "\" has no account in likeness.json under profile \"" + profile + "\"",
				Remedy: "add `\"" + inst.Name + "\": { \"account\": \"<id>\" }` under `profiles." + profile + ".instances` in likeness.json",
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
