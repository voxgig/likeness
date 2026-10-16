/* The unit corpus, spec/unit.json, against this port's pure functions, run by
 * omni one group at a time.
 *
 *   unit ROOT          run every group; TAP on stdout
 *   unit ROOT --eval   read {"fn","in"} lines on stdin, write {"out"} or {"err"}
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "args.h"
#include "bridge.h"
#include "cli.h"
#include "envelope.h"
#include "errors.h"
#include "evaluate.h"
#include "harness.h"
#include "identity.h"
#include "joplin.h"
#include "notion.h"
#include "obsidian.h"
#include "pin.h"
#include "selector.h"
#include "sources.h"
#include "spec.h"
#include "utf8.h"
#include "vault.h"

typedef int (*unit_fn)(arena *a, const jval *in, jval **out, str *err);

typedef struct {
  const char *name;
  unit_fn fn;
} implemented;

typedef struct {
  const char *name;
  const char *on;
} waiting;

static int malformed(str *err) {
  *err = str_of("malformed corpus input");
  return -1;
}

static int strings(arena *a, const jval *in, str **out, size_t *n) {
  size_t i;
  if (!jv_is(in, J_ARRAY)) return -1;
  *out = ar_alloc(a, (in->len + 1) * sizeof **out);
  for (i = 0; i < in->len; i++) {
    if (!jv_is(in->item[i], J_STRING)) return -1;
    (*out)[i] = in->item[i]->s;
  }
  *n = in->len;
  return 0;
}

static jval *string_list(arena *a, const str *list, size_t n) {
  jval *out = jv_arr(a);
  size_t i;
  for (i = 0; i < n; i++) jv_push(a, out, jv_str(a, list[i]));
  return out;
}

static int fn_serialise(arena *a, const jval *in, jval **out, str *err) {
  str s;
  if (0 != lk_serialise(a, in, &s, err)) return -1;
  *out = jv_str(a, s);
  return 0;
}

static int fn_parse_selector(arena *a, const jval *in, jval **out, str *err) {
  sel_node *n;
  sel_error e;
  if (!jv_is(in, J_STRING)) return malformed(err);
  if (0 != lk_parse_selector(a, in->s, &n, &e)) {
    *err = e.message;
    return -1;
  }
  *out = lk_selector_model(a, n);
  return 0;
}

/* The refusal is the answer: the byte offset and the token it blames. */
static int fn_parse_selector_error(arena *a, const jval *in, jval **out, str *err) {
  sel_node *n;
  sel_error e;
  if (!jv_is(in, J_STRING)) return malformed(err);
  if (0 == lk_parse_selector(a, in->s, &n, &e)) {
    *err = str_of("expected a SelectorError and the selector parsed cleanly");
    return -1;
  }
  *out = jv_obj(a);
  jv_setz(a, *out, "offset", jv_num(a, (double)e.offset));
  jv_setz(a, *out, "token", jv_str(a, e.token));
  return 0;
}

/* Normalised to -1, 0 or 1: the sign is the contract, the magnitude is not. */
static int fn_compare_code_points(arena *a, const jval *in, jval **out, str *err) {
  str *pair;
  size_t n;
  if (0 != strings(a, in, &pair, &n) || 2 != n) return malformed(err);
  *out = jv_num(a, (double)lk_compare_code_points(pair[0], pair[1]));
  return 0;
}

static int fn_lid(arena *a, const jval *in, jval **out, str *err) {
  str *p;
  size_t n;
  if (0 != strings(a, in, &p, &n) || 4 != n) return malformed(err);
  *out = jv_str(a, lk_lid(a, p[0], p[1], p[2], p[3]));
  return 0;
}

static int fn_rfc3339(arena *a, const jval *in, jval **out, str *err) {
  str s;
  const char *bad;
  if (!jv_is(in, J_NUMBER)) return malformed(err);
  bad = lk_rfc3339(a, in->num, &s);
  if (NULL != bad) {
    *err = str_of(bad);
    return -1;
  }
  *out = jv_str(a, s);
  return 0;
}

static int fn_crockford_alphabet(arena *a, const jval *in, jval **out, str *err) {
  (void)in;
  (void)err;
  *out = jv_strz(a, LK_CROCKFORD);
  return 0;
}

static int fn_fold_case(arena *a, const jval *in, jval **out, str *err) {
  if (!jv_is(in, J_STRING)) return malformed(err);
  *out = jv_str(a, lk_fold_case(a, in->s));
  return 0;
}

static int fn_take_config_option(arena *a, const jval *in, jval **out, str *err) {
  str *argv;
  size_t n;
  lk_config_option opt;
  if (0 != strings(a, in, &argv, &n)) return malformed(err);
  lk_take_config_option(a, argv, n, &opt);
  *out = jv_obj(a);
  jv_setz(a, *out, "rest", string_list(a, opt.rest, opt.n));
  if (opt.found) jv_setz(a, *out, "value", jv_str(a, opt.value));
  return 0;
}

static int fn_parse_argv(arena *a, const jval *in, jval **out, str *err) {
  str *argv;
  size_t n;
  lk_parsed p;
  lk_error e;
  if (0 != strings(a, in, &argv, &n)) return malformed(err);
  if (0 != lk_parse_argv(a, argv, n, &p, &e)) {
    *err = e.message;
    return -1;
  }
  *out = jv_obj(a);
  jv_setz(a, *out, "command", jv_str(a, p.command));
  jv_setz(a, *out, "flags", p.flags);
  jv_setz(a, *out, "args", string_list(a, p.args, p.nargs));
  return 0;
}

static int fn_project_joplin(arena *a, const jval *in, jval **out, str *err) {
  const jval *raw = jv_getz(in, "raw");
  lk_error e;
  if (!jv_is(in, J_OBJECT)) return malformed(err);
  if (!jv_is(raw, J_OBJECT)) raw = jv_obj(a);
  if (0 != lk_project_joplin(a, raw, field_str(in, "instance"), field_str(in, "account"), 0, out, &e)) {
    *err = e.message;
    return -1;
  }
  return 0;
}

static int fn_partial_codes(arena *a, const jval *in, jval **out, str *err) {
  (void)in;
  (void)err;
  *out = lk_partial_codes(a);
  return 0;
}

static int fn_vault_entry(arena *a, const jval *in, jval **out, str *err) {
  const jval *profile = jv_getz(in, "profile");
  const jval *key = jv_getz(in, "key");
  lk_vault v;
  lk_error e;
  if (!jv_is(in, J_OBJECT)) return malformed(err);
  if (0 != lk_vault_entry(a, jv_getz(in, "station"),
                          jv_is(profile, J_STRING) ? profile->s : str_of("default"),
                          str_of("/home/u"), str_of("/home/u/.config/likeness"),
                          jv_is(key, J_STRING) ? &key->s : NULL, &v, &e)) {
    *err = e.message;
    return -1;
  }
  *out = jv_obj(a);
  jv_setz(a, *out, "file", jv_str(a, v.file));
  jv_setz(a, *out, "key", jv_str(a, v.key));
  jv_setz(a, *out, "shown", jv_str(a, v.shown));
  return 0;
}

static int refused(const lk_error *e, str *err) {
  *err = e->message;
  return -1;
}

static int fn_obsidian_url(arena *a, const jval *in, jval **out, str *err) {
  const jval *vault = jv_getz(in, "vault");
  const jval *path = jv_getz(in, "path");
  if (!jv_is(vault, J_STRING) || !jv_is(path, J_STRING)) return malformed(err);
  *out = jv_str(a, lk_obsidian_url(a, vault->s, path->s));
  return 0;
}

static int fn_vault_entries(arena *a, const jval *in, jval **out, str *err) {
  str *names;
  size_t n;
  lk_error e;
  if (!jv_is(in, J_ARRAY)) return malformed(err);
  if (0 != lk_obsidian_entries(a, in, &names, &n, &e)) return refused(&e, err);
  *out = string_list(a, names, n);
  return 0;
}

/* Each list step is answered with that directory's listing, read as the
 * adapter reads one; a directory with none lists nothing. */
static int fn_vault_walk(arena *a, const jval *in, jval **out, str *err) {
  const jval *listings = jv_getz(in, "listings");
  lk_obsidian_walk w;
  lk_obsidian_step step;
  lk_error e;
  if (!jv_is(listings, J_OBJECT)) return malformed(err);
  *out = jv_arr(a);
  step = lk_obsidian_walk_start(a, &w);
  for (;;) {
    jval *row = jv_obj(a);
    const jval *listed = step.list ? jv_get(listings, step.path) : NULL;
    str *names = NULL;
    size_t n = 0;
    jv_setz(a, row, step.list ? "list" : "read", jv_str(a, step.path));
    jv_push(a, *out, row);
    if (NULL != listed && J_NULL != listed->kind) {
      if (!jv_is(listed, J_ARRAY)) return malformed(err);
      if (0 != lk_obsidian_entries(a, listed, &names, &n, &e)) return refused(&e, err);
    }
    if (!lk_obsidian_walk_next(&w, names, n, &step)) return 0;
  }
}

static int fn_obsidian_transport(arena *a, const jval *in, jval **out, str *err) {
  const jval *instance = jv_getz(in, "instance");
  const jval *block = jv_getz(in, "block");
  lk_obsidian_tls tls;
  lk_error e;
  if (!jv_is(instance, J_STRING) || !jv_is(block, J_OBJECT)) return malformed(err);
  if (0 != lk_obsidian_transport(a, instance->s, block, &tls, &e)) return refused(&e, err);
  *out = jv_obj(a);
  jv_setz(a, *out, "tls", jv_strz(a, tls.pinned ? "pinned" : "off"));
  if (tls.pinned) jv_setz(a, *out, "pin", jv_str(a, tls.pin));
  return 0;
}

static int fn_project_obsidian(arena *a, const jval *in, jval **out, str *err) {
  const jval *path = jv_getz(in, "path");
  const jval *instance = jv_getz(in, "instance");
  const jval *account = jv_getz(in, "account");
  lk_error e;
  if (!jv_is(path, J_STRING) || !jv_is(instance, J_STRING) || !jv_is(account, J_STRING)) return malformed(err);
  if (0 != lk_project_obsidian(a, jv_getz(in, "raw"), path->s, instance->s, account->s, 0, out, &e)) {
    return refused(&e, err);
  }
  return 0;
}

static int fn_parse_pin(arena *a, const jval *in, jval **out, str *err) {
  str pin;
  const char *bad = lk_parse_pin(a, in, &pin);
  if (NULL != bad) {
    *err = str_of(bad);
    return -1;
  }
  *out = jv_str(a, pin);
  return 0;
}

static int hex_value(char c) {
  if ('0' <= c && c <= '9') return c - '0';
  if ('a' <= c && c <= 'f') return c - 'a' + 10;
  if ('A' <= c && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Buffer.from(hex, 'hex'): pairs up to the first that is not two hex digits. */
static int fn_fingerprint_of(arena *a, const jval *in, jval **out, str *err) {
  unsigned char *der;
  size_t n = 0;
  if (!jv_is(in, J_STRING)) return malformed(err);
  der = ar_alloc(a, in->s.n / 2 + 1);
  while (2 * n + 1 < in->s.n && 0 <= hex_value(in->s.p[2 * n]) && 0 <= hex_value(in->s.p[2 * n + 1])) {
    der[n] = (unsigned char)(hex_value(in->s.p[2 * n]) * 16 + hex_value(in->s.p[2 * n + 1]));
    n++;
  }
  *out = jv_str(a, lk_fingerprint_of(a, der, n));
  return 0;
}

static int fn_notion_version(arena *a, const jval *in, jval **out, str *err) {
  const jval *instance = jv_getz(in, "instance");
  const jval *block = jv_getz(in, "block");
  str version;
  lk_error e;
  if (!jv_is(instance, J_STRING) || !jv_is(block, J_OBJECT)) return malformed(err);
  if (0 != lk_notion_configure(a, instance->s, block, &version, &e)) return refused(&e, err);
  *out = jv_obj(a);
  jv_setz(a, *out, "version", jv_str(a, version));
  return 0;
}

static int fn_notion_title(arena *a, const jval *in, jval **out, str *err) {
  str title;
  lk_error e;
  if (0 != lk_notion_title(a, in, &title, &e)) return refused(&e, err);
  *out = jv_str(a, title);
  return 0;
}

/* Absent is `{}`: the corpus has no way to say "no value" but an empty record. */
static int fn_notion_space(arena *a, const jval *in, jval **out, str *err) {
  str space;
  lk_error e;
  if (0 != lk_notion_space(a, in, &space, &e)) return refused(&e, err);
  *out = jv_obj(a);
  if (0 < space.n) jv_setz(a, *out, "space", jv_str(a, space));
  return 0;
}

static int fn_notion_time(arena *a, const jval *in, jval **out, str *err) {
  str when;
  lk_error e;
  if (0 != lk_notion_stamp(a, in, "created_time", &when, &e)) return refused(&e, err);
  *out = jv_str(a, when);
  return 0;
}

static int fn_project_notion(arena *a, const jval *in, jval **out, str *err) {
  const jval *instance = jv_getz(in, "instance");
  const jval *account = jv_getz(in, "account");
  lk_error e;
  if (!jv_is(instance, J_STRING) || !jv_is(account, J_STRING)) return malformed(err);
  if (0 != lk_project_notion(a, jv_getz(in, "raw"), instance->s, account->s, 0, out, &e)) return refused(&e, err);
  return 0;
}

static int fn_secret_name(arena *a, const jval *in, jval **out, str *err) {
  if (!jv_is(in, J_STRING)) return malformed(err);
  *out = jv_str(a, lk_secret_name(a, in->s));
  return 0;
}

static int fn_ref_for(arena *a, const jval *in, jval **out, str *err) {
  const jval *source = jv_getz(in, "source");
  const jval *instance = jv_getz(in, "instance");
  str ref;
  lk_error e;
  if (!jv_is(source, J_STRING) || (NULL != instance && !jv_is(instance, J_STRING))) return malformed(err);
  if (0 != lk_ref_for(a, source->s, NULL == instance ? NULL : &instance->s, &ref, &e)) return refused(&e, err);
  *out = jv_str(a, ref);
  return 0;
}

static const implemented REGISTRY[] = {
  { "compareCodePoints", fn_compare_code_points },
  { "crockfordAlphabet", fn_crockford_alphabet },
  { "fingerprintOf", fn_fingerprint_of },
  { "foldCase", fn_fold_case },
  { "lid", fn_lid },
  { "notionSpace", fn_notion_space },
  { "notionTime", fn_notion_time },
  { "notionTitle", fn_notion_title },
  { "notionVersion", fn_notion_version },
  { "obsidianTransport", fn_obsidian_transport },
  { "obsidianUrl", fn_obsidian_url },
  { "parseArgv", fn_parse_argv },
  { "parsePin", fn_parse_pin },
  { "parseSelector", fn_parse_selector },
  { "parseSelectorError", fn_parse_selector_error },
  { "partialCodes", fn_partial_codes },
  { "projectJoplin", fn_project_joplin },
  { "projectNotion", fn_project_notion },
  { "projectObsidian", fn_project_obsidian },
  { "refFor", fn_ref_for },
  { "rfc3339", fn_rfc3339 },
  { "secretName", fn_secret_name },
  { "serialise", fn_serialise },
  { "takeConfigOption", fn_take_config_option },
  { "vaultEntries", fn_vault_entries },
  { "vaultEntry", fn_vault_entry },
  { "vaultWalk", fn_vault_walk },
  { NULL, NULL },
};

/* What this port cannot run yet, and the upstream change each waits on: omni
 * holds each of their entries while it fails. */
static const waiting WAITING[] = {
  { "connections", "voxgig/station#23: station's C library cannot open station.json to validate it" },
  { NULL, NULL },
};

static unit_fn lookup(const implemented *reg, str name) {
  size_t i;
  for (i = 0; NULL != reg[i].name; i++) {
    if (str_eqz(name, reg[i].name)) return reg[i].fn;
  }
  return NULL;
}

static const char *waits_on(const waiting *w, str name) {
  size_t i;
  for (i = 0; NULL != w[i].name; i++) {
    if (str_eqz(name, w[i].name)) return w[i].on;
  }
  return NULL;
}

static int in_corpus(const omni_json *entries, const char *fn) {
  size_t i;
  for (i = 0; i < entries->listlen; i++) {
    if (0 == strcmp(omni_strz(omni_map_get(entries->list[i], "fn")), fn)) return 1;
  }
  return 0;
}

static void report(tally *t, const char *name, str why) {
  if (NULL != t) tap_fail(t, str_of(name), why);
}

/* The declarations agree with the corpus in every direction, or the run fails.
 * A NULL tally counts the faults without reporting them. */
static int declaration_faults(arena *a, const implemented *reg, const waiting *w, const omni_json *entries,
                              tally *t) {
  int faults = 0;
  size_t i;
  for (i = 0; NULL != w[i].name; i++) {
    sbuf m;
    sb_init(&m, a);
    if (NULL != lookup(reg, str_of(w[i].name))) {
      sb_puts(&m, "the waiting list names ");
      sb_puts(&m, w[i].name);
      sb_puts(&m, ", which this port implements");
      report(t, "declared: waiting", sb_done(&m));
      faults++;
    }
    else if (!in_corpus(entries, w[i].name)) {
      sb_puts(&m, "the waiting list names ");
      sb_puts(&m, w[i].name);
      sb_puts(&m, ", which no corpus entry uses");
      report(t, "declared: waiting", sb_done(&m));
      faults++;
    }
  }
  for (i = 0; i < entries->listlen; i++) {
    const char *fn = omni_strz(omni_map_get(entries->list[i], "fn"));
    size_t k;
    int earlier = 0;
    for (k = 0; k < i; k++) {
      if (0 == strcmp(fn, omni_strz(omni_map_get(entries->list[k], "fn")))) earlier = 1;
    }
    if (!earlier && NULL == lookup(reg, str_of(fn)) && NULL == waits_on(w, str_of(fn))) {
      sbuf m;
      sb_init(&m, a);
      sb_puts(&m, "the corpus uses ");
      sb_puts(&m, fn);
      sb_puts(&m, ", which this port neither implements nor declares waiting");
      report(t, "declared: every function", sb_done(&m));
      faults++;
    }
  }
  return faults;
}

static int duplicate_ids(arena *a, const omni_json *entries, tally *t) {
  int faults = 0;
  size_t i;
  size_t k;
  for (i = 0; i < entries->listlen; i++) {
    const char *id = omni_strz(omni_map_get(entries->list[i], "id"));
    for (k = 0; k < i; k++) {
      if (0 == strcmp(id, omni_strz(omni_map_get(entries->list[k], "id")))) {
        sbuf m;
        sb_init(&m, a);
        sb_puts(&m, "duplicate corpus id: ");
        sb_puts(&m, id);
        report(t, "ids are unique", sb_done(&m));
        faults++;
        break;
      }
    }
  }
  return faults;
}

typedef struct {
  omni_pool *pool;
  unit_fn fn;
  const char *waits;
} unit_call;

/* The answer is the port's own serialisation read back by omni, so `true`
 * and `1` stay different answers. Each call has its own arena: nothing it
 * returns points into it. */
static omni_result call_unit(omni_subject *self, omni_json **args, size_t nargs) {
  const unit_call *c = self->data;
  arena *a = ar_new();
  omni_result r;
  jval *got = NULL;
  str err = str_mk("", 0);
  str text;
  str why = str_of("the answer has no envelope form");
  r.val = NULL;
  r.err = NULL;
  if (NULL != c->waits) r.err = c->waits;
  else if (0 != c->fn(a, 0 < nargs ? jv_from_omni(a, args[0]) : NULL, &got, &err)) r.err = omni_text(c->pool, err);
  else if (0 != lk_serialise(a, got, &text, &why)) r.err = omni_text(c->pool, why);
  else {
    char *bad = NULL;
    r.val = omni_parse(c->pool, text.p, &bad);
    if (NULL == r.val) r.err = bad;
  }
  ar_free(a);
  return r;
}

/* A waiting function answers every entry with its cause, so omni's wait can
 * hold the entry rather than refuse an unknown fn. */
static omni_subject *unit_subject(omni_provider *self, const char *name) {
  omni_pool *pool = self->data;
  unit_fn fn = lookup(REGISTRY, str_of(name));
  const char *on = waits_on(WAITING, str_of(name));
  unit_call *c;
  omni_subject *s;
  if (NULL == fn && NULL == on) return NULL;
  c = omni_pool_alloc(pool, sizeof *c);
  c->pool = pool;
  c->fn = fn;
  if (NULL == fn) {
    char *waits = omni_pool_alloc(pool, strlen("waiting on ") + strlen(on) + 1);
    strcat(strcpy(waits, "waiting on "), on);
    c->waits = waits;
  }
  s = omni_pool_alloc(pool, sizeof *s);
  s->call = call_unit;
  s->data = c;
  return s;
}

typedef struct {
  omni_pool *pool;
  omni_provider provider;
  omni_json *header;
  omni_runpack *pack;
  const char **groups;
  size_t ngroups;
  omni_json *entries;
} corpus;

static void load(corpus *c, arena *a, const char *root) {
  char *err = NULL;
  omni_json *all;
  omni_runner *runner;
  size_t i;
  memset(c, 0, sizeof *c);
  c->pool = omni_pool_new();
  c->provider.subject = unit_subject;
  c->provider.data = c->pool;
  all = omni_loadspec(c->pool, joinpath(a, root, str_of("spec/unit.json")), &err);
  if (NULL == all || !omni_ismap(omni_map_get(omni_map_get(all, "primary"), "unit"))) {
    fprintf(stderr, "%s - run `make spec-build` from the repository root first\n",
      NULL == err ? "spec/unit.json has no primary.unit" : err);
    exit(2);
  }
  c->header = omni_map_get(all, "OMNI");
  runner = omni_make_runner(c->pool, NULL, all, &c->provider, &err);
  if (NULL == runner) {
    fprintf(stderr, "%s\n", err);
    exit(2);
  }
  c->pack = omni_runner_run(runner, "unit", NULL, &err);
  c->groups = omni_group_names(c->pool, omni_spec(c->pack), &c->ngroups);
  c->entries = omni_list(c->pool);
  for (i = 0; i < c->ngroups; i++) {
    const omni_json *set = omni_map_get(omni_set(c->pack, c->groups[i]), "set");
    size_t k;
    for (k = 0; omni_islist(set) && k < set->listlen; k++) omni_list_push(c->entries, set->list[k]);
  }
}

/* Each entry of the set whose function waits, held by id to its cause. */
static omni_json *waits_in(omni_pool *pool, const omni_json *set) {
  omni_json *waits = omni_map(pool);
  size_t i;
  for (i = 0; omni_islist(set) && i < set->listlen; i++) {
    const omni_json *e = set->list[i];
    const char *on = waits_on(WAITING, str_of(omni_strz(omni_map_get(e, "fn"))));
    if (NULL != on) {
      omni_json *wait = omni_map(pool);
      omni_map_set(wait, "cause", omni_str(pool, on));
      omni_map_set(waits, omni_strz(omni_map_get(e, "id")), wait);
    }
  }
  return 0 < waits->maplen ? waits : NULL;
}

static void run_corpus(arena *a, corpus *c, tally *t) {
  size_t held = 0;
  char note[120];
  size_t i;
  for (i = 0; i < c->ngroups; i++) {
    omni_json *group = omni_set(c->pack, c->groups[i]);
    omni_json *waits = waits_in(c->pool, omni_map_get(group, "set"));
    omni_flags flags = omni_flags_nonull();
    char *message = NULL;
    sbuf name;
    int failed;
    size_t k;
    flags.all = 1;
    flags.wait = waits;
    failed = omni_runsetflags(c->pack, group, flags, NULL, &message);
    sb_init(&name, a);
    sb_puts(&name, "unit ");
    sb_puts(&name, c->groups[i]);
    tap_omni(t, sb_done(&name), failed, message);
    for (k = 0; !failed && NULL != waits && k < waits->maplen; k++) {
      sbuf why;
      sb_init(&name, a);
      sb_puts(&name, "unit ");
      sb_puts(&name, waits->keys[k]);
      sb_init(&why, a);
      sb_puts(&why, "waiting on ");
      sb_puts(&why, omni_strz(omni_map_get(waits->vals[k], "cause")));
      tap_skip(t, sb_done(&name), sb_done(&why).p);
      held++;
    }
  }
  snprintf(note, sizeof note, "%lu entries in %lu groups through omni, %lu of them held waiting",
    (unsigned long)c->entries->listlen, (unsigned long)c->ngroups, (unsigned long)held);
  tap_note(note);
}

static const char *check(corpus *c, omni_json *e) {
  omni_json *set = omni_list(c->pool);
  char *message = NULL;
  omni_list_push(set, e);
  if (0 == omni_run_group(c->pool, &c->provider, c->header, "unit", "one", set, 0, NULL, &message)) return NULL;
  return NULL == message ? "omni failed and gave no message" : message;
}

static omni_json *find(corpus *c, const char *id) {
  size_t i;
  for (i = 0; i < c->entries->listlen; i++) {
    if (0 == strcmp(omni_strz(omni_map_get(c->entries->list[i], "id")), id)) {
      return omni_clone(c->pool, c->entries->list[i]);
    }
  }
  return NULL;
}

static omni_json *without(omni_pool *pool, const omni_json *e, const char *key) {
  omni_json *out = omni_map(pool);
  size_t i;
  for (i = 0; i < e->maplen; i++) {
    if (0 != strcmp(e->keys[i], key)) omni_map_set(out, e->keys[i], omni_clone(pool, e->vals[i]));
  }
  return out;
}

static void expect(tally *t, const char *name, int held, const char *message) {
  if (held) tap_ok(t, str_of(name));
  else tap_fail(t, str_of(name), str_of(NULL == message ? "the harness stayed green" : message));
}

static void meta(arena *a, corpus *c, tally *t) {
  static const waiting WAITING_ON_AN_IMPLEMENTED[] = { { "serialise", "test" }, { NULL, NULL } };
  static const waiting WAITING_ON_NOTHING[] = { { "noSuchFunction", "test" }, { NULL, NULL } };
  static const waiting NONE_WAITING[] = { { NULL, NULL } };
  omni_json *keys = find(c, "envelope/keys-sorted");
  omni_json *refused = find(c, "envelope/float-is-refused");
  omni_json *json_true = find(c, "args/selector-terms-accumulate");
  omni_json *e;
  const char *said;

  if (NULL == keys || NULL == refused || NULL == json_true) {
    tap_fail(t, str_of("meta: the entries the meta tests mutate exist"), str_of("an entry is missing"));
    return;
  }

  said = check(c, keys);
  expect(t, "meta: the unmutated entry passes", NULL == said, said);

  e = omni_clone(c->pool, keys);
  omni_map_set(e, "out", omni_str(c->pool, "{\"10\":4,\"2\":5,\"C\":3,\"a\":2,\"b\":1}"));
  said = check(c, e);
  expect(t, "meta: output missing its newline is reported", omni_says(said, ": result mismatch"), said);

  e = omni_clone(c->pool, refused);
  omni_map_set(e, "err", omni_str(c->pool, "a message nobody writes"));
  said = check(c, e);
  expect(t, "meta: the wrong error message is reported", omni_says(said, ": error mismatch"), said);

  e = without(c->pool, keys, "out");
  omni_map_set(e, "err", omni_str(c->pool, "anything"));
  said = check(c, e);
  expect(t, "meta: an error expected from a function that succeeds is reported",
    omni_says(said, ": expected error did not occur"), said);

  e = omni_clone(c->pool, keys);
  omni_map_set(e, "fn", omni_str(c->pool, "noSuchFunction"));
  said = check(c, e);
  expect(t, "meta: an unknown function is reported", omni_says(said, "unknown fn: noSuchFunction"), said);

  e = omni_clone(c->pool, json_true);
  omni_map_set(omni_map_get(omni_map_get(e, "out"), "flags"), "json", omni_num(c->pool, 1));
  said = check(c, e);
  expect(t, "meta: 1 where the port answers true is reported", omni_says(said, ": result mismatch"), said);

  expect(t, "meta: a waiting function the port implements is refused",
    0 < declaration_faults(a, REGISTRY, WAITING_ON_AN_IMPLEMENTED, c->entries, NULL), NULL);
  expect(t, "meta: a waiting function absent from the corpus is refused",
    0 < declaration_faults(a, REGISTRY, WAITING_ON_NOTHING, c->entries, NULL), NULL);
  expect(t, "meta: a corpus function neither implemented nor waiting is refused",
    0 < declaration_faults(a, REGISTRY, NONE_WAITING, c->entries, NULL), NULL);

  {
    omni_json *twice = omni_list(c->pool);
    omni_list_push(twice, keys);
    omni_list_push(twice, keys);
    expect(t, "meta: a duplicate id is refused", 0 < duplicate_ids(a, twice, NULL), NULL);
  }
}

/* A lone surrogate leaves as a \u escape, so the reader rebuilds the string a
 * JavaScript port holds rather than a replacement character per byte. */
static str escaped_surrogates(arena *a, str s) {
  static const char hex[] = "0123456789abcdef";
  sbuf b;
  size_t i = 0;
  sb_init(&b, a);
  while (i < s.n) {
    unsigned long cp;
    size_t len = u8_next(s.p, s.n, i, &cp);
    if (0xD800 <= cp && cp <= 0xDFFF) {
      char esc[6];
      esc[0] = '\\';
      esc[1] = 'u';
      esc[2] = hex[(cp >> 12) & 15];
      esc[3] = hex[(cp >> 8) & 15];
      esc[4] = hex[(cp >> 4) & 15];
      esc[5] = hex[cp & 15];
      sb_put(&b, esc, 6);
    }
    else sb_put(&b, s.p + i, len);
    i += len;
  }
  return sb_done(&b);
}

static int eval(arena *top) {
  char *line = NULL;
  size_t cap = 0;
  size_t n = 0;
  int c;
  for (;;) {
    arena *a;
    jval *e = NULL;
    jval *got = NULL;
    str err = str_mk("", 0);
    str text;
    unit_fn fn;
    jval *reply;
    n = 0;
    while (EOF != (c = getchar()) && '\n' != c) {
      if (n + 1 >= cap) {
        char *grown = ar_alloc(top, 0 == cap ? 1024 : cap * 2);
        if (0 < n) memcpy(grown, line, n);
        line = grown;
        cap = 0 == cap ? 1024 : cap * 2;
      }
      line[n++] = (char)c;
    }
    if (0 == n && EOF == c) return 0;
    a = ar_new();
    reply = jv_obj(a);
    if (NULL != json_parse(a, line, n, &e)) jv_setz(a, reply, "fault", jv_strz(a, "the line is not JSON"));
    else if (NULL == (fn = lookup(REGISTRY, field_str(e, "fn")))) {
      jv_setz(a, reply, "skip", jv_strz(a, NULL != waits_on(WAITING, field_str(e, "fn")) ? "waiting" : "unknown"));
    }
    else if (0 == fn(a, jv_getz(e, "in"), &got, &err)) jv_setz(a, reply, "out", got);
    else jv_setz(a, reply, "err", jv_str(a, err));
    if (0 != lk_serialise(a, reply, &text, NULL)) text = str_of("{\"fault\":\"the answer has no envelope form\"}\n");
    text = escaped_surrogates(a, text);
    fwrite(text.p, 1, text.n, stdout);
    fflush(stdout);
    ar_free(a);
    if (EOF == c) return 0;
  }
}

int main(int argc, char **argv) {
  arena *a = ar_new();
  const char *root = repo_root(a, argc, argv);
  corpus c;
  tally t;
  int status;

  if (2 < argc && 0 == strcmp(argv[2], "--eval")) {
    status = eval(a);
    ar_free(a);
    spec_unload();
    return status;
  }

  memset(&t, 0, sizeof t);
  load(&c, a, root);
  tap_begin();
  if (0 == c.entries->listlen) tap_fail(&t, str_of("the unit corpus is not empty"), str_of("spec/unit.json has no entries"));
  else tap_ok(&t, str_of("the unit corpus is not empty"));
  if (0 == duplicate_ids(a, c.entries, &t)) tap_ok(&t, str_of("every corpus id is unique"));
  if (0 == declaration_faults(a, REGISTRY, WAITING, c.entries, &t)) {
    tap_ok(&t, str_of("every corpus function is implemented or declared waiting, and nothing else is"));
  }
  run_corpus(a, &c, &t);
  meta(a, &c, &t);
  status = tap_end(&t);
  omni_pool_free(c.pool);
  ar_free(a);
  spec_unload();
  return status;
}
