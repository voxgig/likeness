/* The transcript corpus, spec/cli.json, as far as this port answers it: help,
 * version, which, a command declared not ready, and every command line the
 * grammar refuses, run by omni one group at a time. Every other entry waits
 * upstream: it is reported as skipped, and this port's answer to it must be
 * the honest refusal. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "args.h"
#include "bridge.h"
#include "core.h"
#include "envelope.h"
#include "harness.h"
#include "spec.h"

#define VAULT_WAITS "asserts the vault, which this port cannot read until voxgig/station#23"

static const char *const ISSUES[] = { "voxgig/sdkgen#403", "voxgig/sdkgen#405", "voxgig/station#23", NULL };

typedef struct {
  arena *a;
  sbuf out;
  int n;
} failures;

static void failz(failures *f, const char *why) {
  if (0 < f->n) sb_putc(&f->out, '\n');
  sb_puts(&f->out, why);
  f->n++;
}

static void fault(omni_json *faults, const char *why) {
  omni_list_push(faults, omni_str(faults->pool, why));
}

static int ends_with(const char *s, const char *suffix) {
  size_t n = strlen(s);
  size_t k = strlen(suffix);
  return k <= n && 0 == strcmp(s + n - k, suffix);
}

static int truthy(const omni_json *v) {
  return NULL != v && OMNI_BOOL == v->type && v->boolval;
}

static int non_negative_integer(const jval *v) {
  return jv_is(v, J_NUMBER) && 0 <= v->num && (double)(long long)v->num == v->num;
}

/* The stdout to compare: as printed, or for JSON the canonical bytes less the
 * fields that may differ by port, each of those checked here instead. */
static str seen_stdout(arena *a, int json, str actual, omni_json *faults) {
  jval *parsed = NULL;
  str canonical;
  str stripped;
  const jval *port;
  const jval *data;
  if (!json) return actual;
  if (NULL != json_parse(a, actual.p, actual.n, &parsed)) {
    fault(faults, "stdout is not JSON, and the entry says it should be");
    return actual;
  }
  if (0 != lk_serialise(a, parsed, &canonical, NULL)) {
    fault(faults, "stdout cannot be re-rendered");
    return actual;
  }
  if (!str_eq(canonical, actual)) {
    fault(faults, "stdout is not in canonical form (sorted keys, one line, one trailing newline)");
  }
  port = jv_getz(parsed, "port");
  if (!jv_is(port, J_STRING) || !str_eqz(port->s, LK_PORT)) fault(faults, "envelope port is not \"" LK_PORT "\"");
  data = jv_getz(parsed, "data");
  if (NULL != jv_getz(data, "port") && !(jv_is(jv_getz(data, "port"), J_STRING) &&
                                         str_eqz(jv_getz(data, "port")->s, LK_PORT))) {
    fault(faults, "data.port is not \"" LK_PORT "\"");
  }
  if (!non_negative_integer(jv_getz(jv_getz(parsed, "meta"), "elapsed_ms"))) {
    fault(faults, "meta.elapsed_ms is not a non-negative integer");
  }
  if (0 != lk_serialise(a, lk_strip_parity_exceptions(a, parsed), &stripped, NULL)) return actual;
  return stripped;
}

/* omni's strings end at a NUL, so bytes past one would go uncompared. */
static omni_json *text_of(omni_pool *pool, str s, omni_json *faults, const char *field) {
  if (NULL != memchr(s.p, '\0', s.n)) {
    char why[80];
    snprintf(why, sizeof why, "%s holds a NUL byte, which omni cannot compare past", field);
    fault(faults, why);
  }
  return omni_str(pool, omni_text(pool, s));
}

static lk_result run_command(arena *a, const omni_json *ctx, omni_json *const *argv, size_t argc) {
  const jval *path = jv_from_omni(a, omni_map_get(ctx, "path"));
  str *args = ar_alloc(a, (argc + 1) * sizeof *args);
  lk_ctx c;
  size_t i;
  for (i = 0; i < argc; i++) {
    const char *arg = omni_strz(argv[i]);
    args[i] = str_mk(ar_copy(a, arg, strlen(arg)), strlen(arg));
  }
  c.argv = args;
  c.argc = argc;
  c.path = NULL;
  if (jv_is(path, J_ARRAY)) {
    jval *rows = jv_arr(a);
    for (i = 0; i < path->len; i++) {
      jval *row = jv_obj(a);
      jv_setz(a, row, "path", jv_str(a, field_str(path->item[i], "path")));
      jv_setz(a, row, "port", jv_str(a, field_str(path->item[i], "port")));
      jv_setz(a, row, "version", jv_str(a, field_str(path->item[i], "version")));
      jv_push(a, rows, row);
    }
    c.path = rows;
  }
  return lk_run(a, &c);
}

/* omni's subject: one command, in-process. The run is pure, so it makes no
 * call, shows no prompt and writes no file, and it cannot open the vault. */
static omni_result transcript(omni_subject *self, omni_json **args, size_t nargs) {
  omni_pool *pool = self->data;
  arena *a = ar_new();
  const omni_json *ctx = 0 < nargs ? args[0] : NULL;
  const omni_json *observe = omni_map_get(ctx, "observe");
  const omni_json *files = omni_map_get(observe, "files");
  lk_result r = run_command(a, ctx, args + (0 < nargs), 0 < nargs ? nargs - 1 : 0);
  omni_json *seen = omni_map(pool);
  omni_json *faults = omni_list(pool);
  omni_result out;
  str stdout_seen = seen_stdout(a, truthy(omni_map_get(observe, "json")), r.out, faults);
  omni_map_set(seen, "exit", omni_num(pool, r.exit));
  omni_map_set(seen, "stdout", text_of(pool, stdout_seen, faults, "stdout"));
  omni_map_set(seen, "stderr", text_of(pool, r.err, faults, "stderr"));
  omni_map_set(seen, "calls", omni_list(pool));
  omni_map_set(seen, "prompts", omni_list(pool));
  omni_map_set(seen, "faults", faults);
  if (omni_map_has(observe, "vault")) {
    omni_map_set(seen, "vault", omni_null(pool));
    fault(faults, "the vault cannot be read until voxgig/station#23");
  }
  if (omni_islist(files)) {
    omni_json *written = omni_map(pool);
    size_t i;
    for (i = 0; i < files->listlen; i++) omni_map_set(written, omni_strz(files->list[i]), omni_null(pool));
    omni_map_set(seen, "files", written);
  }
  if (omni_map_has(observe, "absent")) omni_map_set(seen, "absent", omni_clone(pool, omni_map_get(observe, "absent")));
  ar_free(a);
  out.val = seen;
  out.err = NULL;
  return out;
}

static omni_subject *subject(omni_provider *self, const char *name) {
  omni_subject *s;
  if (0 != strcmp(name, "cli")) return NULL;
  s = omni_pool_alloc(self->data, sizeof *s);
  s->call = transcript;
  s->data = self->data;
  return s;
}

typedef struct {
  omni_pool *pool;
  omni_provider provider;
  const char *root;
  omni_json *header;
  omni_json *groups;
  const char **names;
  size_t ngroups;
  size_t total;
} corpus;

static str named(arena *a, const char *prefix, const char *id) {
  sbuf b;
  sb_init(&b, a);
  sb_puts(&b, prefix);
  sb_puts(&b, id);
  return sb_done(&b);
}

/* NULL when the file cannot be read, or holds a NUL that would end omni's
 * string early. */
static char *bytes_of(omni_pool *pool, arena *a, const char *root, const char *rel) {
  str s;
  if (0 != read_file(a, joinpath(a, root, str_of(rel)), &s) || NULL != memchr(s.p, '\0', s.n)) return NULL;
  return omni_text(pool, s);
}

/* The entry as omni runs it: what `out` names by path becomes the bytes, and
 * what the subject must observe rides in ctx.observe. NULL, with why, when an
 * expectation cannot be read. */
static omni_json *resolved(corpus *c, arena *a, const omni_json *e, const char **why) {
  omni_pool *pool = c->pool;
  const omni_json *o = omni_map_get(e, "out");
  const omni_json *calls = omni_map_get(o, "calls");
  const omni_json *files = omni_map_get(o, "files");
  const char *rel = omni_strz(omni_map_get(o, "stdout"));
  omni_json *observe = omni_map(pool);
  omni_json *want = omni_map(pool);
  omni_json *ctx = omni_clone(pool, omni_map_get(e, "ctx"));
  omni_json *entry = omni_map(pool);
  omni_json *list = omni_list(pool);
  char *text = bytes_of(pool, a, c->root, rel);
  size_t i;

  if (NULL == text) {
    *why = named(a, "cannot read expectation ", rel).p;
    return NULL;
  }
  omni_map_set(observe, "id", omni_clone(pool, omni_map_get(e, "id")));
  omni_map_set(observe, "json", omni_bool(pool, ends_with(rel, ".json")));
  omni_map_set(want, "exit", omni_clone(pool, omni_map_get(o, "exit")));
  omni_map_set(want, "stdout", omni_str(pool, text));
  omni_map_set(want, "stderr", omni_map_has(o, "stderr") ? omni_clone(pool, omni_map_get(o, "stderr"))
                                                          : omni_str(pool, ""));
  for (i = 0; omni_islist(calls) && i < calls->listlen; i++) {
    omni_json *call = omni_map(pool);
    omni_map_set(call, "instance", omni_clone(pool, omni_map_get(calls->list[i], "instance")));
    omni_map_set(call, "method", omni_clone(pool, omni_map_get(calls->list[i], "method")));
    omni_map_set(call, "path", omni_clone(pool, omni_map_get(calls->list[i], "path")));
    omni_list_push(list, call);
  }
  omni_map_set(want, "calls", list);
  omni_map_set(want, "prompts", omni_map_has(o, "prompts") ? omni_clone(pool, omni_map_get(o, "prompts"))
                                                            : omni_list(pool));
  omni_map_set(want, "faults", omni_list(pool));
  if (omni_map_has(o, "vault")) {
    const omni_json *v = omni_map_get(o, "vault");
    omni_json *vault = omni_map(pool);
    omni_map_set(observe, "vault", omni_bool(pool, 1));
    omni_map_set(vault, "names", omni_clone(pool, omni_map_get(v, "names")));
    if (omni_map_has(v, "keys")) omni_map_set(vault, "keys", omni_clone(pool, omni_map_get(v, "keys")));
    if (omni_map_has(v, "values")) omni_map_set(vault, "values", omni_clone(pool, omni_map_get(v, "values")));
    omni_map_set(want, "vault", vault);
  }
  if (omni_ismap(files)) {
    omni_json *names = omni_list(pool);
    omni_json *bytes = omni_map(pool);
    for (i = 0; i < files->maplen; i++) {
      char *held = bytes_of(pool, a, c->root, omni_strz(files->vals[i]));
      if (NULL == held) {
        *why = named(a, "cannot read expected file ", omni_strz(files->vals[i])).p;
        return NULL;
      }
      omni_list_push(names, omni_str(pool, files->keys[i]));
      omni_map_set(bytes, files->keys[i], omni_str(pool, held));
    }
    omni_map_set(observe, "files", names);
    omni_map_set(want, "files", bytes);
  }
  if (omni_map_has(o, "absent")) {
    omni_map_set(observe, "absent", omni_clone(pool, omni_map_get(o, "absent")));
    omni_map_set(want, "absent", omni_clone(pool, omni_map_get(o, "absent")));
  }
  if (!omni_ismap(ctx)) ctx = omni_map(pool);
  omni_map_set(ctx, "observe", observe);
  omni_map_set(entry, "id", omni_clone(pool, omni_map_get(e, "id")));
  omni_map_set(entry, "args", omni_clone(pool, omni_map_get(e, "args")));
  omni_map_set(entry, "ctx", ctx);
  omni_map_set(entry, "out", want);
  return entry;
}

/* The honest answer to a command that waits: unsupported-capability, exit 4,
 * naming every upstream change it waits on. */
static void check_waits(failures *f, lk_result r, int json) {
  str message = str_mk("", 0);
  size_t i;
  if (4 != r.exit) failz(f, "a waiting command did not exit 4");
  if (json) {
    jval *env = NULL;
    if (NULL == json_parse(f->a, r.out.p, r.out.n, &env) &&
        str_eqz(field_str(env, "code"), "unsupported-capability")) {
      message = field_str(jv_getz(env, "error"), "message");
    }
    else failz(f, "a waiting command did not answer unsupported-capability");
  }
  else if (str_starts(r.err, "error: unsupported-capability\n") && 0 == r.out.n) message = r.err;
  else failz(f, "a waiting command did not narrate unsupported-capability on stderr alone");
  for (i = 0; NULL != ISSUES[i]; i++) {
    if (!str_contains(message, str_of(ISSUES[i]))) failz(f, "a waiting command does not name what it waits on");
  }
}

static lk_result run_entry(arena *a, const omni_json *e) {
  const omni_json *args = omni_map_get(e, "args");
  return run_command(a, omni_map_get(e, "ctx"), omni_islist(args) ? args->list : NULL,
                     omni_islist(args) ? args->listlen : 0);
}

typedef enum { ANSWERED, WAITS, VAULT } kind;

static kind kind_of(arena *a, const omni_json *e, int *json) {
  const omni_json *args = omni_map_get(e, "args");
  size_t n = omni_islist(args) ? args->listlen : 0;
  str *argv = ar_alloc(a, (n + 1) * sizeof *argv);
  kind answered = omni_map_has(omni_map_get(e, "out"), "vault") ? VAULT : ANSWERED;
  lk_parsed p;
  lk_error err;
  size_t i;
  for (i = 0; i < n; i++) argv[i] = str_of(omni_strz(args->list[i]));
  *json = 0;
  if (0 != lk_parse_argv(a, argv, n, &p, &err)) return answered;
  *json = jv_is(jv_getz(p.flags, "json"), J_TRUE);
  if (lk_answers(p.command) || !jv_is(jv_getz(lk_command_def(p.command), "ready"), J_TRUE)) return answered;
  return WAITS;
}

static omni_json *waiting_on_the_vault(omni_pool *pool) {
  omni_json *wait = omni_map(pool);
  omni_map_set(wait, "cause", omni_str(pool, VAULT_WAITS));
  return wait;
}

/* The waiting entry as its cause predicts it: everything but the vault holds. */
static omni_json *predicted(omni_pool *pool, const omni_json *e) {
  omni_json *out = omni_clone(pool, e);
  const omni_json *o = omni_map_get(e, "out");
  omni_json *rest = omni_map(pool);
  size_t i;
  for (i = 0; i < o->maplen; i++) {
    if (0 != strcmp(o->keys[i], "vault")) omni_map_set(rest, o->keys[i], omni_clone(pool, o->vals[i]));
  }
  omni_map_set(out, "out", rest);
  return out;
}

typedef struct {
  size_t answered;
  size_t vault;
  size_t waits;
  size_t ran;
  omni_json *held;
} tallies;

/* Every answered entry of the group through omni at once, then every waiting
 * one held to its refusal. */
static void run_group(corpus *c, arena *a, const char *group, tally *t, tallies *n) {
  const omni_json *set = omni_map_get(omni_map_get(c->groups, group), "set");
  omni_json *mine = omni_list(c->pool);
  omni_json *on_the_vault = omni_map(c->pool);
  sbuf unread;
  size_t i;
  sb_init(&unread, a);
  for (i = 0; omni_islist(set) && i < set->listlen; i++) {
    const omni_json *e = set->list[i];
    const char *why = NULL;
    int json;
    kind k = kind_of(a, e, &json);
    omni_json *r;
    if (WAITS == k) continue;
    r = resolved(c, a, e, &why);
    if (NULL == r) {
      sb_puts(&unread, omni_strz(omni_map_get(e, "id")));
      sb_puts(&unread, ": ");
      sb_puts(&unread, why);
      sb_putc(&unread, '\n');
      continue;
    }
    omni_list_push(mine, r);
    if (VAULT == k) {
      omni_map_set(on_the_vault, omni_strz(omni_map_get(e, "id")), waiting_on_the_vault(c->pool));
      omni_list_push(n->held, (omni_json *)e);
      n->vault++;
    }
    else n->answered++;
  }
  if (0 < unread.n) tap_fail(t, named(a, "cli ", group), sb_done(&unread));
  else if (0 < mine->listlen) {
    char *message = NULL;
    int failed = omni_run_group(c->pool, &c->provider, c->header, "cli", group, mine, 1,
                                0 < on_the_vault->maplen ? on_the_vault : NULL, &message);
    tap_omni(t, named(a, "cli ", group), failed, message);
    for (i = 0; !failed && i < on_the_vault->maplen; i++) {
      tap_skip(t, named(a, "cli ", on_the_vault->keys[i]), VAULT_WAITS);
    }
    n->ran += mine->listlen;
  }
  for (i = 0; omni_islist(set) && i < set->listlen; i++) {
    const omni_json *e = set->list[i];
    failures f;
    int json;
    if (WAITS != kind_of(a, e, &json)) continue;
    f.a = a;
    f.n = 0;
    sb_init(&f.out, a);
    check_waits(&f, run_entry(a, e), json);
    if (0 < f.n) tap_fail(t, named(a, "cli ", omni_strz(omni_map_get(e, "id"))), sb_done(&f.out));
    else tap_skip(t, named(a, "cli ", omni_strz(omni_map_get(e, "id"))), "waiting on " LK_WAITING_ON);
    n->waits++;
  }
}

static void run_corpus(corpus *c, arena *a, tally *t) {
  tallies n;
  size_t total = c->total;
  char note[160];
  size_t i;
  memset(&n, 0, sizeof n);
  n.held = omni_list(c->pool);
  for (i = 0; i < c->ngroups; i++) run_group(c, a, c->names[i], t, &n);
  if (0 < n.held->listlen) {
    omni_json *set = omni_list(c->pool);
    char *message = NULL;
    int failed;
    for (i = 0; i < n.held->listlen; i++) {
      const char *why = NULL;
      omni_json *r = resolved(c, a, predicted(c->pool, n.held->list[i]), &why);
      if (NULL != r) omni_list_push(set, r);
    }
    failed = set->listlen < n.held->listlen ||
             omni_run_group(c->pool, &c->provider, c->header, "cli", "predicted", set, 1, NULL, &message);
    tap_omni(t, str_of("cli waiting entries differ only as their cause predicts"), failed,
      NULL == message ? "a predicted entry cannot be resolved" : message);
  }
  snprintf(note, sizeof note, "%lu entries: %lu through omni, %lu refused naming what they wait on",
    (unsigned long)total, (unsigned long)n.ran, (unsigned long)n.waits);
  if (n.ran + n.waits == total) tap_ok(t, str_of("every entry runs through omni or is refused naming what it waits on"));
  else tap_fail(t, str_of("every entry runs through omni or is refused naming what it waits on"), str_of(note));
  tap_note(note);
  snprintf(note, sizeof note, "answered %lu, waiting %lu, vault-asserting %lu",
    (unsigned long)n.answered, (unsigned long)n.waits, (unsigned long)n.vault);
  tap_note(note);
}

static omni_json *find(corpus *c, const char *id) {
  size_t i;
  for (i = 0; i < c->ngroups; i++) {
    const omni_json *set = omni_map_get(omni_map_get(c->groups, c->names[i]), "set");
    size_t k;
    for (k = 0; omni_islist(set) && k < set->listlen; k++) {
      if (0 == strcmp(omni_strz(omni_map_get(set->list[k], "id")), id)) return omni_clone(c->pool, set->list[k]);
    }
  }
  return NULL;
}

/* One resolved entry through omni, alone: NULL, or omni's message. */
static const char *check_resolved(corpus *c, omni_json *r) {
  omni_json *set = omni_list(c->pool);
  char *message = NULL;
  omni_list_push(set, r);
  if (0 == omni_run_group(c->pool, &c->provider, c->header, "cli", "one", set, 0, NULL, &message)) return NULL;
  return NULL == message ? "omni failed and gave no message" : message;
}

static const char *check(corpus *c, arena *a, const omni_json *e) {
  const char *why = NULL;
  omni_json *r = resolved(c, a, e, &why);
  return NULL == r ? why : check_resolved(c, r);
}

static void expect(tally *t, const char *name, int held, const char *message) {
  if (held) tap_ok(t, str_of(name));
  else tap_fail(t, str_of(name), str_of(NULL == message ? "the harness stayed green" : message));
}

static int differs(corpus *c, const char *message, const char *fields) {
  const char *got = omni_differs(c->pool, message);
  return NULL != got && 0 == strcmp(got, fields);
}

static void one_byte_off(omni_json *r) {
  char *text = omni_map_get(omni_map_get(r, "out"), "stdout")->strval;
  text[strlen(text) - 3] = 'x';
}

static void meta(corpus *c, arena *a, tally *t) {
  omni_json *version = find(c, "meta/version");
  omni_json *search = find(c, "meta/stub-is-honest");
  omni_json *e;
  omni_json *r;
  omni_json *faults = omni_list(c->pool);
  const char *said;
  const char *why = NULL;
  failures f;

  if (NULL == version || NULL == search || NULL == resolved(c, a, version, &why)) {
    tap_fail(t, str_of("meta: the entries the meta tests mutate exist"), str_of("an entry or its expectation is missing"));
    return;
  }

  said = check(c, a, version);
  expect(t, "meta: the unmutated entry passes", NULL == said, said);

  e = omni_clone(c->pool, version);
  omni_map_set(omni_map_get(e, "out"), "exit", omni_num(c->pool, 3));
  said = check(c, a, e);
  expect(t, "meta: a wrong exit code is reported", differs(c, said, "exit"), said);

  r = resolved(c, a, version, &why);
  one_byte_off(r);
  said = check_resolved(c, r);
  expect(t, "meta: stdout differing by one byte is reported", differs(c, said, "stdout"), said);

  e = omni_clone(c->pool, version);
  omni_map_set(omni_map_get(e, "out"), "stderr", omni_str(c->pool, "something the command never printed\n"));
  said = check(c, a, e);
  expect(t, "meta: unexpected stderr is reported", differs(c, said, "stderr"), said);

  e = omni_clone(c->pool, version);
  omni_map_set(omni_map_get(e, "out"), "stdout", omni_str(c->pool, "spec/expect/.meta-does-not-exist.json"));
  expect(t, "meta: a missing expectation is a failure, not a pass", NULL == resolved(c, a, e, &why), NULL);

  e = omni_clone(c->pool, version);
  {
    omni_json *call = omni_map(c->pool);
    omni_json *calls = omni_list(c->pool);
    omni_map_set(call, "instance", omni_str(c->pool, "joplin"));
    omni_map_set(call, "method", omni_str(c->pool, "GET"));
    omni_map_set(call, "path", omni_str(c->pool, "/notes"));
    omni_list_push(calls, call);
    omni_map_set(omni_map_get(e, "out"), "calls", calls);
  }
  said = check(c, a, e);
  expect(t, "meta: a call this port never made is reported", differs(c, said, "calls"), said);

  e = omni_clone(c->pool, version);
  {
    omni_json *prompts = omni_list(c->pool);
    omni_list_push(prompts, omni_str(c->pool, "Passphrase: "));
    omni_map_set(omni_map_get(e, "out"), "prompts", prompts);
  }
  said = check(c, a, e);
  expect(t, "meta: a prompt this port never showed is reported", differs(c, said, "prompts"), said);

  e = omni_clone(c->pool, version);
  {
    omni_json *files = omni_map(c->pool);
    omni_map_set(files, "station.json", omni_str(c->pool, "spec/expect/meta/version.json"));
    omni_map_set(omni_map_get(e, "out"), "files", files);
  }
  said = check(c, a, e);
  expect(t, "meta: a file this port never wrote is reported", differs(c, said, "files"), said);

  e = omni_clone(c->pool, version);
  omni_map_set(omni_map_get(e, "out"), "exit", omni_num(c->pool, 3));
  omni_map_set(omni_map_get(e, "out"), "stderr", omni_str(c->pool, "no\n"));
  r = resolved(c, a, e, &why);
  one_byte_off(r);
  said = check_resolved(c, r);
  expect(t, "meta: every failure is reported, not just the first", differs(c, said, "exit,stderr,stdout"), said);

  seen_stdout(a, 1, str_of("{\"port\":\"go\",\"meta\":{\"elapsed_ms\":-1}}\n"), faults);
  expect(t, "meta: stdout out of form, in another port's name, is three faults", 3 == faults->listlen,
    omni_jsonstr(c->pool, faults));

  f.a = a;
  f.n = 0;
  sb_init(&f.out, a);
  check_waits(&f, run_entry(a, search), 1);
  expect(t, "meta: a refusal that names no upstream change is not a waiting answer", 0 < f.n, NULL);
}

static void load(corpus *c, arena *a, const char *root) {
  char *err = NULL;
  omni_json *all;
  size_t i;
  memset(c, 0, sizeof *c);
  c->pool = omni_pool_new();
  c->provider.subject = subject;
  c->provider.data = c->pool;
  c->root = root;
  all = omni_loadspec(c->pool, joinpath(a, root, str_of("spec/cli.json")), &err);
  c->groups = omni_map_get(omni_map_get(all, "primary"), "cli");
  if (NULL == all || !omni_ismap(c->groups)) {
    fprintf(stderr, "%s - run `make spec-build` from the repository root first\n",
      NULL == err ? "spec/cli.json has no primary.cli" : err);
    exit(2);
  }
  c->header = omni_map_get(all, "OMNI");
  c->names = omni_group_names(c->pool, c->groups, &c->ngroups);
  for (i = 0; i < c->ngroups; i++) {
    const omni_json *set = omni_map_get(omni_map_get(c->groups, c->names[i]), "set");
    c->total += omni_islist(set) ? set->listlen : 0;
  }
}

int main(int argc, char **argv) {
  arena *a = ar_new();
  corpus c;
  tally t;
  int status;
  memset(&t, 0, sizeof t);
  load(&c, a, repo_root(a, argc, argv));
  tap_begin();
  if (0 == c.total) tap_fail(&t, str_of("the transcript corpus is not empty"), str_of("spec/cli.json has no entries"));
  else tap_ok(&t, str_of("the transcript corpus is not empty"));
  run_corpus(&c, a, &t);
  meta(&c, a, &t);
  status = tap_end(&t);
  omni_pool_free(c.pool);
  ar_free(a);
  spec_unload();
  return status;
}
