#include "cli.h"

#include <dirent.h>
#include <errno.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "core.h"
#include "envelope.h"
#include "path.h"
#include "spec.h"
#include "utf8.h"

#define CONFIG_REMEDY "fix the file, or point --config at another"

void lk_take_config_option(arena *a, const str *argv, size_t argc, lk_config_option *out) {
  size_t at = 0;
  size_t width = 0;
  size_t count = 0;
  int bad = 0;
  size_t i;
  str value = str_mk("", 0);

  for (i = 1; i < argc; i++) {
    str arg = argv[i];
    if (str_eqz(arg, "--")) break;
    if (str_eqz(arg, "--config")) {
      if (argc <= i + 1 || (str_starts(argv[i + 1], "-") && !str_eqz(argv[i + 1], "-"))) bad = 1;
      else {
        at = i;
        width = 2;
        value = argv[i + 1];
        count++;
      }
      i++;
    }
    else if (str_starts(arg, "--config=")) {
      if (9 == arg.n) bad = 1;
      else {
        at = i;
        width = 1;
        value = str_slice(arg, 9);
        count++;
      }
    }
  }

  out->rest = ar_alloc(a, (argc + 1) * sizeof *out->rest);
  out->n = 0;
  out->found = !bad && 1 == count;
  out->value = out->found ? value : str_mk("", 0);
  for (i = 0; i < argc; i++) {
    if (out->found && at <= i && i < at + width) continue;
    out->rest[out->n++] = argv[i];
  }
}

static int port_of(const char *name, str *port) {
  const char *tail;
  if (0 != strncmp(name, "likeness", 8)) return 0;
  tail = name + 8;
  if ('\0' == *tail) {
    *port = str_mk("", 0);
    return 1;
  }
  if ('-' != *tail || '\0' == tail[1]) return 0;
  for (tail++; '\0' != *tail; tail++) {
    if (*tail < 'a' || 'z' < *tail) return 0;
  }
  *port = str_of(name + 9);
  return 1;
}

static int by_name(const void *x, const void *y) {
  return strcmp(*(const char *const *)x, *(const char *const *)y);
}

static int seen_before(const jval *rows, str full) {
  size_t i;
  for (i = 0; i < rows->len; i++) {
    if (str_eq(jv_getz(rows->item[i], "path")->s, full)) return 1;
  }
  return 0;
}

static void probe_dir(arena *a, str dir, jval *rows) {
  DIR *d = opendir(ar_copy(a, dir.p, dir.n));
  struct dirent *e;
  char **names = NULL;
  size_t n = 0;
  size_t cap = 0;
  size_t i;
  if (NULL == d) return;
  while (NULL != (e = readdir(d))) {
    str port;
    if (!port_of(e->d_name, &port)) continue;
    if (n == cap) {
      size_t grown = 0 == cap ? 8 : cap * 2;
      char **bigger = ar_alloc(a, grown * sizeof *bigger);
      if (0 < n) memcpy(bigger, names, n * sizeof *bigger);
      names = bigger;
      cap = grown;
    }
    names[n++] = ar_copy(a, e->d_name, strlen(e->d_name));
  }
  closedir(d);
  if (1 < n) qsort(names, n, sizeof *names, by_name);
  for (i = 0; i < n; i++) {
    str parts[2];
    str full;
    str port = str_mk("", 0);
    struct stat st;
    jval *row;
    parts[0] = dir;
    parts[1] = str_of(names[i]);
    full = path_join(a, parts, 2);
    if (seen_before(rows, full)) continue;
    if (0 != stat(ar_copy(a, full.p, full.n), &st) || !S_ISREG(st.st_mode)) continue;
    port_of(names[i], &port);
    row = jv_obj(a);
    jv_setz(a, row, "path", jv_str(a, full));
    jv_setz(a, row, "port", jv_str(a, port));
    jv_setz(a, row, "version", jv_strz(a, ""));
    jv_push(a, rows, row);
  }
}

jval *lk_probe_path(arena *a, str path_env) {
  jval *rows = jv_arr(a);
  size_t start = 0;
  size_t i;
  for (i = 0; i <= path_env.n; i++) {
    if (i == path_env.n || ':' == path_env.p[i]) {
      if (start < i) probe_dir(a, str_mk(path_env.p + start, i - start), rows);
      start = i + 1;
    }
  }
  if (0 == rows->len) {
    jval *row = jv_obj(a);
    jv_setz(a, row, "path", jv_strz(a, "(this port, not on PATH)"));
    jv_setz(a, row, "port", jv_strz(a, LK_PORT));
    jv_setz(a, row, "version", jv_strz(a, LK_VERSION));
    jv_push(a, rows, row);
  }
  return rows;
}

static str env_value(arena *a, const char *name, int *set) {
  const char *v = getenv(name);
  *set = NULL != v;
  if (NULL == v) return str_mk("", 0);
  return u8_sanitize(a, v, strlen(v));
}

static str home_dir(arena *a) {
  int set;
  str home = env_value(a, "HOME", &set);
  struct passwd *pw;
  if (set) return home;
  pw = getpwuid(getuid());
  if (NULL == pw || NULL == pw->pw_dir) return str_mk("", 0);
  return u8_sanitize(a, pw->pw_dir, strlen(pw->pw_dir));
}

/* A file that exists and cannot be read counts as absent, as the Go port
 * counts it. */
static int read_text(arena *a, str path, str *out) {
  FILE *f = fopen(ar_copy(a, path.p, path.n), "rb");
  sbuf b;
  char chunk[4096];
  size_t got;
  int failed;
  if (NULL == f) return -1;
  sb_init(&b, a);
  while (0 < (got = fread(chunk, 1, sizeof chunk, f))) sb_put(&b, chunk, got);
  failed = ferror(f);
  fclose(f);
  if (failed) return -1;
  *out = u8_sanitize(a, b.p, b.n);
  return 0;
}

static int exists(arena *a, str path) {
  struct stat st;
  return 0 == stat(ar_copy(a, path.p, path.n), &st);
}

/* Only that each file is a JSON object: station's own validation of
 * station.json waits on its C library reading it. */
static int json_object_fault(arena *a, str path, str *why) {
  str text;
  jval *doc = NULL;
  sbuf m;
  if (!exists(a, path) || 0 != read_text(a, path, &text)) return 0;
  sb_init(&m, a);
  sb_str(&m, path);
  if (NULL != json_parse(a, text.p, text.n, &doc)) sb_puts(&m, " is not valid JSON");
  else if (!jv_is(doc, J_OBJECT)) sb_puts(&m, " is not a JSON object");
  else return 0;
  *why = sb_done(&m);
  return -1;
}

static int config_fault(arena *a, str path, str *why) {
  str parts[2];
  if (!exists(a, path)) return 0;
  if (0 != json_object_fault(a, path, why)) return -1;
  parts[0] = path_dirname(a, path);
  parts[1] = str_of("likeness.json");
  return json_object_fault(a, path_join(a, parts, 2), why);
}

static int write_all(int fd, str s) {
  size_t done = 0;
  while (done < s.n) {
    ssize_t w = write(fd, s.p + done, s.n - done);
    if (w < 0) {
      if (EINTR == errno) continue;
      return -1;
    }
    done += (size_t)w;
  }
  return 0;
}

int lk_main(int argc, char **argv) {
  arena *a = ar_new();
  size_t n = 1 < argc ? (size_t)argc - 1 : 0;
  str *args = ar_alloc(a, (n + 1) * sizeof *args);
  lk_config_option opt;
  str home;
  str path_env;
  str config;
  str why;
  int set;
  int status;
  size_t i;

  signal(SIGPIPE, SIG_IGN);
  for (i = 0; i < n; i++) args[i] = u8_sanitize(a, argv[i + 1], strlen(argv[i + 1]));
  lk_take_config_option(a, args, n, &opt);
  path_env = env_value(a, "PATH", &set);
  home = home_dir(a);
  if (opt.found) config = opt.value;
  else {
    str parts[4];
    parts[0] = home;
    parts[1] = str_of(".config");
    parts[2] = str_of("likeness");
    parts[3] = str_of("station.json");
    config = path_join(a, parts, 4);
  }

  if (0 != config_fault(a, config, &why)) {
    sbuf m;
    sb_init(&m, a);
    sb_puts(&m, "error: invalid-project\n  ");
    sb_str(&m, why);
    sb_puts(&m, "\n  remedy  " CONFIG_REMEDY "\n");
    write_all(2, u8_wellformed(a, sb_done(&m)));
    status = 3;
  }
  else {
    lk_ctx ctx;
    lk_result r;
    ctx.argv = opt.rest;
    ctx.argc = opt.n;
    ctx.path = lk_probe_path(a, path_env);
    r = lk_run(a, &ctx);
    status = r.exit;
    if (0 != write_all(1, u8_wellformed(a, r.out)) && EPIPE == errno) status = 0;
    else write_all(2, u8_wellformed(a, r.err));
  }

  ar_free(a);
  spec_unload();
  return status;
}
