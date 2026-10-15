#ifndef LIKENESS_SHA256_H
#define LIKENESS_SHA256_H

#include <stddef.h>

/* SHA-256 (FIPS 180-4), written for the port, which takes no dependency. */
typedef struct {
  unsigned long h[8];
  unsigned char block[64];
  size_t used;
  unsigned long long bytes;
} sha256_ctx;

void sha256_init(sha256_ctx *c);
void sha256_update(sha256_ctx *c, const void *data, size_t n);
void sha256_final(sha256_ctx *c, unsigned char digest[32]);

#endif
