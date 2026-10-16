#include "harness.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

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
  *out = sb_done(&b);
  return 0;
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
