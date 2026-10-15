#include "errors.h"

#include <stdlib.h>

#include "envelope.h"
#include "spec.h"

int lk_fail(lk_error *e, const char *code, str message, str remedy) {
  e->code = code;
  e->message = message;
  e->remedy = remedy;
  return -1;
}

int lk_failz(lk_error *e, const char *code, const char *message, const char *remedy) {
  return lk_fail(e, code, str_of(message), str_of(remedy));
}

int lk_exit_for(str code) {
  const jval *def = jv_get(jv_getz(spec_errors(), "error"), code);
  const jval *status = jv_getz(def, "exit");
  if (!jv_is(status, J_NUMBER)) die("no such error code");
  return (int)status->num;
}

static int by_text(const void *x, const void *y) {
  return lk_compare_code_points((*(const jval *const *)x)->s, (*(const jval *const *)y)->s);
}

jval *lk_partial_codes(arena *a) {
  const jval *all = jv_getz(spec_errors(), "error");
  jval *out = jv_arr(a);
  size_t i;
  for (i = 0; NULL != all && i < all->len; i++) {
    const jval *def = all->item[i];
    const jval *code = jv_getz(def, "code");
    if (jv_is(jv_getz(def, "partial"), J_TRUE) && jv_is(code, J_STRING)) jv_push(a, out, jv_str(a, code->s));
  }
  if (1 < out->len) qsort(out->item, out->len, sizeof *out->item, by_text);
  return out;
}
