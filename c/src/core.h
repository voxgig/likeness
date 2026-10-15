#ifndef LIKENESS_CORE_H
#define LIKENESS_CORE_H

#include "base.h"
#include "json.h"

#define LK_PORT "c"
#define LK_VERSION "0.1.0"

/* The upstream changes every command that reaches a source or the vault
 * waits on in this port. */
#define LK_WAITING_ON "voxgig/sdkgen#403, voxgig/sdkgen#405 and voxgig/station#23"

typedef struct {
  const str *argv;
  size_t argc;
  /* The likeness binaries on PATH, as `which` reports them. NULL means none
   * was supplied, which is the empty answer. */
  const jval *path;
} lk_ctx;

typedef struct {
  int exit;
  str out;
  str err;
} lk_result;

/* A whole command as a pure function of its inputs: no call is made. */
lk_result lk_run(arena *a, const lk_ctx *ctx);

/* The commands this port answers in full. */
int lk_answers(str command);

#endif
