#ifndef LIKENESS_ENVELOPE_H
#define LIKENESS_ENVELOPE_H

#include "base.h"
#include "json.h"

int lk_compare_code_points(str a, str b);

void lk_escape_string(sbuf *out, str s);

/* ECMAScript Number::toString, the form a raw payload writes its numbers in. */
void lk_js_number(sbuf *out, double v);

/* 0, or -1 with why the value has no envelope form; why may be NULL. A NULL
 * value is an absent one, refused as the canonical port refuses `undefined`. */
int lk_render(arena *a, const jval *v, str *out, str *why);
int lk_render_raw(arena *a, const jval *v, str *out, str *why);
int lk_serialise(arena *a, const jval *v, str *out, str *why);

/* The declared non-parity fields removed by path: `port`, `meta.elapsed_ms`
 * and `data.port`, and nothing deeper. */
jval *lk_strip_parity_exceptions(arena *a, const jval *v);

#endif
