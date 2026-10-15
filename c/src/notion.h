#ifndef LIKENESS_NOTION_H
#define LIKENESS_NOTION_H

#include "base.h"
#include "errors.h"
#include "json.h"

/* The Notion adapter's pure half. Reaching the API waits on the C SDK's
 * transport. */

/* The API version every request carries, pinned in the connection's block in
 * station.json as its one header. */
int lk_notion_configure(arena *a, str instance, const jval *block, str *version, lk_error *err);

/* A page's title: its property of type `title`, the first by name in
 * code-point order, rich text whose parts' plain text is joined. */
int lk_notion_title(arena *a, const jval *properties, str *out, lk_error *err);

/* A page's space: its parent database, or its parent page. Empty when the
 * parent is a workspace, a block or nothing. */
int lk_notion_space(arena *a, const jval *parent, str *out, lk_error *err);

/* A page's time in RFC 3339 UTC. Text that is not an RFC 3339 date-time, or
 * a value that is not text, is the epoch. */
int lk_notion_stamp(arena *a, const jval *v, const char *field, str *out, lk_error *err);

int lk_project_notion(arena *a, const jval *raw, str instance, str account, int with_raw, jval **out,
                      lk_error *err);

#endif
