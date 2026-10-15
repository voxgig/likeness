#include "envelope.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "utf8.h"

#define SAFE_INTEGER_MAX 9007199254740991.0

int lk_compare_code_points(str a, str b) {
  size_t i = 0;
  size_t j = 0;
  while (i < a.n && j < b.n) {
    unsigned long x;
    unsigned long y;
    i += u8_next(a.p, a.n, i, &x);
    j += u8_next(b.p, b.n, j, &y);
    if (x != y) return x < y ? -1 : 1;
  }
  if (i < a.n) return 1;
  if (j < b.n) return -1;
  return 0;
}

void lk_escape_string(sbuf *out, str s) {
  static const char hex[] = "0123456789abcdef";
  size_t i;
  sb_putc(out, '"');
  for (i = 0; i < s.n; i++) {
    unsigned char c = (unsigned char)s.p[i];
    if ('"' == c) sb_puts(out, "\\\"");
    else if ('\\' == c) sb_puts(out, "\\\\");
    else if (c < 0x20) {
      char esc[6];
      esc[0] = '\\';
      esc[1] = 'u';
      esc[2] = '0';
      esc[3] = '0';
      esc[4] = hex[c >> 4];
      esc[5] = hex[c & 15];
      sb_put(out, esc, 6);
    }
    else sb_putc(out, (char)c);
  }
  sb_putc(out, '"');
}

/* The shortest digits that read back as v are the first precision at which
 * the correctly rounded form round-trips, which is the choice ECMAScript makes. */
void lk_js_number(sbuf *out, double v) {
  char buf[40];
  char digits[24];
  int k = 0;
  int n;
  int p;
  int i;
  char *e;

  if (isnan(v)) {
    sb_puts(out, "NaN");
    return;
  }
  if (isinf(v)) {
    sb_puts(out, v < 0 ? "-Infinity" : "Infinity");
    return;
  }
  if (0 == v) {
    sb_putc(out, '0');
    return;
  }
  if (v < 0) {
    sb_putc(out, '-');
    v = -v;
  }
  for (p = 1; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*e", p - 1, v);
    if (strtod(buf, NULL) == v) break;
  }
  for (e = buf; 'e' != *e; e++) {
    if ('.' != *e) digits[k++] = *e;
  }
  while (1 < k && '0' == digits[k - 1]) k--;
  digits[k] = '\0';
  n = atoi(e + 1) + 1;

  if (k <= n && n <= 21) {
    sb_put(out, digits, (size_t)k);
    for (i = k; i < n; i++) sb_putc(out, '0');
  }
  else if (0 < n && n <= 21) {
    sb_put(out, digits, (size_t)n);
    sb_putc(out, '.');
    sb_put(out, digits + n, (size_t)(k - n));
  }
  else if (-6 < n && n <= 0) {
    sb_puts(out, "0.");
    for (i = 0; i < -n; i++) sb_putc(out, '0');
    sb_put(out, digits, (size_t)k);
  }
  else {
    sb_putc(out, digits[0]);
    if (1 < k) {
      sb_putc(out, '.');
      sb_put(out, digits + 1, (size_t)(k - 1));
    }
    sb_putc(out, 'e');
    sb_putc(out, n - 1 < 0 ? '-' : '+');
    sb_long(out, n - 1 < 0 ? 1 - n : n - 1);
  }
}

typedef struct jpath {
  const struct jpath *up;
  str key;
  size_t index;
  int is_index;
} jpath;

static void path_text(sbuf *out, const jpath *p) {
  if (NULL == p) return;
  path_text(out, p->up);
  if (p->is_index) {
    sb_putc(out, '[');
    sb_long(out, (long long)p->index);
    sb_putc(out, ']');
  }
  else {
    sb_putc(out, '.');
    sb_str(out, p->key);
  }
}

static int refuse(arena *a, const char *reason, const jpath *p, str *why) {
  sbuf b;
  sb_init(&b, a);
  sb_puts(&b, reason);
  sb_puts(&b, " at ");
  if (NULL == p) sb_putc(&b, '$');
  else path_text(&b, p);
  if (NULL != why) *why = sb_done(&b);
  return -1;
}

typedef struct {
  str key;
  const jval *v;
} member;

static int by_key(const void *x, const void *y) {
  return lk_compare_code_points(((const member *)x)->key, ((const member *)y)->key);
}

static int number(arena *a, sbuf *out, double v, const jpath *p, int loose, str *why) {
  if (!isfinite(v)) return refuse(a, "non-finite number", p, why);
  if (loose) {
    lk_js_number(out, v);
    return 0;
  }
  if (floor(v) != v) return refuse(a, "floating point is not representable in the envelope", p, why);
  if (SAFE_INTEGER_MAX < fabs(v)) {
    return refuse(a, "integer beyond exact double precision - use a bigint", p, why);
  }
  sb_long(out, (long long)v);
  return 0;
}

static int render(arena *a, sbuf *out, const jval *v, const jpath *p, int loose, str *why) {
  size_t i;
  if (NULL == v) return refuse(a, "undefined is not a value - omit the key instead", p, why);
  switch (v->kind) {
    case J_NULL:
      sb_puts(out, "null");
      return 0;
    case J_TRUE:
      sb_puts(out, "true");
      return 0;
    case J_FALSE:
      sb_puts(out, "false");
      return 0;
    case J_NUMBER:
      return number(a, out, v->num, p, loose, why);
    case J_STRING:
      lk_escape_string(out, v->s);
      return 0;
    case J_ARRAY:
      sb_putc(out, '[');
      for (i = 0; i < v->len; i++) {
        jpath at;
        at.up = p;
        at.key = str_mk("", 0);
        at.index = i;
        at.is_index = 1;
        if (0 < i) sb_putc(out, ',');
        if (0 != render(a, out, v->item[i], &at, loose, why)) return -1;
      }
      sb_putc(out, ']');
      return 0;
    case J_OBJECT: {
      member *m = ar_alloc(a, (v->len + 1) * sizeof *m);
      for (i = 0; i < v->len; i++) {
        m[i].key = v->key[i];
        m[i].v = v->item[i];
      }
      qsort(m, v->len, sizeof *m, by_key);
      sb_putc(out, '{');
      for (i = 0; i < v->len; i++) {
        jpath at;
        at.up = p;
        at.key = m[i].key;
        at.index = 0;
        at.is_index = 0;
        if (0 < i) sb_putc(out, ',');
        lk_escape_string(out, m[i].key);
        sb_putc(out, ':');
        if (0 != render(a, out, m[i].v, &at, loose, why)) return -1;
      }
      sb_putc(out, '}');
      return 0;
    }
  }
  return refuse(a, "value of unsupported type", p, why);
}

int lk_render(arena *a, const jval *v, str *out, str *why) {
  sbuf b;
  int rc;
  sb_init(&b, a);
  rc = render(a, &b, v, NULL, 0, why);
  *out = sb_done(&b);
  return rc;
}

int lk_render_raw(arena *a, const jval *v, str *out, str *why) {
  sbuf b;
  int rc;
  sb_init(&b, a);
  rc = render(a, &b, v, NULL, 1, why);
  *out = sb_done(&b);
  return rc;
}

int lk_serialise(arena *a, const jval *v, str *out, str *why) {
  sbuf b;
  int rc;
  sb_init(&b, a);
  rc = render(a, &b, v, NULL, 0, why);
  sb_putc(&b, '\n');
  *out = sb_done(&b);
  return rc;
}

jval *lk_strip_parity_exceptions(arena *a, const jval *v) {
  jval *out;
  size_t i;
  if (!jv_is(v, J_OBJECT)) return (jval *)v;
  out = jv_obj(a);
  for (i = 0; i < v->len; i++) {
    str k = v->key[i];
    const jval *e = v->item[i];
    if (str_eqz(k, "port")) continue;
    if ((str_eqz(k, "meta") || str_eqz(k, "data")) && jv_is(e, J_OBJECT)) {
      const char *drop = str_eqz(k, "meta") ? "elapsed_ms" : "port";
      jval *inner = jv_obj(a);
      size_t j;
      for (j = 0; j < e->len; j++) {
        if (!str_eqz(e->key[j], drop)) jv_set(a, inner, e->key[j], e->item[j]);
      }
      jv_set(a, out, k, inner);
      continue;
    }
    jv_set(a, out, k, (jval *)e);
  }
  return out;
}
