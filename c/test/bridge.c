#include "bridge.h"

#include <stdlib.h>
#include <string.h>

jval *jv_from_omni(arena *a, const omni_json *v) {
  jval *out;
  size_t i;
  if (omni_isabsent(v)) return NULL;
  switch (v->type) {
    case OMNI_NULL:
      return jv_null(a);
    case OMNI_BOOL:
      return jv_bool(a, v->boolval);
    case OMNI_NUM:
      return jv_num(a, v->numval);
    case OMNI_STR:
      return jv_str(a, str_mk(ar_copy(a, v->strval, strlen(v->strval)), strlen(v->strval)));
    case OMNI_LIST:
      out = jv_arr(a);
      for (i = 0; i < v->listlen; i++) jv_push(a, out, jv_from_omni(a, v->list[i]));
      return out;
    case OMNI_MAP:
      out = jv_obj(a);
      for (i = 0; i < v->maplen; i++) {
        jv_set(a, out, str_mk(ar_copy(a, v->keys[i], strlen(v->keys[i])), strlen(v->keys[i])),
               jv_from_omni(a, v->vals[i]));
      }
      return out;
    default:
      return NULL;
  }
}

char *omni_text(omni_pool *pool, str s) {
  char *out = omni_pool_alloc(pool, s.n + 1);
  if (0 < s.n) memcpy(out, s.p, s.n);
  out[s.n] = '\0';
  return out;
}

const char *omni_strz(const omni_json *v) {
  const char *s = omni_strval(v);
  return NULL == s ? "" : s;
}

static int by_name(const void *x, const void *y) {
  return strcmp(*(const char *const *)x, *(const char *const *)y);
}

const char **omni_group_names(omni_pool *pool, const omni_json *groups, size_t *n) {
  const char **names = omni_pool_alloc(pool, (omni_ismap(groups) ? groups->maplen + 1 : 1) * sizeof *names);
  size_t i;
  *n = omni_ismap(groups) ? groups->maplen : 0;
  for (i = 0; i < *n; i++) names[i] = groups->keys[i];
  qsort(names, *n, sizeof *names, by_name);
  return names;
}

int omni_run_group(omni_pool *pool, omni_provider *provider, const omni_json *header, const char *section,
                   const char *name, omni_json *set, int all, omni_json *waits, char **message) {
  omni_json *spec = omni_map(pool);
  omni_json *groups = omni_map(pool);
  omni_json *group = omni_map(pool);
  omni_runner *runner;
  omni_runpack *pack;
  omni_flags flags = omni_flags_nonull();
  omni_map_set(group, "set", set);
  omni_map_set(groups, name, group);
  omni_map_set(spec, "OMNI", omni_clone(pool, header));
  omni_map_set(spec, section, groups);
  runner = omni_make_runner(pool, NULL, spec, provider, message);
  if (NULL == runner) return 1;
  pack = omni_runner_run(runner, section, NULL, message);
  flags.all = all;
  flags.wait = waits;
  return omni_runsetflags(pack, omni_set(pack, name), flags, NULL, message);
}

void tap_omni(tally *t, str name, int failed, const char *message) {
  if (failed) tap_fail(t, name, str_of(NULL == message ? "omni failed and gave no message" : message));
  else tap_ok(t, name);
}

int omni_says(const char *message, const char *reason) {
  const char *end;
  const char *at;
  if (NULL == message) return 0;
  end = strchr(message, '\n');
  at = strstr(message, reason);
  return NULL != at && (NULL == end || at < end);
}

/* The JSON after "\n  <label>:" on its own line. */
static omni_json *side(omni_pool *pool, const char *message, const char *label) {
  const char *at = strstr(message, label);
  const char *end;
  char *text;
  char *bad = NULL;
  if (NULL == at) return NULL;
  at += strlen(label);
  end = strchr(at, '\n');
  text = omni_text(pool, str_mk(at, NULL == end ? strlen(at) : (size_t)(end - at)));
  return omni_parse(pool, text, &bad);
}

const char *omni_differs(omni_pool *pool, const char *message) {
  omni_json *want;
  omni_json *got;
  const char **keys;
  size_t n = 0;
  size_t i;
  char *out;
  size_t len = 1;
  if (!omni_says(message, ": result mismatch")) return NULL;
  want = side(pool, message, "\n  expected: ");
  got = side(pool, message, "\n  actual:   ");
  if (!omni_ismap(want) || !omni_ismap(got)) return NULL;
  keys = omni_pool_alloc(pool, (want->maplen + got->maplen + 1) * sizeof *keys);
  for (i = 0; i < want->maplen; i++) keys[n++] = want->keys[i];
  for (i = 0; i < got->maplen; i++) {
    if (!omni_map_has(want, got->keys[i])) keys[n++] = got->keys[i];
  }
  qsort(keys, n, sizeof *keys, by_name);
  for (i = 0; i < n; i++) len += strlen(keys[i]) + 1;
  out = omni_pool_alloc(pool, len);
  for (i = 0; i < n; i++) {
    if (omni_deepequal(omni_map_get(want, keys[i]), omni_map_get(got, keys[i]))) continue;
    if ('\0' != out[0]) strcat(out, ",");
    strcat(out, keys[i]);
  }
  return out;
}
