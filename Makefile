# likeness - root Makefile.
#
# The schema gates come first because they are the cheapest checks in the
# project and the ones that catch a whole class of mistake before any port is
# built. `make spec-check` should be the first thing a change runs and the
# first thing CI runs.

AONTU ?= npx --yes aontu@0.67.0
SPEC  := spec
DEF   := $(SPEC)/def

# Every data file, paired with the shape it must satisfy. Adding a data file
# without adding it here is the one gap this Makefile cannot catch, so
# `spec-list` prints both lists for comparison.
VET_PAIRS := \
	$(DEF)/source.aon:$(SPEC)/sources.aon \
	$(DEF)/capability.aon:$(SPEC)/caps.aon \
	$(DEF)/error.aon:$(SPEC)/errors.aon \
	$(DEF)/project.aon:$(SPEC)/example/likeness.aon \
	$(DEF)/replica.aon:$(SPEC)/replica.aon \
	$(DEF)/corpus.aon:$(SPEC)/unit.aon \
	$(DEF)/corpus.aon:$(SPEC)/cli.aon

# Files that MUST fail to vet, AND MUST FAIL FOR THE RIGHT REASON. `aontu vet`
# exits 1 for a contradiction, 2 for a usage error and 3 for an incomplete
# model, so a loop that accepts any non-zero status also accepts a deleted or
# renamed file - and then prints "fails as required" while proving nothing,
# which is the exact failure this target exists to prevent. Exit 1, or it is a
# build failure.
VET_MUSTFAIL := \
	$(DEF)/project.aon:$(SPEC)/example/likeness-broken.aon


.PHONY: help
help:
	@echo 'likeness make targets:'
	@echo '  spec-check    every data file satisfies its shape, and the red tests go red'
	@echo '  spec-agree    the registry is present, and capability rows match it'
	@echo '                (set LIKENESS_SDK_ROOT to also check against real SDKs)'
	@echo '  spec-build    compile the data files to the JSON every port reads'
	@echo '  spec-fresh    fail if a committed JSON file is stale'
	@echo '  spec-json     export the shapes as JSON Schema'
	@echo '  spec-fmt      check schema formatting'
	@echo '  spec-hash     print a content hash per schema file'
	@echo '  spec          spec-fmt, spec-check, spec-fresh and spec-agree'
	@echo '  sdk           clone the generated SDKs at their pinned revisions'
	@echo '  sdk-check     fail if a clone is missing or off its pin'
	@echo '  test-ts       build and run the TypeScript port against both corpora'
	@echo '  check         spec and every port'
	@echo '  expect        REGENERATE the committed expectations - read the diff'
	@echo '  mock          run the local source mock server'


.PHONY: spec
spec: spec-fmt spec-check spec-fresh spec-agree


# Everything. What CI runs, and what a change should run before it is pushed.
.PHONY: check
check: spec test-ts


.PHONY: spec-build
spec-build:
	@AONTU="$(AONTU)" node tools/build-spec.mjs


# Drift between a .aon file and the JSON committed beside it fails a build here
# rather than being discovered a month later, when a port disagrees with the
# spec it claims to implement.
.PHONY: spec-fresh
spec-fresh:
	@AONTU="$(AONTU)" node tools/build-spec.mjs --check


# The generated SDKs are not published to any language registry yet, so there
# is no lockfile to hold them and this does the job instead. The revisions come
# from spec/sources.json and are never restated in the Makefile.
.PHONY: sdk
sdk:
	@node tools/fetch-sdk.mjs


.PHONY: sdk-check
sdk-check:
	@node tools/fetch-sdk.mjs --check


# sdk-check first: a port built against a drifted clone produces a corpus
# result about an SDK nobody else has.
.PHONY: test-ts
test-ts: sdk-check
	@cd typescript && npm run build && npm test


# NOT A TEST, and never run to make one pass. It rewrites the contract to agree
# with whatever the code now does, which is the opposite of what the corpus is
# for. Run it deliberately, read the diff, and commit it only if the change was
# the one you meant to make. CI never runs this; it runs `make check`.
.PHONY: expect
expect:
	@echo '  Regenerating committed expectations from the CANONICAL (ts) port.' >&2
	@echo '  READ THE DIFF before committing: this rewrites the contract.' >&2
	@node tools/regen-expect.mjs


.PHONY: spec-check
spec-check:
	@fail=0; \
	for pair in $(VET_PAIRS); do \
	  shape=$${pair%%:*}; data=$${pair#*:}; \
	  printf '  vet %-34s %s ... ' "$$(basename $$data)" "$$(basename $$shape)"; \
	  if $(AONTU) vet "$$shape" "$$data" >/tmp/likeness-vet.$$$$ 2>&1; then \
	    echo 'valid'; \
	  else \
	    echo 'INVALID'; cat /tmp/likeness-vet.$$$$; fail=1; \
	  fi; rm -f /tmp/likeness-vet.$$$$; \
	done; \
	for pair in $(VET_MUSTFAIL); do \
	  shape=$${pair%%:*}; data=$${pair#*:}; \
	  printf '  red %-34s %s ... ' "$$(basename $$data)" "$$(basename $$shape)"; \
	  $(AONTU) vet "$$shape" "$$data" >/dev/null 2>&1; rc=$$?; \
	  if [ 1 -eq $$rc ]; then \
	    echo 'fails as required'; \
	  elif [ 0 -eq $$rc ]; then \
	    echo 'PASSED BUT MUST FAIL'; fail=1; \
	  else \
	    echo "WRONG FAILURE (exit $$rc, wanted 1)"; fail=1; \
	  fi; \
	done; \
	exit $$fail


.PHONY: spec-agree
spec-agree:
	@AONTU="$(AONTU)" node tools/check-registry.mjs


.PHONY: spec-json
# The notes go to STDERR so that `make spec-json > schema.json` produces JSON
# rather than JSON with two English sentences on top of it.
spec-json:
	@echo '  NOTE: an export, not the gate. aontu prints a "lossy:" line for each' >&2
	@echo '  declaration it could not carry across; read them before trusting it.' >&2
	@echo '  Known losses: a value reached through a named type exports as {} and' >&2
	@echo '  admits anything, and every type() definition appears as a REQUIRED' >&2
	@echo '  top-level property, so no likeness document satisfies the export.' >&2
	@echo '  `aontu vet` is the authority. This is for readers, not validators.' >&2
	@$(AONTU) jsonschema $(DEF)/likeness.aon


.PHONY: spec-fmt
spec-fmt:
	@$(AONTU) fmt --check $(DEF)/*.aon $(SPEC)/*.aon $(SPEC)/example/*.aon && echo '  fmt ok'


.PHONY: spec-hash
spec-hash:
	@for f in $(DEF)/*.aon $(SPEC)/*.aon; do printf '  %-32s ' "$$(basename $$f)"; $(AONTU) hash "$$f"; done


.PHONY: spec-list
spec-list:
	@echo 'data files present:'; ls $(SPEC)/*.aon $(SPEC)/example/*.aon
	@echo 'data files vetted:'; for p in $(VET_PAIRS) $(VET_MUSTFAIL); do echo "  $${p#*:}"; done


.PHONY: mock
mock:
	@cd mock && npm start
