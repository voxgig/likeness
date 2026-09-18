/* Identity: the likeness id, derived and never stored anywhere.
 *
 *   lid = 'lk_' + crockford32_lower(sha256(source 0x00 account 0x00 entity 0x00 id))[0:12]
 *
 * `account` is the SOURCE'S OWN stable identifier for the workspace, never the
 * user-chosen instance name: renaming a connection from `work` to `plan` must
 * not silently change the identity of every note in it.
 *
 * CROCKFORD BASE32, which omits i, l, o and u because they are misread. The
 * known vectors are in the unit corpus, because a port that gets this subtly
 * wrong produces plausible-looking identifiers that silently fail to match
 * another port's - and nothing else would notice.
 */

package likeness

import (
	"crypto/sha256"
	"time"
)

// Crockford is the alphabet, lowercase. Pinned by a unit corpus entry, because
// a port that reached for RFC 4648 base32 instead would produce identifiers
// that look right.
const Crockford = "0123456789abcdefghjkmnpqrstvwxyz"

// Crockford32 encodes bytes big-endian, five bits at a time, no padding, and
// stops after `chars` symbols.
func Crockford32(bytes []byte, chars int) string {
	out := make([]byte, 0, chars)
	acc := 0
	bits := 0
	for _, b := range bytes {
		acc = (acc << 8) | int(b)
		bits += 8
		for 5 <= bits {
			bits -= 5
			out = append(out, Crockford[(acc>>bits)&31])
			if len(out) == chars {
				return string(out)
			}
		}
	}
	if 0 < bits && len(out) < chars {
		out = append(out, Crockford[(acc<<(5-bits))&31])
	}
	if chars < len(out) {
		out = out[:chars]
	}
	return string(out)
}

// Lid derives the likeness identifier. The NUL separators are what stop
// ("ab","c") and ("a","bc") colliding.
func Lid(source, account, entity, id string) string {
	h := sha256.New()
	h.Write([]byte(source))
	h.Write([]byte{0})
	h.Write([]byte(account))
	h.Write([]byte{0})
	h.Write([]byte(entity))
	h.Write([]byte{0})
	h.Write([]byte(id))
	return "lk_" + Crockford32(h.Sum(nil), 12)
}

// Rfc3339 renders epoch milliseconds as RFC 3339, UTC, SECOND precision, Z.
//
// Milliseconds are truncated toward the past, never rounded, and never
// formatted by time.RFC3339 - that constant emits an offset for a non-UTC
// location and would put a local timezone into the envelope on any machine
// whose clock is not UTC.
func Rfc3339(ms int64) string {
	t := time.UnixMilli(ms).UTC()
	return t.Format("2006-01-02T15:04:05") + "Z"
}
