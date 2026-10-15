#include "sources.h"

#include <string.h>

static int alnum(unsigned char c) {
  return ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9');
}

/* A run of any other bytes is one underscore, and none is kept at either end. */
str lk_secret_name(arena *a, str ref) {
  sbuf b;
  size_t i;
  int gap = 0;
  sb_init(&b, a);
  for (i = 0; i < ref.n; i++) {
    unsigned char c = (unsigned char)ref.p[i];
    if (!alnum(c)) {
      gap = 1;
      continue;
    }
    if (gap && 0 < b.n) sb_putc(&b, '_');
    gap = 0;
    sb_putc(&b, (char)('A' <= c && c <= 'Z' ? c - 'A' + 'a' : c));
  }
  sb_puts(&b, ".apikey");
  return sb_done(&b);
}

static int lower_digit_hyphen(unsigned char c) {
  return ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') || '-' == c;
}

static int is_name(str s) {
  size_t i;
  if (0 == s.n || !('a' <= s.p[0] && s.p[0] <= 'z')) return 0;
  for (i = 1; i < s.n; i++) {
    if (!lower_digit_hyphen((unsigned char)s.p[i])) return 0;
  }
  return 1;
}

static int is_tag(str s) {
  size_t i;
  if (0 == s.n) return 0;
  for (i = 0; i < s.n; i++) {
    if (!lower_digit_hyphen((unsigned char)s.p[i])) return 0;
  }
  return 1;
}

/* A `$`-less value is always a tag, as station reads one. */
int lk_ref_for(arena *a, str source, const str *instance, str *out, lk_error *err) {
  const char *at;
  str tag;
  sbuf m;
  sbuf ref;
  if (!is_name(source)) {
    return lk_failz(err, "invalid-argument", "--source takes a source's name", "run `likeness help sources add`");
  }
  if (NULL == instance) {
    *out = source;
    return 0;
  }
  at = 0 == instance->n ? NULL : memchr(instance->p, '$', instance->n);
  sb_init(&m, a);
  if (NULL != at && !str_eq(str_mk(instance->p, (size_t)(at - instance->p)), source)) {
    sb_puts(&m, "give the tag alone: `--source ");
    sb_str(&m, source);
    sb_puts(&m, " --instance <tag>` adds ");
    sb_str(&m, source);
    sb_puts(&m, "$<tag>");
    return lk_fail(err, "invalid-argument", str_of("--instance names a connection to another API than --source does"),
                   sb_done(&m));
  }
  tag = NULL == at ? *instance : str_slice(*instance, (size_t)(at - instance->p) + 1);
  if (!is_tag(tag)) {
    sb_puts(&m, "write `--instance work` to add ");
    sb_str(&m, source);
    sb_puts(&m, "$work");
    return lk_fail(err, "invalid-argument", str_of("--instance takes a tag of lowercase letters, digits and hyphens"),
                   sb_done(&m));
  }
  sb_init(&ref, a);
  sb_str(&ref, source);
  sb_putc(&ref, '$');
  sb_str(&ref, tag);
  *out = sb_done(&ref);
  return 0;
}
