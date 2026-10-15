# `spec/` — the likeness ground-truth schema

The application, specified in [aontu](https://www.npmjs.com/package/aontu) so
that a machine can refuse to let it drift.

```
spec/
  def/              THE SHAPES. Truths, not values: these do not evaluate alone.
    likeness.aontu      entry point — includes every shape below
    base.aontu          primitive named types every other file is built from
    note.aontu          the six projected entities
    source.aontu        the source registry: which SDK, which revision, how it is test-seeded
    capability.aontu    the capability matrix shape
    error.aontu         the error and exit code registry shape
    envelope.aontu      the output envelope shape
    command.aontu       the CLI command surface shape
    project.aontu       the project file shape
    corpus.aontu        the unit and transcript corpus shapes
  sources.aontu       DATA. The four SDKs, pinned by revision.
  caps.aontu          DATA. What each source can and cannot do.
  errors.aontu        DATA. Every code likeness can emit.
  commands.aontu      DATA. The command surface and its argument grammar.
  unit.aontu          DATA. The unit corpus: pure functions, every port.
  cli.aontu           DATA. The transcript corpus: whole commands, every port.
  help.json           RENDERED from commands.aontu by `make spec-build`; `help` prints it.
  expect/             What each transcript entry prints, byte for byte.
  written/            What each transcript entry writes, byte for byte.
  example/
    likeness.aontu          a valid project file
    likeness-broken.aontu   a deliberately invalid one; CI asserts it FAILS
```

`make spec-build` compiles the data files to `spec/*.json`. It also writes
`errors.json`, `caps.json`, `commands.json` and `help.json` into
`typescript/src/spec/`, `go/spec/`, `python/likeness/spec/` and
`ruby/lib/likeness/spec/`, and the same bytes as string literals into
`c/src/spec_embed.c`, where each port's build embeds them (the Python
package carries them as package data), so an
installed port reads no specification file from disk and needs no checkout.
`make spec-fresh` fails if any copy is stale; none of them is edited by hand.

The command table carries rules its shape cannot say, and the build refuses a
table that breaks them: a command may not redeclare a global flag, only the last
positional repeats, a valued flag names its value, a range belongs to an integer,
and every exit is a registered code. Each source's `connect` row in `caps.aontu`
names the `sources add` flags that source alone reads and the defaults its flags
take, and the build refuses one that names a flag the command does not declare;
the help for `sources add` says which source reads each flag, and its default,
from that row.

A transcript entry runs in a home directory of its own, with the configuration
directory at `~/.config/likeness`. Each of its connections is an instance under
`sdk` in station.json, whose block there is the connection's `block`, or `{}`
when it gives none, and whose seed is its own `fixture`, or the entry's when it
names none. It may bring files into the directory (the fixture vaults under
`fixtures/vault/`, which every port's sekreto reads), give stdin, stand in for a
terminal with the answers typed at its prompts, and say what certificate each
TLS server presents, by `host:port`, for the probe that pins one. An entry that
brings `station.json` or `likeness.json` (from `fixtures/config/`, or what
another entry wrote) is configured by those files alone, read as the argv shell
reads them, and declares no connections. It then asserts the prompts shown, for
a vault command what the vault holds afterwards as one key reads it, and for a
command that writes the configuration each file afterwards, byte for byte
against `spec/written/` or the fixture it brought, and the files that are not
there. The vault's bytes are never compared: they change on every write.

The TypeScript, Go, Python and Ruby ports run both corpora in full, and `make
parity` compares their transcript output byte for byte. The `sources` group, its
76 transcript entries and its 17 unit entries (`secretName`, `refFor`), is built
in TypeScript, with its two pure functions in C as well, and waits to be ported
to Go, Python and Ruby, which already pass the six entries the grammar and help
answer. Where a port's SDK or
station still differs upstream, the port declares the entry waiting, with a reason
naming the issue, and the declaration is held to its cause: the entry must still
fail, and must pass once the cause's predicted change is applied. So a declaration
fails the moment the fix lands, and cannot hide a second difference. Python and
Ruby wait on two Obsidian entries
([sdkgen#418](https://github.com/voxgig/sdkgen/issues/418)), and Go on eight
([station#50](https://github.com/voxgig/station/issues/50), sdkgen#418).
`tools/parity-waiting.json` sets aside Go's one differing answer in the comparison
the same way. The C port runs the unit corpus but for
`connections`, which waits on station's C library reading `station.json`
([station#23](https://github.com/voxgig/station/issues/23)), and the 43 transcript
entries whose answer needs no source: `help`, `version`, `which`, a command not
ready yet, and every command line the grammar refuses. The other transcript entries
wait on a live transport in the C SDK ([sdkgen#403](https://github.com/voxgig/sdkgen/issues/403)),
two C SDKs in one program ([sdkgen#405](https://github.com/voxgig/sdkgen/issues/405))
and station#23; its harness reports each as skipped and checks that the port refuses
it naming all three. Until those land, `make parity` does not include C.

The corpora run offline, through each SDK's test mode. The live path, from each port's
own CLI through its station and vault to a server, is `make matrix`'s
([PROCESS.md](../PROCESS.md) §5). Its red cells are declared in `tools/matrix-waiting.json`,
each naming its upstream issue, and held to what that issue predicts the same way.

## What is exercised, and what is not

Every shape is run against data. The table names the data each one meets:

| Shape | Data | Note |
|---|---|---|
| `source.aontu` | `sources.aontu` | checked |
| `capability.aontu` | `caps.aontu` | checked |
| `error.aontu` | `errors.aontu` | checked |
| `replica.aontu` | `replica.aontu` | checked |
| `project.aontu` | `example/likeness.aontu` + a red case | checked |
| `base.aontu` | — | exercised through every shape that includes it |
| `note.aontu` | every row of a committed `list` or `get` expectation | checked by `make spec-expect` |
| `envelope.aontu` | every committed JSON expectation | checked by `make spec-expect` |
| `command.aontu` | `commands.aontu` + a red case | checked |
| `corpus.aontu` | `unit.aontu`, `cli.aontu` + red cases | checked |

So `make spec-check` proves that the registries, the command table, both corpora
and one example project file are internally consistent, and `make spec-expect`
proves that every committed output is an envelope and every note in one is a
note. The expectations are stripped of `port` and `meta.elapsed_ms` before the
byte comparison, so `spec-expect` puts both back before vetting. Only the note
type is exercised: no command answers a space, tag, link, attachment or comment
yet.

## Check it

```sh
make spec-check     # every data file against its shape, and the red cases stay red
make spec-expect    # every committed expectation against the envelope and note shapes
make spec-agree     # the capability matrix against the SDKs it claims to reach
make spec           # both, plus formatting
```

## Ask it

```sh
aontu model get '$.error.budget-exceeded' spec/errors.aontu
aontu model why '$.capability.notion.entity.note.op.delete' spec/caps.aontu
aontu jsonschema spec/def/likeness.aontu
```

## Two rules that are easy to get wrong

**A data file must not import its own shape.** `aontu vet` composes them. A data
file that imports its shape puts the shape's declarations on the data side and
the verdict comes back `incomplete` instead of `valid`.

**A shape file failing to evaluate on its own is correct.** `aontu
spec/def/project.aontu` reports that it has no value for `$.project.name`. That is
the shape doing its job. Use `vet`.

[PROCESS.md](../PROCESS.md) has the rest: how to change a shape, how the SDKs
are pinned, why unit tests use the SDKs' offline test mode, and where to file a
bug that is really upstream.
