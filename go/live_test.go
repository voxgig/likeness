package likeness

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/voxgig/sekreto/go/plugins/minivault"
	"github.com/voxgig/station/go/station"
)

type throwaway struct {
	der  []byte
	cert tls.Certificate
	pem  string
	key  string
}

var certSerial atomic.Int64

// selfSigned is a certificate for 127.0.0.1 as the Obsidian plugin makes one:
// its own authority, naming the address it serves. from and to place its
// validity in days around now: -1, 2 is current and -3, -1 has expired.
func selfSigned(t *testing.T, from, to int) throwaway {
	t.Helper()
	return certFor(t, net.IPv4(127, 0, 0, 1), from, to)
}

func certFor(t *testing.T, ip net.IP, from, to int) throwaway {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if nil != err {
		t.Fatal(err)
	}
	day := 24 * time.Hour
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(certSerial.Add(1)),
		Subject:               pkix.Name{CommonName: ip.String()},
		NotBefore:             now.Add(time.Duration(from) * day),
		NotAfter:              now.Add(time.Duration(to) * day),
		IsCA:                  true,
		BasicConstraintsValid: true,
		IPAddresses:           []net.IP{ip},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if nil != err {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if nil != err {
		t.Fatal(err)
	}
	certPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	pair, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if nil != err {
		t.Fatal(err)
	}
	return throwaway{der: der, cert: pair, pem: certPEM, key: keyPEM}
}

// mockServer is mock/ running in a node process of its own, and a client for
// its control plane that trusts what it serves.
type mockServer struct {
	base   string
	client *http.Client
}

// The mock's own entry runs plain HTTP alone, so it is built here as an
// in-process suite builds it, with the options given.
const mockScript = `
const { buildServer } = await import(process.env.LIKENESS_MOCK_MODULE)
const app = await buildServer(JSON.parse(process.env.LIKENESS_MOCK_OPTIONS))
await app.listen({ port: 0, host: '127.0.0.1' })
process.stdout.write('likeness mock listening on port ' + app.server.address().port + '\n')
`

func serveMock(t *testing.T, sources []string, served *throwaway) mockServer {
	t.Helper()
	if _, err := exec.LookPath("node"); nil != err {
		t.Fatal("node is required: the wire tests drive the real transport against mock/")
	}
	opts := map[string]any{}
	if nil != sources {
		opts["sources"] = sources
	}
	scheme := "http"
	client := &http.Client{Transport: &http.Transport{}}
	if nil != served {
		opts["https"] = map[string]any{"key": served.key, "cert": served.pem}
		scheme = "https"
		leaf, err := x509.ParseCertificate(served.der)
		if nil != err {
			t.Fatal(err)
		}
		roots := x509.NewCertPool()
		roots.AddCert(leaf)
		client = &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}}
	}
	encoded, err := json.Marshal(opts)
	if nil != err {
		t.Fatal(err)
	}
	module := (&url.URL{Scheme: "file", Path: filepath.Join(Root(t), "mock", "server.js")}).String()

	cmd := exec.Command("node", "--input-type=module", "-e", mockScript)
	cmd.Env = append(os.Environ(), "LIKENESS_MOCK_MODULE="+module, "LIKENESS_MOCK_OPTIONS="+string(encoded))
	cmd.Stderr = os.Stderr
	out, err := cmd.StdoutPipe()
	if nil != err {
		t.Fatal(err)
	}
	if err := cmd.Start(); nil != err {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	port := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			if rest, found := strings.CutPrefix(sc.Text(), "likeness mock listening on port "); found {
				port <- rest
			}
		}
	}()
	select {
	case p := <-port:
		return mockServer{base: scheme + "://127.0.0.1:" + p, client: client}
	case <-time.After(30 * time.Second):
		t.Fatal("the mock server did not report its address in time")
	}
	return mockServer{}
}

// mockRow is one request as the mock's ring records it.
type mockRow struct {
	Source  string            `json:"source"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Auth    string            `json:"auth"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
}

// rows are the requests the mock received for one source, in the order they came.
func (m mockServer) rows(t *testing.T, source string) []mockRow {
	t.Helper()
	resp, err := m.client.Get(m.base + "/__requests?source=" + source)
	if nil != err {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := []mockRow{}
	if err := json.NewDecoder(resp.Body).Decode(&out); nil != err {
		t.Fatal(err)
	}
	return out
}

func (m mockServer) clear(t *testing.T) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", m.base+"/__requests", nil)
	resp, err := m.client.Do(req)
	if nil != err {
		t.Fatal(err)
	}
	resp.Body.Close()
}

const wirePassphrase = "wire suite passphrase"

type liveStation struct {
	st    *station.Station
	calls *Calls
	conns []Connection
}

// live is a station over the given instance blocks, its tokens in a
// throwaway vault.
func live(t *testing.T, sdk map[string]any, tokens, accounts map[string]string) liveStation {
	t.Helper()
	file := filepath.Join(t.TempDir(), "likeness.skmv")
	vault, err := minivault.Create(&minivault.Options{File: file, Key: "master", Passphrase: wirePassphrase, Iterations: 1000})
	if nil != err {
		t.Fatal(err)
	}
	for name, value := range tokens {
		if err := vault.Set(name, value); nil != err {
			t.Fatal(err)
		}
	}
	vault.Close()
	chain := []any{map[string]any{"kind": "minivault", "file": file, "vaultkey": "master", "passphrase": wirePassphrase}}
	st, err := openStation(map[string]any{
		"station":  1,
		"profiles": map[string]any{"default": map[string]any{"secrets": map[string]any{"providers": chain}, "sdk": sdk}},
	}, nil)
	if nil != err {
		t.Fatal(err)
	}
	conns, err := connectionsOf(st, accounts, "default")
	if nil != err {
		t.Fatal(err)
	}
	return liveStation{st: st, calls: NewCalls(st), conns: conns}
}

// asked is each call station observed, as method and path.
func (l liveStation) asked() []string {
	out := []string{}
	for _, c := range l.calls.All() {
		out = append(out, c.Method+" "+c.Path)
	}
	return out
}

func received(rows []mockRow) []string {
	out := []string{}
	for _, r := range rows {
		out = append(out, r.Method+" "+r.URL)
	}
	return out
}

// leaks reports whether a value reached station's events.
func (l liveStation) leaks(t *testing.T, value string) bool {
	t.Helper()
	events, err := json.Marshal(l.st.Events())
	if nil != err {
		t.Fatal(err)
	}
	return strings.Contains(string(events), value)
}
