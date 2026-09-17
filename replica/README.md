# `replica/` — the local SQLite copy, reached through a generated SDK

A subproject of likeness. It holds a local copy of what the four sources hold,
and **it is reached through a generated SDK like any other source**, so the core
has no special case for it and the access layer is generated rather than written
five times.

## Why an SDK and not a database layer

Five ports over one schema would otherwise mean five hand-written query layers,
and they would diverge — which is the failure this whole project exists to
prevent, reappearing inside it. Generated from one definition, the queries, the
row mapping and the entity surface are the same artefact everywhere.

**The mechanism already exists and is already proven.** A generated SDK's
transport is a single function, and a feature declaring `transport: 'base'`
replaces it. That is exactly what the SDKs' own offline `test` feature does, in
all seven generated languages. The replica is not a new mechanism; it is an
existing one pointed at a file instead of at an in-memory map.

```
generated entity surface   ─┐
generated queries           ├─ one artefact, five ports
generated row mapping      ─┘
        │
        ▼
  transport: 'base'          ← the only per-port code
        │
        ▼
  "run this statement, give me rows"
```

## What it buys: search

**No source's SDK has a search operation.** Not Joplin, Notion, Obsidian or
Linear — every definition is a scoped subset and none includes one. Without a
replica there is no cross-source search at all, only client-side filtering over
whatever `list` returns, and Notion has no `list` either.

With the replica there is one FTS5 index over every source at once:

```
$ likeness search 'retention' --replica
  plan   CORE-412               Retention policy for archived notes
  docs   9f2c1a7b               Data retention policy (draft)
  vault  launch/retention.md    Retention policy
```

`schema.sql` builds that as an external-content FTS5 table over `note`, so the
text is stored once and three triggers keep the index current. Verified working,
including column filters such as `body:legal`.

## What it costs: three ports need a dependency

This is the honest headline, and it is why `spec/replica.aon` records it per
port as data rather than as a footnote. Measured, not assumed:

| Port | SQLite | Dependency |
|---|---|---|
| Python | `sqlite3`, standard library, FTS5 present | no |
| TypeScript | `node:sqlite`, standard library from Node 22.5 | no, but still flagged experimental |
| C | the public-domain amalgamation, vendored in-tree | no, same precedent as the in-tree SHA-256 |
| Go | **no standard library driver exists** — `database/sql` is an interface only | **yes** |
| Ruby | **no stdlib sqlite** — the gem builds a native extension | **yes** |

The project's rule is that no port carries a third-party runtime dependency.
Go and Ruby cannot honour it here. That is a **declared parity exception with a
reason per port**, in the same register as the C port's env-only secret backend
— not a quiet import.

It also reverses a recorded decision. `SPEC.LIKENESS.md` §22 Q3 asked whether
likeness needs a local index and leaned towards JSON-lines **specifically so the
C port would need no database**. C turns out to be the easy case, because
vendoring one public-domain source file is what that port already does for
SHA-256. Go and Ruby are the hard ones, which is the opposite of what the
leaning assumed.

## The rules that keep it a cache

likeness is not a notes application and owns nothing (§5). Four rules, declared
in `spec/def/replica.aon` so that a port breaking one fails a check rather than
a code review:

- **Write-through.** A write goes to the source first and reaches the replica
  only after the source accepts it. Never the other way round.
- **Disposable.** Deleting the file is always safe and loses nothing. A replica
  written by an older likeness is discarded and rebuilt rather than migrated: it
  is a cache, so rebuilding is always correct and cheaper than a migration
  nobody tested.
- **Reads are marked.** An answer served from the replica says so in the
  envelope, so a caller can tell a cached answer from a fetched one.
- **Opt-in.** Off unless asked for. A cache that turns itself on changes what
  every existing command means.

## Layout

```
replica/
  README.md                   this file
  schema.sql                  the SQLite schema, including the FTS5 index
  def/likeness-replica.json   the definition the SDK is generated from
```

`def/likeness-replica.json` describes the replica as an API so sdkgen can
consume it. **The paths are nominal**: nothing is served over HTTP, and they
exist only because that is how sdkgen names an operation and derives an entity
surface. The `servers` entry says so out loud.

## State

Designed, not built. The schema applies and its search is verified; the SDK has
not been generated, which is why `spec/replica.aon` carries a zero revision. The
shape, the rules and the per-port cost are settled first on purpose — the cost
is the part most likely to change the decision, and it should be visible before
any code depends on it.
