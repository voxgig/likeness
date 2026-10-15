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
| `spec/unit.aontu` — the pure-function corpus | 163 entries, run by every port, C included but for the eighteen of `connections` |
| `spec/cli.aontu` — the transcript corpus | 143 whole commands, run by the TypeScript, Go, Python and Ruby ports; C answers the 37 that need no source |
| `typescript/` — the canonical port | `list`, `get`, `doctor`, `secrets`, `help`, `version`, `which`; offline through the real generated SDK |
| `go/` — the second port | the same, passing the same corpora and the same committed bytes |
| `python/` — the third port | the same again, through station's Python library |
| `ruby/` — the Ruby port | the same again, on station's Ruby library and the SDK's `rb` gem |
| `c/` — the fifth port, C99 and POSIX with no dependency | every pure function of the unit corpus; `version`, `help` and `which`; every other command refused as `unsupported-capability`, naming what it waits on: a live transport in the C SDK ([sdkgen#403](https://github.com/voxgig/sdkgen/issues/403)), two C SDKs in one program ([sdkgen#405](https://github.com/voxgig/sdkgen/issues/405)) and station's C library reading the vault ([station#23](https://github.com/voxgig/station/issues/23)) |
| The parity comparison | `make parity`: the TypeScript, Go, Python and Ruby ports agree, each names itself, and the comparison is proved to go red. It runs the transcript corpus, so C joins it when its transcript cells do |
| `mock/` — a Fastify server emulating all four sources on one port | working, smoke-tested |
| `replica/` — a local SQLite copy reached through a generated SDK | designed; schema and search verified, SDK not generated |

In the staging plan's terms (SPEC §20) this is **Stage 0 and Stage 1** complete — the ground
truth and the walking skeleton, now in four ports, with C through the unit corpus. Stage 2 is
the primary loop: all four sources, and writes.

## Start here

```sh
make sdk         # clone the generated SDKs at their pinned revisions
make py-deps     # the Python port's pinned checkouts and python/.venv
make rb-libs     # clone station, sekreto and plugin, which the Ruby port loads from checkouts
make check       # the schema, every port, both corpora and the parity comparison
make mock        # run the source mock server on 127.0.0.1:7777
```

`make check` is the whole gate. `make help` lists the parts of it.

### Running a command

Every port is a library with a thin argv shell, so a whole command is a pure
function of its inputs and the transcript corpus can run it in-process. From a
built tree:

```sh
node typescript/bin/likeness.js list 'updated>7d' --json
cd go && go run ./cmd/likeness list 'updated>7d' --json
python/.venv/bin/likeness-py list 'updated>7d' --json
ruby/bin/likeness-rb list 'updated>7d' --json         # after `make rb-deps`
```

Every port parses its arguments from one declared table, `spec/commands.aontu`, so the
command line is the same interface in every port: `likeness help` and
`likeness help <command>` print the help rendered from it, and an undeclared flag,
a mistyped value or a misplaced argument is refused as `invalid-argument` before
anything runs. A selector term that begins with `-` follows `--`:
`likeness list -- '-tag:draft title:a'`.

Every port reads `~/.config/likeness/station.json` (or `--config PATH`), which is a
[voxgig/station](https://github.com/voxgig/station) configuration in station's
own grammar. Each instance is a ref under `sdk`: `joplin` for the first Joplin
profile, `joplin$work` for a second. The account each instance belongs to, which
note identity derives from, is in `likeness.json` beside it, under the same
station profile:

```json
{ "station": 1, "profiles": { "default": { "sdk": { "joplin": { "base": "http://localhost:41184" } } } } }
```

```json
{ "likeness": 1, "profiles": { "default": { "instances": { "joplin": { "account": "<the Joplin profile id>" } } } } }
```

A profile reads only its own accounts. Two profiles may declare `joplin`
against different applications, and an account shared between them would give
one profile's notes the other's identities.

Every port binds every client through station, and the calls a command reports
are station's own request events.

### Secrets

Every source token is kept in one [sekreto](https://github.com/voxgig/sekreto)
minivault, `likeness.skmv` beside `station.json` unless the file names another.
That one store is the whole chain: likeness refuses any other kind, so a token
in the environment is never read, and it refuses a passphrase written in the
file.

```json
{ "station": 1, "profiles": { "default": {
  "secrets": { "providers": [{ "kind": "minivault", "file": "likeness.skmv" }] },
  "sdk": { "joplin": { "base": "http://localhost:41184" } } } } }
```

The passphrase comes from `LIKENESS_PASSPHRASE`, or the variable
`--passphrase-env` names, or a prompt when stdin is a terminal. likeness opens
the vault with it and hands station the chain in memory. `--vault-key NAME`
opens the vault as a restricted key, not `master`. `likeness secrets` is the
vault's command line:

```sh
likeness secrets init                                    # the vault and its master key
printf '%s\n' "$TOKEN" | likeness secrets set joplin.apikey -
likeness secrets grant ci joplin.apikey                  # a key that reads only that
likeness secrets list                                    # also get, remove, keys, revoke, rotate
```

Station looks for an instance's token under `<instance>.apikey`, with every
character outside `a-z0-9` written as `_` (`joplin_work.apikey` for
`joplin$work`), unless the instance's block names a `secret`.

A live source reached through the vault needs two station changes that are not
released yet. The TypeScript port's `@voxgig/station` 0.1.0 depends on a sekreto
with no minivault ([voxgig/station#34](https://github.com/voxgig/station/issues/34)),
and Joplin takes its key as the `token` query parameter, which station does not
place ([voxgig/station#25](https://github.com/voxgig/station/issues/25), fixed by
[voxgig/station#28](https://github.com/voxgig/station/pull/28)). With station
`main` and #28 in place, `doctor` and `list` pass against the mock in the
TypeScript, Go and Python ports; the Python port takes #28 when
`python/deps.json` moves its station pin. The Ruby port's station passes
sekreto no plugins, so it cannot open the vault until
[voxgig/station#40](https://github.com/voxgig/station/pull/40) lands
([voxgig/station#33](https://github.com/voxgig/station/issues/33)).

With no instances configured they answer `no-match` and exit 1, which is the
answer "none" rather than an error.

- [PROCESS.md](PROCESS.md) — how this repository is developed, and why
  unit tests use the SDKs' own offline test mode
- [spec/README.md](spec/README.md) — the schema, file by file
- [mock/README.md](mock/README.md) — the mock server and the wire quirks it preserves
- [replica/README.md](replica/README.md) — the local SQLite replica: why it is an SDK, what it buys (search), and the three ports that need a dependency for it
- [upstream/](upstream/) — gaps found in the SDKs and the toolchain, written up ready to file

MIT.
