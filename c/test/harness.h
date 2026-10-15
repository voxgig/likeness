#ifndef LIKENESS_TEST_HARNESS_H
#define LIKENESS_TEST_HARNESS_H

#include "base.h"
#include "json.h"

typedef struct {
  int count;
  int failed;
  int skipped;
} tally;

/* argv[1], or the nearest directory up from here that holds spec/cli.json. */
const char *repo_root(arena *a, int argc, char **argv);

int read_file(arena *a, const char *path, str *out);
str read_file_or_die(arena *a, const char *path);
const char *joinpath(arena *a, const char *dir, str rel);

/* spec/<name>.json's entries, its groups in name order, as both other ports
 * read them. */
jval *corpus_entries(arena *a, const char *root, const char *name);

str field_str(const jval *obj, const char *key);
int str_contains(str hay, str needle);

void tap_begin(void);
void tap_ok(tally *t, str name);
void tap_fail(tally *t, str name, str why);
void tap_skip(tally *t, str name, const char *why);
void tap_note(const char *line);
int tap_end(tally *t);

#endif
