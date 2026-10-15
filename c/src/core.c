#include "core.h"

#include <string.h>
#include <time.h>

#include "args.h"
#include "envelope.h"
#include "errors.h"
#include "spec.h"

typedef struct {
  jval *env;
  str text;
  int has_text;
} answer;

static long long now_ms(void) {
  struct timespec ts;
  if (0 != clock_gettime(CLOCK_MONOTONIC, &ts)) return 0;
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* String.prototype.split(' '): every space divides, so "" is [""]. */
static jval *words(arena *a, str name) {
  jval *out = jv_arr(a);
  size_t start = 0;
  size_t i;
  for (i = 0; i <= name.n; i++) {
    if (i == name.n || ' ' == name.p[i]) {
      jv_push(a, out, jv_str(a, str_mk(name.p + start, i - start)));
      start = i + 1;
    }
  }
  return out;
}

static jval *envelope(arena *a, str name, str code, jval *data, size_t count, const lk_error *error) {
  jval *env = jv_obj(a);
  jval *meta = jv_obj(a);
  jv_setz(a, meta, "count", jv_num(a, (double)count));
  jv_setz(a, meta, "truncated", jv_bool(a, 0));
  jv_setz(a, meta, "sources", jv_arr(a));
  jv_setz(a, meta, "incomplete", jv_arr(a));
  jv_setz(a, meta, "calls", jv_num(a, 0));
  jv_setz(a, meta, "elapsed_ms", jv_num(a, 0));
  jv_setz(a, env, "ok", jv_bool(a, NULL == error));
  jv_setz(a, env, "code", jv_str(a, code));
  jv_setz(a, env, "cmd", words(a, name));
  jv_setz(a, env, "data", data);
  jv_setz(a, env, "meta", meta);
  jv_setz(a, env, "port", jv_strz(a, LK_PORT));
  jv_setz(a, env, "version", jv_strz(a, LK_VERSION));
  if (NULL != error) {
    jval *e = jv_obj(a);
    jv_setz(a, e, "message", jv_str(a, error->message));
    jv_setz(a, e, "remedy", jv_str(a, error->remedy));
    jv_setz(a, env, "error", e);
  }
  return env;
}

static jval *refusal(arena *a, str name, const lk_error *err) {
  return envelope(a, name, str_of(err->code), jv_null(a), 0, err);
}

static str rendered(arena *a, const jval *v) {
  str out;
  if (0 != lk_render(a, v, &out, NULL)) die("a value this port built has no envelope form");
  return out;
}

static str human(arena *a, const jval *env) {
  const jval *d = jv_getz(env, "data");
  sbuf b;
  size_t i;
  sb_init(&b, a);
  if (jv_is(d, J_NULL)) return sb_done(&b);
  if (jv_is(d, J_ARRAY)) {
    for (i = 0; i < d->len; i++) {
      sb_str(&b, rendered(a, d->item[i]));
      sb_putc(&b, '\n');
    }
    return sb_done(&b);
  }
  sb_str(&b, rendered(a, d));
  sb_putc(&b, '\n');
  return sb_done(&b);
}

static str narrate(arena *a, const jval *env) {
  const jval *error = jv_getz(env, "error");
  sbuf b;
  sb_init(&b, a);
  if (NULL != error) {
    sb_puts(&b, "error: ");
    sb_str(&b, jv_getz(env, "code")->s);
    sb_puts(&b, "\n  ");
    sb_str(&b, jv_getz(error, "message")->s);
    sb_puts(&b, "\n  remedy  ");
    sb_str(&b, jv_getz(error, "remedy")->s);
    sb_putc(&b, '\n');
  }
  return sb_done(&b);
}

static lk_result finish(arena *a, const answer *ans, int json, int deterministic, long long started) {
  lk_result r;
  jval *meta = jv_getz(ans->env, "meta");
  long long elapsed = deterministic ? 0 : now_ms() - started;
  jv_setz(a, meta, "elapsed_ms", jv_num(a, (double)(elapsed < 0 ? 0 : elapsed)));
  r.exit = lk_exit_for(jv_getz(ans->env, "code")->s);
  if (json) {
    if (0 != lk_serialise(a, ans->env, &r.out, NULL)) die("an envelope this port built has no envelope form");
    r.err = str_mk("", 0);
  }
  else {
    r.out = ans->has_text ? ans->text : human(a, ans->env);
    r.err = narrate(a, ans->env);
  }
  return r;
}

static int given(const lk_ctx *ctx, const char *flag) {
  size_t i;
  for (i = 0; i < ctx->argc; i++) {
    if (str_eqz(ctx->argv[i], flag)) return 1;
  }
  return 0;
}

static str joined(arena *a, const str *list, size_t n) {
  sbuf b;
  size_t i;
  sb_init(&b, a);
  for (i = 0; i < n; i++) {
    if (0 < i) sb_putc(&b, ' ');
    sb_str(&b, list[i]);
  }
  return sb_done(&b);
}

static int help(arena *a, const lk_parsed *parsed, answer *ans, lk_error *err) {
  str name = joined(a, parsed->args, parsed->nargs);
  const jval *text = lk_help_text(name);
  const jval *all = lk_help_rows();
  jval *rows = jv_arr(a);
  size_t i;
  if (NULL == text) {
    sbuf m;
    sb_init(&m, a);
    sb_puts(&m, "no such command: ");
    sb_str(&m, name);
    return lk_fail(err, "invalid-argument", sb_done(&m), str_of("run `likeness help` for the command list"));
  }
  for (i = 0; NULL != all && i < all->len; i++) {
    const jval *command = jv_getz(all->item[i], "command");
    str c = jv_is(command, J_STRING) ? command->s : str_mk("", 0);
    if (0 == name.n || str_eq(c, name) ||
        (name.n < c.n && 0 == memcmp(c.p, name.p, name.n) && ' ' == c.p[name.n])) {
      jv_push(a, rows, all->item[i]);
    }
  }
  ans->env = envelope(a, str_of("help"), str_of("ok"), rows, rows->len, NULL);
  ans->text = text->s;
  ans->has_text = 1;
  return 0;
}

static void version(arena *a, answer *ans) {
  jval *data = jv_obj(a);
  jv_setz(a, data, "port", jv_strz(a, LK_PORT));
  jv_setz(a, data, "version", jv_strz(a, LK_VERSION));
  ans->env = envelope(a, str_of("version"), str_of("ok"), data, 1, NULL);
}

static void which(arena *a, const lk_ctx *ctx, answer *ans) {
  jval *rows = NULL == ctx->path ? jv_arr(a) : (jval *)ctx->path;
  ans->env = envelope(a, str_of("which"), str_of(0 == rows->len ? "no-match" : "ok"), rows, rows->len, NULL);
}

int lk_answers(str command) {
  return str_eqz(command, "help") || str_eqz(command, "version") || str_eqz(command, "which");
}

static int waits(arena *a, str name, lk_error *err) {
  sbuf m;
  sb_init(&m, a);
  sb_putc(&m, '`');
  sb_str(&m, name);
  sb_puts(&m, "` waits, in the C port, on " LK_WAITING_ON
    ": the C SDK has no live transport, two C SDKs cannot link into one program,"
    " and station's C library does not read the vault");
  return lk_fail(err, "unsupported-capability", sb_done(&m),
    str_of("run it with another port, such as likeness-ts or likeness-go"));
}

lk_result lk_run(arena *a, const lk_ctx *ctx) {
  long long started = now_ms();
  lk_parsed parsed;
  lk_error err;
  answer ans;
  const jval *def;
  int json;
  int deterministic;

  memset(&ans, 0, sizeof ans);
  if (0 != lk_parse_argv(a, ctx->argv, ctx->argc, &parsed, &err)) {
    ans.env = refusal(a, lk_command_words(a, ctx->argv, ctx->argc), &err);
    return finish(a, &ans, given(ctx, "--json"), given(ctx, "--deterministic"), started);
  }

  json = jv_is(jv_getz(parsed.flags, "json"), J_TRUE);
  deterministic = jv_is(jv_getz(parsed.flags, "deterministic"), J_TRUE);
  def = lk_command_def(parsed.command);

  if (!jv_is(jv_getz(def, "ready"), J_TRUE)) {
    const jval *shortdesc = jv_getz(def, "short");
    sbuf m;
    sb_init(&m, a);
    sb_putc(&m, '`');
    sb_str(&m, parsed.command);
    sb_puts(&m, "` is not implemented yet - ");
    if (jv_is(shortdesc, J_STRING)) sb_str(&m, shortdesc->s);
    lk_fail(&err, "unsupported-capability", sb_done(&m),
      str_of("it arrives in a later stage; run `likeness help` for what works now"));
    ans.env = refusal(a, parsed.command, &err);
  }
  else if (str_eqz(parsed.command, "help")) {
    if (0 != help(a, &parsed, &ans, &err)) ans.env = refusal(a, parsed.command, &err);
  }
  else if (str_eqz(parsed.command, "version")) version(a, &ans);
  else if (str_eqz(parsed.command, "which")) which(a, ctx, &ans);
  else {
    waits(a, parsed.command, &err);
    ans.env = refusal(a, parsed.command, &err);
  }
  return finish(a, &ans, json, deterministic, started);
}
