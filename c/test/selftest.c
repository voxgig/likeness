/* The building blocks the corpus reaches only in part, against values taken
 * from the canonical runtime: Node's own Number, JSON.parse, UTF-8 decoder,
 * String.prototype.slice and path.posix, and SHA-256, against FIPS 180-4's
 * examples. */

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "envelope.h"
#include "harness.h"
#include "json.h"
#include "path.h"
#include "sha256.h"
#include "utf8.h"

static void expect_str(tally *t, arena *a, const char *name, str got, const char *want) {
  if (str_eqz(got, want)) {
    tap_ok(t, str_of(name));
    return;
  }
  {
    sbuf m;
    sb_init(&m, a);
    sb_puts(&m, "want ");
    sb_puts(&m, want);
    sb_puts(&m, "\ngot  ");
    sb_str(&m, got);
    tap_fail(t, str_of(name), sb_done(&m));
  }
}

static void numbers(tally *t, arena *a) {
  static const struct {
    double v;
    const char *js;
  } cases[] = {
    { 0.0, "0" }, { -0.0, "0" }, { 1.0, "1" }, { -1.0, "-1" }, { 0.5, "0.5" },
    { 0.1 + 0.2, "0.30000000000000004" }, { 123.456, "123.456" }, { 1e21, "1e+21" },
    { 1e20, "100000000000000000000" }, { 123456789012345680000.0, "123456789012345680000" },
    { 1e-6, "0.000001" }, { 1e-7, "1e-7" }, { 1.5e-7, "1.5e-7" }, { 5e-324, "5e-324" },
    { 1.7976931348623157e308, "1.7976931348623157e+308" }, { 9007199254740992.0, "9007199254740992" },
    { -9007199254740994.0, "-9007199254740994" }, { 1.0 / 3.0, "0.3333333333333333" }, { 100.0, "100" },
    { 1234.5678e10, "12345678000000" }, { 4.35, "4.35" }, { 0.000001234, "0.000001234" },
    { 1.5e300, "1.5e+300" }, { -1.5e-300, "-1.5e-300" },
  };
  size_t i;
  for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    sbuf b;
    char name[64];
    sb_init(&b, a);
    lk_js_number(&b, cases[i].v);
    snprintf(name, sizeof name, "Number::toString %s", cases[i].js);
    expect_str(t, a, name, sb_done(&b), cases[i].js);
  }
}

static void json(tally *t, arena *a) {
  static const struct {
    const char *text;
    int accepted;
  } cases[] = {
    { "{}", 1 }, { "[]", 1 }, { " 1 ", 1 }, { "\"a\"", 1 }, { "{\"a\":1,}", 0 }, { "[1,]", 0 },
    { "01", 0 }, { "1.", 0 }, { ".5", 0 }, { "+1", 0 }, { "-0", 1 }, { "1e400", 1 },
    { "\"\\u00e9\"", 1 }, { "\"\\ud83d\\ude00\"", 1 }, { "\"\\ud83d\"", 1 }, { "nul", 0 },
    { "true false", 0 }, { "\"a\tb\"", 0 }, { "\xef\xbb\xbf{}", 0 }, { "{\"a\":1,\"a\":2}", 1 },
    { "[1 2]", 0 }, { "{\"a\" 1}", 0 }, { "{1:2}", 0 }, { "\"\\x\"", 0 }, { "", 0 }, { "  ", 0 },
    { "[[[[]]]]", 1 }, { "1e5", 1 }, { "-", 0 }, { "1E+2", 1 }, { "\"\\/\"", 1 },
  };
  size_t i;
  jval *v = NULL;
  for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    sbuf name;
    int accepted;
    v = NULL;
    accepted = NULL == json_parse(a, cases[i].text, strlen(cases[i].text), &v);
    sb_init(&name, a);
    sb_puts(&name, cases[i].accepted ? "JSON.parse accepts " : "JSON.parse refuses ");
    lk_escape_string(&name, str_of(cases[i].text));
    if (accepted == cases[i].accepted) tap_ok(t, sb_done(&name));
    else tap_fail(t, sb_done(&name), str_of(accepted ? "accepted" : "refused"));
  }

  json_parse(a, "{\"a\":1,\"a\":2}", 13, &v);
  if (1 == v->len && 2 == jv_getz(v, "a")->num) tap_ok(t, str_of("a repeated key keeps its last value"));
  else tap_fail(t, str_of("a repeated key keeps its last value"), str_of("it did not"));
  json_parse(a, "-0", 2, &v);
  if (0 == v->num && signbit(v->num)) tap_ok(t, str_of("-0 reads as negative zero"));
  else tap_fail(t, str_of("-0 reads as negative zero"), str_of("it did not"));
  json_parse(a, "1e400", 5, &v);
  if (isinf(v->num)) tap_ok(t, str_of("1e400 reads as Infinity"));
  else tap_fail(t, str_of("1e400 reads as Infinity"), str_of("it did not"));
  json_parse(a, "\"\\ud83d\\ude00\"", 14, &v);
  expect_str(t, a, "a surrogate pair is one code point", v->s, "\xf0\x9f\x98\x80");
  json_parse(a, "\"\\ud83d\"", 8, &v);
  expect_str(t, a, "a lone surrogate is kept, as a JavaScript string keeps it", v->s, "\xed\xa0\xbd");
  expect_str(t, a, "and is written as U+FFFD where it leaves as UTF-8", u8_wellformed(a, v->s), "\xef\xbf\xbd");
}

static void utf8(tally *t, arena *a) {
  static const struct {
    const char *in;
    const char *out;
  } cases[] = {
    { "\xff", "\xef\xbf\xbd" }, { "\xe2\x82", "\xef\xbf\xbd" }, { "\xe2\x82" "A", "\xef\xbf\xbd" "A" },
    { "\xed\xa0\x80", "\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd" }, { "\xf0\x9f\x98", "\xef\xbf\xbd" },
    { "\xf0\x9f\x98\x80", "\xf0\x9f\x98\x80" }, { "\xc0\xaf", "\xef\xbf\xbd\xef\xbf\xbd" },
    { "\xe0\x80\x8f", "\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd" },
    { "\xf4\x90\x80\x80", "\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd" }, { "\xc3", "\xef\xbf\xbd" },
    { "A\xc3", "A\xef\xbf\xbd" }, { "\xf8", "\xef\xbf\xbd" }, { "\xed\x9f\xbf", "\xed\x9f\xbf" },
    { "\xef\xbf\xbd", "\xef\xbf\xbd" },
  };
  size_t i;
  for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    sbuf name;
    size_t k;
    sb_init(&name, a);
    sb_puts(&name, "the WHATWG decoder reads");
    for (k = 0; '\0' != cases[i].in[k]; k++) {
      char hex[4];
      snprintf(hex, sizeof hex, " %02x", (unsigned char)cases[i].in[k]);
      sb_puts(&name, hex);
    }
    expect_str(t, a, sb_done(&name).p, u8_sanitize(a, cases[i].in, strlen(cases[i].in)), cases[i].out);
  }
}

static void slices(tally *t, arena *a) {
  static const struct {
    const char *s;
    long start;
    long end;
    const char *out;
    size_t units;
  } cases[] = {
    { "abc", 0, -1, "ab", 3 },
    { "abc", -2, 3, "bc", 3 },
    { "abc", 2, 1, "", 3 },
    { "", 0, -3, "", 0 },
    { "a\xc3\xa9", 0, -1, "a", 2 },
    { "\xf0\x9f\x98\x80" "ab", 0, 1, "\xed\xa0\xbd", 4 },
    { "\xf0\x9f\x98\x80" "ab", 1, 4, "\xed\xb8\x80" "ab", 4 },
    { "\xf0\x9f\x98\x80" "ab", 0, 2, "\xf0\x9f\x98\x80", 4 },
    { "a\xf0\x9f\x98\x80", 0, 2, "a\xed\xa0\xbd", 3 },
    { "a\xf0\x9f\x98\x80", 2, 9, "\xed\xb8\x80", 3 },
    { "\xf0\x9f\x98\x80", -1, 2, "\xed\xb8\x80", 2 },
    { "x/\xf0\x9f\x98\x80.md", 2, -3, "\xf0\x9f\x98\x80", 7 },
  };
  size_t i;
  for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    str s = str_of(cases[i].s);
    sbuf name;
    sb_init(&name, a);
    sb_puts(&name, "String.prototype.slice ");
    lk_escape_string(&name, s);
    sb_putc(&name, ' ');
    sb_long(&name, cases[i].start);
    sb_putc(&name, ' ');
    sb_long(&name, cases[i].end);
    expect_str(t, a, sb_done(&name).p, u8_slice(a, s, cases[i].start, cases[i].end), cases[i].out);
    sb_init(&name, a);
    sb_puts(&name, "length ");
    lk_escape_string(&name, s);
    if (cases[i].units == u8_units(s)) tap_ok(t, sb_done(&name));
    else tap_fail(t, sb_done(&name), str_of("a different count of UTF-16 code units"));
  }
}

static void paths(tally *t, arena *a) {
  static const char *const normalize[][2] = {
    { "", "." }, { ".", "." }, { "/", "/" }, { "//", "/" }, { "///a//b/", "/a/b/" }, { "a/../..", ".." },
    { "/a/../..", "/" }, { "a/./b/../c", "a/c" }, { "../a", "../a" }, { "./", "./" }, { "a/b/..", "a" },
    { "/x/..", "/" }, { "a//", "a/" }, { "..", ".." }, { "../..", "../.." }, { "a/..", "." },
    { "/../a", "/a" }, { "\xc3\xa9/../b", "b" },
  };
  static const char *const dirname[][2] = {
    { "", "." }, { "a", "." }, { "/a", "/" }, { "/a/b/", "/a" }, { "a/b//", "a" }, { "//a", "//" },
    { "/", "/" }, { "station.json", "." }, { "/x/station.json", "/x" },
  };
  static const char *const resolve[][3] = {
    { "/home/u", "../team/v.skmv", "/home/team/v.skmv" }, { "/home/u/.config/likeness", "/srv/v", "/srv/v" },
    { "/a", "", "/a" }, { "/home/u", "v.skmv/", "/home/u/v.skmv" },
  };
  static const char *const join[][3] = {
    { "", "a", "a" }, { ".", "likeness", "likeness" }, { "/usr/bin/", "likeness", "/usr/bin/likeness" },
    { "", "", "." },
  };
  size_t i;
  for (i = 0; i < sizeof normalize / sizeof normalize[0]; i++) {
    sbuf name;
    sb_init(&name, a);
    sb_puts(&name, "path.normalize ");
    lk_escape_string(&name, str_of(normalize[i][0]));
    expect_str(t, a, sb_done(&name).p, path_normalize(a, str_of(normalize[i][0])), normalize[i][1]);
  }
  for (i = 0; i < sizeof dirname / sizeof dirname[0]; i++) {
    sbuf name;
    sb_init(&name, a);
    sb_puts(&name, "path.dirname ");
    lk_escape_string(&name, str_of(dirname[i][0]));
    expect_str(t, a, sb_done(&name).p, path_dirname(a, str_of(dirname[i][0])), dirname[i][1]);
  }
  for (i = 0; i < sizeof resolve / sizeof resolve[0]; i++) {
    str parts[2];
    sbuf name;
    parts[0] = str_of(resolve[i][0]);
    parts[1] = str_of(resolve[i][1]);
    sb_init(&name, a);
    sb_puts(&name, "path.resolve ");
    sb_puts(&name, resolve[i][0]);
    sb_puts(&name, " ");
    sb_puts(&name, resolve[i][1]);
    expect_str(t, a, sb_done(&name).p, path_resolve(a, parts, 2), resolve[i][2]);
  }
  {
    str parts[4];
    parts[0] = str_of("/");
    parts[1] = str_of("..");
    parts[2] = str_of("x");
    expect_str(t, a, "path.resolve / .. x", path_resolve(a, parts, 3), "/x");
    parts[0] = str_of("a");
    parts[1] = str_of("..");
    parts[2] = str_of("..");
    parts[3] = str_of("b");
    expect_str(t, a, "path.join a .. .. b", path_join(a, parts, 4), "../b");
  }
  for (i = 0; i < sizeof join / sizeof join[0]; i++) {
    str parts[2];
    sbuf name;
    parts[0] = str_of(join[i][0]);
    parts[1] = str_of(join[i][1]);
    sb_init(&name, a);
    sb_puts(&name, "path.join ");
    lk_escape_string(&name, parts[0]);
    sb_puts(&name, " ");
    lk_escape_string(&name, parts[1]);
    expect_str(t, a, sb_done(&name).p, path_join(a, parts, 2), join[i][2]);
  }
}

static str hex_of(arena *a, const unsigned char *d, size_t n) {
  sbuf b;
  size_t i;
  sb_init(&b, a);
  for (i = 0; i < n; i++) {
    char two[3];
    snprintf(two, sizeof two, "%02x", d[i]);
    sb_puts(&b, two);
  }
  return sb_done(&b);
}

static void sha(tally *t, arena *a) {
  static const char *const cases[][2] = {
    { "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    { "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    { "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1" },
  };
  unsigned char d[32];
  sha256_ctx c;
  size_t i;
  for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    sbuf name;
    sha256_init(&c);
    sha256_update(&c, cases[i][0], strlen(cases[i][0]));
    sha256_final(&c, d);
    sb_init(&name, a);
    sb_puts(&name, "SHA-256 of ");
    lk_escape_string(&name, str_of(cases[i][0]));
    expect_str(t, a, sb_done(&name).p, hex_of(a, d, 32), cases[i][1]);
  }
  sha256_init(&c);
  for (i = 0; i < 1000000; i += 1000) {
    static char thousand[1000];
    memset(thousand, 'a', sizeof thousand);
    sha256_update(&c, thousand, sizeof thousand);
  }
  sha256_final(&c, d);
  expect_str(t, a, "SHA-256 of a million a, in pieces", hex_of(a, d, 32),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

int main(void) {
  arena *a = ar_new();
  tally t;
  int status;
  memset(&t, 0, sizeof t);
  tap_begin();
  numbers(&t, a);
  json(&t, a);
  utf8(&t, a);
  slices(&t, a);
  paths(&t, a);
  sha(&t, a);
  status = tap_end(&t);
  ar_free(a);
  return status;
}
