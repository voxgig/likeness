#include "obsidian.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "envelope.h"
#include "evaluate.h"
#include "identity.h"
#include "pin.h"
#include "utf8.h"

#define SOURCE "obsidian"
#define NOTE_SUFFIX ".md"
#define BUG_REMEDY "this is a bug in the source or its SDK; run with --raw to capture the payload"
#define OPTIONS_REMEDY "its options take tls alone"
#define PLAIN_REMEDY \
  "declare plain HTTP with \"options\": { \"tls\": false }, or use the plugin's HTTPS base with a pinned certificate"

static int has(const jval *v) {
  return NULL != v && J_NULL != v->kind;
}

/* A non-string value projects as its canonical JSON text. */
static int text(arena *a, const jval *v, str *out, lk_error *err) {
  str why;
  if (jv_is(v, J_STRING)) {
    *out = v->s;
    return 0;
  }
  if (0 != lk_render_raw(a, v, out, &why)) return lk_fail(err, NULL, why, str_mk("", 0));
  return 0;
}

static double ms(const jval *v) {
  if (jv_is(v, J_NUMBER) && isfinite(v->num) && floor(v->num) == v->num) return v->num;
  return 0;
}

static int ends_with(str s, const char *suffix) {
  size_t n = strlen(suffix);
  return n <= s.n && 0 == memcmp(s.p + s.n - n, suffix, n);
}

static int by_text(const void *x, const void *y) {
  return lk_compare_code_points(*(const str *)x, *(const str *)y);
}

static int unreserved(unsigned char c) {
  return ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') || '-' == c || '.' == c ||
         '_' == c || '~' == c;
}

static void percent_encode(arena *a, sbuf *b, str s) {
  static const char hex[] = "0123456789ABCDEF";
  str bytes = u8_wellformed(a, s);
  size_t i;
  for (i = 0; i < bytes.n; i++) {
    unsigned char c = (unsigned char)bytes.p[i];
    char esc[3];
    if (unreserved(c)) {
      sb_putc(b, (char)c);
      continue;
    }
    esc[0] = '%';
    esc[1] = hex[c >> 4];
    esc[2] = hex[c & 15];
    sb_put(b, esc, 3);
  }
}

str lk_obsidian_url(arena *a, str vault, str path) {
  sbuf b;
  sb_init(&b, a);
  sb_puts(&b, SOURCE "://open?vault=");
  percent_encode(a, &b, vault);
  sb_puts(&b, "&file=");
  percent_encode(a, &b, path);
  return sb_done(&b);
}

/* No empty, . or .. segment, but for a directory's trailing slash. */
static int names_a_path_below(str name) {
  size_t start = 0;
  size_t i;
  if (0 == name.n) return 0;
  for (i = 0; i <= name.n; i++) {
    str seg;
    if (i < name.n && '/' != name.p[i]) continue;
    seg = str_mk(name.p + start, i - start);
    if (str_eqz(seg, ".") || str_eqz(seg, "..") || (0 == seg.n && i < name.n)) return 0;
    start = i + 1;
  }
  return 1;
}

static str first_segment(str name) {
  size_t i;
  for (i = 0; i < name.n; i++) {
    if ('/' == name.p[i]) return str_mk(name.p, i + 1);
  }
  return name;
}

int lk_obsidian_entries(arena *a, const jval *listed, str **out, size_t *n, lk_error *err) {
  size_t len = jv_is(listed, J_ARRAY) ? listed->len : 0;
  str *names = ar_alloc(a, (len + 1) * sizeof *names);
  size_t got = 0;
  size_t kept = 0;
  size_t i;
  for (i = 0; i < len; i++) {
    const jval *e = listed->item[i];
    const jval *id = jv_getz(e, "id");
    str name = jv_is(e, J_STRING) ? e->s : jv_is(id, J_STRING) ? id->s : str_mk("", 0);
    if (!names_a_path_below(name)) {
      return lk_failz(err, "source-unavailable",
        SOURCE " returned a vault listing with an entry that names no path below it", BUG_REMEDY);
    }
    names[got++] = first_segment(name);
  }
  if (1 < got) qsort(names, got, sizeof *names, by_text);
  for (i = 0; i < got; i++) {
    if (0 == kept || !str_eq(names[kept - 1], names[i])) names[kept++] = names[i];
  }
  *out = names;
  *n = kept;
  return 0;
}

struct lk_obsidian_frame {
  str dir;
  str *names;
  size_t n;
  size_t at;
};

static void enter(lk_obsidian_walk *w, str dir) {
  lk_obsidian_frame *f;
  if (w->depth == w->cap) {
    size_t cap = 0 == w->cap ? 8 : w->cap * 2;
    lk_obsidian_frame *grown = ar_alloc(w->a, cap * sizeof *grown);
    if (0 < w->depth) memcpy(grown, w->frames, w->depth * sizeof *grown);
    w->frames = grown;
    w->cap = cap;
  }
  f = &w->frames[w->depth++];
  f->dir = dir;
  f->names = NULL;
  f->n = 0;
  f->at = 0;
  w->listing = 1;
}

lk_obsidian_step lk_obsidian_walk_start(arena *a, lk_obsidian_walk *w) {
  lk_obsidian_step step;
  w->a = a;
  w->frames = NULL;
  w->depth = 0;
  w->cap = 0;
  enter(w, str_mk("", 0));
  step.list = 1;
  step.path = w->frames[0].dir;
  return step;
}

int lk_obsidian_walk_next(lk_obsidian_walk *w, const str *entries, size_t n, lk_obsidian_step *step) {
  if (w->listing && 0 < w->depth) {
    lk_obsidian_frame *f = &w->frames[w->depth - 1];
    f->names = ar_alloc(w->a, (n + 1) * sizeof *f->names);
    if (0 < n) memcpy(f->names, entries, n * sizeof *entries);
    f->n = n;
    w->listing = 0;
  }
  while (0 < w->depth) {
    lk_obsidian_frame *f = &w->frames[w->depth - 1];
    str name;
    sbuf path;
    if (f->at == f->n) {
      w->depth--;
      continue;
    }
    name = f->names[f->at++];
    sb_init(&path, w->a);
    sb_str(&path, f->dir);
    sb_str(&path, name);
    step->path = sb_done(&path);
    if (ends_with(name, "/")) {
      enter(w, step->path);
      step->list = 1;
      return 1;
    }
    if (ends_with(step->path, NOTE_SUFFIX)) {
      step->list = 0;
      return 1;
    }
  }
  return 0;
}

static int refused(arena *a, str instance, str what, const char *remedy, lk_error *err) {
  sbuf m;
  sbuf r;
  sb_init(&m, a);
  sb_puts(&m, SOURCE " connection \"");
  sb_str(&m, instance);
  sb_puts(&m, "\" ");
  sb_str(&m, what);
  if (NULL != remedy) return lk_fail(err, "invalid-project", sb_done(&m), str_of(remedy));
  sb_init(&r, a);
  sb_puts(&r, "pin its certificate under sdk.");
  sb_str(&r, instance);
  sb_puts(&r, " in station.json: \"options\": { \"tls\": { \"fingerprint\": \"sha256:<hex>\" } }");
  return lk_fail(err, "invalid-project", sb_done(&m), sb_done(&r));
}

static str *sorted_keys(arena *a, const jval *map, size_t *n) {
  str *keys;
  size_t i;
  *n = jv_is(map, J_OBJECT) ? map->len : 0;
  keys = ar_alloc(a, (*n + 1) * sizeof *keys);
  for (i = 0; i < *n; i++) keys[i] = map->key[i];
  if (1 < *n) qsort(keys, *n, sizeof *keys, by_text);
  return keys;
}

static str quoting(arena *a, const char *what, str key) {
  sbuf b;
  sb_init(&b, a);
  sb_puts(&b, what);
  sb_puts(&b, " \"");
  sb_str(&b, key);
  sb_putc(&b, '"');
  return sb_done(&b);
}

int lk_obsidian_transport(arena *a, str instance, const jval *block, lk_obsidian_tls *out, lk_error *err) {
  const jval *options = jv_getz(block, "options");
  const jval *base = jv_getz(block, "base");
  const jval *tls;
  str scheme = str_of("https://");
  str *keys;
  size_t n;
  size_t i;
  int secure;

  if (!has(options)) options = NULL;
  else if (!jv_is(options, J_OBJECT)) {
    return refused(a, instance, str_of("has options that are not a map"), OPTIONS_REMEDY, err);
  }
  keys = sorted_keys(a, options, &n);
  for (i = 0; i < n; i++) {
    if (!str_eqz(keys[i], "tls")) {
      return refused(a, instance, quoting(a, "has an option likeness does not read:", keys[i]), OPTIONS_REMEDY, err);
    }
  }

  /* Folding A-Z agrees with toLowerCase here: no other character lowercases to h, t, p or s. */
  if (has(base)) {
    if (0 != text(a, base, &scheme, err)) return -1;
    scheme = lk_fold_case(a, scheme);
  }
  secure = str_starts(scheme, "https://");
  if (!secure && !str_starts(scheme, "http://")) {
    return refused(a, instance, str_of("has a base that is neither https nor http"),
      "name the plugin's address, as https://127.0.0.1:27124", err);
  }

  tls = jv_getz(options, "tls");
  out->pinned = 0;
  out->pin = str_mk("", 0);
  if (jv_is(tls, J_FALSE)) {
    if (secure) {
      return refused(a, instance, str_of("turns TLS off on an https base, and verification is never turned off"),
        NULL, err);
    }
    return 0;
  }
  if (!secure) {
    return refused(a, instance,
      str_of(NULL == tls ? "is plain HTTP and does not declare it" : "pins a certificate on a plain HTTP base"),
      PLAIN_REMEDY, err);
  }
  if (NULL == tls) {
    return refused(a, instance, str_of("pins no certificate, and the plugin's certificate is self-signed"), NULL, err);
  }
  if (!jv_is(tls, J_OBJECT) || 1 != tls->len || NULL == jv_getz(tls, "fingerprint")) {
    return refused(a, instance, str_of("has a tls option that is neither a pinned fingerprint nor false"), NULL, err);
  }
  if (NULL != lk_parse_pin(a, jv_getz(tls, "fingerprint"), &out->pin)) {
    return refused(a, instance, str_of("pins a fingerprint that is not sha256 and 64 hex digits"), NULL, err);
  }
  out->pinned = 1;
  return 0;
}

static int stamp(arena *a, const jval *v, const char *field, jval **out, lk_error *err) {
  str when;
  if (NULL != lk_rfc3339(a, ms(v), &when)) {
    sbuf m;
    sb_init(&m, a);
    sb_puts(&m, SOURCE " returned a note whose ");
    sb_puts(&m, field);
    sb_puts(&m, " is outside the years 0000 to 9999");
    return lk_fail(err, "source-unavailable", sb_done(&m), str_of(BUG_REMEDY));
  }
  *out = jv_str(a, when);
  return 0;
}

/* Absent is fetched and empty; a null entry is dropped, any other is its text. */
static int tags_of(arena *a, const jval *v, jval **out, lk_error *err) {
  int many = jv_is(v, J_ARRAY);
  size_t n = !has(v) ? 0 : many ? v->len : 1;
  size_t i;
  *out = jv_arr(a);
  for (i = 0; i < n; i++) {
    const jval *tag = many ? v->item[i] : v;
    str s;
    if (!has(tag)) continue;
    if (0 != text(a, tag, &s, err)) return -1;
    jv_push(a, *out, jv_str(a, s));
  }
  return 0;
}

static long last_slash(str path) {
  size_t i = path.n;
  while (0 < i) {
    if ('/' == path.p[--i]) return (long)i;
  }
  return -1;
}

int lk_project_obsidian(arena *a, const jval *raw, str path, str instance, str account, int with_raw,
                        jval **out, lk_error *err) {
  long at = last_slash(path);
  long from = 0 <= at ? (long)u8_units(str_mk(path.p, (size_t)at)) + 1 : 0;
  long to = (long)u8_units(path) - (long)strlen(NOTE_SUFFIX);
  const jval *stat;
  const jval *content;
  jval *created = NULL;
  jval *updated = NULL;
  jval *tags = NULL;
  jval *note;

  if (!jv_is(raw, J_OBJECT)) {
    return lk_failz(err, "source-unavailable", SOURCE " returned a note that is not a record", BUG_REMEDY);
  }
  stat = jv_getz(raw, "stat");
  if (!jv_is(stat, J_OBJECT)) stat = NULL;
  if (0 != stamp(a, jv_getz(stat, "ctime"), "stat.ctime", &created, err)) return -1;
  if (0 != stamp(a, jv_getz(stat, "mtime"), "stat.mtime", &updated, err)) return -1;
  if (0 != tags_of(a, jv_getz(raw, "tags"), &tags, err)) return -1;

  note = jv_obj(a);
  jv_setz(a, note, "lid", jv_str(a, lk_lid(a, str_of(SOURCE), account, str_of("note"), path)));
  jv_setz(a, note, "source", jv_strz(a, SOURCE));
  jv_setz(a, note, "instance", jv_str(a, instance));
  jv_setz(a, note, "id", jv_str(a, path));
  jv_setz(a, note, "title", jv_str(a, u8_slice(a, path, from, to)));
  jv_setz(a, note, "url", jv_str(a, lk_obsidian_url(a, account, path)));
  jv_setz(a, note, "created", created);
  jv_setz(a, note, "updated", updated);
  jv_setz(a, note, "tags", tags);
  if (0 < at) jv_setz(a, note, "space", jv_str(a, str_mk(path.p, (size_t)at)));

  content = jv_getz(raw, "content");
  if (has(content)) {
    str body;
    if (0 != text(a, content, &body, err)) return -1;
    jv_setz(a, note, "body", jv_str(a, body));
  }
  if (with_raw) {
    str payload;
    str why;
    if (0 != lk_render_raw(a, raw, &payload, &why)) return lk_fail(err, NULL, why, str_mk("", 0));
    jv_setz(a, note, "raw", jv_str(a, payload));
  }
  *out = note;
  return 0;
}
