#ifndef LIKENESS_OBSIDIAN_H
#define LIKENESS_OBSIDIAN_H

#include "base.h"
#include "errors.h"
#include "json.h"

/* The Obsidian adapter's pure half. Reaching the plugin waits on the C SDK's
 * transport. */

/* Obsidian's own URI: the vault by its id, which is the connection's account. */
str lk_obsidian_url(arena *a, str vault, str path);

/* A listing's entries, as the plugin lists one directory: by first segment, a
 * directory with its slash, each once, in code-point order. `listed` is an
 * array of names, or of records naming theirs as `id`. */
int lk_obsidian_entries(arena *a, const jval *listed, str **out, size_t *n, lk_error *err);

typedef struct {
  int list;
  str path;
} lk_obsidian_step;

typedef struct lk_obsidian_frame lk_obsidian_frame;

typedef struct {
  arena *a;
  lk_obsidian_frame *frames;
  size_t depth;
  size_t cap;
  int listing;
} lk_obsidian_walk;

/* The walk: one directory at a time, depth first, each directory's entries in
 * the order given, each note read as it is met. The first step lists the
 * vault's root. A list step is answered with that directory's entries, a read
 * step with none; next is 0 once the walk is over. */
lk_obsidian_step lk_obsidian_walk_start(arena *a, lk_obsidian_walk *w);
int lk_obsidian_walk_next(lk_obsidian_walk *w, const str *entries, size_t n, lk_obsidian_step *step);

/* How a connection reaches the plugin, from its block in station.json:
 * HTTPS with a pinned certificate, or plain HTTP where the block says so. */
typedef struct {
  int pinned;
  str pin;
} lk_obsidian_tls;

int lk_obsidian_transport(arena *a, str instance, const jval *block, lk_obsidian_tls *out, lk_error *err);

/* A note, by its path from the vault root, projected onto the common shape. */
int lk_project_obsidian(arena *a, const jval *raw, str path, str instance, str account, int with_raw,
                        jval **out, lk_error *err);

#endif
