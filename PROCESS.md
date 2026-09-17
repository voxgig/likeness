# likeness — the development process

This repository is developed **schema-first**. `spec/def/` is an
[aontu](https://www.npmjs.com/package/aontu) schema that specifies the
application, and it is ground truth in a literal sense: a claim that is not in
it, or that contradicts it, fails a build rather than surviving as an opinion.

`SPEC.LIKENESS.md` in `metsitaba/project-specs` remains the reasoned source of
record — it says *why*. `spec/` is its testable projection — it says exactly
*what*, in a form that a machine refuses to let drift. Where the two disagree,
that is a bug in one of them, and it is fixed in one commit.

---

## 1. The loop

Four commands, after every change. They are the shape of the `check.sh` that
`aontu init` writes for any project, applied to this one.

```sh
make spec-check                      # 1. does every data file satisfy its shape?
make spec-agree                      # 2. does the capability matrix match the SDKs?
aontu model get '$.capability.notion.entity.note.op' spec/caps.aon   # 3. what does it say?
aontu model why  '$.capability.notion.entity.note.op' spec/caps.aon  # 4. why does it say that?
```

Steps 3 and 4 are not decoration. `model why` reports **every contribution to a
value with the line it was written on**, which is the difference between knowing
what the schema says and knowing who said it. Reach for it the moment a value
surprises you, and before changing the thing you assume produced it.

### The gates, and what each one is for

| Gate | Catches |
|---|---|
| `make spec-check` | a data file that violates its shape — with a path, an expected, an actual, and both source lines |
| `make spec-check` red cases | a gate that has stopped gating. `spec/example/likeness-broken.aon` **must fail**; if it passes, the build fails |
| `make spec-agree` | the capability matrix and the SDK registry disagreeing while both remain individually valid |
| `make spec-fmt` | formatting drift, so a diff is about meaning |
| `make spec-hash` | a pin per schema file, for the AGENTS.md stanza and for release notes |

---

## 2. Rules for writing schema

Learned by running aontu 0.67.0, not assumed. Each one cost time to find.

**A schema file does not evaluate on its own, and that is correct.** A shape is
a truth, not a value. `aontu spec/def/project.aon` reports that it has no value
for `$.project.name`, which is exactly what it should say. Use `vet`.

**A data file must never import its own shape.** `vet` composes the two. A data
file that begins `@"./def/source.aon"` puts the shape's declarations on the
*data* side, where they read as unsatisfied requirements, and the verdict comes
back `incomplete` (exit 3) rather than `valid`. This is the single most
confusing failure in the toolchain and it looks like a schema bug.

**Use `type(...)` for structures and `hide(...)` for enumerations.** Both keep a
definition out of generated output. A bare disjunction that is neither cannot
generate and surfaces as `disjunct_no_gen`.

**Literal disjunctions are fine.** The SDK repositories' `AGENTS.md` says
literal disjunctions are "fragile in aontu" and recommends `*'prod' | string`
with the enum enforced in code. That guidance is about *generating* a value from
an unresolved disjunction. As a **schema** on 0.67 a literal disjunction is
exact and gives a far better error than a bare `string` ever will. Do not
"fix" the enumerations in `spec/def/` into `*x | string`.

**`close()` is what catches a typo.** Without it, `instanse: 'plan'` is simply
an extra key nobody asked about. With it, it is a failure with a line number.
Every record shape in `spec/def/` is closed.

**A quoted `"*"` is a key named `*`, not a wildcard.** A schema written that way
constrains nothing and still reports `valid`. Reach for `&:`.

**Regex is restricted, on purpose.** `re()` refuses backreferences, lookaround
and a quantifier applied to a group that contains one, because those backtrack
exponentially in one of the two host engines. Write `[ab]+`, not `(?:a|b)+`.

**`aontu jsonschema` is an export, not the gate.** Named definitions come out
faithfully — `pattern`, `minimum`, `enum`, `additionalProperties: false`. But a
conjunction written *inside* a `&:` template exports as `{}`, which admits
anything. aontu says so rather than hiding it, on stderr:

```
lossy: $.x.&.conj unresolved: this is not a value yet, so there is nothing to
constrain a consumer to; the schema admits anything here
```

So `make spec-json` is for a consumer who wants the shape in a familiar format,
and **`aontu vet` remains the only authority**. Read the `lossy:` lines before
handing the export to anyone who will validate against it.

---

## 3. Changing the schema

A change to `spec/def/` is a change to the application's contract. Before
proposing one:

```sh
aontu breaking --against HEAD spec/def/error.aon
```

Read the **verdict line**, not the exit status: `breaking` currently exits `0`
whatever it concludes, so a CI gate must parse the output. The verdict names the
class — `compat_required_added`, `sub_unresolved` — with both source lines.

Renaming an error code, removing a capability key, or making an optional field
required are all breaking. They are allowed; they are not allowed to be silent.

---

## 4. The SDKs are upstream, and they are pinned

Every source is reached through a generated SDK from
[github.com/voxgig-sdk](https://github.com/voxgig-sdk). **No port hand-writes an
HTTP client.** Doing so would put the project's own claim in doubt, since the
point of likeness is that generated SDKs can carry a real application in five
languages.

`spec/sources.aon` is the registry: which SDK, at which revision, with the exact
dependency line per language.

### Pinning is by commit sha, and that is not a style choice

None of the four SDK repositories carries a git tag, and none of their packages
resolves from npm, PyPI, RubyGems or the Go module proxy. Their READMEs offer
"install from git tag" and the tag list is empty. A commit sha is therefore the
only pin that pins. When the packages are published, `spec/sources.aon` gains a
`published: true` per target and the `pin` lines become ordinary version ranges;
until then, `rev` is required and `make spec-check` enforces it.

### Re-pinning

Re-pinning an SDK is a deliberate change with its own commit:

1. Update `rev` and `pin` for that source in `spec/sources.aon`.
2. `make spec-agree` — the SDK's operation surface may have changed, and a
   capability row that no longer matches must fail here rather than at runtime.
3. Re-run the parity corpora. A parity failure six months from now is far more
   likely to be an upstream bump than a change in this repository, which is why
   the pinned revisions are recorded rather than floated.

---

## 5. Unit tests use the SDKs' offline test mode

**This is the default, not an option.** Every generated SDK ships a `test`
feature that replaces its HTTP transport with an in-memory mock seeded from a
map of records. It exists in all seven generated languages — TypeScript, Go,
Python, Ruby, C, PHP and Lua — so every likeness port has it.

```ts
const client = JoplinSDK.test({ entity: { note: { n1: { id: 'n1', title: 'T' } } } })
```

The seeding shape is `{entity: {<entity>: {<id>: <record>}}}`, and the SDK
stamps the map key onto the record's own identifier field.

**That field is derived, not fixed.** The SDK works it out from the entity's
route, so it is declared per source in `spec/sources.aon` under `test.idfield`
rather than assumed. For all four sources it derives to `id` — verified by
running each SDK's own resolver over its own config, not by reading the routes,
which is a distinction worth keeping: the Obsidian vault route is
`/vault/{filename}` and its seeding key is still `id`. Check the declaration
before writing a seed for a new entity. A seed written against the wrong field
is silently never found, and the test fails in a way that looks like a logic
bug.

**Always supply an explicit `id` on a create.** When a create supplies none, the
mock mints a random one — and the ports do not agree on its form. TypeScript
builds it from four unpadded `Math.random()` values then pads the result to
sixteen characters; Go, Python, Ruby and C each format four full 16-bit values
as `%04x`. So a created record's identifier is both non-reproducible *and*
differently shaped between ports, which defeats byte-identical output at its
root. This is recorded as `mints_id: true` in `spec/sources.aon` and is filed
upstream; supplying the id avoids it entirely.

**Network conditions come from the same feature.** `SDK.test({net: {...}})`
gives `latency`, `failTimes` with `failStatus`, `errorTimes` and `offline`,
counter-driven and therefore deterministic. Use it for the retry, timeout and
rate-limit paths.

**There is no separate `netsim` feature.** The four SDKs generate exactly eight
features: `debug`, `idempotency`, `metrics`, `paging`, `ratelimit`, `retry`,
`test` and `timeout`. netsim is the `net:` option of `test`. Any plan that
speaks of "the netsim feature" is describing something that does not exist.

### The feature is not yet identical across the ports

The TypeScript implementation is the same 494 lines in all four SDKs, so there
is one intended semantic — but the other ports implement different subsets of
it. This is recorded in `upstream/issue/07`, and until it is fixed upstream it
constrains where the offline mode can be relied on:

| Behaviour | TS | Go | Py | Rb | C |
|---|---|---|---|---|---|
| multi-segment response envelope (`body.data.x.y`) | yes | yes | yes | **no** | **no** |
| `update` whose id matches nothing | **404** | 200, clobbers a record | 200, clobbers the first | 200, clobbers the first | 200, clobbers the first |
| `update` merge depth | **deep** | shallow | shallow | shallow | shallow |
| stamps `id` from the seed map key | yes | yes | yes | **no** | yes |
| required query params also matched | yes | yes | yes | **no** | **no** |

**The consequence that changes plans: Linear cannot be tested offline in the
Ruby or C ports.** Every Linear operation unwraps a multi-segment envelope —
`body.data.issue`, `body.data.issueCreate.issue` — and those two ports
synthesise only a single segment. So until `issue/07` is resolved, the Ruby and
C ports reach Linear through `mock/` instead. That is a declared exception with
a named cause, not a port quietly growing its own mock.

**And treat an `update` against an unseeded id as undefined behaviour** in every
port. It is a 404 in TypeScript and a silent clobber of an unrelated record in
the other four, which is the failure a mock exists to prevent. Seed what you
update.

### Where the mock server still earns its place

`mock/` is a Fastify server emulating all four sources on one port. It is **not**
redundant with the SDKs' offline mode, and the two have different jobs:

| Use | Mechanism |
|---|---|
| Unit tests of likeness logic, per port, offline, no process | `SDK.test({entity, net})` |
| Whole-command transcript entries | `SDK.test({entity, net})` |
| Proving the generated client's real wire behaviour — headers, encoding, status codes, GraphQL error envelopes | `mock/` |
| Exercising auth failure, pagination headers, and vendor quirks the in-memory mock does not model | `mock/` |
| Linear, in the Ruby and C ports, until `upstream/issue/07` is fixed | `mock/` |

The rule: **if a test asserts on likeness's behaviour, it uses the SDK's test
mode; if it asserts on the wire, it uses `mock/`.**

---

## 6. Filing issues upstream

likeness consumes four SDK repositories and their generator, and owns none of
them. It is the downstream customer whose complaints improve them, so **a gap
found here is filed, not worked around**. A local workaround for a generator bug
is a fork with extra steps, and it hides the evidence that would have fixed it
for everyone.

### Where a bug belongs

The SDKs are generated, so the repository you noticed a bug in is usually not
where it should be fixed. Decide in this order:

| The wrong thing is in | Fix belongs in | Example |
|---|---|---|
| A language directory (`ts/`, `go/`, `c/` …) | **not there** — it is build output | a typo in `ts/src/entity/NoteEntity.ts` |
| Behaviour that is the same for every API | `voxgig/sdkgen` — the template under `.sdk/tm/` | the test feature minting a random id |
| Behaviour that depends on this API | that SDK repo's `.sdk/model/` | a wrong `id.field` for an entity |
| The API definition's coverage | that SDK repo's `.sdk/def/` | no search operation in the definition |
| The definition parser | `voxgig/apidef` | an OpenAPI construct read wrongly |
| The schema language or its CLI | `aontu` | `--coverage` miscounting |

File against the SDK repository when the fix lands in its `.sdk/`; file
upstream when the fix lands in a generator or the language, and cross-reference
from the SDK repository so the trail is followable.

### What an issue must carry

An issue from likeness is worth more than a bug report from a stranger because
it can be exact. Include:

- the **repository and revision** it was observed at, from `spec/sources.aon`;
- the **generated file and line**, and the **model or template file** the fix
  belongs in;
- a **minimal reproduction** that runs with no credentials and no network — the
  SDKs' own offline test mode makes this always possible;
- what it costs likeness, specifically. "This breaks byte-identical output
  across five ports" is actionable in a way that "this seems wrong" is not.

[`upstream/`](upstream/) holds the issues found so far, each written to be filed
as-is. When one is filed, add its link to the top of the file rather than
deleting it: a closed issue next to the schema that depends on it is how a
future reader learns why a workaround here exists.
