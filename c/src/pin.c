#include "pin.h"

#include "sha256.h"

#define PREFIX "sha256:"
#define DIGEST 32

static const char HEX[] = "0123456789abcdef";

static int is_hex(char c) {
  return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F');
}

static char lower(char c) {
  return 'A' <= c && c <= 'F' ? (char)(c + 32) : c;
}

/* Colon-joined pairs hold a colon at every third character, and hex elsewhere. */
static int digest_form(str hex) {
  size_t i;
  int pairs = 3 * DIGEST - 1 == hex.n;
  if (!pairs && 2 * DIGEST != hex.n) return 0;
  for (i = 0; i < hex.n; i++) {
    if ((pairs && 2 == i % 3) ? ':' != hex.p[i] : !is_hex(hex.p[i])) return 0;
  }
  return 1;
}

const char *lk_parse_pin(arena *a, const jval *text, str *out) {
  str hex;
  sbuf b;
  size_t i;
  if (!jv_is(text, J_STRING) || !str_starts(text->s, PREFIX)) return "not a sha256 certificate fingerprint";
  hex = str_slice(text->s, sizeof PREFIX - 1);
  if (!digest_form(hex)) return "not a sha256 certificate fingerprint";
  sb_init(&b, a);
  sb_puts(&b, PREFIX);
  for (i = 0; i < hex.n; i++) {
    if (':' != hex.p[i]) sb_putc(&b, lower(hex.p[i]));
  }
  *out = sb_done(&b);
  return NULL;
}

str lk_fingerprint_of(arena *a, const unsigned char *der, size_t n) {
  unsigned char digest[DIGEST];
  sha256_ctx c;
  sbuf b;
  size_t i;
  sha256_init(&c);
  sha256_update(&c, der, n);
  sha256_final(&c, digest);
  sb_init(&b, a);
  sb_puts(&b, PREFIX);
  for (i = 0; i < DIGEST; i++) {
    sb_putc(&b, HEX[digest[i] >> 4]);
    sb_putc(&b, HEX[digest[i] & 15]);
  }
  return sb_done(&b);
}
