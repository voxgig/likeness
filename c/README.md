# likeness, the C port

C99 and POSIX, and nothing else: no package manager, no library, nothing to
install before `make`. It is the port that shows the stack is not secretly a
JavaScript stack (SPEC §8.1), so it is held to `-std=c99 -Wall -Wextra -Werror
-pedantic` and to a clean run under AddressSanitizer, UBSan and Valgrind.

```sh
make                  # bin/likeness-c
make test             # the suites below, from this directory
make asan             # the same suites built with AddressSanitizer and UBSan
make valgrind         # the same suites under Valgrind, every spawned binary included
```

From the repository root these are `make test-c`, `make test-c-asan` and
`make test-c-valgrind`; `make check` runs `test-c`.

## What it answers, and what waits

The port cannot reach a source yet. The C SDK has no live transport
([voxgig/sdkgen#403](https://github.com/voxgig/sdkgen/issues/403)), two C SDKs
cannot be linked into one program
([voxgig/sdkgen#405](https://github.com/voxgig/sdkgen/issues/405)), and
station's C library reads only the environment, so it can neither validate
`station.json` nor open the vault
([voxgig/station#23](https://github.com/voxgig/station/issues/23)). So:

| Part | State |
|---|---|
| The unit corpus | every pure function: `serialise`, `parseSelector`, `parseSelectorError`, `compareCodePoints`, `lid`, `crockfordAlphabet`, `rfc3339`, `foldCase`, `takeConfigOption`, `parseArgv`, `partialCodes`, `projectJoplin`, `vaultEntry` |
| `connections` | waiting on station#23: it opens `station.json` through station |
| `version`, `help`, `which` | answered as the transcript corpus defines them |
| A command the table declares not ready | refused as every port refuses it |
| A command line the grammar refuses | refused as every port refuses it, before anything runs |
| `list`, `get`, `doctor`, the `secrets` actions | `unsupported-capability`, exit 4, naming the three issues |
| `make parity` | not included: it runs the transcript corpus |

The argv shell reads `station.json` and the `likeness.json` beside it only far
enough to refuse a file that is not a JSON object, as the other ports refuse it.
Station's own validation of the file waits on station#23. A configuration that
is not there is absent; one that is there and cannot be read as a file, such as
a directory, is refused as every port refuses it, and so is one nested more than
64 levels deep, counted on the text before it is parsed.

## The suites

| Program | Checks |
|---|---|
| `test/unit.c` | `spec/unit.json`, entry by entry. `connections` is declared waiting, and the run fails if that list names a function the port implements or one the corpus does not use, or if the corpus uses a function the port neither implements nor declares. A waiting entry is reported as a TAP `SKIP`, never as a pass. `unit ROOT --eval` answers `{"fn","in"}` lines on stdin, for comparing the port with another |
| `test/transcript.c` | the 37 entries of `spec/cli.json` this port answers, against the committed bytes in `spec/expect/`. Every other entry is a `SKIP`, and the port's answer to it must be the refusal naming the three issues |
| `test/process.c` | the binary as a process: no checkout and an empty `HOME`, a malformed configuration through both flag forms, one that cannot be read, one nested past 64 levels, a broken pipe, `which` over a real `PATH`, an argument that is not UTF-8 |
| `test/selftest.c` | the building blocks against the canonical runtime: Node's `Number` formatting, `JSON.parse`, its UTF-8 decoder and `path.posix`, and the FIPS 180-4 SHA-256 examples |

The unit and transcript suites prove they can go red: their meta checks mutate
an entry, an expectation or a declaration and require the failure to be
reported.

## Layout

The sources follow the TypeScript port's modules, which is canonical.

| File | Holds |
|---|---|
| `src/envelope.c` | the serialiser: sorted keys by code point, the escaping rules, integers within a double's exact range, a raw payload's numbers as ECMAScript writes them |
| `src/selector.c` | the selector tokeniser and parser, offsets in bytes |
| `src/identity.c`, `src/sha256.c` | `lid` and Crockford base32 over a SHA-256 written here, and `rfc3339` |
| `src/evaluate.c` | case folding: A-Z to a-z and nothing else, so no Unicode table |
| `src/args.c` | the one table-driven parser over the embedded `commands.json` |
| `src/vault.c`, `src/joplin.c` | the vault entry's path resolution and refusals, and the Joplin projection |
| `src/path.c` | Node's `path.posix`, which the canonical port names files with |
| `src/utf8.c` | the WHATWG decoder Node reads argv, the environment and files with |
| `src/json.c` | a JSON reader written here, iterative, reading numbers as doubles as `JSON.parse` does |
| `src/core.c`, `src/cli.c`, `src/main.c` | the in-process run, the argv shell and the binary |
| `src/base.c`, `src/errors.c`, `src/spec.c` | allocation and strings, the error registry, the embedded tables parsed once |
| `src/spec_embed.c` | **generated** by `tools/build-spec.mjs`: `commands.json`, `help.json`, `errors.json` and `caps.json` as string literals. `make spec-fresh` fails when it is stale |

Everything here is written for this repository and is under its MIT licence.
