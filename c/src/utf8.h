#ifndef LIKENESS_UTF8_H
#define LIKENESS_UTF8_H

#include "base.h"

/* The code point at s[i], returning its length in bytes. A surrogate written
 * as WTF-8 is one code point, as it is in a JavaScript string; an ill-formed
 * byte reads as U+FFFD, one byte long. */
size_t u8_next(const char *s, size_t n, size_t i, unsigned long *cp);

void u8_put(sbuf *b, unsigned long cp);

/* Ill-formed sequences replaced as the WHATWG decoder replaces them, which is
 * how Node reads argv, the environment and a file. */
str u8_sanitize(arena *a, const char *s, size_t n);

/* Each lone surrogate written as U+FFFD, as TextEncoder writes it. */
str u8_wellformed(arena *a, str s);

/* A JavaScript string's length, in UTF-16 code units. */
size_t u8_units(str s);

/* String.prototype.slice, by UTF-16 code units. A cut through an astral
 * character keeps the surrogate on its side, as WTF-8. */
str u8_slice(arena *a, str s, long start, long end);

#endif
