#include "path.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static long last_slash_in(const sbuf *b) {
  size_t i = b->n;
  while (0 < i) {
    i--;
    if ('/' == b->p[i]) return (long)i;
  }
  return -1;
}

static void truncate_to(sbuf *b, size_t n) {
  b->n = n;
  b->p[n] = '\0';
}

/* Node's normalizeString, step for step. */
static str normalize_string(arena *a, str path, int allow_above_root) {
  sbuf res;
  size_t last_segment_length = 0;
  long last_slash = -1;
  int dots = 0;
  char code = 0;
  size_t i;

  sb_init(&res, a);
  for (i = 0; i <= path.n; ++i) {
    if (i < path.n) code = path.p[i];
    else if ('/' == code) break;
    else code = '/';

    if ('/' == code) {
      if (last_slash == (long)i - 1 || 1 == dots) {
        /* an empty segment, or "." */
      }
      else if (2 == dots) {
        if (res.n < 2 || 2 != last_segment_length || '.' != res.p[res.n - 1] || '.' != res.p[res.n - 2]) {
          if (res.n > 2) {
            long at = last_slash_in(&res);
            if (-1 == at) {
              truncate_to(&res, 0);
              last_segment_length = 0;
            }
            else {
              truncate_to(&res, (size_t)at);
              last_segment_length = (size_t)((long)res.n - 1 - last_slash_in(&res));
            }
            last_slash = (long)i;
            dots = 0;
            continue;
          }
          else if (0 != res.n) {
            truncate_to(&res, 0);
            last_segment_length = 0;
            last_slash = (long)i;
            dots = 0;
            continue;
          }
        }
        if (allow_above_root) {
          sb_puts(&res, 0 < res.n ? "/.." : "..");
          last_segment_length = 2;
        }
      }
      else {
        if (0 < res.n) sb_putc(&res, '/');
        sb_put(&res, path.p + last_slash + 1, i - (size_t)(last_slash + 1));
        last_segment_length = i - (size_t)last_slash - 1;
      }
      last_slash = (long)i;
      dots = 0;
    }
    else if ('.' == code && -1 != dots) {
      ++dots;
    }
    else {
      dots = -1;
    }
  }
  return sb_done(&res);
}

int path_is_absolute(str p) {
  return 0 < p.n && '/' == p.p[0];
}

str path_normalize(arena *a, str p) {
  int absolute;
  int trailing;
  str res;
  sbuf out;
  if (0 == p.n) return str_of(".");
  absolute = '/' == p.p[0];
  trailing = '/' == p.p[p.n - 1];
  res = normalize_string(a, p, !absolute);
  if (0 == res.n) {
    if (absolute) return str_of("/");
    return trailing ? str_of("./") : str_of(".");
  }
  sb_init(&out, a);
  if (absolute) sb_putc(&out, '/');
  sb_str(&out, res);
  if (trailing) sb_putc(&out, '/');
  return sb_done(&out);
}

str path_join(arena *a, const str *parts, size_t n) {
  sbuf joined;
  size_t i;
  int any = 0;
  sb_init(&joined, a);
  for (i = 0; i < n; i++) {
    if (0 == parts[i].n) continue;
    if (any) sb_putc(&joined, '/');
    sb_str(&joined, parts[i]);
    any = 1;
  }
  if (!any) return str_of(".");
  return path_normalize(a, sb_done(&joined));
}

static str cwd(arena *a) {
  size_t size = 256;
  for (;;) {
    char *buf = ar_alloc(a, size);
    if (NULL != getcwd(buf, size)) return str_of(buf);
    if (size > 65536) return str_mk("", 0);
    size *= 2;
  }
}

str path_resolve(arena *a, const str *parts, size_t n) {
  str resolved = str_mk("", 0);
  int absolute = 0;
  long i;
  for (i = (long)n - 1; -1 <= i && !absolute; i--) {
    str p = 0 <= i ? parts[i] : cwd(a);
    sbuf b;
    if (0 == p.n) continue;
    sb_init(&b, a);
    sb_str(&b, p);
    sb_putc(&b, '/');
    sb_str(&b, resolved);
    resolved = sb_done(&b);
    absolute = '/' == p.p[0];
  }
  resolved = normalize_string(a, resolved, !absolute);
  if (absolute) {
    sbuf out;
    sb_init(&out, a);
    sb_putc(&out, '/');
    sb_str(&out, resolved);
    return sb_done(&out);
  }
  return 0 < resolved.n ? resolved : str_of(".");
}

str path_dirname(arena *a, str p) {
  int root;
  long end = -1;
  int matched_slash = 1;
  long i;
  if (0 == p.n) return str_of(".");
  root = '/' == p.p[0];
  for (i = (long)p.n - 1; i >= 1; --i) {
    if ('/' == p.p[i]) {
      if (!matched_slash) {
        end = i;
        break;
      }
    }
    else {
      matched_slash = 0;
    }
  }
  if (-1 == end) return root ? str_of("/") : str_of(".");
  if (root && 1 == end) return str_of("//");
  return str_mk(ar_copy(a, p.p, (size_t)end), (size_t)end);
}
