#include "joplin.h"

#include <math.h>

#include "envelope.h"
#include "identity.h"

#define SOURCE "joplin"
#define BUG_REMEDY "this is a bug in the source or its SDK; run with --raw to capture the payload"

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

static int stamp(arena *a, const jval *v, const char *field, jval **out, lk_error *err) {
  str when;
  if (NULL != lk_rfc3339(a, ms(v), &when)) {
    sbuf m;
    sb_init(&m, a);
    sb_puts(&m, "the source returned a " SOURCE " record whose ");
    sb_puts(&m, field);
    sb_puts(&m, " is outside the years 0000 to 9999");
    return lk_fail(err, "source-unavailable", sb_done(&m), str_of(BUG_REMEDY));
  }
  *out = jv_str(a, when);
  return 0;
}

int lk_project_joplin(arena *a, const jval *raw, str instance, str account, int with_raw, jval **out,
                      lk_error *err) {
  str id = str_mk("", 0);
  str title = str_mk("", 0);
  jval *note;
  jval *created = NULL;
  jval *updated = NULL;
  sbuf url;
  const jval *v;

  v = jv_getz(raw, "id");
  if (has(v) && 0 != text(a, v, &id, err)) return -1;
  if (0 == id.n) {
    return lk_failz(err, "source-unavailable", "the source returned a " SOURCE " record with no id", BUG_REMEDY);
  }

  v = jv_getz(raw, "title");
  if (has(v) && 0 != text(a, v, &title, err)) return -1;
  if (0 != stamp(a, jv_getz(raw, "created_time"), "created_time", &created, err)) return -1;
  if (0 != stamp(a, jv_getz(raw, "updated_time"), "updated_time", &updated, err)) return -1;

  note = jv_obj(a);
  jv_setz(a, note, "lid", jv_str(a, lk_lid(a, str_of(SOURCE), account, str_of("note"), id)));
  jv_setz(a, note, "source", jv_strz(a, SOURCE));
  jv_setz(a, note, "instance", jv_str(a, instance));
  jv_setz(a, note, "id", jv_str(a, id));
  jv_setz(a, note, "title", jv_str(a, title));
  sb_init(&url, a);
  sb_puts(&url, "joplin://x-callback-url/openNote?id=");
  sb_str(&url, id);
  jv_setz(a, note, "url", jv_str(a, sb_done(&url)));
  jv_setz(a, note, "created", created);
  jv_setz(a, note, "updated", updated);

  v = jv_getz(raw, "parent_id");
  if (has(v)) {
    str space;
    if (0 != text(a, v, &space, err)) return -1;
    if (0 < space.n) jv_setz(a, note, "space", jv_str(a, space));
  }
  v = jv_getz(raw, "body");
  if (has(v)) {
    str body;
    if (0 != text(a, v, &body, err)) return -1;
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
