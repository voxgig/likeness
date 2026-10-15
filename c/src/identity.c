#include "identity.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "envelope.h"
#include "sha256.h"
#include "utf8.h"

#define RFC3339_MIN -62167219200000.0
#define RFC3339_MAX 253402300799999.0
#define DAY_MS 86400000LL

str lk_crockford32(arena *a, const unsigned char *bytes, size_t n, size_t chars) {
  static const char alphabet[] = LK_CROCKFORD;
  sbuf out;
  unsigned long acc = 0;
  int bits = 0;
  size_t i;

  sb_init(&out, a);
  for (i = 0; i < n; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (5 <= bits) {
      bits -= 5;
      sb_putc(&out, alphabet[(acc >> bits) & 31]);
      if (out.n == chars) return sb_done(&out);
    }
  }
  if (0 < bits && out.n < chars) sb_putc(&out, alphabet[(acc << (5 - bits)) & 31]);
  return sb_done(&out);
}

/* The NUL separators keep ("ab", "c") and ("a", "bc") apart. */
str lk_lid(arena *a, str source, str account, str entity, str id) {
  static const unsigned char nul = 0;
  const str parts[4] = { source, account, entity, id };
  unsigned char digest[32];
  sha256_ctx c;
  sbuf out;
  int i;

  sha256_init(&c);
  for (i = 0; i < 4; i++) {
    str bytes = u8_wellformed(a, parts[i]);
    if (0 < i) sha256_update(&c, &nul, 1);
    sha256_update(&c, bytes.p, bytes.n);
  }
  sha256_final(&c, digest);
  sb_init(&out, a);
  sb_puts(&out, "lk_");
  sb_str(&out, lk_crockford32(a, digest, sizeof digest, 12));
  return sb_done(&out);
}

static void civil(long long z, long long *y, int *m, int *d) {
  long long era;
  long long doe;
  long long yoe;
  long long doy;
  long long mp;
  z += 719468;
  era = (0 <= z ? z : z - 146096) / 146097;
  doe = z - era * 146097;
  yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  mp = (5 * doy + 2) / 153;
  *d = (int)(doy - (153 * mp + 2) / 5 + 1);
  *m = (int)(mp < 10 ? mp + 3 : mp - 9);
  *y = yoe + era * 400 + (*m <= 2 ? 1 : 0);
}

const char *lk_rfc3339(arena *a, double ms, str *out) {
  long long t;
  long long days;
  long long rem;
  long long y;
  int m;
  int d;
  char tmp[32];

  if (!isfinite(ms) || ms < RFC3339_MIN || RFC3339_MAX < ms) {
    sbuf why;
    sb_init(&why, a);
    sb_puts(&why, "rfc3339: ");
    lk_js_number(&why, ms);
    sb_puts(&why, " ms is outside the years 0000 to 9999");
    return sb_done(&why).p;
  }
  t = (long long)ms;
  days = t / DAY_MS;
  rem = t % DAY_MS;
  if (rem < 0) {
    rem += DAY_MS;
    days -= 1;
  }
  civil(days, &y, &m, &d);
  snprintf(tmp, sizeof tmp, "%04lld-%02d-%02dT%02d:%02d:%02dZ", y, m, d,
    (int)(rem / 3600000), (int)(rem / 60000 % 60), (int)(rem / 1000 % 60));
  *out = str_mk(ar_copy(a, tmp, 20), 20);
  return NULL;
}

static int is_digit(char c) {
  return '0' <= c && c <= '9';
}

static int at(str s, size_t i, const char *any) {
  return i < s.n && '\0' != s.p[i] && NULL != strchr(any, s.p[i]);
}

static int number_at(str s, size_t i, size_t width, long *out) {
  long v = 0;
  size_t k;
  if (s.n < i + width) return 0;
  for (k = i; k < i + width; k++) {
    if (!is_digit(s.p[k])) return 0;
    v = v * 10 + (s.p[k] - '0');
  }
  *out = v;
  return 1;
}

static long long days_from_civil(long year, long month, long day) {
  long long y = month <= 2 ? year - 1 : year;
  long long era = (0 <= y ? y : y - 399) / 400;
  long long yoe = y - era * 400;
  long long doy = (153 * (month + (2 < month ? -3 : 9)) + 2) / 5 + day - 1;
  return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

static long days_in(long year, long month) {
  static const long days[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
  int leap = 0 == year % 4 && (0 != year % 100 || 0 == year % 400);
  return 2 == month && leap ? 29 : days[month - 1];
}

int lk_parse_rfc3339(str t, double *ms) {
  long year;
  long month;
  long day;
  long hour;
  long minute;
  long second;
  long oh = 0;
  long om = 0;
  long sign = 0;
  size_t i = 19;

  if (!number_at(t, 0, 4, &year) || !at(t, 4, "-") || !number_at(t, 5, 2, &month) || !at(t, 7, "-") ||
      !number_at(t, 8, 2, &day) || !at(t, 10, "Tt") || !number_at(t, 11, 2, &hour) || !at(t, 13, ":") ||
      !number_at(t, 14, 2, &minute) || !at(t, 16, ":") || !number_at(t, 17, 2, &second)) {
    return 0;
  }
  if (at(t, i, ".")) {
    size_t from = ++i;
    while (i < t.n && is_digit(t.p[i])) i++;
    if (i == from) return 0;
  }
  if (at(t, i, "Zz")) i++;
  else if (at(t, i, "+-")) {
    sign = '-' == t.p[i] ? -1 : 1;
    if (!number_at(t, i + 1, 2, &oh) || !at(t, i + 3, ":") || !number_at(t, i + 4, 2, &om)) return 0;
    i += 6;
  }
  else return 0;
  if (i != t.n) return 0;

  if (month < 1 || 12 < month || day < 1 || days_in(year, month) < day) return 0;
  if (23 < hour || 59 < minute || 59 < second) return 0;
  if (23 < oh || 59 < om) return 0;
  *ms = (double)((((days_from_civil(year, month, day) * 24 + hour) * 60 + minute - sign * (oh * 60 + om)) *
    60000) + second * 1000);
  return 1;
}
