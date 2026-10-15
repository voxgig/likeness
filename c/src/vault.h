#ifndef LIKENESS_VAULT_H
#define LIKENESS_VAULT_H

#include "base.h"
#include "errors.h"
#include "json.h"

typedef struct {
  str file;
  str key;
  str shown;
} lk_vault;

/* The one secret store likeness allows: a minivault, chosen the way station
 * chooses its profile's chain, with no passphrase written beside it. A NULL
 * key is the flag left unset. Opening the vault waits on sekreto in this port. */
int lk_vault_entry(arena *a, const jval *station, str profile, str home, str dir, const str *key,
                   lk_vault *out, lk_error *err);

#endif
