**Repository:** `voxgig-sdk/joplin-sdk` — the Go target
**Observed at:** `4504c82ae6502ef24b582a528bcd747d485d0a1e`
**Fix belongs in:** `voxgig/sdkgen` — `.sdk/tm/go/src/feature/test/`, since the coercion is the template's and not this API's

---

# Go: the offline test feature SILENTLY IGNORES a `net` option decoded as `json.Number`

Filed from [voxgig/likeness](https://github.com/voxgig/likeness), which builds one application in five languages against these SDKs and holds the ports to byte-identical output.

## What happens

`TestSDK(testopts, nil)` accepts `net` options — `failTimes`, `failStatus`, `latency`, `errorTimes` — as `map[string]any`. The Go template reads the numbers with a type switch that handles `int` and `float64`. It does not handle `encoding/json.Number`, and there is no default branch, so a value of that type is **ignored without any error**.

The consequence is the bad one: `failTimes` set to a `json.Number` does nothing, the simulated failure never happens, and **the request succeeds**. A test that believes it is exercising a failure path is exercising the success path, and it passes.

`json.Number` is not an exotic type here. It is what `encoding/json` produces whenever a decoder has `UseNumber()` set, which is the standard way to read a JSON document without turning every integer into a float64. Any consumer that keeps its fixtures in JSON files and cares about integer exactness will hit this.

## Why it matters

A silently ignored option is much worse than a rejected one. Our transcript corpus has an entry asserting that `doctor` reports `auth-failed` when the source rejects the credential; with the seed read through `UseNumber()` the SDK answered normally and the entry reported a *passing* `doctor` run with exit 0. The only reason we noticed is that the same entry also pins the exact stdout bytes. A consumer asserting only on the exit code would have a permanently green test for a path that never runs.

## Reproduction

No credentials, no network.

```go
package main

import (
	"encoding/json"
	"fmt"
	"strings"

	joplin "github.com/voxgig-sdk/joplin-sdk/go"
)

func try(label string, net map[string]any) {
	sdk := joplin.TestSDK(map[string]any{
		"entity": map[string]any{"note": map[string]any{"x1": map[string]any{"id": "x1"}}},
		"net":    net,
	}, nil)
	_, err := sdk.Note(nil).List(map[string]any{}, nil)
	fmt.Printf("%-12s %T  err=%v\n", label, net["failStatus"], err)
}

func main() {
	try("int", map[string]any{"failTimes": 1, "failStatus": 401})
	try("float64", map[string]any{"failTimes": float64(1), "failStatus": float64(401)})

	var n map[string]any
	d := json.NewDecoder(strings.NewReader(`{"failTimes":1,"failStatus":401}`))
	d.UseNumber()
	_ = d.Decode(&n)
	try("json.Number", n)
}
```

Output:

```
int          int  err=JoplinSDK: list: request: 401: Simulated Failure
float64      float64  err=JoplinSDK: list: request: 401: Simulated Failure
json.Number  json.Number  err=<nil>
```

The third line is the bug: the same document, decoded the other standard way, turns the simulated failure off.

## Suggested fix, in order of preference

1. **Accept `json.Number`** in the numeric coercion, alongside `int` and `float64`. One case in the existing type switch.
2. **Fail loudly on a type it cannot read** — return an error naming the option and the type. Even without (1) this turns a silent wrong answer into a clear one, which is the part that matters.
3. Document the accepted types in `REFERENCE.md`, so a consumer reading the docs rather than the template knows.

(1) and (2) together would be ideal: accept the type, and refuse anything still unrecognised rather than dropping it.

## What we do meanwhile

The Go corpus harness rewrites every `json.Number` under `net` to `int` before handing the seed to the SDK, and a test asserts that a `failStatus` set that way actually reaches it — so a regression in that workaround is reported directly rather than as a puzzling `doctor` diff. It is a workaround in our repository for a coercion that belongs in the template.
