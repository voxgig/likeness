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

- `issue/03` — **filed as [aontu-lang/aontu#245](https://github.com/aontu-lang/aontu/issues/245)**, by a session rooted at that repository, which reproduced the bug against its own build before filing.

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
