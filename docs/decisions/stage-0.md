# Stage 0 — the schema, and the SDKs as found

A resumption note: what the stage delivered, what it is pinned to, and what it
waits on. The stage itself is SPEC.LIKENESS.md §20.3 in `metsitaba/project-specs`.
Written at the re-baseline of 2026-10-14; the pins below are the ones in force
then, and `spec/sources.aontu` is the authority if the two ever differ.

## Delivered

- The ten shapes under `spec/def/`, and the data files `spec/sources.aontu`,
  `spec/caps.aontu` and `spec/errors.aontu` that satisfy them. `make spec` runs
  the vet, the red cases that must fail, the freshness of every compiled JSON
  file, and the agreement checks.
- Four SDKs pinned by commit in `spec/sources.aontu`, enforced by `make sdk` and
  `make sdk-check` rather than written down and hoped for.
- `spec/caps.aontu` written from the SDKs, cross-checked against the cloned
  generated models on every `make spec-agree`: entities and operations are read
  from each model's `op` block, in either model file extension, and the check's
  self-test falsifies a capability to prove it goes red.
- The offline test mode proven end to end in TypeScript
  (`typescript/test/offline.test.ts`): seed, list, load, create and update with
  every network call refused.
- station and sekreto port coverage confirmed by running the suites (SPEC §9.3).

## Pins

| Source | Repository | Revision | Note |
|---|---|---|---|
| joplin | `voxgig-sdk/joplin-sdk` | `c7621966bf0c5d2f0f385038b75a74a10372acfb` | the 2026-09-27 regeneration on sdkgen 4.30.2 / apidef 8.17.2; re-pinned from `4504c82` at the re-baseline |
| obsidian | `voxgig-sdk/obsidian-sdk` | `958b620f1ef9ecdfc6c9d553cda94029e060c523` | |
| notion | `voxgig-sdk/notion-sdk` | `785fb7e1e6c1ec3369a001956d1d14eefca0c16d` | still on the generator of 2026-09-17 |
| linear | `voxgig-sdk/linear-sdk` | `046371226512e1faa497905086b254f9ba41b563` | held, SPEC §0 decision 11 |

Toolchain: aontu `0.76.0` (`.aontu` files), Node 24 or later, Go 1.21 in
`go.mod` and 1.24 in CI.

## Waits on

Nothing blocks the stage itself. The findings it produced are filed and tracked
in [`upstream/README.md`](../../upstream/README.md); the ones later stages wait
on are listed in [`stage-1.md`](stage-1.md).
