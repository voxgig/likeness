#ifndef LIKENESS_ARGS_H
#define LIKENESS_ARGS_H

#include "base.h"
#include "errors.h"
#include "json.h"

/* A command line the grammar accepted. */
typedef struct {
  str command;
  jval *flags;
  str *args;
  size_t nargs;
} lk_parsed;

/* The one table-driven parser over the declared command surface (SPEC 13.1):
 * 0, or -1 with an invalid-argument refusal in err. */
int lk_parse_argv(arena *a, const str *argv, size_t argc, lk_parsed *out, lk_error *err);

const jval *lk_command_def(str name);

/* The words naming the command argv starts with, as far as they can be read,
 * joined with a space. */
str lk_command_words(arena *a, const str *argv, size_t argc);

/* NULL when no command has that help. */
const jval *lk_help_text(str name);
const jval *lk_help_rows(void);

#endif
