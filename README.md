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
| `spec/unit.aontu` — the pure-function corpus | 292 entries, run by every port, C included but for the eighteen of `connections` |
| `spec/cli.aontu` — the transcript corpus | 259 whole commands, run by the TypeScript, Go, Python and Ruby ports. Where a port's SDK or station still differs upstream, it declares the entry waiting, held to its cause: two Obsidian entries in Python and Ruby ([sdkgen#418](https://github.com/voxgig/sdkgen/issues/418)), eight in Go ([station#50](https://github.com/voxgig/station/issues/50), sdkgen#418). C answers the 43 that need no source |
| `typescript/` — the canonical port | `list`, `get`, `doctor`, `secrets`, `sources`, `help`, `version`, `which`, over Joplin and Obsidian, and Notion by `get`, since its SDK lists no pages; offline through the real generated SDK |
| `go/` — the second port | the same, passing the same corpora and the same committed bytes |
| `python/` — the third port | the same again, through station's Python library |
| `ruby/` — the Ruby port | the same again, on station's Ruby library and the three SDKs' `rb` gems, loaded together with their constant collisions ([sdkgen#404](https://github.com/voxgig/sdkgen/issues/404)) proved inert for what likeness uses |
| `c/` — the fifth port, C99 and POSIX with no dependency | every pure function of the unit corpus; `version`, `help` and `which`; every other command refused as `unsupported-capability`, naming what it waits on: a live transport in the C SDK ([sdkgen#403](https://github.com/voxgig/sdkgen/issues/403)), two C SDKs in one program ([sdkgen#405](https://github.com/voxgig/sdkgen/issues/405)) and station's C library reading the vault ([station#23](https://github.com/voxgig/station/issues/23)) |
| The parity comparison | `make parity`: the TypeScript, Go, Python and Ruby ports agree on every entry but one answer declared waiting in `tools/parity-waiting.json`, each names itself, and the comparison is proved to go red, a stale declaration included. It runs the transcript corpus, so C joins it when its transcript cells do |
| The source × port matrix | `make matrix`: each port's own CLI binary reaches each source through its station-bound SDK, its token in a vault the run makes, against `mock/`. Go, Python and Ruby reach Joplin and Notion, and Obsidian but for its `list`. Every other cell is red, naming in `tools/matrix-waiting.json` the upstream issue it waits on, and is held to what that issue predicts: a station release for TypeScript's vault ([station#34](https://github.com/voxgig/station/issues/34)), Linear ([sdkgen#400](https://github.com/voxgig/sdkgen/issues/400)), C's three, and the walk of an Obsidian vault from its root in Go, Python and Ruby ([sdkgen#419](https://github.com/voxgig/sdkgen/issues/419)). It runs in `make check`, and CI writes its table to the run's summary |
| `mock/` — a Fastify server emulating all four sources on one port | working, smoke-tested |
| `replica/` — a local SQLite copy reached through a generated SDK | designed; schema and search verified, SDK not generated |

In the staging plan's terms (SPEC §20) **Stage 0 and Stage 1** are complete: the ground truth
and the walking skeleton, in four ports, with C through the unit corpus. **Stage 2**, the
matrix, is under way: Joplin, Obsidian and Notion from every port but C, every client bound
through station, and Obsidian over a pinned certificate. `make matrix` runs it from every
port's own CLI against `mock/`: 6 of its 20 cells are green, and it names the upstream issue
behind each red one. Linear waits on [sdkgen#400](https://github.com/voxgig/sdkgen/issues/400).
Stage 3 is the primary loop: search and writes.

## Start here

```sh
make sdk         # clone the generated SDKs at their pinned revisions
make py-deps     # the Python port's pinned checkouts and python/.venv
make rb-libs     # clone station, sekreto and plugin, which the Ruby port loads from checkouts
make check       # the schema, every port, both corpora, the parity comparison and the matrix
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

`likeness sources` keeps both files, under the active profile, so neither need be
written by hand:

```sh
likeness sources add --source joplin --account <the Joplin profile id>   # the token is typed, echo off
likeness sources add --source notion --instance docs --account <workspace id> --secret notion_docs.apikey
likeness sources list                          # ref, source, base, account and secret name, never a value
likeness sources rename 'notion$docs' 'notion$wiki'   # its account goes with it, so no lid changes
likeness sources remove 'notion$wiki'          # its account goes too; its token stays in the vault
likeness sources test joplin                   # doctor's row, for the connections named
```

`add` writes the instance `<api>`, or `<api>$<tag>` with `--instance`, and never
overwrites a connection or a token. It stores the token in the vault under the
instance's secret name before either file changes: typed at a prompt with echo
off, or already stored and named with `--secret`, never an argument. No wired SDK
can name the account a token reaches yet, so `--account` is required, and the
refusal says why for each source; `spec/caps.aontu` marks a source whose SDK can,
and `add` then asks it instead. It pins Obsidian's certificate as the plugin
presents it, read by a probe that writes nothing: on a terminal it shows the
fingerprint and asks, and otherwise `--fingerprint` names it and is held to it.
`--plain-http`, with an `http://` base, writes `"tls": false` instead. Notion's
`notion-version` is `--notion-version`, or 2022-06-28. Joplin's base is
`http://127.0.0.1:41184` unless `--base` says otherwise.

Each write changes both files or neither, and keeps everything in them that it
does not change, in their own order and as written, laid out as
`JSON.stringify(doc, null, 2)` lays out JSON. A rename writes the secret name the
old ref derived into the block, so the token still resolves, and a profile
cannot change a connection it inherits from `default`.

#### Obsidian

Obsidian is reached through its Local REST API community plugin, whose HTTPS
port presents a certificate the plugin made for itself. likeness trusts it by
its SHA-256 fingerprint alone, pinned in the instance's block, and never turns
verification off:

```json
{ "station": 1, "profiles": { "default": { "sdk": { "obsidian": {
  "base": "https://127.0.0.1:27124",
  "options": { "tls": { "fingerprint": "sha256:<the certificate's SHA-256, in hex>" } } } } } } }
```

The plugin serves its certificate at `/obsidian-local-rest-api.crt`, and
`openssl x509 -noout -fingerprint -sha256 -in obsidian-local-rest-api.crt`
prints the digest, which may be written after `sha256:` with its colons or
without them. A certificate that no longer matches is refused as
`certificate-rejected` before any request is written. The plugin's plain HTTP
port is used only where the block says so, with `"base": "http://127.0.0.1:27123"`
and `"options": { "tls": false }`, and `doctor` reports it. The instance's
account is the vault's id, which its notes' `obsidian://` links name.

#### Notion

Every request to Notion carries the API version it was written against, so
each Notion connection pins one, as its only header, and a connection that pins
none is refused before any call:

```json
{ "station": 1, "profiles": { "default": { "sdk": { "notion": {
  "options": { "headers": { "notion-version": "2022-06-28" } } } } } } }
```

A page is read by `get notion:<page id>`. Notion's generated SDK has no way to
list pages, so `list` names Notion as a connection that cannot answer, and
`list --source notion` is refused before any call.

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

The Go, Python and Ruby ports take station at the `main` revision that places
Joplin's `token` query parameter
([voxgig/station#25](https://github.com/voxgig/station/issues/25)) and passes
sekreto every plugin in Ruby
([voxgig/station#33](https://github.com/voxgig/station/issues/33)), so each
reaches a live source through the vault. The TypeScript port takes station from
npm, and `@voxgig/station` 0.1.0 depends on a sekreto with no minivault
([voxgig/station#34](https://github.com/voxgig/station/issues/34)); the release
that fixes it is [voxgig/station#62](https://github.com/voxgig/station/pull/62).
`make matrix` holds that as a red cell naming its issue, and fails the day it
stops holding.

With no instances configured they answer `no-match` and exit 1, which is the
answer "none" rather than an error.

- [PROCESS.md](PROCESS.md) — how this repository is developed, and why
  unit tests use the SDKs' own offline test mode
- [spec/README.md](spec/README.md) — the schema, file by file
- [mock/README.md](mock/README.md) — the mock server and the wire quirks it preserves
- [replica/README.md](replica/README.md) — the local SQLite replica: why it is an SDK, what it buys (search), and the three ports that need a dependency for it
- [upstream/](upstream/) — gaps found in the SDKs and the toolchain, written up ready to file

MIT.
