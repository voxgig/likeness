#include "notion.h"

#include <stdlib.h>

#include "envelope.h"
#include "evaluate.h"
#include "identity.h"

#define SOURCE "notion"
#define VERSION_HEADER "notion-version"
#define BUG_REMEDY "this is a bug in the source or its SDK; run with --raw to capture the payload"
#define OPTIONS_REMEDY "its options take headers alone"

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

static int by_text(const void *x, const void *y) {
  return lk_compare_code_points(*(const str *)x, *(const str *)y);
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
  sb_puts(&r, "pin the API version under sdk.");
  sb_str(&r, instance);
  sb_puts(&r, " in station.json: \"options\": { \"headers\": { \"" VERSION_HEADER "\": \"2022-06-28\" } }");
  return lk_fail(err, "invalid-project", sb_done(&m), sb_done(&r));
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

static int is_date(str s) {
  size_t i;
  if (10 != s.n) return 0;
  for (i = 0; i < s.n; i++) {
    int dash = 4 == i || 7 == i;
    if (dash ? '-' != s.p[i] : (s.p[i] < '0' || '9' < s.p[i])) return 0;
  }
  return 1;
}

int lk_notion_configure(arena *a, str instance, const jval *block, str *version, lk_error *err) {
  const jval *options = jv_getz(block, "options");
  const jval *headers;
  const jval *value;
  str *keys;
  size_t n;
  size_t i;

  if (!has(options)) options = NULL;
  else if (!jv_is(options, J_OBJECT)) {
    return refused(a, instance, str_of("has options that are not a map"), OPTIONS_REMEDY, err);
  }
  keys = sorted_keys(a, options, &n);
  for (i = 0; i < n; i++) {
    if (!str_eqz(keys[i], "headers")) {
      return refused(a, instance, quoting(a, "has an option likeness does not read:", keys[i]), OPTIONS_REMEDY, err);
    }
  }

  headers = jv_getz(options, "headers");
  if (!has(headers)) headers = NULL;
  else if (!jv_is(headers, J_OBJECT)) return refused(a, instance, str_of("has headers that are not a map"), NULL, err);
  keys = sorted_keys(a, headers, &n);
  /* Folding A-Z agrees with toLowerCase here: no other character lowercases to this name's letters alone. */
  for (i = 0; i < n; i++) {
    if (!str_eqz(lk_fold_case(a, keys[i]), VERSION_HEADER)) {
      return refused(a, instance, quoting(a, "has a header likeness does not send:", keys[i]),
        "its headers take " VERSION_HEADER " alone", err);
    }
  }
  if (0 == n) {
    return refused(a, instance, str_of("pins no Notion-Version, which every request to Notion carries"), NULL, err);
  }
  if (1 < n) return refused(a, instance, str_of("pins Notion-Version more than once"), NULL, err);
  value = jv_get(headers, keys[0]);
  if (!jv_is(value, J_STRING) || !is_date(value->s)) {
    return refused(a, instance, str_of("pins a Notion-Version that is not a date such as 2022-06-28"), NULL, err);
  }
  *version = value->s;
  return 0;
}

int lk_notion_title(arena *a, const jval *properties, str *out, lk_error *err) {
  size_t n;
  str *keys = sorted_keys(a, properties, &n);
  const jval *value = NULL;
  int found = 0;
  sbuf b;
  size_t i;

  *out = str_mk("", 0);
  for (i = 0; i < n && !found; i++) {
    const jval *p = jv_get(properties, keys[i]);
    const jval *type = jv_getz(p, "type");
    if (jv_is(type, J_STRING) && str_eqz(type->s, "title")) {
      found = 1;
      value = jv_getz(p, "title");
    }
  }
  if (!found) return 0;
  if (!jv_is(value, J_ARRAY)) return has(value) ? text(a, value, out, err) : 0;
  sb_init(&b, a);
  for (i = 0; i < value->len; i++) {
    const jval *part = value->item[i];
    const jval *plain = jv_is(part, J_OBJECT) ? jv_getz(part, "plain_text") : part;
    str s;
    if (!has(plain)) continue;
    if (0 != text(a, plain, &s, err)) return -1;
    sb_str(&b, s);
  }
  *out = sb_done(&b);
  return 0;
}

int lk_notion_space(arena *a, const jval *parent, str *out, lk_error *err) {
  const jval *type = jv_getz(parent, "type");
  const jval *id = NULL;
  str kind;

  *out = str_mk("", 0);
  if (!jv_is(parent, J_OBJECT)) return 0;
  if (jv_is(type, J_STRING)) kind = type->s;
  else kind = str_of(has(jv_getz(parent, "database_id")) ? "database_id" : "page_id");
  if (str_eqz(kind, "data_source_id")) id = jv_getz(parent, "database_id");
  else if (str_eqz(kind, "database_id") || str_eqz(kind, "page_id")) id = jv_get(parent, kind);
  return has(id) ? text(a, id, out, err) : 0;
}

int lk_notion_stamp(arena *a, const jval *v, const char *field, str *out, lk_error *err) {
  double ms = 0;
  if (!jv_is(v, J_STRING) || !lk_parse_rfc3339(v->s, &ms)) ms = 0;
  if (NULL != lk_rfc3339(a, ms, out)) {
    sbuf m;
    sb_init(&m, a);
    sb_puts(&m, SOURCE " returned a page whose ");
    sb_puts(&m, field);
    sb_puts(&m, " is outside the years 0000 to 9999");
    return lk_fail(err, "source-unavailable", sb_done(&m), str_of(BUG_REMEDY));
  }
  return 0;
}

int lk_project_notion(arena *a, const jval *raw, str instance, str account, int with_raw, jval **out,
                      lk_error *err) {
  const jval *v;
  const jval *url;
  str id = str_mk("", 0);
  str title;
  str created;
  str updated;
  str space;
  jval *note;

  if (!jv_is(raw, J_OBJECT)) {
    return lk_failz(err, "source-unavailable", SOURCE " returned a page that is not a record", BUG_REMEDY);
  }
  v = jv_getz(raw, "id");
  if (has(v) && 0 != text(a, v, &id, err)) return -1;
  if (0 == id.n) return lk_failz(err, "source-unavailable", SOURCE " returned a page with no id", BUG_REMEDY);
  /* Refused, not made up: a page's link is the one thing about it no id can stand in for. */
  url = jv_getz(raw, "url");
  if (!jv_is(url, J_STRING) || !(str_starts(url->s, "http://") || str_starts(url->s, "https://"))) {
    return lk_failz(err, "source-unavailable", SOURCE " returned a page with no http or https url", BUG_REMEDY);
  }
  if (0 != lk_notion_title(a, jv_getz(raw, "properties"), &title, err)) return -1;
  if (0 != lk_notion_stamp(a, jv_getz(raw, "created_time"), "created_time", &created, err)) return -1;
  if (0 != lk_notion_stamp(a, jv_getz(raw, "last_edited_time"), "last_edited_time", &updated, err)) return -1;
  if (0 != lk_notion_space(a, jv_getz(raw, "parent"), &space, err)) return -1;

  note = jv_obj(a);
  jv_setz(a, note, "lid", jv_str(a, lk_lid(a, str_of(SOURCE), account, str_of("note"), id)));
  jv_setz(a, note, "source", jv_strz(a, SOURCE));
  jv_setz(a, note, "instance", jv_str(a, instance));
  jv_setz(a, note, "id", jv_str(a, id));
  jv_setz(a, note, "title", jv_str(a, title));
  jv_setz(a, note, "url", jv_str(a, url->s));
  jv_setz(a, note, "created", jv_str(a, created));
  jv_setz(a, note, "updated", jv_str(a, updated));
  if (0 < space.n) jv_setz(a, note, "space", jv_str(a, space));
  if (with_raw) {
    str payload;
    str why;
    if (0 != lk_render_raw(a, raw, &payload, &why)) return lk_fail(err, NULL, why, str_mk("", 0));
    jv_setz(a, note, "raw", jv_str(a, payload));
  }
  *out = note;
  return 0;
}
