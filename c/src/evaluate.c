#include "evaluate.h"

str lk_fold_case(arena *a, str s) {
  char *out = ar_copy(a, s.p, s.n);
  size_t i;
  for (i = 0; i < s.n; i++) {
    if ('A' <= out[i] && out[i] <= 'Z') out[i] = (char)(out[i] + 32);
  }
  return str_mk(out, s.n);
}
