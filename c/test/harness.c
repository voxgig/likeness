#include "harness.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "envelope.h"
#include "utf8.h"

int read_file(arena *a, const char *path, str *out) {
  FILE *f = fopen(path, "rb");
  sbuf b;
  char chunk[8192];
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

str read_file_or_die(arena *a, const char *path) {
  str s;
  if (0 != read_file(a, path, &s)) {
    fprintf(stderr, "cannot read %s - run `make spec-build` from the repository root first\n", path);
    exit(2);
  }
  return s;
}

const char *joinpath(arena *a, const char *dir, str rel) {
  sbuf b;
  sb_init(&b, a);
  sb_puts(&b, dir);
  sb_putc(&b, '/');
  sb_str(&b, rel);
  return sb_done(&b).p;
}

const char *repo_root(arena *a, int argc, char **argv) {
  char here[4096];
  int up;
  if (1 < argc) return argv[1];
  if (NULL == getcwd(here, sizeof here)) return ".";
  for (up = 0; up < 8; up++) {
    struct stat st;
    const char *probe = joinpath(a, here, str_of("spec/cli.json"));
    char *slash;
    if (0 == stat(probe, &st)) return ar_copy(a, here, strlen(here));
    slash = strrchr(here, '/');
    if (NULL == slash || slash == here) break;
    *slash = '\0';
  }
  return ".";
}

static int by_key(const void *x, const void *y) {
  return lk_compare_code_points(*(const str *)x, *(const str *)y);
}

jval *corpus_entries(arena *a, const char *root, const char *name) {
  sbuf rel;
  str text;
  jval *doc = NULL;
  const jval *groups;
  const char *err;
  jval *out = jv_arr(a);
  str *names;
  size_t i;

  sb_init(&rel, a);
  sb_puts(&rel, "spec/");
  sb_puts(&rel, name);
  sb_puts(&rel, ".json");
  text = read_file_or_die(a, joinpath(a, root, sb_done(&rel)));
  err = json_parse(a, text.p, text.n, &doc);
  if (NULL != err) {
    fprintf(stderr, "spec/%s.json is not JSON: %s\n", name, err);
    exit(2);
  }
  groups = jv_getz(jv_getz(doc, "primary"), name);
  if (!jv_is(groups, J_OBJECT)) {
    fprintf(stderr, "spec/%s.json has no primary.%s\n", name, name);
    exit(2);
  }
  names = ar_alloc(a, (groups->len + 1) * sizeof *names);
  for (i = 0; i < groups->len; i++) names[i] = groups->key[i];
  qsort(names, groups->len, sizeof *names, by_key);
  for (i = 0; i < groups->len; i++) {
    const jval *set = jv_getz(jv_get(groups, names[i]), "set");
    size_t k;
    for (k = 0; jv_is(set, J_ARRAY) && k < set->len; k++) jv_push(a, out, set->item[k]);
  }
  return out;
}

str field_str(const jval *obj, const char *key) {
  const jval *v = jv_getz(obj, key);
  return jv_is(v, J_STRING) ? v->s : str_mk("", 0);
}

int str_contains(str hay, str needle) {
  size_t i;
  if (0 == needle.n) return 1;
  for (i = 0; i + needle.n <= hay.n; i++) {
    if (0 == memcmp(hay.p + i, needle.p, needle.n)) return 1;
  }
  return 0;
}

void tap_begin(void) {
  printf("TAP version 13\n");
}

static void line(const char *status, int n, str name) {
  printf("%s %d - %.*s", status, n, (int)name.n, name.p);
}

void tap_ok(tally *t, str name) {
  line("ok", ++t->count, name);
  printf("\n");
}

void tap_fail(tally *t, str name, str why) {
  size_t i;
  line("not ok", ++t->count, name);
  printf("\n  ---\n  message: |\n    ");
  for (i = 0; i < why.n; i++) {
    putchar(why.p[i]);
    if ('\n' == why.p[i]) printf("    ");
  }
  printf("\n  ...\n");
  t->failed++;
}

void tap_skip(tally *t, str name, const char *why) {
  line("ok", ++t->count, name);
  printf(" # SKIP %s\n", why);
  t->skipped++;
}

void tap_note(const char *text) {
  printf("# %s\n", text);
}

int tap_end(tally *t) {
  printf("1..%d\n", t->count);
  printf("# pass %d\n# fail %d\n# skip %d\n", t->count - t->failed - t->skipped, t->failed, t->skipped);
  fflush(stdout);
  return 0 == t->failed ? 0 : 1;
}
