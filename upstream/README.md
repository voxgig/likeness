# `upstream/` — findings filed upstream, and the evidence behind them

likeness consumes four generated SDKs and their toolchain and owns none of them.
[PROCESS.md](../PROCESS.md) §6 says a gap found here is **filed, not worked
around**, and says how to decide which repository owns the fix.

Each file in `issue/` is one finding as it was drafted: the repository, the
revision it was observed at, the file and line, a reproduction that needs no
credentials and no network, and what it costs likeness. The link at the top of
each file is where it was filed.

## Status, 2026-10-14

Every draft but `issue/12` and `issue/13` is filed. "Closed" for a `sdkgen`
issue means the generator carries the fix; an SDK carries it only once
regenerated. Joplin, Obsidian and Notion
were regenerated with station's feature, loaded only when it initialises, and
this repository is pinned to those revisions, the heads of open pull requests:
Joplin at `89b86ca`
([joplin-sdk#4](https://github.com/voxgig-sdk/joplin-sdk/pull/4)), Obsidian at
`5e8cd8e` from the plugin's full definition
([obsidian-sdk#3](https://github.com/voxgig-sdk/obsidian-sdk/pull/3)) and
Notion at `1e45fc3`, which adds the `rb` target
([notion-sdk#5](https://github.com/voxgig-sdk/notion-sdk/pull/5)). Linear
carries the fixes at its pin and is held (SPEC §0 decision 11).

| Draft | Filed as | Status |
|---|---|---|
| `issue/01` | [sdkgen#166](https://github.com/voxgig/sdkgen/issues/166) | closed |
| `issue/02` | [joplin-sdk#2](https://github.com/voxgig-sdk/joplin-sdk/issues/2), [linear-sdk#2](https://github.com/voxgig-sdk/linear-sdk/issues/2), [obsidian-sdk#2](https://github.com/voxgig-sdk/obsidian-sdk/issues/2), [notion-sdk#3](https://github.com/voxgig-sdk/notion-sdk/issues/3) | open; the pins stay commit shas |
| `issue/03` | [aontu-lang/aontu#245](https://github.com/aontu-lang/aontu/issues/245) | fixed upstream for the case it reported: on 0.76.0 a constraint reached through a named `type()` is counted. The case that still reads as vacuous - a disjunction of records, which the unit corpus is - is [aontu#318](https://github.com/aontu-lang/aontu/issues/318), below |
| `issue/04` | [joplin-sdk#3](https://github.com/voxgig-sdk/joplin-sdk/issues/3), [notion-sdk#4](https://github.com/voxgig-sdk/notion-sdk/issues/4) | open |
| `issue/05` | [sdkgen#165](https://github.com/voxgig/sdkgen/issues/165) | closed |
| `issue/07` | [sdkgen#167](https://github.com/voxgig/sdkgen/issues/167) | closed; Linear's offline test mode works in C and Ruby from sdkgen 4.30.2 |
| `issue/08` | [aontu-lang/aontu#246](https://github.com/aontu-lang/aontu/issues/246) | fixed upstream: on 0.76.0 `explain` accepts a code as it is printed, with or without its `aontu/` prefix |
| `issue/09` | [notion-sdk#2](https://github.com/voxgig-sdk/notion-sdk/issues/2) | answered by the regeneration in [notion-sdk#5](https://github.com/voxgig-sdk/notion-sdk/pull/5), which generates `rb`; closes when it merges |
| `issue/10` | [sdkgen#163](https://github.com/voxgig/sdkgen/issues/163) | closed; the Go harness no longer rewrites `json.Number` before seeding |
| `issue/11` | [sdkgen#164](https://github.com/voxgig/sdkgen/issues/164) | closed |
| `issue/12` | not filed yet | open; the Ruby port's suite excepts the two transcript entries it changes, and fails once they match |
| `issue/13` | not filed yet | open; the Ruby port's wire test that walks a vault from its root is skipped, saying why |

## Filed directly, 2026-10-14

Found in the review of the repository against its purpose and filed without a
draft here; the reproduction is in each issue. SPEC.LIKENESS.md §22 in
`metsitaba/project-specs` carries the same table with what each one blocks, and
[`docs/decisions/stage-1.md`](../docs/decisions/stage-1.md) says which stage
waits on which.

| Issue | Repository | What |
|---|---|---|
| [joplin-sdk#1](https://github.com/voxgig-sdk/joplin-sdk/issues/1), [linear-sdk#1](https://github.com/voxgig-sdk/linear-sdk/issues/1), [obsidian-sdk#1](https://github.com/voxgig-sdk/obsidian-sdk/issues/1), [notion-sdk#1](https://github.com/voxgig-sdk/notion-sdk/issues/1) | each SDK | no SDK carries the `station` feature (`@voxgig/sdkgen-station`), so nothing can register with station |
| [sdkgen#400](https://github.com/voxgig/sdkgen/issues/400) | `voxgig/sdkgen` | the regenerated Linear SDK queries `issueSearch`, `attachmentIssue` and `administrableTeams` for a bare list, load and team list |
| [sdkgen#401](https://github.com/voxgig/sdkgen/issues/401) | `voxgig/sdkgen` | relay paging cannot be followed: no model carries `page.connpath` |
| [sdkgen#402](https://github.com/voxgig/sdkgen/issues/402) | `voxgig/sdkgen` | the Python SDK depends on `requests` since 4.30.2 |
| [sdkgen#403](https://github.com/voxgig/sdkgen/issues/403) | `voxgig/sdkgen` | the C SDK has no live HTTP transport and no TLS |
| [sdkgen#404](https://github.com/voxgig/sdkgen/issues/404) | `voxgig/sdkgen` | two Ruby SDKs loaded together redefine each other's entity classes and `VoxgigStruct` |
| [sdkgen#405](https://github.com/voxgig/sdkgen/issues/405) | `voxgig/sdkgen` | two C SDKs cannot be linked into one program |
| [sdkgen#406](https://github.com/voxgig/sdkgen/issues/406) | `voxgig/sdkgen` | a query parameter declared `fields` is generated as `field`, which Joplin ignores; both adapters pass the wire name until it is fixed |
| [sdkgen#407](https://github.com/voxgig/sdkgen/issues/407) | `voxgig/sdkgen` | the generated client discards the response body text, so `--raw` cannot be verbatim; `raw` is the record re-rendered canonically until it is fixed |
| [sdkgen#408](https://github.com/voxgig/sdkgen/issues/408) | `voxgig/sdkgen` | no generated transport can trust a self-signed certificate, so the Obsidian fingerprint pin has nothing to verify it; each port installs the check through the SDK's `utility.fetcher` seam until it lands, and the C port cannot |
| [aontu#318](https://github.com/aontu-lang/aontu/issues/318) | `aontu-lang/aontu` | `vet --coverage` reads a corpus whose entries are a disjunction of records as having checked nothing (`spec/unit.aontu`: 0 of 519 leaves), so `--strict-coverage` cannot gate this repository yet |
| [station#23](https://github.com/voxgig/station/issues/23) | `voxgig/station` | station's C port is env-only and does not use sekreto's C port |
| [station#33](https://github.com/voxgig/station/issues/33) | `voxgig/station` | the ruby, php and perl stations give sekreto no plugins, so none can open a minivault; the Ruby port waits on it for a live token |
| [station#34](https://github.com/voxgig/station/issues/34) | `voxgig/station` | the published `@voxgig/station` 0.1.0 depends on a sekreto with no minivault; `main` has the newer one, unreleased, so the TypeScript port waits on a release for a live token |

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

A new finding gets a draft here, is filed, and then carries its link at the top
of the file rather than being deleted. The evidence is worth keeping next to the
schema that depends on it, and a closed issue with a link is how a future reader
learns why a workaround in this repository exists.

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
| `issue/12-escurl-escapes-what-encodeuricomponent-keeps.md` | `voxgig/sdkgen` | major | the Ruby and Python SDKs percent-encode `!'()*` in a path parameter where TypeScript and Go send them as they are, so the ports' requests differ on the wire |
| `issue/13-list-drops-items-that-are-not-records.md` | `voxgig/sdkgen` | major | a `list` whose items are not records returns entities with no data in Ruby, Python and Go, so a live Obsidian vault cannot be walked from its root |
