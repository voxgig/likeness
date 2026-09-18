**Repository:** `voxgig-sdk/joplin-sdk` — and identically the other three
**Observed at:** `4504c82ae6502ef24b582a528bcd747d485d0a1e`
**Fix belongs in:** `voxgig/sdkgen` — the entity template and the paging feature, since the gap is the same for every API

---

# The paging feature computes `hasMore` and exposes it nowhere a caller can reach

Filed from [voxgig/likeness](https://github.com/voxgig/likeness), which builds one application in five languages against these SDKs and holds the ports to byte-identical output.

## What happens

`PagingFeature` does real work on every response. It reads `x-page`, `x-total-count`, `x-next-page`, a `Link: <...>; rel="next"` header, a Relay `pageInfo` cursor and body-level `next` / `cursor` / `nextCursor` / `hasMore`, and assembles them into a `paging` object on `ctx.result`. Its own header comment says a generated SDK "builds auto-iteration on top of this".

Nothing does. `ctx` is internal to the operation, and none of the three things a caller holds carries it:

- `entity.list(reqmatch, ctrl)` returns a plain array of entities.
- The `ctrl` map passed in comes back **untouched** — it is an input, not an out-parameter.
- The returned entities expose `name`, `_client`, `_utility`, `_entopts`, `_data`, `_match`, `_entctx`, `_deleted`. No result, no paging.

So a consumer cannot follow pages, and — the part that actually bites — cannot even **ask whether there are more**. The signal is computed and discarded.

## Why it matters

A list that silently returns the first page is the worst shape a wrong answer can take: every filter, count and selector result computed from it is wrong, and nothing anywhere says so. A consumer cannot detect it, so it cannot warn, retry or degrade.

likeness has to report an honest `meta.truncated` and `meta.incomplete`. With no signal available, it infers the boundary from row count against the declared `page_max` in its own capability data — which is a guess that is right for a full page and wrong for a source that returns a short final page equal to the limit, and which cannot work at all for a cursor-based source where the page size is not fixed.

## Reproduction

No credentials, no network.

```js
import pkg from '@voxgig-sdk/joplin'
const SDK = pkg.JoplinSDK ?? pkg.default ?? pkg

const sdk = SDK.test({ entity: { note: { n1: { id: 'n1' }, n2: { id: 'n2' } } } })

const ctrl = {}
const rows = await sdk.Note().list({}, ctrl)

console.log('rows:', rows.length)                  // 2
console.log('ctrl after:', JSON.stringify(ctrl))   // {}  <- nothing written back
console.log('entity props:', Object.getOwnPropertyNames(rows[0]).join(','))
// name,name_,Name,_client,_utility,_entopts,_data,_match,_entctx,_deleted
```

The Go port is the same: `sdk.Note(nil).List(map[string]any{}, ctrl)` leaves `ctrl` empty.

## Suggested fix, in order of preference

1. **Write the paging object back into `ctrl`.** It is already the parameter a caller passes and holds; one assignment at the end of the operation makes the computed signal reachable in every language with no new API surface.
2. **Expose an iterator** — `listAll()`, or `list()` returning something with a `next()` — which is what the feature's own comment anticipates.
3. At minimum, **document that the signal is unreachable**, so a consumer does not go looking for it as we did.

(1) is enough on its own: a consumer that can see `hasMore` and a cursor can do its own iteration correctly.

## What we do meanwhile

The adapter treats a page that came back at exactly `page_max` as possibly-short, marks the answer `truncated` and names the instance in `meta.incomplete`. Two transcript corpus entries pin that behaviour. It is a workaround for a signal the SDK already has and does not hand over.
