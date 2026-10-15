#include "sha256.h"

#include <string.h>

#define MASK 0xFFFFFFFFUL
#define ROTR(x, n) ((((x) >> (n)) | ((x) << (32 - (n)))) & MASK)

static const unsigned long K[64] = {
  0x428a2f98UL, 0x71374491UL, 0xb5c0fbcfUL, 0xe9b5dba5UL, 0x3956c25bUL, 0x59f111f1UL,
  0x923f82a4UL, 0xab1c5ed5UL, 0xd807aa98UL, 0x12835b01UL, 0x243185beUL, 0x550c7dc3UL,
  0x72be5d74UL, 0x80deb1feUL, 0x9bdc06a7UL, 0xc19bf174UL, 0xe49b69c1UL, 0xefbe4786UL,
  0x0fc19dc6UL, 0x240ca1ccUL, 0x2de92c6fUL, 0x4a7484aaUL, 0x5cb0a9dcUL, 0x76f988daUL,
  0x983e5152UL, 0xa831c66dUL, 0xb00327c8UL, 0xbf597fc7UL, 0xc6e00bf3UL, 0xd5a79147UL,
  0x06ca6351UL, 0x14292967UL, 0x27b70a85UL, 0x2e1b2138UL, 0x4d2c6dfcUL, 0x53380d13UL,
  0x650a7354UL, 0x766a0abbUL, 0x81c2c92eUL, 0x92722c85UL, 0xa2bfe8a1UL, 0xa81a664bUL,
  0xc24b8b70UL, 0xc76c51a3UL, 0xd192e819UL, 0xd6990624UL, 0xf40e3585UL, 0x106aa070UL,
  0x19a4c116UL, 0x1e376c08UL, 0x2748774cUL, 0x34b0bcb5UL, 0x391c0cb3UL, 0x4ed8aa4aUL,
  0x5b9cca4fUL, 0x682e6ff3UL, 0x748f82eeUL, 0x78a5636fUL, 0x84c87814UL, 0x8cc70208UL,
  0x90befffaUL, 0xa4506cebUL, 0xbef9a3f7UL, 0xc67178f2UL,
};

static void compress(sha256_ctx *c, const unsigned char *p) {
  unsigned long w[64];
  unsigned long s[8];
  int t;

  for (t = 0; t < 16; t++) {
    w[t] = ((unsigned long)p[4 * t] << 24) | ((unsigned long)p[4 * t + 1] << 16) |
           ((unsigned long)p[4 * t + 2] << 8) | (unsigned long)p[4 * t + 3];
  }
  for (t = 16; t < 64; t++) {
    unsigned long s0 = ROTR(w[t - 15], 7) ^ ROTR(w[t - 15], 18) ^ (w[t - 15] >> 3);
    unsigned long s1 = ROTR(w[t - 2], 17) ^ ROTR(w[t - 2], 19) ^ (w[t - 2] >> 10);
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) & MASK;
  }

  memcpy(s, c->h, sizeof s);
  for (t = 0; t < 64; t++) {
    unsigned long e = s[4];
    unsigned long a = s[0];
    unsigned long ch = (e & s[5]) ^ (~e & s[6] & MASK);
    unsigned long maj = (a & s[1]) ^ (a & s[2]) ^ (s[1] & s[2]);
    unsigned long t1 = (s[7] + (ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25)) + ch + K[t] + w[t]) & MASK;
    unsigned long t2 = ((ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22)) + maj) & MASK;
    s[7] = s[6];
    s[6] = s[5];
    s[5] = s[4];
    s[4] = (s[3] + t1) & MASK;
    s[3] = s[2];
    s[2] = s[1];
    s[1] = s[0];
    s[0] = (t1 + t2) & MASK;
  }
  for (t = 0; t < 8; t++) c->h[t] = (c->h[t] + s[t]) & MASK;
}

void sha256_init(sha256_ctx *c) {
  static const unsigned long H0[8] = {
    0x6a09e667UL, 0xbb67ae85UL, 0x3c6ef372UL, 0xa54ff53aUL,
    0x510e527fUL, 0x9b05688cUL, 0x1f83d9abUL, 0x5be0cd19UL,
  };
  memcpy(c->h, H0, sizeof c->h);
  c->used = 0;
  c->bytes = 0;
}

void sha256_update(sha256_ctx *c, const void *data, size_t n) {
  const unsigned char *p = data;
  c->bytes += n;
  while (0 < n) {
    size_t take = 64 - c->used;
    if (n < take) take = n;
    memcpy(c->block + c->used, p, take);
    c->used += take;
    p += take;
    n -= take;
    if (64 == c->used) {
      compress(c, c->block);
      c->used = 0;
    }
  }
}

void sha256_final(sha256_ctx *c, unsigned char digest[32]) {
  unsigned long long bits = c->bytes * 8;
  unsigned char pad = 0x80;
  unsigned char zero = 0;
  unsigned char len[8];
  int i;

  sha256_update(c, &pad, 1);
  while (56 != c->used) sha256_update(c, &zero, 1);
  for (i = 0; i < 8; i++) len[i] = (unsigned char)(bits >> (56 - 8 * i));
  sha256_update(c, len, 8);
  for (i = 0; i < 8; i++) {
    digest[4 * i] = (unsigned char)(c->h[i] >> 24);
    digest[4 * i + 1] = (unsigned char)(c->h[i] >> 16);
    digest[4 * i + 2] = (unsigned char)(c->h[i] >> 8);
    digest[4 * i + 3] = (unsigned char)c->h[i];
  }
}
