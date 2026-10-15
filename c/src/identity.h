#ifndef LIKENESS_IDENTITY_H
#define LIKENESS_IDENTITY_H

#include "base.h"

#define LK_CROCKFORD "0123456789abcdefghjkmnpqrstvwxyz"

str lk_crockford32(arena *a, const unsigned char *bytes, size_t n, size_t chars);

str lk_lid(arena *a, str source, str account, str entity, str id);

/* NULL, or why ms has no RFC 3339 form with a four-digit year. A fraction is
 * dropped toward zero, as a JavaScript Date drops it. */
const char *lk_rfc3339(arena *a, double ms, str *out);

#endif
