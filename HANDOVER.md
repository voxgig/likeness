# Handover: station 0.2.0 on every port

Written 2026-10-17 by a Claude Code session that could not push a git tag or
change a GitHub workflow file. Everything else is done. Three steps remain, and
the patches they need are in [`upstream/patch/`](upstream/patch/). Delete this
file and that directory once all three have landed.

## Where things stand

| | state |
|---|---|
| station's ports | every port but go declares `0.2.0`, read from station's root `VERSION` file ([voxgig/station#65](https://github.com/voxgig/station/pull/65), merged as `a570686`); go's version is its tag |
| `@voxgig/station` | 0.2.0 on npm, built from `a509752`, tagged `typescript/v0.2.0` |
| `@voxgig/station-js` | 0.2.0 on npm, built from `a570686`, tagged `javascript/v0.2.0` |
| station's Go module | **not tagged**: `go/v0.2.0` belongs on `a570686` |
| station's release workflow | still releases one port per dispatch; the one-dispatch version is `station-release-workflow.patch` |
| likeness | binds station's Go module through a `replace` to `9021c99`, and pins Python and Ruby there too; the move to 0.2.0 is `likeness-station-go-v0.2.0.patch` |

In station, `make release-plan` on `main` prints the same picture per port,
with the commit each tag and each npm build came from.

## Why the session stopped

- **Tags.** Pushing `go/v0.2.0` returned HTTP 403 from the session's own egress
  proxy. The response carried none of GitHub's headers, and branch pushes from
  the same session went through. Reconnecting GitHub did not change it within
  that session.
- **Workflow files.** GitHub refused every change under `.github/workflows/`,
  by push and through the API, because the session's token lacked the
  `workflow` scope.

## 1. Tag station's Go module

The commit is checked. On `a570686`, with no go workspace, the module builds,
passes its tests, verifies and is tidy, and its `go.mod` has no `replace`. A go
tag cannot be withdrawn once proxy.golang.org has fetched it, so tag only the
commit `make release-plan` names.

```sh
cd station
git switch main && git pull --ff-only
make release-plan                # go: tag, from a570686
git tag go/v0.2.0 a570686fe886bc2d686c991ffee5c7e6a47b5f8a
git push origin go/v0.2.0
make release-plan                # every port: done
GOPROXY=https://proxy.golang.org go list -m github.com/voxgig/station/go@v0.2.0
```

Then close [voxgig/station#27](https://github.com/voxgig/station/issues/27),
naming the tag. It asked for exactly this, and the sdkgen-station feature model
already requires `v0.2.0`.

## 2. Release every port from one dispatch

```sh
cd station
git switch -c release-every-port origin/main
git am ../likeness/upstream/patch/station-release-workflow.patch
make version-check release-plan-test
```

Push it with a token that has the `workflow` scope, and open a pull request.

- **`release.yml`** releases every port at `VERSION` in one run. typescript and
  javascript publish to npm, go is a tag, and every tag goes up in one atomic
  push after every publish has succeeded and the go module has passed as a
  consumer resolves it.
- **`build.yml`** gains a `versions` job running `make version-check` and the
  release plan's tests.
- **`AGENTS.md`** and the **`Makefile`** follow: the Makefile hooks that carry
  the gate today are no longer needed.

The file keeps its name, so trusted publishing on npm is unaffected. It also
closes the one review thread left open on station#65: today's workflow skips
the version gate when a re-run only tags. `actionlint`, with `shellcheck`,
passes on both files.

## 3. Move likeness onto station 0.2.0

After step 1, because `go mod tidy` needs the tag to exist:

```sh
cd likeness
git switch -c station-0.2.0 origin/main
git am upstream/patch/likeness-station-go-v0.2.0.patch
(cd go && go mod tidy) && git commit -a --amend --no-edit
make rb-libs test-go test-py test-rb
```

The patch requires station's Go module at `v0.2.0`, and moves the Python and
Ruby pins from `9021c99` to `a570686`. The Python and Ruby suites already pass at
those pins.

## Also known

- **The generated SDKs** still require station's Go module at `v0.0.1`, so
  likeness keeps one `replace` mapping that to the tag. Regenerating them with
  sdkgen-station from station's `main` makes them require `v0.2.0`, and the
  `replace` can go.
- **station's proxy daemon** does not compile against the sekreto revision
  station's CI pins: `sekreto.MakeNamedChain` and `sekreto.NewNamed` are
  undefined. That predates the version change, and the proxy has no CI lane.
- **Outside the shared version, by decision:** sdkgen-station's own package
  version, and the `version` each port's adapter gives the station feature.
