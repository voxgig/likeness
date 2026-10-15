#include "json.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "utf8.h"

typedef struct {
  jval *box;
  str key;
} frame;

typedef struct {
  arena *a;
  const char *s;
  size_t n;
  size_t i;
} reader;

static const char *fault(reader *r, const char *what) {
  char tmp[96];
  snprintf(tmp, sizeof tmp, "%s at byte %lu", what, (unsigned long)r->i);
  return ar_copy(r->a, tmp, strlen(tmp));
}

static void skip_ws(reader *r) {
  while (r->i < r->n) {
    char c = r->s[r->i];
    if (' ' != c && '\t' != c && '\n' != c && '\r' != c) break;
    r->i++;
  }
}

static int hex4(reader *r, unsigned long *out) {
  unsigned long v = 0;
  size_t k;
  if (r->n < r->i + 4) return 0;
  for (k = 0; k < 4; k++) {
    char c = r->s[r->i + k];
    v <<= 4;
    if ('0' <= c && c <= '9') v |= (unsigned long)(c - '0');
    else if ('a' <= c && c <= 'f') v |= (unsigned long)(c - 'a' + 10);
    else if ('A' <= c && c <= 'F') v |= (unsigned long)(c - 'A' + 10);
    else return 0;
  }
  r->i += 4;
  *out = v;
  return 1;
}

static const char *string(reader *r, str *out) {
  sbuf b;
  sb_init(&b, r->a);
  r->i++;
  for (;;) {
    unsigned char c;
    if (r->n <= r->i) return fault(r, "unterminated string");
    c = (unsigned char)r->s[r->i];
    if ('"' == c) {
      r->i++;
      break;
    }
    if (c < 0x20) return fault(r, "control character in a string");
    if ('\\' != c) {
      sb_putc(&b, (char)c);
      r->i++;
      continue;
    }
    r->i++;
    if (r->n <= r->i) return fault(r, "unterminated string");
    c = (unsigned char)r->s[r->i++];
    switch (c) {
      case '"': sb_putc(&b, '"'); break;
      case '\\': sb_putc(&b, '\\'); break;
      case '/': sb_putc(&b, '/'); break;
      case 'b': sb_putc(&b, '\b'); break;
      case 'f': sb_putc(&b, '\f'); break;
      case 'n': sb_putc(&b, '\n'); break;
      case 'r': sb_putc(&b, '\r'); break;
      case 't': sb_putc(&b, '\t'); break;
      case 'u': {
        unsigned long u;
        unsigned long lo;
        size_t at;
        if (!hex4(r, &u)) return fault(r, "malformed \\u escape");
        at = r->i;
        if (0xD800 <= u && u <= 0xDBFF && r->i + 1 < r->n &&
            '\\' == r->s[r->i] && 'u' == r->s[r->i + 1]) {
          r->i += 2;
          if (hex4(r, &lo) && 0xDC00 <= lo && lo <= 0xDFFF) {
            u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
          }
          else {
            r->i = at;
          }
        }
        u8_put(&b, u);
        break;
      }
      default:
        r->i--;
        return fault(r, "malformed escape");
    }
  }
  *out = sb_done(&b);
  return NULL;
}

static int digit(reader *r) {
  return r->i < r->n && '0' <= r->s[r->i] && r->s[r->i] <= '9';
}

static const char *number(reader *r, jval **out) {
  size_t start = r->i;
  char *text;
  if ('-' == r->s[r->i]) r->i++;
  if (!digit(r)) return fault(r, "malformed number");
  if ('0' == r->s[r->i]) r->i++;
  else while (digit(r)) r->i++;
  if (r->i < r->n && '.' == r->s[r->i]) {
    r->i++;
    if (!digit(r)) return fault(r, "malformed number");
    while (digit(r)) r->i++;
  }
  if (r->i < r->n && ('e' == r->s[r->i] || 'E' == r->s[r->i])) {
    r->i++;
    if (r->i < r->n && ('+' == r->s[r->i] || '-' == r->s[r->i])) r->i++;
    if (!digit(r)) return fault(r, "malformed number");
    while (digit(r)) r->i++;
  }
  text = ar_copy(r->a, r->s + start, r->i - start);
  *out = jv_num(r->a, strtod(text, NULL));
  return NULL;
}

static int literal(reader *r, const char *word) {
  size_t n = strlen(word);
  if (r->n - r->i < n || 0 != memcmp(r->s + r->i, word, n)) return 0;
  r->i += n;
  return 1;
}

static void attach(arena *a, frame *stack, size_t depth, jval **root, jval *v) {
  frame *top;
  if (0 == depth) {
    *root = v;
    return;
  }
  top = &stack[depth - 1];
  if (J_ARRAY == top->box->kind) jv_push(a, top->box, v);
  else jv_set(a, top->box, top->key, v);
}

static const char *member_key(reader *r, frame *top) {
  const char *err;
  skip_ws(r);
  if (r->n <= r->i || '"' != r->s[r->i]) return fault(r, "expected a member name");
  err = string(r, &top->key);
  if (NULL != err) return err;
  skip_ws(r);
  if (r->n <= r->i || ':' != r->s[r->i]) return fault(r, "expected ':'");
  r->i++;
  return NULL;
}

/* Iterative, so a hostile nesting depth costs heap rather than the stack. */
const char *json_parse(arena *a, const char *text, size_t n, jval **out) {
  reader r;
  frame *stack = NULL;
  size_t depth = 0;
  size_t cap = 0;
  jval *root = NULL;
  int want_value = 1;
  const char *err;

  r.a = a;
  r.s = text;
  r.n = n;
  r.i = 0;

  for (;;) {
    skip_ws(&r);
    if (want_value) {
      jval *v = NULL;
      char c;
      if (r.n <= r.i) return fault(&r, "unexpected end of the text");
      c = r.s[r.i];
      if ('{' == c || '[' == c) {
        v = '{' == c ? jv_obj(a) : jv_arr(a);
        r.i++;
        attach(a, stack, depth, &root, v);
        if (depth == cap) {
          size_t grown = 0 == cap ? 16 : cap * 2;
          frame *bigger = ar_alloc(a, grown * sizeof *bigger);
          if (0 < depth) memcpy(bigger, stack, depth * sizeof *bigger);
          stack = bigger;
          cap = grown;
        }
        stack[depth].box = v;
        stack[depth].key = str_mk("", 0);
        depth++;
        skip_ws(&r);
        if ('{' == c) {
          if (r.i < r.n && '}' == r.s[r.i]) {
            r.i++;
            depth--;
            want_value = 0;
            continue;
          }
          err = member_key(&r, &stack[depth - 1]);
          if (NULL != err) return err;
          continue;
        }
        if (r.i < r.n && ']' == r.s[r.i]) {
          r.i++;
          depth--;
          want_value = 0;
        }
        continue;
      }
      if ('"' == c) {
        str s = str_mk("", 0);
        err = string(&r, &s);
        if (NULL != err) return err;
        v = jv_str(a, s);
      }
      else if ('-' == c || ('0' <= c && c <= '9')) {
        err = number(&r, &v);
        if (NULL != err) return err;
      }
      else if (literal(&r, "true")) v = jv_bool(a, 1);
      else if (literal(&r, "false")) v = jv_bool(a, 0);
      else if (literal(&r, "null")) v = jv_null(a);
      else return fault(&r, "unexpected character");
      attach(a, stack, depth, &root, v);
      want_value = 0;
      continue;
    }

    if (0 == depth) {
      if (r.i != r.n) return fault(&r, "unexpected text after the value");
      *out = root;
      return NULL;
    }
    if (r.n <= r.i) return fault(&r, "unexpected end of the text");
    if (J_ARRAY == stack[depth - 1].box->kind) {
      if (',' == r.s[r.i]) {
        r.i++;
        want_value = 1;
      }
      else if (']' == r.s[r.i]) {
        r.i++;
        depth--;
      }
      else return fault(&r, "expected ',' or ']'");
      continue;
    }
    if (',' == r.s[r.i]) {
      r.i++;
      err = member_key(&r, &stack[depth - 1]);
      if (NULL != err) return err;
      want_value = 1;
    }
    else if ('}' == r.s[r.i]) {
      r.i++;
      depth--;
    }
    else return fault(&r, "expected ',' or '}'");
  }
}

static jval *make(arena *a, jkind k) {
  jval *v = ar_alloc(a, sizeof *v);
  v->kind = k;
  v->s = str_mk("", 0);
  return v;
}

jval *jv_null(arena *a) {
  return make(a, J_NULL);
}

jval *jv_bool(arena *a, int b) {
  return make(a, b ? J_TRUE : J_FALSE);
}

jval *jv_num(arena *a, double d) {
  jval *v = make(a, J_NUMBER);
  v->num = d;
  return v;
}

jval *jv_str(arena *a, str s) {
  jval *v = make(a, J_STRING);
  v->s = str_mk(ar_copy(a, s.p, s.n), s.n);
  return v;
}

jval *jv_strz(arena *a, const char *z) {
  return jv_str(a, str_of(z));
}

jval *jv_arr(arena *a) {
  return make(a, J_ARRAY);
}

jval *jv_obj(arena *a) {
  return make(a, J_OBJECT);
}

static void grow(arena *a, jval *box) {
  size_t cap = 0 == box->cap ? 4 : box->cap * 2;
  jval **item = ar_alloc(a, cap * sizeof *item);
  if (0 < box->len) memcpy(item, box->item, box->len * sizeof *item);
  box->item = item;
  if (J_OBJECT == box->kind) {
    str *key = ar_alloc(a, cap * sizeof *key);
    if (0 < box->len) memcpy(key, box->key, box->len * sizeof *key);
    box->key = key;
  }
  box->cap = cap;
}

void jv_push(arena *a, jval *arr, jval *v) {
  if (arr->len == arr->cap) grow(a, arr);
  arr->item[arr->len++] = v;
}

void jv_set(arena *a, jval *obj, str key, jval *v) {
  size_t i;
  for (i = 0; i < obj->len; i++) {
    if (str_eq(obj->key[i], key)) {
      obj->item[i] = v;
      return;
    }
  }
  if (obj->len == obj->cap) grow(a, obj);
  obj->key[obj->len] = str_mk(ar_copy(a, key.p, key.n), key.n);
  obj->item[obj->len++] = v;
}

void jv_setz(arena *a, jval *obj, const char *key, jval *v) {
  jv_set(a, obj, str_of(key), v);
}

jval *jv_get(const jval *obj, str key) {
  size_t i;
  if (NULL == obj || J_OBJECT != obj->kind) return NULL;
  for (i = 0; i < obj->len; i++) {
    if (str_eq(obj->key[i], key)) return obj->item[i];
  }
  return NULL;
}

jval *jv_getz(const jval *obj, const char *key) {
  return jv_get(obj, str_of(key));
}

int jv_is(const jval *v, jkind k) {
  return NULL != v && k == v->kind;
}

/* SameValue on numbers, as assert.deepStrictEqual compares them: -0 is not 0. */
int jv_equal(const jval *a, const jval *b) {
  size_t i;
  if (NULL == a || NULL == b) return a == b;
  if (a->kind != b->kind) return 0;
  switch (a->kind) {
    case J_NULL:
    case J_FALSE:
    case J_TRUE:
      return 1;
    case J_NUMBER:
      if (isnan(a->num) || isnan(b->num)) return isnan(a->num) && isnan(b->num);
      return a->num == b->num && signbit(a->num) == signbit(b->num);
    case J_STRING:
      return str_eq(a->s, b->s);
    case J_ARRAY:
      if (a->len != b->len) return 0;
      for (i = 0; i < a->len; i++) {
        if (!jv_equal(a->item[i], b->item[i])) return 0;
      }
      return 1;
    case J_OBJECT:
      if (a->len != b->len) return 0;
      for (i = 0; i < a->len; i++) {
        if (!jv_equal(a->item[i], jv_get(b, a->key[i]))) return 0;
      }
      return 1;
  }
  return 0;
}
