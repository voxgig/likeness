# `upstream/` — issues to file, and why they are here rather than filed

likeness consumes four generated SDKs and their toolchain and owns none of them.
[PROCESS.md](../PROCESS.md) §6 says a gap found here is **filed, not worked
around**, and says how to decide which repository owns the fix.

Each file in `issue/` is one issue, written to be filed as-is: it names the
repository, the revision it was observed at, the file and line, a reproduction
that needs no credentials and no network, and what it costs likeness
specifically. Filing one means pasting it into a new issue on the named
repository.

They are drafted here rather than filed directly because the session that found
them had read-only access to the `voxgig-sdk` organisation. That is a permission
boundary, not a judgement about whether they should be raised — they should.

## Filed

Every issue whose fix belongs in **`voxgig/sdkgen`** is now filed there, re-verified
against `sdkgen@4089761` before filing rather than against the generated output where
it was noticed — which is the rule in [PROCESS.md](../PROCESS.md) §6, and which changed
one of them substantially.

| Draft | Filed as | What |
|---|---|---|
| `issue/10` | [sdkgen#163](https://github.com/voxgig/sdkgen/issues/163) | every numeric feature option is silently dropped when it arrives as `json.Number` |
| `issue/11` | [sdkgen#164](https://github.com/voxgig/sdkgen/issues/164) | paging is inactive by default, blind to `has_more`, and reachable only via `client._paging` |
| `issue/05` | [sdkgen#165](https://github.com/voxgig/sdkgen/issues/165) | the shared corpus tests only `cost`, which no SDK generates |
| `issue/01` | [sdkgen#166](https://github.com/voxgig/sdkgen/issues/166) | test mode mints a random id whose TypeScript form differs from every other target |
| `issue/07` | [sdkgen#167](https://github.com/voxgig/sdkgen/issues/167) | the test feature diverges per target; C and Ruby cannot run a GraphQL SDK at all |

- `issue/03` — **filed as [aontu-lang/aontu#245](https://github.com/aontu-lang/aontu/issues/245)**, by a session rooted at that repository, which reproduced the bug against its own build before filing.
- `issue/08` — **filed as [aontu-lang/aontu#246](https://github.com/aontu-lang/aontu/issues/246)**, same way. It re-derived the counts rather than taking mine: 29 of 168 registered codes have no text, and the `compat` class is 13 of 13.

## Still unfiled, and why

Three drafts belong in `voxgig-sdk/*` repositories rather than in sdkgen, and the
sessions doing this work cannot attach that organisation — a tooling boundary, not a
judgement about whether they should be raised.

| Draft | Belongs in | Why it is not a sdkgen issue |
|---|---|---|
| `issue/02` | each SDK repository | no git tags and no published packages: a release-process gap in the repositories that would cut the releases |
| `issue/04` | each SDK's `.sdk/def/` | the API definitions are subsets narrow enough that no source can offer search; the definition is per-SDK input, not generator behaviour |
| `issue/09` | `voxgig-sdk/notion-sdk` | `.sdk/model/target/target-index.aon` imports nine targets and `rb` is not among them, where joplin-sdk's does include it. One import line, per SDK |

## A correction worth keeping

`issue/11` was rewritten before filing. Its first draft said the paging signal was
"computed and exposed nowhere a caller can reach". That was **wrong**: it was measured
with the feature at its default `active: false`, and the absence of `client._paging` was
read as absence of the mechanism rather than absence of the run.

The real defects are worse than the reported one — chiefly that the feature never
recognises `has_more`, which Joplin's own definition declares, so an active paging
feature reports `hasMore: false` on a short page. A missing signal is a gap; a confident
wrong one is a bug.

The lesson is the same one this directory already records about an exit code read through
a pipe: **measure the thing at the setting it actually ships with, and check whether a
null result means "absent" or "never ran".**

## Retracted

**`breaking --against` exits 0 whatever it concludes** — drafted, then withdrawn
before filing. It does not. It exits `1` on a breaking verdict and `0`
otherwise, on npm 0.67.0 and on `main` alike. The original measurement piped the
command into `head` and then read `$?`, which is `head`'s status and not
aontu's. Recorded here so the same non-bug is not found again, and as a reminder
that an exit code read through a pipeline is not an exit code.

## Filing

When one is filed, add the issue link to the top of its file rather than
deleting it. The evidence is worth keeping next to the schema that depends on
it, and a closed issue with a link is how a future reader learns why a
workaround in this repository exists.

## The list

| File | Repository | Severity | What |
|---|---|---|---|
| `issue/01-test-mode-random-id.md` | `voxgig-sdk/joplin-sdk` (all four) | blocker for parity | offline test mode mints a random id whose form differs between ports |
| `issue/02-no-tags-no-packages.md` | `voxgig-sdk/joplin-sdk` (all four) | blocker for consumers | no git tags and no published packages, so the documented install path has nothing to install |
| `issue/03-aontu-coverage-vacuous.md` | `aontu-lang/aontu` | major | `--coverage` reports a run checked nothing while that same run reports violations, so `--strict-coverage` rejects correct schemas |
| `issue/04-scoped-definitions.md` | `voxgig-sdk/joplin-sdk` (all four) | major | the definitions are subsets narrow enough that no source can offer search |
| `issue/05-corpus-activates-absent-features.md` | `voxgig-sdk/joplin-sdk` | major | the shared corpus activates `cost` and `netsim`, which no SDK generates, so its only feature section runs zero cases everywhere |
| `issue/07-test-feature-port-divergence.md` | `voxgig-sdk/linear-sdk` (all four) | **blocker** | the offline test feature behaves differently in each port, and in C and Ruby it cannot run the Linear SDK at all |
| `issue/08-explain-prefix-and-missing-text.md` | `aontu-lang/aontu` | minor | `explain` rejects the code as it is printed, and a large minority of codes have no text |
| `issue/09-notion-no-ruby-target.md` | `voxgig-sdk/notion-sdk` | **blocker** | no Ruby target, so likeness's Ruby port cannot reach Notion at all |
| `issue/10-go-netsim-ignores-json-number.md` | `voxgig-sdk/joplin-sdk` (Go target) | major | a `net` option decoded as `json.Number` is silently ignored, so a simulated failure does not happen and the test passes |
| `issue/11-paging-signal-unreachable.md` | `voxgig-sdk/joplin-sdk` (all four) | major | the paging feature computes `hasMore` and a cursor, and exposes them nowhere a caller can reach, so a consumer cannot follow pages or even detect one |
