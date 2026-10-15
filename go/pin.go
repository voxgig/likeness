package likeness

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var pinShape = regexp.MustCompile(`^sha256:(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31})$`)

var errNotAPin = errors.New("not a sha256 certificate fingerprint")

// parsePin reads `sha256:` and the hex digest, bare or as colon-joined pairs,
// in either case.
func parsePin(v any) (string, error) {
	text, ok := v.(string)
	if !ok || !pinShape.MatchString(text) {
		return "", errNotAPin
	}
	return "sha256:" + strings.ToLower(strings.ReplaceAll(text[len("sha256:"):], ":", "")), nil
}

func fingerprintOf(der []byte) string {
	sum := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(sum[:])
}

const (
	refusedChanged     = "changed"
	refusedExpired     = "expired"
	refusedNotYetValid = "not-yet-valid"
	refusedWrongHost   = "wrong-host"
	refusedInvalid     = "invalid"
)

type certificateError struct{ refusal string }

func (e *certificateError) Error() string { return "the certificate was refused: " + e.refusal }

// refusalOf names why a handshake refused the certificate; an error that is
// not about the certificate comes back as it is.
func refusalOf(err error) error {
	var pinned *certificateError
	if errors.As(err, &pinned) {
		return pinned
	}
	var verification *tls.CertificateVerificationError
	if !errors.As(err, &verification) {
		return err
	}
	var invalid x509.CertificateInvalidError
	var host x509.HostnameError
	var authority x509.UnknownAuthorityError
	switch {
	case errors.As(verification.Err, &invalid) && x509.Expired == invalid.Reason:
		if time.Now().Before(invalid.Cert.NotBefore) {
			return &certificateError{refusedNotYetValid}
		}
		return &certificateError{refusedExpired}
	case errors.As(verification.Err, &host):
		return &certificateError{refusedWrongHost}
	case errors.As(verification.Err, &authority):
		return &certificateError{refusedChanged}
	}
	return &certificateError{refusedInvalid}
}

type endpoint struct{ host, port string }

func endpointOf(u *url.URL) endpoint {
	port := u.Port()
	if "" == port {
		port = "443"
	}
	return endpoint{host: u.Hostname(), port: port}
}

func (at endpoint) dial() (net.Conn, error) {
	return net.Dial("tcp", net.JoinHostPort(at.host, at.port))
}

// presented is the certificate a server shows to a handshake that trusts no
// root at all, so Go's verification ends it once the certificate has arrived
// and before anything is written on it.
func presented(at endpoint) (*x509.Certificate, error) {
	raw, err := at.dial()
	if nil != err {
		return nil, err
	}
	defer raw.Close()
	err = tls.Client(raw, &tls.Config{ServerName: at.host, RootCAs: x509.NewCertPool()}).Handshake()
	var verification *tls.CertificateVerificationError
	if errors.As(err, &verification) && 0 < len(verification.UnverifiedCertificates) {
		return verification.UnverifiedCertificates[0], nil
	}
	if nil == err {
		return nil, &certificateError{refusedInvalid}
	}
	return nil, err
}

// verified is a connection Go's own verification accepted, with the pinned
// certificate as the only root and the host checked against it, that then
// presented the pinned certificate itself.
func verified(at endpoint, anchor *x509.Certificate, pin string) (*tls.Conn, error) {
	raw, err := at.dial()
	if nil != err {
		return nil, err
	}
	roots := x509.NewCertPool()
	roots.AddCert(anchor)
	conn := tls.Client(raw, &tls.Config{
		ServerName: at.host,
		RootCAs:    roots,
		VerifyConnection: func(state tls.ConnectionState) error {
			if pin != fingerprintOf(state.PeerCertificates[0].Raw) {
				return &certificateError{refusedChanged}
			}
			return nil
		},
	})
	if err := conn.Handshake(); nil != err {
		raw.Close()
		return nil, refusalOf(err)
	}
	return conn, nil
}

// pinnedTransport serves the SDK's `utility.fetcher` seam, trusting exactly
// the certificate whose SHA-256 fingerprint is its pin. No request byte is
// written before the presented certificate has matched it.
type pinnedTransport struct {
	pin    string
	anchor *x509.Certificate
	// The SDK keeps only the text of its transport's error, so a refusal is
	// held here until the adapter takes it.
	refused *certificateError
}

func (p *pinnedTransport) takeRefusal() *certificateError {
	r := p.refused
	p.refused = nil
	return r
}

func (p *pinnedTransport) fetch(fullurl string, def map[string]any) (map[string]any, error) {
	res, err := p.request(fullurl, def)
	p.refused = nil
	var refused *certificateError
	if errors.As(err, &refused) {
		p.refused = refused
	}
	return res, err
}

func (p *pinnedTransport) request(fullurl string, def map[string]any) (map[string]any, error) {
	u, err := url.Parse(fullurl)
	if nil != err {
		return nil, err
	}
	if "https" != u.Scheme {
		return nil, &certificateError{refusedInvalid}
	}
	at := endpointOf(u)
	if nil == p.anchor {
		cert, err := presented(at)
		if nil != err {
			return nil, err
		}
		if p.pin != fingerprintOf(cert.Raw) {
			return nil, &certificateError{refusedChanged}
		}
		p.anchor = cert
	}
	conn, err := verified(at, p.anchor, p.pin)
	if nil != err {
		var refused *certificateError
		if errors.As(err, &refused) {
			p.anchor = nil
		}
		return nil, err
	}
	return exchange(conn, u, def)
}

// exchange sends one request on a verified connection and reads its whole
// response into the shape the SDK's own transport answers with. The
// connection is closed once the response is read: one left open would hold
// the process until the plugin times it out.
func exchange(conn *tls.Conn, u *url.URL, def map[string]any) (map[string]any, error) {
	defer conn.Close()
	method, _ := def["method"].(string)
	if "" == method {
		method = "GET"
	}
	req, err := http.NewRequest(method, u.String(), requestBody(def["body"]))
	if nil != err {
		return nil, err
	}
	// An empty User-Agent sends none: the request carries the SDK's headers alone.
	req.Header.Set("User-Agent", "")
	if headers, ok := def["headers"].(map[string]any); ok {
		for k, v := range headers {
			if s, ok := v.(string); ok {
				req.Header.Set(k, s)
			}
		}
	}
	if err := req.Write(conn); nil != err {
		return nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if nil != err {
		return nil, err
	}
	raw, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if nil != err {
		return nil, err
	}

	headers := map[string]any{}
	for k, vals := range resp.Header {
		headers[strings.ToLower(k)] = strings.Join(vals, ", ")
	}
	var body any
	unreadable := false
	if 0 < len(bytes.TrimSpace(raw)) {
		unreadable = nil != json.Unmarshal(raw, &body)
	}
	statusText := resp.Status
	if at := strings.Index(statusText, " "); 0 <= at {
		statusText = statusText[at+1:]
	}
	return map[string]any{
		"status":     resp.StatusCode,
		"statusText": statusText,
		"headers":    headers,
		"json":       func() any { return body },
		"body":       string(raw),
		"unreadable": unreadable,
	}, nil
}

func requestBody(body any) io.Reader {
	switch b := body.(type) {
	case string:
		if "" != b {
			return strings.NewReader(b)
		}
	case []byte:
		return bytes.NewReader(b)
	case io.Reader:
		return b
	}
	return nil
}
