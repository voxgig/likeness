#ifndef LIKENESS_SELECTOR_H
#define LIKENESS_SELECTOR_H

#include "base.h"
#include "json.h"

typedef enum { SEL_OR, SEL_AND, SEL_NOT, SEL_CMP, SEL_TEXT } sel_kind;
typedef enum { VAL_WORD, VAL_DATE, VAL_DUR } val_kind;

typedef struct sel_node sel_node;
struct sel_node {
  sel_kind t;
  sel_node **kids;
  size_t nkids;
  sel_node *kid;
  str field;
  str op;
  val_kind vk;
  str v;
  long n;
  str unit;
};

/* A refusal with a place: the offset is in bytes of the UTF-8 input. */
typedef struct {
  str message;
  size_t offset;
  str token;
} sel_error;

int lk_parse_selector(arena *a, str input, sel_node **out, sel_error *err);

jval *lk_selector_model(arena *a, const sel_node *n);

#endif
