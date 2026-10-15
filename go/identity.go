package likeness

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// Crockford is the alphabet, lowercase. Pinned by a unit corpus entry, because
// a port that reached for RFC 4648 base32 instead would produce identifiers
// that look right.
const Crockford = "0123456789abcdefghjkmnpqrstvwxyz"

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

// The milliseconds of the first and last instants with a four-digit year.
const (
	rfc3339Min = -62167219200000
	rfc3339Max = 253402300799999
)

func Rfc3339(ms int64) (string, error) {
	if ms < rfc3339Min || rfc3339Max < ms {
		return "", fmt.Errorf("rfc3339: %d ms is outside the years 0000 to 9999", ms)
	}
	t := time.UnixMilli(ms).UTC()
	return t.Format("2006-01-02T15:04:05") + "Z", nil
}

var instant = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$`)

// daysFromCivil counts days from the Unix epoch in the proleptic Gregorian
// calendar. The era is floored: truncation would misplace the start of year 0.
func daysFromCivil(year, month, day int64) int64 {
	y := year
	if month <= 2 {
		y--
	}
	era := y / 400
	if y%400 < 0 {
		era--
	}
	yoe := y - era*400
	mp := month - 3
	if month <= 2 {
		mp = month + 9
	}
	doy := (153*mp+2)/5 + day - 1
	return era*146097 + yoe*365 + yoe/4 - yoe/100 + doy - 719468
}

// parseInstant reads an RFC 3339 date-time, offset required and any fraction
// of a second dropped, as epoch milliseconds.
func parseInstant(text string) (int64, bool) {
	m := instant.FindStringSubmatch(text)
	if nil == m {
		return 0, false
	}
	n := make([]int64, 10)
	for i := 1; i < len(m); i++ {
		n[i], _ = strconv.ParseInt(m[i], 10, 64)
	}
	year, month, day, hour, minute, second := n[1], n[2], n[3], n[4], n[5], n[6]
	if month < 1 || 12 < month || day < 1 || int64(DaysIn(int(year), int(month))) < day {
		return 0, false
	}
	if 23 < hour || 59 < minute || 59 < second {
		return 0, false
	}
	offset := int64(0)
	if "" != m[7] {
		if 23 < n[8] || 59 < n[9] {
			return 0, false
		}
		offset = n[8]*60 + n[9]
		if "-" == m[7] {
			offset = -offset
		}
	}
	return ((daysFromCivil(year, month, day)*24+hour)*60+minute-offset)*60000 + second*1000, true
}
