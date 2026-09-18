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
| `spec/` — the aontu ground-truth schema | shapes complete; source, capability and error data populated |
| `mock/` — a Fastify server emulating all four sources on one port | working, smoke-tested |
| `replica/` — a local SQLite copy reached through a generated SDK | designed; schema and search verified, SDK not generated |
| The five ports | not started |
| The parity corpora | shapes defined, entries not written |

## Start here

```sh
make spec        # check the schema and its data
make mock        # run the source mock server on 127.0.0.1:7777
```

- [PROCESS.md](PROCESS.md) — how this repository is developed, and why
  unit tests use the SDKs' own offline test mode
- [spec/README.md](spec/README.md) — the schema, file by file
- [mock/README.md](mock/README.md) — the mock server and the wire quirks it preserves
- [replica/README.md](replica/README.md) — the local SQLite replica: why it is an SDK, what it buys (search), and the three ports that need a dependency for it
- [upstream/](upstream/) — gaps found in the SDKs and the toolchain, written up ready to file

MIT.
