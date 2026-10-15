#include "base.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct arena {
  void **ptr;
  size_t n;
  size_t cap;
};

void die(const char *why) {
  fprintf(stderr, "likeness-c: %s\n", why);
  abort();
}

arena *ar_new(void) {
  arena *a = calloc(1, sizeof *a);
  if (NULL == a) die("out of memory");
  return a;
}

void ar_free(arena *a) {
  size_t i;
  if (NULL == a) return;
  for (i = 0; i < a->n; i++) free(a->ptr[i]);
  free(a->ptr);
  free(a);
}

void *ar_alloc(arena *a, size_t n) {
  void *p;
  if (a->n == a->cap) {
    size_t cap = 0 == a->cap ? 64 : a->cap * 2;
    void **grown = realloc(a->ptr, cap * sizeof *grown);
    if (NULL == grown) die("out of memory");
    a->ptr = grown;
    a->cap = cap;
  }
  p = calloc(1, 0 == n ? 1 : n);
  if (NULL == p) die("out of memory");
  a->ptr[a->n++] = p;
  return p;
}

char *ar_copy(arena *a, const char *p, size_t n) {
  char *out = ar_alloc(a, n + 1);
  if (0 < n) memcpy(out, p, n);
  out[n] = '\0';
  return out;
}

str str_of(const char *z) {
  str s;
  s.p = z;
  s.n = strlen(z);
  return s;
}

str str_mk(const char *p, size_t n) {
  str s;
  s.p = p;
  s.n = n;
  return s;
}

int str_eq(str a, str b) {
  return a.n == b.n && (0 == a.n || 0 == memcmp(a.p, b.p, a.n));
}

int str_eqz(str a, const char *z) {
  return str_eq(a, str_of(z));
}

int str_starts(str s, const char *prefix) {
  size_t n = strlen(prefix);
  return n <= s.n && 0 == memcmp(s.p, prefix, n);
}

str str_slice(str s, size_t from) {
  if (from > s.n) from = s.n;
  return str_mk(s.p + from, s.n - from);
}

void sb_init(sbuf *b, arena *a) {
  b->a = a;
  b->cap = 32;
  b->p = ar_alloc(a, b->cap);
  b->n = 0;
}

static void reserve(sbuf *b, size_t more) {
  char *grown;
  size_t cap = b->cap;
  if (b->n + more + 1 <= cap) return;
  while (b->n + more + 1 > cap) cap *= 2;
  grown = ar_alloc(b->a, cap);
  memcpy(grown, b->p, b->n);
  b->p = grown;
  b->cap = cap;
}

void sb_put(sbuf *b, const char *p, size_t n) {
  if (0 == n) return;
  reserve(b, n);
  memcpy(b->p + b->n, p, n);
  b->n += n;
  b->p[b->n] = '\0';
}

void sb_puts(sbuf *b, const char *z) {
  sb_put(b, z, strlen(z));
}

void sb_putc(sbuf *b, char c) {
  sb_put(b, &c, 1);
}

void sb_str(sbuf *b, str s) {
  sb_put(b, s.p, s.n);
}

void sb_long(sbuf *b, long long v) {
  char tmp[32];
  int n = snprintf(tmp, sizeof tmp, "%lld", v);
  sb_put(b, tmp, (size_t)n);
}

str sb_done(sbuf *b) {
  b->p[b->n] = '\0';
  return str_mk(b->p, b->n);
}
