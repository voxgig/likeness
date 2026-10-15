#ifndef LIKENESS_SPEC_H
#define LIKENESS_SPEC_H

#include "base.h"
#include "json.h"

/* The tables an installed binary reads, parsed once from the copies compiled
 * into it: no specification file is read from disk. */
const jval *spec_caps(void);
const jval *spec_commands(void);
const jval *spec_errors(void);
const jval *spec_help(void);

/* An embedded file's bytes, as the lines were joined. */
str spec_text(arena *a, const char *const *lines);

void spec_unload(void);

#endif
