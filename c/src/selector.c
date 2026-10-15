#include "selector.h"

#include <string.h>

#include "utf8.h"

static const char *const FIELDS[] = {
  "assignee", "author", "body", "created", "has", "instance", "source",
  "space", "state", "status", "tag", "title", "updated",
};

typedef enum { TK_WORD, TK_QUOTED, TK_LPAREN, TK_RPAREN, TK_OP, TK_DASH } tok_kind;

typedef struct {
  tok_kind kind;
  str text;
  size_t offset;
} tok;

typedef struct {
  arena *a;
  tok *t;
  size_t n;
  size_t cap;
  size_t pos;
  size_t end;
  sel_error *err;
} parser;

static int is_space(char c) {
  return ' ' == c || '\t' == c || '\n' == c || '\r' == c;
}

/* '-' is not a stop: `rate-limit` is one word, and a dash negates only where
 * it opens an atom. */
static int is_word_stop(char c) {
  return is_space(c) || '(' == c || ')' == c || ':' == c || '=' == c || '!' == c ||
    '>' == c || '<' == c || '"' == c;
}

static int is_keyword(str t) {
  return str_eqz(t, "AND") || str_eqz(t, "and") || str_eqz(t, "OR") || str_eqz(t, "or") ||
    str_eqz(t, "NOT") || str_eqz(t, "not");
}

static int refuse_text(parser *p, str message, size_t offset, str token) {
  p->err->message = message;
  p->err->offset = offset;
  p->err->token = token;
  return -1;
}

static int refuse(parser *p, const char *message, size_t offset, str token) {
  return refuse_text(p, str_of(message), offset, token);
}

static void push(parser *p, tok_kind kind, str text, size_t offset) {
  if (p->n == p->cap) {
    size_t cap = 0 == p->cap ? 16 : p->cap * 2;
    tok *grown = ar_alloc(p->a, cap * sizeof *grown);
    if (0 < p->n) memcpy(grown, p->t, p->n * sizeof *grown);
    p->t = grown;
    p->cap = cap;
  }
  p->t[p->n].kind = kind;
  p->t[p->n].text = str_mk(ar_copy(p->a, text.p, text.n), text.n);
  p->t[p->n].offset = offset;
  p->n++;
}

static int tokenise(parser *p, str in) {
  size_t i = 0;
  while (i < in.n) {
    char c = in.p[i];

    if (is_space(c)) {
      i++;
      continue;
    }
    if ('(' == c) {
      push(p, TK_LPAREN, str_of("("), i++);
      continue;
    }
    if (')' == c) {
      push(p, TK_RPAREN, str_of(")"), i++);
      continue;
    }

    if ('"' == c) {
      size_t start = i;
      int closed = 0;
      sbuf v;
      sb_init(&v, p->a);
      i++;
      while (i < in.n) {
        char q = in.p[i];
        if ('\\' == q) {
          unsigned long cp;
          size_t len;
          i++;
          if (in.n <= i) break;
          len = u8_next(in.p, in.n, i, &cp);
          sb_put(&v, in.p + i, len);
          i += len;
          continue;
        }
        if ('"' == q) {
          i++;
          closed = 1;
          break;
        }
        sb_putc(&v, q);
        i++;
      }
      if (!closed) {
        sbuf shown;
        sb_init(&shown, p->a);
        sb_putc(&shown, '"');
        sb_str(&shown, sb_done(&v));
        return refuse(p, "unterminated quoted value", start, sb_done(&shown));
      }
      push(p, TK_QUOTED, sb_done(&v), start);
      continue;
    }

    if ('!' == c) {
      if (i + 1 < in.n && '=' == in.p[i + 1]) {
        push(p, TK_OP, str_of("!="), i);
        i += 2;
        continue;
      }
      return refuse(p, "'!' must be part of '!='", i, str_of("!"));
    }
    if ('>' == c || '<' == c) {
      if (i + 1 < in.n && '=' == in.p[i + 1]) {
        push(p, TK_OP, str_mk(in.p + i, 2), i);
        i += 2;
        continue;
      }
      push(p, TK_OP, str_mk(in.p + i, 1), i);
      i++;
      continue;
    }
    if (':' == c || '=' == c) {
      push(p, TK_OP, str_mk(in.p + i, 1), i);
      i++;
      continue;
    }

    if ('-' == c) {
      int opens = 0 == i || is_space(in.p[i - 1]);
      if (!opens && 0 < p->n) {
        const tok *prev = &p->t[p->n - 1];
        opens = TK_LPAREN == prev->kind || TK_OP == prev->kind || TK_DASH == prev->kind ||
          (TK_WORD == prev->kind && is_keyword(prev->text));
      }
      if (opens) {
        push(p, TK_DASH, str_of("-"), i);
        i++;
        continue;
      }
    }

    {
      size_t start = i;
      while (i < in.n && !is_word_stop(in.p[i])) i++;
      if (start == i) {
        unsigned long cp;
        size_t len = u8_next(in.p, in.n, i, &cp);
        return refuse(p, "unexpected character", start, str_mk(in.p + i, len));
      }
      push(p, TK_WORD, str_mk(in.p + start, i - start), start);
    }
  }
  return 0;
}

static const tok *peek(parser *p) {
  return p->pos < p->n ? &p->t[p->pos] : NULL;
}

static const tok *next(parser *p) {
  const tok *t = peek(p);
  p->pos++;
  return t;
}

static int at_end(parser *p) {
  return p->n <= p->pos;
}

static sel_node *fail_text(parser *p, sbuf *message, const tok *t) {
  if (NULL == t) refuse_text(p, sb_done(message), p->end, str_mk("", 0));
  else refuse_text(p, sb_done(message), t->offset, t->text);
  return NULL;
}

static sel_node *fail(parser *p, const char *message, const tok *t) {
  sbuf m;
  sb_init(&m, p->a);
  sb_puts(&m, message);
  return fail_text(p, &m, t);
}

static int word_is(const tok *t, const char *upper, const char *lower) {
  return NULL != t && TK_WORD == t->kind && (str_eqz(t->text, upper) || str_eqz(t->text, lower));
}

static int is_ordering(str op) {
  return str_eqz(op, ">") || str_eqz(op, "<") || str_eqz(op, ">=") || str_eqz(op, "<=");
}

static int is_field(str s) {
  size_t i;
  for (i = 0; i < sizeof FIELDS / sizeof FIELDS[0]; i++) {
    if (str_eqz(s, FIELDS[i])) return 1;
  }
  return 0;
}

static sel_node *node(parser *p, sel_kind t) {
  sel_node *n = ar_alloc(p->a, sizeof *n);
  n->t = t;
  return n;
}

static void add_kid(parser *p, sel_node *n, sel_node *kid, size_t *cap) {
  if (n->nkids == *cap) {
    size_t grown = 0 == *cap ? 4 : *cap * 2;
    sel_node **kids = ar_alloc(p->a, grown * sizeof *kids);
    if (0 < n->nkids) memcpy(kids, n->kids, n->nkids * sizeof *kids);
    n->kids = kids;
    *cap = grown;
  }
  n->kids[n->nkids++] = kid;
}

static int digits(str s, size_t from, size_t to) {
  size_t i;
  for (i = from; i < to; i++) {
    if (s.p[i] < '0' || '9' < s.p[i]) return 0;
  }
  return 1;
}

static long number_of(str s, size_t from, size_t to) {
  long v = 0;
  size_t i;
  for (i = from; i < to; i++) v = v * 10 + (s.p[i] - '0');
  return v;
}

static int is_leap(long y) {
  return (0 == y % 4 && 0 != y % 100) || 0 == y % 400;
}

static long days_in(long y, long m) {
  static const long MONTH_DAYS[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
  if (2 == m) return is_leap(y) ? 29 : 28;
  return MONTH_DAYS[m - 1];
}

static int classify(parser *p, const tok *t, sel_node *cmp) {
  str s = t->text;
  size_t d = 0;
  if (TK_QUOTED == t->kind) {
    cmp->vk = VAL_WORD;
    cmp->v = s;
    return 0;
  }
  if (str_eqz(s, "today") || str_eqz(s, "yesterday")) {
    cmp->vk = VAL_DATE;
    cmp->v = s;
    return 0;
  }
  if (10 == s.n && '-' == s.p[4] && '-' == s.p[7] && digits(s, 0, 4) && digits(s, 5, 7) &&
      digits(s, 8, 10)) {
    long y = number_of(s, 0, 4);
    long m = number_of(s, 5, 7);
    long day = number_of(s, 8, 10);
    if (m < 1 || 12 < m || day < 1 || days_in(y, m) < day) {
      return refuse(p, "date is out of range", t->offset, s);
    }
    cmp->vk = VAL_DATE;
    cmp->v = s;
    return 0;
  }
  while (d < s.n && '0' <= s.p[d] && s.p[d] <= '9') d++;
  if (0 < d) {
    str unit = str_slice(s, d);
    if (str_eqz(unit, "mo") || str_eqz(unit, "d") || str_eqz(unit, "w") || str_eqz(unit, "y")) {
      if (8 < d) return refuse(p, "duration is out of range", t->offset, s);
      cmp->vk = VAL_DUR;
      cmp->n = number_of(s, 0, d);
      cmp->unit = unit;
      return 0;
    }
  }
  cmp->vk = VAL_WORD;
  cmp->v = s;
  return 0;
}

static sel_node *parse_or(parser *p);

static sel_node *parse_atom(parser *p) {
  const tok *t = next(p);
  const tok *op;
  if (NULL == t) return fail(p, "unexpected end of selector", NULL);

  if (TK_LPAREN == t->kind) {
    sel_node *inner = parse_or(p);
    const tok *close;
    if (NULL == inner) return NULL;
    close = next(p);
    if (NULL == close) return fail(p, "unclosed group", NULL);
    if (TK_RPAREN != close->kind) return fail(p, "expected )", close);
    return inner;
  }
  if (TK_RPAREN == t->kind) return fail(p, "unmatched )", t);
  if (TK_OP == t->kind) return fail(p, "operator with no field", t);
  if (TK_DASH == t->kind) return fail(p, "dangling -", t);

  if (TK_QUOTED == t->kind) {
    sel_node *text = node(p, SEL_TEXT);
    text->v = t->text;
    return text;
  }

  op = peek(p);
  if (NULL != op && TK_OP == op->kind) {
    sel_node *cmp;
    const tok *vtok;
    sbuf why;
    next(p);
    sb_init(&why, p->a);
    if (!is_field(t->text)) {
      sb_puts(&why, "unknown field \"");
      sb_str(&why, t->text);
      sb_putc(&why, '"');
      return fail_text(p, &why, t);
    }
    if (is_ordering(op->text) && !str_eqz(t->text, "created") && !str_eqz(t->text, "updated")) {
      sb_putc(&why, '"');
      sb_str(&why, op->text);
      sb_puts(&why, "\" compares dates, which only created and updated hold");
      return fail_text(p, &why, op);
    }
    vtok = next(p);
    if (NULL == vtok) {
      sb_putc(&why, '"');
      sb_str(&why, t->text);
      sb_str(&why, op->text);
      sb_puts(&why, "\" has no value");
      return fail_text(p, &why, NULL);
    }
    if (TK_OP == vtok->kind || TK_LPAREN == vtok->kind || TK_RPAREN == vtok->kind ||
        TK_DASH == vtok->kind) {
      return fail(p, "expected a value", vtok);
    }
    cmp = node(p, SEL_CMP);
    cmp->field = t->text;
    cmp->op = op->text;
    if (0 != classify(p, vtok, cmp)) return NULL;
    if (is_ordering(op->text) && VAL_WORD == cmp->vk) {
      sb_putc(&why, '"');
      sb_str(&why, op->text);
      sb_puts(&why, "\" needs a date or a duration, not a bareword");
      return fail_text(p, &why, vtok);
    }
    return cmp;
  }

  {
    sel_node *text = node(p, SEL_TEXT);
    text->v = t->text;
    return text;
  }
}

static sel_node *parse_not(parser *p) {
  const tok *t = peek(p);
  if (word_is(t, "NOT", "not") || (NULL != t && TK_DASH == t->kind)) {
    sel_node *neg = node(p, SEL_NOT);
    next(p);
    if (at_end(p)) return fail(p, "NOT must be followed by a term", NULL);
    neg->kid = parse_not(p);
    return NULL == neg->kid ? NULL : neg;
  }
  return parse_atom(p);
}

static sel_node *parse_and(parser *p) {
  sel_node *first = parse_not(p);
  sel_node *conj;
  size_t cap = 0;
  if (NULL == first) return NULL;
  conj = node(p, SEL_AND);
  add_kid(p, conj, first, &cap);
  for (;;) {
    const tok *t = peek(p);
    sel_node *kid;
    if (NULL == t || TK_RPAREN == t->kind || word_is(t, "OR", "or")) break;
    if (word_is(t, "AND", "and")) {
      next(p);
      if (at_end(p)) return fail(p, "AND must be followed by a term", NULL);
    }
    kid = parse_not(p);
    if (NULL == kid) return NULL;
    add_kid(p, conj, kid, &cap);
  }
  return 1 == conj->nkids ? conj->kids[0] : conj;
}

static sel_node *parse_or(parser *p) {
  sel_node *first = parse_and(p);
  sel_node *disj;
  size_t cap = 0;
  if (NULL == first) return NULL;
  disj = node(p, SEL_OR);
  add_kid(p, disj, first, &cap);
  while (word_is(peek(p), "OR", "or")) {
    sel_node *kid;
    next(p);
    if (at_end(p)) return fail(p, "OR must be followed by a term", NULL);
    kid = parse_and(p);
    if (NULL == kid) return NULL;
    add_kid(p, disj, kid, &cap);
  }
  return 1 == disj->nkids ? disj->kids[0] : disj;
}

int lk_parse_selector(arena *a, str input, sel_node **out, sel_error *err) {
  parser p;
  sel_node *n;
  memset(&p, 0, sizeof p);
  p.a = a;
  p.err = err;
  p.end = input.n;
  if (0 != tokenise(&p, input)) return -1;
  if (0 == p.n) return refuse(&p, "empty selector", 0, str_mk("", 0));
  n = parse_or(&p);
  if (NULL == n) return -1;
  if (!at_end(&p)) {
    const tok *t = peek(&p);
    return refuse(&p, "unexpected token", t->offset, t->text);
  }
  *out = n;
  return 0;
}

jval *lk_selector_model(arena *a, const sel_node *n) {
  jval *m = jv_obj(a);
  size_t i;
  switch (n->t) {
    case SEL_OR:
    case SEL_AND: {
      jval *kids = jv_arr(a);
      for (i = 0; i < n->nkids; i++) jv_push(a, kids, lk_selector_model(a, n->kids[i]));
      jv_setz(a, m, "t", jv_strz(a, SEL_OR == n->t ? "or" : "and"));
      jv_setz(a, m, "kids", kids);
      return m;
    }
    case SEL_NOT:
      jv_setz(a, m, "t", jv_strz(a, "not"));
      jv_setz(a, m, "kid", lk_selector_model(a, n->kid));
      return m;
    case SEL_CMP: {
      jval *value = jv_obj(a);
      if (VAL_DUR == n->vk) {
        jv_setz(a, value, "k", jv_strz(a, "dur"));
        jv_setz(a, value, "n", jv_num(a, (double)n->n));
        jv_setz(a, value, "unit", jv_str(a, n->unit));
      }
      else {
        jv_setz(a, value, "k", jv_strz(a, VAL_DATE == n->vk ? "date" : "word"));
        jv_setz(a, value, "v", jv_str(a, n->v));
      }
      jv_setz(a, m, "t", jv_strz(a, "cmp"));
      jv_setz(a, m, "field", jv_str(a, n->field));
      jv_setz(a, m, "op", jv_str(a, n->op));
      jv_setz(a, m, "value", value);
      return m;
    }
    case SEL_TEXT:
      jv_setz(a, m, "t", jv_strz(a, "text"));
      jv_setz(a, m, "v", jv_str(a, n->v));
      return m;
  }
  return m;
}
