# `spec/` — the likeness ground-truth schema

The application, specified in [aontu](https://www.npmjs.com/package/aontu) so
that a machine can refuse to let it drift.

```
spec/
  def/              THE SHAPES. Truths, not values: these do not evaluate alone.
    likeness.aon      entry point — includes every shape below
    base.aon          primitive named types every other file is built from
    note.aon          the six projected entities
    source.aon        the source registry: which SDK, which revision, how it is test-seeded
    capability.aon    the capability matrix shape
    error.aon         the error and exit code registry shape
    envelope.aon      the output envelope shape
    command.aon       the CLI command surface shape
    project.aon       the project file shape
    corpus.aon        the unit and transcript corpus shapes
  sources.aon       DATA. The four SDKs, pinned by revision.
  caps.aon          DATA. What each source can and cannot do.
  errors.aon        DATA. Every code likeness can emit.
  example/
    likeness.aon          a valid project file
    likeness-broken.aon   a deliberately invalid one; CI asserts it FAILS
```

## What is exercised, and what is not

Four of the ten shapes have no data file yet, and therefore have never been run
against a value. They are named here rather than left to be discovered:

| Shape | Data | Note |
|---|---|---|
| `source.aon` | `sources.aon` | checked |
| `capability.aon` | `caps.aon` | checked |
| `error.aon` | `errors.aon` | checked |
| `project.aon` | `example/likeness.aon` + a red case | checked |
| `base.aon` | — | exercised through the four above |
| `note.aon` | **none** | the projected entity model |
| `envelope.aon` | **none** | the output shape every port must match byte for byte |
| `command.aon` | **none** | the CLI surface `describe` is generated from |
| `corpus.aon` | **none** | both parity corpora |

So `make spec-check` currently proves that three registries and one example
project file are internally consistent. It does not yet say anything about the
four shapes the project's central claims rest on. Each gets a data file as the
stage that needs it lands, and until then this table is the honest statement of
coverage.

## Check it

```sh
make spec-check     # every data file against its shape, and the red cases stay red
make spec-agree     # the capability matrix against the SDKs it claims to reach
make spec           # both, plus formatting
```

## Ask it

```sh
aontu model get '$.error.budget-exceeded' spec/errors.aon
aontu model why '$.capability.notion.entity.note.op.delete' spec/caps.aon
aontu jsonschema spec/def/likeness.aon
```

## Two rules that are easy to get wrong

**A data file must not import its own shape.** `aontu vet` composes them. A data
file that imports its shape puts the shape's declarations on the data side and
the verdict comes back `incomplete` instead of `valid`.

**A shape file failing to evaluate on its own is correct.** `aontu
spec/def/project.aon` reports that it has no value for `$.project.name`. That is
the shape doing its job. Use `vet`.

[PROCESS.md](../PROCESS.md) has the rest: how to change a shape, how the SDKs
are pinned, why unit tests use the SDKs' offline test mode, and where to file a
bug that is really upstream.
