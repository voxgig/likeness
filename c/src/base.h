#ifndef LIKENESS_BASE_H
#define LIKENESS_BASE_H

#include <stddef.h>

/* Every allocation is its own malloc, so AddressSanitizer and Valgrind see
 * each boundary; the arena only remembers them, to free them together. */
typedef struct arena arena;

arena *ar_new(void);
void ar_free(arena *a);
void *ar_alloc(arena *a, size_t n);
char *ar_copy(arena *a, const char *p, size_t n);

/* Bytes and a length. `p` is NUL-terminated wherever this port made it, but
 * a JSON string may hold a NUL, so the length is the truth. */
typedef struct {
  const char *p;
  size_t n;
} str;

str str_of(const char *z);
str str_mk(const char *p, size_t n);
int str_eq(str a, str b);
int str_eqz(str a, const char *z);
int str_starts(str s, const char *prefix);
str str_slice(str s, size_t from);

typedef struct {
  arena *a;
  char *p;
  size_t n;
  size_t cap;
} sbuf;

void sb_init(sbuf *b, arena *a);
void sb_put(sbuf *b, const char *p, size_t n);
void sb_puts(sbuf *b, const char *z);
void sb_putc(sbuf *b, char c);
void sb_str(sbuf *b, str s);
void sb_long(sbuf *b, long long v);
str sb_done(sbuf *b);

#if defined(__GNUC__)
#define LK_NORETURN __attribute__((noreturn))
#else
#define LK_NORETURN
#endif

void die(const char *why) LK_NORETURN;

#endif
