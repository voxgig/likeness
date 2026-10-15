#ifndef LIKENESS_CLI_H
#define LIKENESS_CLI_H

#include "base.h"
#include "json.h"

typedef struct {
  str *rest;
  size_t n;
  int found;
  str value;
} lk_config_option;

/* `--config PATH` or `--config=PATH`, taken out before the command runs. Only
 * a single well-formed one after the command and before `--` is taken;
 * anything else is left in place for the grammar to refuse. */
void lk_take_config_option(arena *a, const str *argv, size_t argc, lk_config_option *out);

/* Every likeness binary on PATH. The port is read from the file name, never
 * by running it. */
jval *lk_probe_path(arena *a, str path_env);

/* The whole process: argv in, bytes out, the exit status returned. */
int lk_main(int argc, char **argv);

#endif
