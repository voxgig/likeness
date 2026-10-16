# likeness, C port: C99 and POSIX, and no other code in the library or the
# binary. The unit and transcript programs also compile omni, the corpus
# runner, from vendor/omni, which `make c-deps` at the repository root links to
# the checkout c/libs.json pins. README.md lists the targets. The suites read
# spec/ from the repository root, one directory up.

CC       ?= cc
STRICT   := -std=c99 -Wall -Wextra -Werror -pedantic
CFLAGS   ?= -O2
CPPFLAGS += -D_POSIX_C_SOURCE=200809L -Isrc
LDLIBS   += -lm
ROOT     := ..

LIB   := $(filter-out src/main.c,$(sort $(wildcard src/*.c)))
HDR   := $(wildcard src/*.h)
TESTS := unit transcript process selftest

OMNI     := vendor/omni/c/src
OMNI_SRC := $(addprefix $(OMNI)/,json.c util.c runner.c)
ON_OMNI  := unit transcript

SANITIZE := -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -g -O1

.PHONY: all test asan valgrind clean

all: bin/likeness-c

$(OMNI)/%:
	@echo "no omni checkout at $(OMNI) - run \`make c-deps\` from the repository root" >&2; exit 1

# One build per flavour, so a sanitized object never links into the plain one.
define flavour
$(1)/lib.a: $$(LIB) $$(HDR)
	@mkdir -p $(1)/obj
	@for f in $$(LIB); do \
	  $$(CC) $$(STRICT) $(2) $$(CPPFLAGS) -c $$$$f -o $(1)/obj/$$$$(basename $$$$f .c).o || exit 1; \
	done
	@rm -f $$@ && ar rcs $$@ $(1)/obj/*.o

$(1)/omni.a: $$(OMNI_SRC) $(OMNI)/omni.h
	@mkdir -p $(1)/omni
	@for f in $$(OMNI_SRC); do \
	  $$(CC) $$(STRICT) $(2) -D_POSIX_C_SOURCE=200809L -c $$$$f -o $(1)/omni/$$$$(basename $$$$f .c).o || exit 1; \
	done
	@rm -f $$@ && ar rcs $$@ $(1)/omni/*.o

$(1)/likeness-c: src/main.c $(1)/lib.a
	$$(CC) $$(STRICT) $(2) $$(CPPFLAGS) src/main.c $(1)/lib.a $$(LDLIBS) -o $$@

$(addprefix $(1)/,$(ON_OMNI)): $(1)/%: test/%.c test/harness.h test/harness.c test/bridge.h test/bridge.c \
  $(1)/lib.a $(1)/omni.a
	$$(CC) $$(STRICT) $(2) $$(CPPFLAGS) -Itest -I$(OMNI) $$< test/harness.c test/bridge.c \
	  $(1)/lib.a $(1)/omni.a $$(LDLIBS) -o $$@

$(1)/%: test/%.c test/harness.h test/harness.c $(1)/lib.a
	$$(CC) $$(STRICT) $(2) $$(CPPFLAGS) -Itest $$< test/harness.c $(1)/lib.a $$(LDLIBS) -o $$@
endef

$(eval $(call flavour,build/plain,$(CFLAGS)))
$(eval $(call flavour,build/asan,$(SANITIZE)))

bin/likeness-c: build/plain/likeness-c
	@mkdir -p bin
	cp build/plain/likeness-c $@

# $(1) is the build, $(2) the command each suite runs under.
define suite
	$(2) $(1)/unit $(ROOT)
	$(2) $(1)/transcript $(ROOT)
	$(2) $(1)/process $(1)/likeness-c
	$(2) $(1)/selftest
endef

test: bin/likeness-c $(addprefix build/plain/,$(TESTS))
	$(call suite,build/plain,)

asan: build/asan/likeness-c $(addprefix build/asan/,$(TESTS))
	$(call suite,build/asan,ASAN_OPTIONS=detect_leaks=1:abort_on_error=1 UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1)

VALGRIND := valgrind --quiet --error-exitcode=99 --leak-check=full --errors-for-leak-kinds=all \
  --show-leak-kinds=all --trace-children=yes

valgrind: build/plain/likeness-c $(addprefix build/plain/,$(TESTS))
	@command -v valgrind >/dev/null || { echo 'valgrind is not installed; nothing was checked' >&2; exit 1; }
	$(call suite,build/plain,$(VALGRIND))

clean:
	rm -rf build bin
