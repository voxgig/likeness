#ifndef LIKENESS_SOURCES_H
#define LIKENESS_SOURCES_H

#include "base.h"
#include "errors.h"

/* Station's name for an instance's secret when its block names none. */
str lk_secret_name(arena *a, str ref);

/* The ref `sources add` writes from --source and --instance; a NULL instance is
 * the flag left unset. */
int lk_ref_for(arena *a, str source, const str *instance, str *out, lk_error *err);

#endif
