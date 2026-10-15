#include "vault.h"

#include <stdlib.h>

#include "envelope.h"
#include "path.h"

#define DEFAULT_FILE "likeness.skmv"
#define PASSPHRASE_ENV "LIKENESS_PASSPHRASE"
#define REMEDY "name the vault alone: \"providers\": [{ \"kind\": \"minivault\", \"file\": \"likeness.skmv\" }]"

static int refused(lk_error *err, str message, const char *remedy) {
  return lk_fail(err, "invalid-project", message, str_of(remedy));
}

static const jval *chain(const jval *profile) {
  const jval *secrets = jv_getz(profile, "secrets");
  if (!jv_is(profile, J_OBJECT) || !jv_is(secrets, J_OBJECT)) return NULL;
  return jv_getz(secrets, "providers");
}

static int is_key_name(str s) {
  size_t i;
  if (0 == s.n || s.p[0] < 'a' || 'z' < s.p[0]) return 0;
  for (i = 1; i < s.n; i++) {
    char c = s.p[i];
    if (!('a' <= c && c <= 'z') && !('0' <= c && c <= '9') && '-' != c) return 0;
  }
  return 1;
}

static int by_text(const void *x, const void *y) {
  return lk_compare_code_points(*(const str *)x, *(const str *)y);
}

static str shown(arena *a, str path, str home) {
  str h = path_resolve(a, &home, 1);
  sbuf b;
  if (str_eq(path, h)) return str_of("~");
  if (h.n + 1 <= path.n && str_eq(str_mk(path.p, h.n), h) && '/' == path.p[h.n]) {
    sb_init(&b, a);
    sb_puts(&b, "~/");
    sb_str(&b, str_slice(path, h.n + 1));
    return sb_done(&b);
  }
  return path;
}

static str located(arena *a, str file, str home, str dir) {
  str parts[2];
  if (str_starts(file, "~/")) {
    parts[0] = home;
    parts[1] = str_slice(file, 2);
    return path_resolve(a, parts, 2);
  }
  if (path_is_absolute(file)) return path_resolve(a, &file, 1);
  parts[0] = dir;
  parts[1] = file;
  return path_resolve(a, parts, 2);
}

/* A non-string kind is named as the raw writer renders it; an absent one has
 * no rendering, and that refusal is the answer, as in the canonical port. */
static int names_the_store(arena *a, const jval *kind, lk_error *err) {
  sbuf m;
  sb_init(&m, a);
  sb_puts(&m, "likeness reads secrets from its vault alone, and station.json names the store \"");
  if (jv_is(kind, J_STRING)) sb_str(&m, kind->s);
  else {
    str text;
    str why;
    if (0 != lk_render_raw(a, kind, &text, &why)) return lk_fail(err, NULL, why, str_mk("", 0));
    sb_str(&m, text);
  }
  sb_putc(&m, '"');
  return refused(err, sb_done(&m), REMEDY);
}

int lk_vault_entry(arena *a, const jval *station, str profile, str home, str dir, const str *key,
                   lk_vault *out, lk_error *err) {
  const jval *profiles = jv_getz(station, "profiles");
  const jval *providers = NULL;
  const jval *entry = NULL;
  const jval *file;
  const jval *vaultkey;

  if (!jv_is(station, J_OBJECT) || !jv_is(profiles, J_OBJECT)) profiles = NULL;
  if (!str_eqz(profile, "default")) providers = chain(jv_get(profiles, profile));
  if (NULL == providers || J_NULL == providers->kind) providers = chain(jv_getz(profiles, "default"));

  if (NULL != providers) {
    const jval *only;
    str *extra;
    size_t nextra = 0;
    size_t i;
    if (!jv_is(providers, J_ARRAY) || 1 != providers->len) {
      return refused(err, str_of("station.json's secrets.providers must name one store, the vault"), REMEDY);
    }
    only = providers->item[0];
    if (!jv_is(only, J_OBJECT)) return names_the_store(a, only, err);
    if (!jv_is(jv_getz(only, "kind"), J_STRING) || !str_eqz(jv_getz(only, "kind")->s, "minivault")) {
      return names_the_store(a, jv_getz(only, "kind"), err);
    }
    if (NULL != jv_getz(only, "passphrase")) {
      return refused(err,
        str_of("station.json holds the vault's passphrase, and a passphrase is never written to a file"),
        "remove it, and set " PASSPHRASE_ENV " or name a variable with --passphrase-env");
    }
    extra = ar_alloc(a, (only->len + 1) * sizeof *extra);
    for (i = 0; i < only->len; i++) {
      str k = only->key[i];
      if (!str_eqz(k, "file") && !str_eqz(k, "kind") && !str_eqz(k, "vaultkey")) extra[nextra++] = k;
    }
    if (0 < nextra) {
      sbuf m;
      qsort(extra, nextra, sizeof *extra, by_text);
      sb_init(&m, a);
      sb_puts(&m, "the vault entry in station.json has no key \"");
      sb_str(&m, extra[0]);
      sb_putc(&m, '"');
      return refused(err, sb_done(&m), "the vault entry takes kind, file and vaultkey");
    }
    file = jv_getz(only, "file");
    if (NULL != file && (!jv_is(file, J_STRING) || 0 == file->s.n)) {
      return refused(err, str_of("the vault entry's file is not a path"), "name the file: \"file\": \"likeness.skmv\"");
    }
    vaultkey = jv_getz(only, "vaultkey");
    if (NULL != vaultkey && (!jv_is(vaultkey, J_STRING) || !is_key_name(vaultkey->s))) {
      return refused(err, str_of("the vault entry's vaultkey is not a key name"), "a key name is [a-z][a-z0-9-]*");
    }
    entry = only;
  }

  file = jv_getz(entry, "file");
  vaultkey = jv_getz(entry, "vaultkey");
  out->file = located(a, jv_is(file, J_STRING) ? file->s : str_of(DEFAULT_FILE), home, dir);
  if (NULL != key) out->key = *key;
  else out->key = jv_is(vaultkey, J_STRING) ? vaultkey->s : str_of("master");
  out->shown = shown(a, out->file, home);
  return 0;
}
