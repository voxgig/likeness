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

#endif
