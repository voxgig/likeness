#ifndef LIKENESS_PATH_H
#define LIKENESS_PATH_H

#include "base.h"

/* Node's path.posix, byte for byte: the canonical port names files with it,
 * and a path is part of what an envelope says. */
str path_normalize(arena *a, str p);
str path_join(arena *a, const str *parts, size_t n);
str path_resolve(arena *a, const str *parts, size_t n);
str path_dirname(arena *a, str p);
int path_is_absolute(str p);

#endif
