#ifndef LIKENESS_PIN_H
#define LIKENESS_PIN_H

#include "base.h"
#include "json.h"

/* NULL with the pin as `sha256:` and lower-case hex, or why text is not a
 * sha256 certificate fingerprint: the hex digest bare or as colon-joined
 * pairs, in either case. */
const char *lk_parse_pin(arena *a, const jval *text, str *out);

str lk_fingerprint_of(arena *a, const unsigned char *der, size_t n);

#endif
