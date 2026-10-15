#ifndef LIKENESS_JSON_H
#define LIKENESS_JSON_H

#include "base.h"

typedef enum { J_NULL, J_FALSE, J_TRUE, J_NUMBER, J_STRING, J_ARRAY, J_OBJECT } jkind;

/* A parsed JSON value. A number is a double, as JSON.parse reads it, so
 * `1.0` is the integer 1 here as it is in the canonical port. */
typedef struct jval jval;
struct jval {
  jkind kind;
  double num;
  str s;
  size_t len;
  size_t cap;
  jval **item;
  str *key;
};

/* NULL, or why the text is not JSON. A repeated key keeps its last value,
 * as JSON.parse does. */
const char *json_parse(arena *a, const char *text, size_t n, jval **out);

/* As json_parse, except that a number past a double's range is refused rather
 * than read as an infinity, which nothing can write back. */
const char *json_parse_finite(arena *a, const char *text, size_t n, jval **out);

jval *jv_null(arena *a);
jval *jv_bool(arena *a, int b);
jval *jv_num(arena *a, double d);
jval *jv_str(arena *a, str s);
jval *jv_strz(arena *a, const char *z);
jval *jv_arr(arena *a);
jval *jv_obj(arena *a);
void jv_push(arena *a, jval *arr, jval *v);
void jv_set(arena *a, jval *obj, str key, jval *v);
void jv_setz(arena *a, jval *obj, const char *key, jval *v);

jval *jv_get(const jval *obj, str key);
jval *jv_getz(const jval *obj, const char *key);
int jv_is(const jval *v, jkind k);
int jv_equal(const jval *a, const jval *b);

#endif
