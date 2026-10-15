/* The transcript corpus, spec/cli.json, as far as this port answers it: the
 * entries whose answer needs no source, station or vault. That is help,
 * version, which, a command declared not ready, and every command line the
 * grammar refuses. Every other entry waits upstream; it is reported as
 * skipped, and this port's answer to it must be the honest refusal. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "args.h"
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

static void fail(failures *f, str why) {
  if (0 < f->n) sb_putc(&f->out, '\n');
  sb_str(&f->out, why);
  f->n++;
}

static void failz(failures *f, const char *why) {
  fail(f, str_of(why));
}

static str *strings(arena *a, const jval *v, size_t *n) {
  str *out = ar_alloc(a, ((jv_is(v, J_ARRAY) ? v->len : 0) + 1) * sizeof *out);
  size_t i;
  *n = 0;
  for (i = 0; jv_is(v, J_ARRAY) && i < v->len; i++) {
    out[(*n)++] = jv_is(v->item[i], J_STRING) ? v->item[i]->s : str_mk("", 0);
  }
  return out;
}

static int ends_with(str s, const char *suffix) {
  size_t n = strlen(suffix);
  return n <= s.n && 0 == memcmp(s.p + s.n - n, suffix, n);
}

static int non_negative_integer(const jval *v) {
  return jv_is(v, J_NUMBER) && 0 <= v->num && (double)(long long)v->num == v->num;
}

/* A NULL expected is an expectation that could not be read: a failure, never
 * an empty comparison. */
static void check_stdout(failures *f, str path, const str *expected, str actual) {
  arena *a = f->a;
  jval *parsed = NULL;
  str canonical;
  str got;
  const jval *port;
  const jval *data;
  sbuf m;

  sb_init(&m, a);
  if (NULL == expected) {
    sb_puts(&m, "cannot read expectation ");
    sb_str(&m, path);
    fail(f, sb_done(&m));
    return;
  }
  if (!ends_with(path, ".json")) {
    if (!str_eq(actual, *expected)) {
      sb_puts(&m, "stdout bytes differ from ");
      sb_str(&m, path);
      fail(f, sb_done(&m));
    }
    return;
  }
  if (NULL != json_parse(a, actual.p, actual.n, &parsed)) {
    sb_puts(&m, "stdout is not JSON, and ");
    sb_str(&m, path);
    sb_puts(&m, " says it should be");
    fail(f, sb_done(&m));
    return;
  }
  if (0 != lk_serialise(a, parsed, &canonical, NULL) || !str_eq(canonical, actual)) {
    failz(f, "stdout is not in canonical form (sorted keys, one line, one trailing newline)");
  }
  port = jv_getz(parsed, "port");
  if (!jv_is(port, J_STRING) || !str_eqz(port->s, LK_PORT)) failz(f, "envelope port is not \"" LK_PORT "\"");
  data = jv_getz(parsed, "data");
  if (NULL != jv_getz(data, "port") && !(jv_is(jv_getz(data, "port"), J_STRING) &&
                                         str_eqz(jv_getz(data, "port")->s, LK_PORT))) {
    failz(f, "data.port is not \"" LK_PORT "\"");
  }
  if (!non_negative_integer(jv_getz(jv_getz(parsed, "meta"), "elapsed_ms"))) {
    failz(f, "meta.elapsed_ms is not a non-negative integer");
  }
  if (0 != lk_serialise(a, lk_strip_parity_exceptions(a, parsed), &got, NULL)) {
    failz(f, "stdout cannot be re-rendered");
    return;
  }
  if (!str_eq(got, *expected)) {
    sb_puts(&m, "stdout differs from ");
    sb_str(&m, path);
    sb_puts(&m, "\n  want ");
    sb_str(&m, *expected);
    sb_puts(&m, "  got  ");
    sb_str(&m, got);
    fail(f, sb_done(&m));
  }
}

static lk_result run_entry(arena *a, const jval *e) {
  const jval *ctxv = jv_getz(e, "ctx");
  const jval *path = jv_getz(ctxv, "path");
  lk_ctx ctx;
  size_t n;
  ctx.argv = strings(a, jv_getz(e, "args"), &n);
  ctx.argc = n;
  ctx.path = NULL;
  if (jv_is(path, J_ARRAY)) {
    jval *rows = jv_arr(a);
    size_t i;
    for (i = 0; i < path->len; i++) {
      jval *row = jv_obj(a);
      jv_setz(a, row, "path", jv_str(a, field_str(path->item[i], "path")));
      jv_setz(a, row, "port", jv_str(a, field_str(path->item[i], "port")));
      jv_setz(a, row, "version", jv_str(a, field_str(path->item[i], "version")));
      jv_push(a, rows, row);
    }
    ctx.path = rows;
  }
  return lk_run(a, &ctx);
}

/* Every comparison an entry makes, each reported, none stopping the others. */
static void check(failures *f, const jval *e, lk_result r, const str *expected) {
  const jval *out = jv_getz(e, "out");
  const jval *calls = jv_getz(out, "calls");
  const jval *prompts = jv_getz(out, "prompts");
  const jval *want_exit = jv_getz(out, "exit");
  sbuf m;

  sb_init(&m, f->a);
  if (!jv_is(want_exit, J_NUMBER) || (double)r.exit != want_exit->num) {
    sb_puts(&m, "exit ");
    sb_long(&m, r.exit);
    sb_puts(&m, ", expected ");
    if (jv_is(want_exit, J_NUMBER)) sb_long(&m, (long long)want_exit->num);
    fail(f, sb_done(&m));
  }
  check_stdout(f, field_str(out, "stdout"), expected, r.out);
  if (!str_eq(r.err, field_str(out, "stderr"))) {
    sb_init(&m, f->a);
    sb_puts(&m, "stderr ");
    sb_str(&m, r.err);
    sb_puts(&m, ", expected ");
    sb_str(&m, field_str(out, "stderr"));
    fail(f, sb_done(&m));
  }
  if (jv_is(calls, J_ARRAY) && 0 < calls->len) failz(f, "calls [], expected the calls the entry lists");
  if (jv_is(prompts, J_ARRAY) && 0 < prompts->len) failz(f, "prompts [], expected the prompts the entry lists");
}

static const str *expectation(arena *a, const char *root, const jval *e) {
  str *text = ar_alloc(a, sizeof *text);
  if (0 != read_file(a, joinpath(a, root, field_str(jv_getz(e, "out"), "stdout")), text)) return NULL;
  return text;
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

typedef enum { ANSWERED, WAITS, VAULT } kind;

static kind kind_of(arena *a, const jval *e, int *json) {
  lk_parsed p;
  lk_error err;
  size_t n;
  str *argv = strings(a, jv_getz(e, "args"), &n);
  kind answered = NULL == jv_getz(jv_getz(e, "out"), "vault") ? ANSWERED : VAULT;
  *json = 0;
  if (0 != lk_parse_argv(a, argv, n, &p, &err)) return answered;
  *json = jv_is(jv_getz(p.flags, "json"), J_TRUE);
  if (lk_answers(p.command) || !jv_is(jv_getz(lk_command_def(p.command), "ready"), J_TRUE)) return answered;
  return WAITS;
}

static void name_of(sbuf *name, const jval *e) {
  sb_puts(name, "cli ");
  sb_str(name, field_str(e, "id"));
}

static void run_corpus(arena *a, const char *root, const jval *entries, tally *t) {
  int answered = 0;
  int waits = 0;
  int vault = 0;
  char note[120];
  size_t i;
  for (i = 0; i < entries->len; i++) {
    const jval *e = entries->item[i];
    failures f;
    sbuf name;
    int json;
    kind k = kind_of(a, e, &json);
    f.a = a;
    f.n = 0;
    sb_init(&f.out, a);
    sb_init(&name, a);
    name_of(&name, e);
    if (VAULT == k) {
      tap_skip(t, sb_done(&name), VAULT_WAITS);
      vault++;
      continue;
    }
    if (WAITS == k) {
      check_waits(&f, run_entry(a, e), json);
      if (0 < f.n) tap_fail(t, sb_done(&name), sb_done(&f.out));
      else tap_skip(t, sb_done(&name), "waiting on " LK_WAITING_ON);
      waits++;
      continue;
    }
    check(&f, e, run_entry(a, e), expectation(a, root, e));
    if (0 < f.n) tap_fail(t, sb_done(&name), sb_done(&f.out));
    else tap_ok(t, sb_done(&name));
    answered++;
  }
  snprintf(note, sizeof note, "answered %d, waiting %d, vault-asserting %d", answered, waits, vault);
  tap_note(note);
}

static const jval *find(const jval *entries, const char *id) {
  size_t i;
  for (i = 0; i < entries->len; i++) {
    if (str_eqz(field_str(entries->item[i], "id"), id)) return entries->item[i];
  }
  return NULL;
}

static jval *copy_of(arena *a, const jval *v) {
  jval *out;
  size_t i;
  if (!jv_is(v, J_OBJECT)) return (jval *)v;
  out = jv_obj(a);
  for (i = 0; i < v->len; i++) jv_set(a, out, v->key[i], copy_of(a, v->item[i]));
  return out;
}

static int failures_for(arena *a, const char *root, const jval *e, const str *expected) {
  failures f;
  f.a = a;
  f.n = 0;
  sb_init(&f.out, a);
  check(&f, e, run_entry(a, e), NULL == expected ? expectation(a, root, e) : expected);
  return f.n;
}

static void meta(arena *a, const char *root, const jval *entries, tally *t) {
  const jval *version = find(entries, "meta/version");
  const jval *search = find(entries, "meta/stub-is-honest");
  jval *e;
  const str *real;
  str *mutated;
  failures f;
  lk_result fake;

  if (NULL == version || NULL == search) {
    tap_fail(t, str_of("meta: the entries the meta tests mutate exist"), str_of("an entry is missing"));
    return;
  }
  real = expectation(a, root, version);
  if (NULL == real) {
    tap_fail(t, str_of("meta: the expectation the meta tests mutate exists"), str_of("cannot read it"));
    return;
  }

  #define EXPECT(name, cond) \
    do { if (cond) tap_ok(t, str_of(name)); else tap_fail(t, str_of(name), str_of("the harness stayed green")); } while (0)

  EXPECT("meta: the unmutated entry passes", 0 == failures_for(a, root, version, real));

  e = copy_of(a, version);
  jv_setz(a, jv_getz(e, "out"), "exit", jv_num(a, 3));
  EXPECT("meta: a wrong exit code is reported", 1 == failures_for(a, root, e, real));

  mutated = ar_alloc(a, sizeof *mutated);
  *mutated = str_mk(ar_copy(a, real->p, real->n), real->n);
  ((char *)mutated->p)[mutated->n - 3] = 'x';
  EXPECT("meta: stdout differing by one byte is reported", 1 == failures_for(a, root, version, mutated));

  e = copy_of(a, version);
  jv_setz(a, jv_getz(e, "out"), "stderr", jv_strz(a, "something the command never printed\n"));
  EXPECT("meta: unexpected stderr is reported", 1 == failures_for(a, root, e, real));

  e = copy_of(a, version);
  jv_setz(a, jv_getz(e, "out"), "stdout", jv_strz(a, "spec/expect/.meta-does-not-exist.json"));
  EXPECT("meta: a missing expectation is a failure, not a pass", 1 == failures_for(a, root, e, NULL));

  e = copy_of(a, version);
  {
    jval *call = jv_obj(a);
    jval *calls = jv_arr(a);
    jv_setz(a, call, "instance", jv_strz(a, "joplin"));
    jv_setz(a, call, "method", jv_strz(a, "GET"));
    jv_setz(a, call, "path", jv_strz(a, "/notes"));
    jv_push(a, calls, call);
    jv_setz(a, jv_getz(e, "out"), "calls", calls);
  }
  EXPECT("meta: a call this port never made is reported", 1 == failures_for(a, root, e, real));

  e = copy_of(a, version);
  jv_setz(a, jv_getz(e, "out"), "exit", jv_num(a, 3));
  jv_setz(a, jv_getz(e, "out"), "stderr", jv_strz(a, "no\n"));
  EXPECT("meta: every failure is reported, not just the first", 3 == failures_for(a, root, e, mutated));

  f.a = a;
  f.n = 0;
  sb_init(&f.out, a);
  fake = run_entry(a, search);
  check_waits(&f, fake, 1);
  EXPECT("meta: a refusal that names no upstream change is not a waiting answer", 0 < f.n);
  #undef EXPECT
}

int main(int argc, char **argv) {
  arena *a = ar_new();
  const char *root = repo_root(a, argc, argv);
  jval *entries = corpus_entries(a, root, "cli");
  tally t;
  int status;
  memset(&t, 0, sizeof t);
  tap_begin();
  if (0 == entries->len) tap_fail(&t, str_of("the transcript corpus is not empty"), str_of("spec/cli.json has no entries"));
  else tap_ok(&t, str_of("the transcript corpus is not empty"));
  run_corpus(a, root, entries, &t);
  meta(a, root, entries, &t);
  status = tap_end(&t);
  ar_free(a);
  spec_unload();
  return status;
}
