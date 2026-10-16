#ifndef LIKENESS_TEST_BRIDGE_H
#define LIKENESS_TEST_BRIDGE_H

#include "omni.h"

#include "base.h"
#include "harness.h"
#include "json.h"

/* omni's value as a jval in `a`, every string copied, so that the arena and
 * the pool can be freed in either order. An absent value is NULL. */
jval *jv_from_omni(arena *a, const omni_json *v);

/* Bytes as a pool string. omni's strings end at their first NUL. */
char *omni_text(omni_pool *pool, str s);

const char *omni_strz(const omni_json *v);

/* A spec's group names in code point order. */
const char **omni_group_names(omni_pool *pool, const omni_json *groups, size_t *n);

/* One group through omni: 0, or 1 with omni's message in *message. `header`
 * is the spec's OMNI block; `waits` maps entry ids to {cause}, or is NULL. */
int omni_run_group(omni_pool *pool, omni_provider *provider, const omni_json *header, const char *section,
                   const char *name, omni_json *set, int all, omni_json *waits, char **message);

void tap_omni(tally *t, str name, int failed, const char *message);

/* Does the first line of omni's message carry `reason`? */
int omni_says(const char *message, const char *reason);

/* The top-level fields omni's one `result mismatch` shows differing, in name
 * order and comma-joined; NULL for any other message. */
const char *omni_differs(omni_pool *pool, const char *message);

#endif
