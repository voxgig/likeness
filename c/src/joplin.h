#ifndef LIKENESS_JOPLIN_H
#define LIKENESS_JOPLIN_H

#include "base.h"
#include "errors.h"
#include "json.h"

/* A Joplin record projected onto the common note shape. Pure: reaching the
 * record waits on the C SDK's transport. */
int lk_project_joplin(arena *a, const jval *raw, str instance, str account, int with_raw, jval **out,
                      lk_error *err);

#endif
