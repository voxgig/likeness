#include "spec.h"

#include "spec_embed.h"

static arena *held;
static jval *caps;
static jval *commands;
static jval *errors;
static jval *help;

str spec_text(arena *a, const char *const *lines) {
  sbuf b;
  size_t i;
  sb_init(&b, a);
  for (i = 0; NULL != lines[i]; i++) {
    sb_puts(&b, lines[i]);
    sb_putc(&b, '\n');
  }
  return sb_done(&b);
}

static jval *parsed(const char *const *lines) {
  jval *v = NULL;
  str text = spec_text(held, lines);
  if (NULL != json_parse(held, text.p, text.n, &v)) die("the embedded specification is not JSON");
  return v;
}

static void load(void) {
  if (NULL != held) return;
  held = ar_new();
  caps = parsed(spec_caps_json);
  commands = parsed(spec_commands_json);
  errors = parsed(spec_errors_json);
  help = parsed(spec_help_json);
}

const jval *spec_caps(void) {
  load();
  return caps;
}

const jval *spec_commands(void) {
  load();
  return commands;
}

const jval *spec_errors(void) {
  load();
  return errors;
}

const jval *spec_help(void) {
  load();
  return help;
}

void spec_unload(void) {
  ar_free(held);
  held = NULL;
  caps = NULL;
  commands = NULL;
  errors = NULL;
  help = NULL;
}
