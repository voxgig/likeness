# likeness, the C port

C99 and POSIX, and nothing else: no package manager, no library, nothing to
install before `make`. It is the port that shows the stack is not secretly a
JavaScript stack (SPEC §8.1), so it is held to `-std=c99 -Wall -Wextra -Werror
-pedantic` and to a clean run under AddressSanitizer, UBSan and Valgrind.

The corpus suites run on [omni](https://github.com/voxgig/omni), the runner
every port shares, compiled from its C sources into those two test programs
and nothing else. `make c-libs` at the repository root clones it at the
revision `libs.json` pins, and `make c-deps` runs that, then verifies the pin
and links the checkout at `vendor/omni`; `OMNI_HOME` names a checkout of the pin to use
instead. omni's three sources build under the same C99 flags as the port.

```sh
make                  # bin/likeness-c
make test             # the suites below, from this directory
make asan             # the same suites built with AddressSanitizer and UBSan
make valgrind         # the same suites under Valgrind, every spawned binary included
```

From the repository root these are `make test-c`, `make test-c-asan` and
`make test-c-valgrind`, each after `c-deps`; `make check` runs `test-c`.

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
| The unit corpus | every entry but the eighteen of `connections` |
| The core's pure functions | `serialise`, `parseSelector`, `parseSelectorError`, `compareCodePoints`, `lid`, `crockfordAlphabet`, `rfc3339`, `foldCase`, `takeConfigOption`, `parseArgv`, `partialCodes`, `vaultEntry`, and `sources add`'s `secretName` and `refFor` |
| Each adapter's pure half | Joplin's `projectJoplin`; Obsidian's `obsidianUrl`, `vaultEntries`, `vaultWalk`, `obsidianTransport` and `projectObsidian`, with the certificate pin's `parsePin` and `fingerprintOf`; Notion's `notionVersion`, `notionTitle`, `notionSpace`, `notionTime` and `projectNotion` |
| `connections` | waiting on station#23: it opens `station.json` through station |
| `version`, `help`, `which` | answered as the transcript corpus defines them |
| A command the table declares not ready | refused as every port refuses it |
| A command line the grammar refuses | refused as every port refuses it, before anything runs |
| `list`, `get`, `doctor`, the `secrets` and `sources` actions | `unsupported-capability`, exit 4, naming the three issues, for every source alike |
| Reaching an Obsidian vault over its pinned certificate | waiting on sdkgen#403 with every read: the pin's grammar and a certificate's fingerprint are here, the TLS connection that holds a certificate to the pin is not |
| `make parity` | not included: it runs the transcript corpus |
| `make matrix` | every cell red, held to the three issues: each command refuses naming all three, and the mock receives nothing |

The argv shell reads `station.json` and the `likeness.json` beside it only far
enough to refuse a file that is not a JSON object, as the other ports refuse it.
Station's own validation of the file waits on station#23. A configuration that
is not there is absent; one that is there and cannot be read as a file, such as
a directory, is refused as every port refuses it, and so is one nested more than
64 levels deep, counted on the text before it is parsed.

## The suites

| Program | Checks |
|---|---|
| `test/unit.c` | `spec/unit.json`, one omni run per group, each entry's `fn` resolved from the registry and its answer the port's own serialisation read back, so `true` and `1` stay different. `connections` is declared waiting: omni's wait flag holds each of its entries to that cause while it fails, and each is also reported as a TAP `SKIP`, never as a pass. The run fails if the waiting list names a function the port implements or one the corpus does not use, or if the corpus uses a function the port neither implements nor declares. `unit ROOT --eval` answers `{"fn","in"}` lines on stdin, for comparing the port with another |
| `test/transcript.c` | the 43 entries of `spec/cli.json` this port answers, one omni run per group, against the committed bytes in `spec/expect/`. An answered entry that also asserts the vault is held by omni's wait flag, and a further run requires it to pass with that assertion taken out. Every other entry is a `SKIP`, checked outside omni: the port's answer to it must be the refusal naming the three issues, and a count requires every entry to be one or the other |
| `test/process.c` | the binary as a process: no checkout and an empty `HOME`, a malformed configuration through both flag forms, one that cannot be read, one nested past 64 levels, a broken pipe, `which` over a real `PATH`, an argument that is not UTF-8 |
| `test/selftest.c` | the building blocks against the canonical runtime: Node's `Number` formatting, `JSON.parse`, its UTF-8 decoder, `String.prototype.slice` and `path.posix`, and the FIPS 180-4 SHA-256 examples |

The unit and transcript suites prove they can go red: their meta checks mutate
an entry, an expectation or a declaration and require the failure to be
reported, through omni where omni compares, naming the fields it finds
differing.

## Layout

The sources follow the TypeScript port's modules, which is canonical.

| File | Holds |
|---|---|
| `src/envelope.c` | the serialiser: sorted keys by code point, the escaping rules, integers within a double's exact range, a raw payload's numbers as ECMAScript writes them |
| `src/selector.c` | the selector tokeniser and parser, offsets in bytes |
| `src/identity.c`, `src/sha256.c` | `lid` and Crockford base32 over a SHA-256 written here, `rfc3339`, and an RFC 3339 time read back to its instant |
| `src/evaluate.c` | case folding: A-Z to a-z and nothing else, so no Unicode table |
| `src/args.c` | the one table-driven parser over the embedded `commands.json` |
| `src/vault.c`, `src/joplin.c` | the vault entry's path resolution and refusals, and the Joplin projection |
| `src/obsidian.c`, `src/pin.c` | the Obsidian link, the listing rule and the walk, the transport a connection's block declares and the projection; the certificate pin's grammar and a certificate's fingerprint |
| `src/notion.c` | the API version a connection pins, a page's title, space and times, and the projection |
| `src/path.c` | Node's `path.posix`, which the canonical port names files with |
| `src/utf8.c` | the WHATWG decoder Node reads argv, the environment and files with, and a JavaScript string's length and `slice` in UTF-16 code units |
| `src/json.c` | a JSON reader written here, iterative, reading numbers as doubles as `JSON.parse` does |
| `src/core.c`, `src/cli.c`, `src/main.c` | the in-process run, the argv shell and the binary |
| `src/base.c`, `src/errors.c`, `src/spec.c` | allocation and strings, the error registry, the embedded tables parsed once |
| `src/spec_embed.c` | **generated** by `tools/build-spec.mjs`: `commands.json`, `help.json`, `errors.json` and `caps.json` as string literals. `make spec-fresh` fails when it is stale |

Everything here is written for this repository and is under its MIT licence.
