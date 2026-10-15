#ifndef LIKENESS_ERRORS_H
#define LIKENESS_ERRORS_H

#include "base.h"
#include "json.h"

/* A refusal with the registered code an envelope reports it under. */
typedef struct {
  const char *code;
  str message;
  str remedy;
} lk_error;

int lk_fail(lk_error *e, const char *code, str message, str remedy);
int lk_failz(lk_error *e, const char *code, const char *message, const char *remedy);

int lk_exit_for(str code);

/* The closed set of codes that may carry data on failure, sorted. */
jval *lk_partial_codes(arena *a);

#endif
