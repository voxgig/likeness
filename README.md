# likeness

A command-line client for the notes you already keep in other people's
applications — Linear, Notion, Obsidian and Joplin. One vocabulary, one selector
grammar, one output shape, over four APIs that agree about almost nothing.

It is also, deliberately, a case study: every source is reached through a
generated SDK from [voxgig-sdk](https://github.com/voxgig-sdk), and the whole
application is built five times over — TypeScript, Go, Python, Ruby and C — and
held to byte-identical output by a shared parity corpus.

The reasoned specification lives in
[`metsitaba/project-specs`](https://github.com/metsitaba/project-specs) under
`likeness/`. This repository holds the machine-checkable form and the code.

## State of the repository

| Part | State |
|---|---|
| `spec/` — the aontu ground-truth schema | shapes complete; source, capability, error and both corpora populated |
| `spec/unit.aon` — the pure-function corpus | 59 entries, run by both ports |
| `spec/cli.aon` — the transcript corpus | 38 whole commands, run by both ports |
| `typescript/` — the canonical port | `list`, `get`, `doctor`, `version`, `which`; offline through the real generated SDK |
| `go/` — the second port | the same, passing the same corpora and the same committed bytes |
| The parity comparison | `make parity`: the ports agree, each names itself, and the comparison is proved to go red |
| `mock/` — a Fastify server emulating all four sources on one port | working, smoke-tested |
| `replica/` — a local SQLite copy reached through a generated SDK | designed; schema and search verified, SDK not generated |
| Python, Ruby and C | not started |

In the staging plan's terms (SPEC §20) this is **Stage 0 and Stage 1** complete — the ground
truth and the two-port walking skeleton. Stage 2 is the primary loop: all four sources, Python
and Ruby, and writes.

## Start here

```sh
make sdk         # clone the generated SDKs at their pinned revisions
make check       # the schema, both ports, both corpora and the parity comparison
make mock        # run the source mock server on 127.0.0.1:7777
```

`make check` is the whole gate. `make help` lists the parts of it.

### Running a command

Both ports are libraries with a thin argv shell, so a whole command is a pure
function of its inputs and the transcript corpus can run it in-process. From a
built tree:

```sh
node typescript/bin/likeness.js list 'updated>7d' --json
cd go && go run ./cmd/likeness list 'updated>7d' --json
```

Both read `~/.config/likeness/station.json` for connections. With none
configured they answer `no-match` and exit 1, which is the answer "none" rather
than an error.

- [PROCESS.md](PROCESS.md) — how this repository is developed, and why
  unit tests use the SDKs' own offline test mode
- [spec/README.md](spec/README.md) — the schema, file by file
- [mock/README.md](mock/README.md) — the mock server and the wire quirks it preserves
- [replica/README.md](replica/README.md) — the local SQLite replica: why it is an SDK, what it buys (search), and the three ports that need a dependency for it
- [upstream/](upstream/) — gaps found in the SDKs and the toolchain, written up ready to file

MIT.
