#include "args.h"

#include <stdlib.h>
#include <string.h>

#include "envelope.h"
#include "spec.h"

typedef struct {
  arena *a;
  lk_error *err;
} ctx;

static const jval *table_commands(void) {
  return jv_getz(spec_commands(), "command");
}

static const jval *table_globals(void) {
  return jv_getz(spec_commands(), "global");
}

const jval *lk_command_def(str name) {
  return jv_get(table_commands(), name);
}

static str spaced(arena *a, str x, str y) {
  sbuf b;
  sb_init(&b, a);
  sb_str(&b, x);
  sb_putc(&b, ' ');
  sb_str(&b, y);
  return sb_done(&b);
}

static int by_text(const void *x, const void *y) {
  return lk_compare_code_points(*(const str *)x, *(const str *)y);
}

static size_t actions_of(arena *a, str group, str **out) {
  const jval *all = table_commands();
  size_t i;
  size_t n = 0;
  str *list = ar_alloc(a, (NULL == all ? 1 : all->len + 1) * sizeof *list);
  for (i = 0; NULL != all && i < all->len; i++) {
    str k = all->key[i];
    if (group.n < k.n && 0 == memcmp(k.p, group.p, group.n) && ' ' == k.p[group.n]) {
      list[n++] = str_slice(k, group.n + 1);
    }
  }
  if (1 < n) qsort(list, n, sizeof *list, by_text);
  *out = list;
  return n;
}

str lk_command_words(arena *a, const str *argv, size_t argc) {
  if (1 < argc && NULL == lk_command_def(argv[0]) &&
      NULL != lk_command_def(spaced(a, argv[0], argv[1]))) {
    return spaced(a, argv[0], argv[1]);
  }
  return 0 == argc ? str_mk("", 0) : argv[0];
}

const jval *lk_help_text(str name) {
  const jval *t = jv_get(jv_getz(spec_help(), "text"), name);
  return jv_is(t, J_STRING) ? t : NULL;
}

const jval *lk_help_rows(void) {
  return jv_getz(spec_help(), "rows");
}

static int is_lower(char c) {
  return 'a' <= c && c <= 'z';
}

static int is_digit(char c) {
  return '0' <= c && c <= '9';
}

static int name_tail(str s, size_t from, size_t to) {
  size_t i;
  for (i = from; i < to; i++) {
    if (!is_lower(s.p[i]) && !is_digit(s.p[i]) && '-' != s.p[i]) return 0;
  }
  return 1;
}

static int is_name(str s) {
  return 0 < s.n && is_lower(s.p[0]) && name_tail(s, 1, s.n);
}

static int is_integer(str s) {
  size_t i;
  if (0 == s.n) return 0;
  if ('0' == s.p[0]) return 1 == s.n;
  for (i = 0; i < s.n; i++) {
    if (!is_digit(s.p[i])) return 0;
  }
  return 1;
}

static int is_instance(str s) {
  size_t at = 0;
  while (at < s.n && '$' != s.p[at]) at++;
  if (0 == at || !is_lower(s.p[0]) || !name_tail(s, 1, at)) return 0;
  return at == s.n || (at + 1 < s.n && name_tail(s, at + 1, s.n));
}

static int is_secret(str s) {
  size_t i;
  size_t run = 0;
  for (i = 0; i < s.n; i++) {
    char c = s.p[i];
    if ('.' == c) {
      if (0 == run) return 0;
      run = 0;
    }
    else if (is_lower(c) || is_digit(c) || '_' == c) run++;
    else return 0;
  }
  return 0 < run;
}

static int is_envvar(str s) {
  size_t i;
  if (0 == s.n || is_digit(s.p[0])) return 0;
  for (i = 0; i < s.n; i++) {
    char c = s.p[i];
    if (!is_lower(c) && !('A' <= c && c <= 'Z') && !is_digit(c) && '_' != c) return 0;
  }
  return 1;
}

static int bad(ctx *c, str message, str remedy) {
  return lk_fail(c->err, "invalid-argument", message, remedy);
}

static int badz(ctx *c, const char *message, const char *remedy) {
  return bad(c, str_of(message), str_of(remedy));
}

static str type_of(const jval *def) {
  const jval *t = jv_getz(def, "type");
  return jv_is(t, J_STRING) ? t->s : str_mk("", 0);
}

static int is_true(const jval *def, const char *key) {
  return jv_is(jv_getz(def, key), J_TRUE);
}

static void described(sbuf *b, const jval *def) {
  str type = type_of(def);
  const jval *min = jv_getz(def, "min");
  const jval *max = jv_getz(def, "max");
  if (str_eqz(type, "integer")) {
    if (jv_is(min, J_NUMBER) && jv_is(max, J_NUMBER)) {
      sb_puts(b, "an integer from ");
      lk_js_number(b, min->num);
      sb_puts(b, " to ");
      lk_js_number(b, max->num);
    }
    else if (jv_is(min, J_NUMBER)) {
      sb_puts(b, "an integer of at least ");
      lk_js_number(b, min->num);
    }
    else if (jv_is(max, J_NUMBER)) {
      sb_puts(b, "an integer of at most ");
      lk_js_number(b, max->num);
    }
    else sb_puts(b, "an integer");
  }
  else if (str_eqz(type, "name")) sb_puts(b, "a name ([a-z][a-z0-9-]*)");
  else if (str_eqz(type, "instance")) sb_puts(b, "an instance ref (api or api$tag)");
  else if (str_eqz(type, "path")) sb_puts(b, "a path");
  else if (str_eqz(type, "secret")) sb_puts(b, "a secret name ([a-z0-9_] words joined by dots)");
  else if (str_eqz(type, "envvar")) sb_puts(b, "an environment variable name");
  else sb_puts(b, "a string");
}

/* Decided on the digits, so a value too long for the host's number type is
 * refused rather than wrapped. */
static int in_range(arena *a, str raw, const jval *def, double *value) {
  const jval *min = jv_getz(def, "min");
  const jval *max = jv_getz(def, "max");
  char *digits = ar_copy(a, raw.p, raw.n);
  *value = strtod(digits, NULL);
  if (jv_is(max, J_NUMBER)) {
    sbuf limit;
    sb_init(&limit, a);
    lk_js_number(&limit, max->num);
    if (raw.n > limit.n) return 0;
  }
  return (!jv_is(min, J_NUMBER) || min->num <= *value) && (!jv_is(max, J_NUMBER) || *value <= max->num);
}

static int checked(ctx *c, str label, const jval *def, str raw, str remedy, int echo, jval **value) {
  str type = type_of(def);
  double n = 0;
  int ok = 1;
  if (str_eqz(type, "integer")) ok = is_integer(raw) && in_range(c->a, raw, def, &n);
  else if (str_eqz(type, "name")) ok = is_name(raw);
  else if (str_eqz(type, "instance")) ok = is_instance(raw);
  else if (str_eqz(type, "path")) ok = 0 < raw.n;
  else if (str_eqz(type, "secret")) ok = is_secret(raw);
  else if (str_eqz(type, "envvar")) ok = is_envvar(raw);
  if (!ok) {
    sbuf m;
    sb_init(&m, c->a);
    sb_str(&m, label);
    sb_puts(&m, " takes ");
    described(&m, def);
    if (echo && !str_eqz(type, "envvar") && !str_eqz(type, "stdin")) {
      sb_puts(&m, ", not \"");
      sb_str(&m, raw);
      sb_putc(&m, '"');
    }
    return bad(c, sb_done(&m), remedy);
  }
  *value = str_eqz(type, "integer") ? jv_num(c->a, n) : jv_str(c->a, raw);
  return 0;
}

static const jval *lookup(const jval *cmd, str name) {
  const jval *def = jv_get(jv_getz(cmd, "flag"), name);
  return NULL != def ? def : jv_get(table_globals(), name);
}

static int flag_shaped(str a) {
  return 0 < a.n && '-' == a.p[0] && !str_eqz(a, "-");
}

static str cat3(arena *a, const char *x, str y, const char *z) {
  sbuf b;
  sb_init(&b, a);
  sb_puts(&b, x);
  sb_str(&b, y);
  sb_puts(&b, z);
  return sb_done(&b);
}

static int needs_action(ctx *c, str name, const str *actions, size_t n) {
  sbuf m;
  size_t i;
  sb_init(&m, c->a);
  sb_putc(&m, '`');
  sb_str(&m, name);
  sb_puts(&m, "` needs an action: ");
  for (i = 0; i + 1 < n; i++) {
    if (0 < i) sb_puts(&m, ", ");
    sb_str(&m, actions[i]);
  }
  sb_puts(&m, " or ");
  sb_str(&m, actions[n - 1]);
  return bad(c, sb_done(&m), cat3(c->a, "run `likeness help ", name, "` for what each does"));
}

static int flag_value(ctx *c, const jval *def, str key, str given, int has_eq, str a, const str *rest,
                      size_t nrest, size_t *i, str remedy, int echo, int negated, jval **value) {
  str raw = str_mk("", 0);
  int have = 0;
  if (str_eqz(type_of(def), "boolean")) {
    if (has_eq) {
      sbuf m;
      sbuf r;
      sb_init(&m, c->a);
      sb_puts(&m, "--");
      sb_str(&m, given);
      sb_puts(&m, " takes no value");
      sb_init(&r, c->a);
      sb_puts(&r, "write --");
      sb_str(&r, key);
      sb_puts(&r, ", or --no-");
      sb_str(&r, key);
      return bad(c, sb_done(&m), sb_done(&r));
    }
    *value = jv_bool(c->a, !negated);
    return 0;
  }
  if (has_eq) {
    const char *eq = memchr(a.p, '=', a.n);
    raw = str_mk(eq + 1, a.n - (size_t)(eq + 1 - a.p));
    have = 1;
  }
  else if (*i + 1 < nrest && !flag_shaped(rest[*i + 1])) {
    *i += 1;
    raw = rest[*i];
    have = 1;
  }
  if (!have) {
    const jval *v = jv_getz(def, "value");
    str placeholder = jv_is(v, J_STRING) ? v->s : str_of("undefined");
    sbuf m;
    sbuf r;
    sb_init(&m, c->a);
    sb_puts(&m, "--");
    sb_str(&m, key);
    sb_puts(&m, " needs a value");
    sb_init(&r, c->a);
    sb_puts(&r, "write --");
    sb_str(&r, key);
    sb_putc(&r, ' ');
    sb_str(&r, placeholder);
    sb_puts(&r, ", or --");
    sb_str(&r, key);
    sb_putc(&r, '=');
    sb_str(&r, placeholder);
    sb_puts(&r, " for a value that begins with -");
    return bad(c, sb_done(&m), sb_done(&r));
  }
  return checked(c, cat3(c->a, "--", key, ""), def, raw, remedy, echo, value);
}

int lk_parse_argv(arena *a, const str *argv, size_t argc, lk_parsed *out, lk_error *err) {
  ctx c;
  str name;
  size_t at = 1;
  const jval *cmd;
  int echo;
  int ready;
  str remedy;
  jval *flags;
  str *positional;
  size_t npos = 0;
  const str *rest;
  size_t nrest;
  size_t i;
  str *args;
  size_t nargs = 0;
  size_t p = 0;
  const jval *argdefs;

  c.a = a;
  c.err = err;

  if (0 == argc) {
    return badz(&c, "no command given", "try `likeness list`, or `likeness help` for the command list");
  }
  name = argv[0];
  if (str_eqz(name, "--help") || str_eqz(name, "-h")) name = str_of("help");
  else if (str_eqz(name, "--version")) name = str_of("version");
  else if (flag_shaped(name)) {
    return bad(&c, cat3(a, "the command comes first, and ", name, " is a flag"),
      cat3(a, "put the command first: `likeness list ", name, "`"));
  }

  if (NULL == lk_command_def(name)) {
    str *actions;
    size_t n = actions_of(a, name, &actions);
    if (0 < n) {
      if (argc < 2 || str_starts(argv[1], "-")) return needs_action(&c, name, actions, n);
      if (NULL == lk_command_def(spaced(a, name, argv[1]))) {
        return bad(&c, cat3(a, "no such command: ", spaced(a, name, argv[1]), ""),
          cat3(a, "run `likeness help ", name, "` for its actions"));
      }
      name = spaced(a, name, argv[1]);
      at = 2;
    }
  }
  cmd = lk_command_def(name);
  if (NULL == cmd) {
    return bad(&c, cat3(a, "no such command: ", name, ""), str_of("run `likeness help` for the command list"));
  }

  echo = !jv_is(jv_getz(cmd, "echo"), J_FALSE);
  ready = is_true(cmd, "ready");
  remedy = cat3(a, "run `likeness help ", name, "` for its arguments");
  flags = jv_obj(a);
  rest = argv + at;
  nrest = argc - at;
  positional = ar_alloc(a, (nrest + 1) * sizeof *positional);

  for (i = 0; i < nrest; i++) {
    str arg = rest[i];
    const char *eq;
    str given;
    str key;
    const jval *def;
    int negated = 0;
    jval *value = NULL;

    if (str_eqz(arg, "--")) {
      for (i = i + 1; i < nrest; i++) positional[npos++] = rest[i];
      break;
    }
    if (!str_starts(arg, "--")) {
      if (flag_shaped(arg) && ready) {
        if (!echo) {
          return badz(&c,
            "an argument begins with - and is not a flag; it is not repeated here, in case it is a secret",
            "a positional that begins with - must follow --");
        }
        {
          sbuf r;
          sb_init(&r, a);
          sb_puts(&r, "write `likeness ");
          sb_str(&r, name);
          sb_puts(&r, " -- ");
          sb_str(&r, arg);
          sb_putc(&r, '`');
          return bad(&c,
            cat3(a, "", arg, " begins with - and is not a flag; a positional that begins with - must follow --"),
            sb_done(&r));
        }
      }
      if (!flag_shaped(arg)) positional[npos++] = arg;
      continue;
    }

    eq = memchr(arg.p, '=', arg.n);
    given = NULL == eq ? str_slice(arg, 2) : str_mk(arg.p + 2, (size_t)(eq - arg.p) - 2);
    key = given;
    def = lookup(cmd, given);
    if (NULL == def && str_starts(given, "no-")) {
      const jval *base = lookup(cmd, str_slice(given, 3));
      if (NULL != base && str_eqz(type_of(base), "boolean")) {
        def = base;
        key = str_slice(given, 3);
        negated = 1;
      }
    }
    if (NULL == def) {
      if (!ready) continue;
      if (echo) {
        sbuf m;
        sb_init(&m, a);
        sb_putc(&m, '`');
        sb_str(&m, name);
        sb_puts(&m, "` has no flag --");
        sb_str(&m, given);
        return bad(&c, sb_done(&m), remedy);
      }
      return bad(&c, cat3(a, "`", name, "` has no such flag; it is not repeated here, in case it is a secret"),
        remedy);
    }

    if (0 != flag_value(&c, def, key, given, NULL != eq, arg, rest, nrest, &i, remedy, echo, negated,
                        &value)) {
      return -1;
    }

    if (is_true(def, "repeat")) {
      jval *list = jv_get(flags, key);
      if (NULL == list) {
        list = jv_arr(a);
        jv_set(a, flags, key, list);
      }
      jv_push(a, list, value);
    }
    else {
      if (NULL != jv_get(flags, key)) {
        return bad(&c, cat3(a, "--", key, " was given twice"), str_of("give it once"));
      }
      jv_set(a, flags, key, value);
    }
  }

  out->command = name;
  out->flags = flags;
  out->args = ar_alloc(a, (npos + 1) * sizeof *out->args);
  out->nargs = 0;
  if (!ready) return 0;

  args = out->args;
  argdefs = jv_getz(cmd, "arg");
  for (i = 0; NULL != argdefs && i < argdefs->len; i++) {
    const jval *def = argdefs->item[i];
    const jval *dname = jv_getz(def, "name");
    str label = jv_is(dname, J_STRING) ? dname->s : str_mk("", 0);
    size_t take = is_true(def, "repeat") ? npos - p : (p < npos ? 1 : 0);
    size_t k;
    if (is_true(def, "required") && 0 == take) {
      sbuf m;
      sb_init(&m, a);
      sb_putc(&m, '`');
      sb_str(&m, name);
      sb_puts(&m, "` needs <");
      sb_str(&m, label);
      sb_putc(&m, '>');
      return bad(&c, sb_done(&m), remedy);
    }
    for (k = p; k < p + take; k++) {
      jval *value;
      if (str_eqz(type_of(def), "stdin") && !str_eqz(positional[k], "-")) {
        return bad(&c, cat3(a, "`", name, "` takes - there, never the value itself"),
          str_of("pipe the value in, with - after the name"));
      }
      if (0 != checked(&c, cat3(a, "<", label, ">"), def, positional[k], remedy, echo, &value)) return -1;
      args[nargs++] = positional[k];
    }
    p += take;
  }
  if (p < npos) {
    if (echo) {
      sbuf m;
      sb_init(&m, a);
      sb_putc(&m, '`');
      sb_str(&m, name);
      sb_puts(&m, "` does not take the argument \"");
      sb_str(&m, positional[p]);
      sb_putc(&m, '"');
      return bad(&c, sb_done(&m), remedy);
    }
    return bad(&c, cat3(a, "`", name, "` takes no further argument; it is not repeated here, in case it is a secret"),
      remedy);
  }
  out->nargs = nargs;
  return 0;
}
