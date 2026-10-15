#include "utf8.h"

static int cont(unsigned char c) {
  return 0x80 == (c & 0xC0);
}

size_t u8_next(const char *s, size_t n, size_t i, unsigned long *cp) {
  const unsigned char *u = (const unsigned char *)s + i;
  size_t left = n - i;
  unsigned char c = u[0];

  if (c < 0x80) {
    *cp = c;
    return 1;
  }
  if (0xC2 <= c && c <= 0xDF && 2 <= left && cont(u[1])) {
    *cp = ((unsigned long)(c & 0x1F) << 6) | (u[1] & 0x3F);
    return 2;
  }
  if (0xE0 <= c && c <= 0xEF && 3 <= left && cont(u[1]) && cont(u[2]) &&
      !(0xE0 == c && u[1] < 0xA0)) {
    *cp = ((unsigned long)(c & 0x0F) << 12) | ((unsigned long)(u[1] & 0x3F) << 6) | (u[2] & 0x3F);
    return 3;
  }
  if (0xF0 <= c && c <= 0xF4 && 4 <= left && cont(u[1]) && cont(u[2]) && cont(u[3]) &&
      !(0xF0 == c && u[1] < 0x90) && !(0xF4 == c && 0x8F < u[1])) {
    *cp = ((unsigned long)(c & 0x07) << 18) | ((unsigned long)(u[1] & 0x3F) << 12) |
          ((unsigned long)(u[2] & 0x3F) << 6) | (u[3] & 0x3F);
    return 4;
  }
  *cp = 0xFFFD;
  return 1;
}

void u8_put(sbuf *b, unsigned long cp) {
  char out[4];
  if (cp < 0x80) {
    out[0] = (char)cp;
    sb_put(b, out, 1);
  }
  else if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    sb_put(b, out, 2);
  }
  else if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    sb_put(b, out, 3);
  }
  else {
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    sb_put(b, out, 4);
  }
}

str u8_sanitize(arena *a, const char *s, size_t n) {
  sbuf b;
  size_t i = 0;
  unsigned long cp = 0;
  int needed = 0;
  int seen = 0;
  unsigned char lower = 0x80;
  unsigned char upper = 0xBF;

  sb_init(&b, a);
  while (i < n) {
    unsigned char c = (unsigned char)s[i];
    if (0 == needed) {
      i++;
      if (c < 0x80) {
        sb_putc(&b, (char)c);
      }
      else if (0xC2 <= c && c <= 0xDF) {
        needed = 1;
        cp = c & 0x1F;
      }
      else if (0xE0 <= c && c <= 0xEF) {
        if (0xE0 == c) lower = 0xA0;
        if (0xED == c) upper = 0x9F;
        needed = 2;
        cp = c & 0x0F;
      }
      else if (0xF0 <= c && c <= 0xF4) {
        if (0xF0 == c) lower = 0x90;
        if (0xF4 == c) upper = 0x8F;
        needed = 3;
        cp = c & 0x07;
      }
      else {
        u8_put(&b, 0xFFFD);
      }
      continue;
    }
    if (c < lower || upper < c) {
      cp = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xBF;
      u8_put(&b, 0xFFFD);
      continue;
    }
    lower = 0x80;
    upper = 0xBF;
    cp = (cp << 6) | (c & 0x3F);
    seen++;
    i++;
    if (seen == needed) {
      u8_put(&b, cp);
      cp = 0;
      needed = 0;
      seen = 0;
    }
  }
  if (0 != needed) u8_put(&b, 0xFFFD);
  return sb_done(&b);
}

str u8_wellformed(arena *a, str s) {
  sbuf b;
  size_t i = 0;
  sb_init(&b, a);
  while (i < s.n) {
    unsigned long cp;
    size_t len = u8_next(s.p, s.n, i, &cp);
    if ((0xD800 <= cp && cp <= 0xDFFF) || (0xFFFD == cp && 1 == len)) u8_put(&b, 0xFFFD);
    else sb_put(&b, s.p + i, len);
    i += len;
  }
  return sb_done(&b);
}

size_t u8_units(str s) {
  size_t i = 0;
  size_t units = 0;
  while (i < s.n) {
    unsigned long cp;
    i += u8_next(s.p, s.n, i, &cp);
    units += 0x10000 <= cp ? 2 : 1;
  }
  return units;
}

static long clamped(long at, long len) {
  if (at < 0) return len + at < 0 ? 0 : len + at;
  return len < at ? len : at;
}

str u8_slice(arena *a, str s, long start, long end) {
  long len = (long)u8_units(s);
  long from = clamped(start, len);
  long to = clamped(end, len);
  long unit = 0;
  size_t i = 0;
  sbuf b;
  sb_init(&b, a);
  while (i < s.n && unit < to) {
    unsigned long cp;
    size_t n = u8_next(s.p, s.n, i, &cp);
    if (0x10000 <= cp) {
      int high = from <= unit;
      int low = unit + 1 < to;
      if (high && low) sb_put(&b, s.p + i, n);
      else if (high) u8_put(&b, 0xD800 + ((cp - 0x10000) >> 10));
      else if (low && from <= unit + 1) u8_put(&b, 0xDC00 + ((cp - 0x10000) & 0x3FF));
      unit += 2;
    }
    else {
      if (from <= unit) sb_put(&b, s.p + i, n);
      unit++;
    }
    i += n;
  }
  return sb_done(&b);
}
