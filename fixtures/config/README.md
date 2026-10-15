# Configuration fixtures

A transcript entry that brings `station.json` or `likeness.json` through its
`files` is configured by them alone, read as the argv shell reads them, and
declares no connections. The `sources` entries bring these.

- `several/` — four Joplin and Notion connections in the default profile: one
  that names its secret, one inactive and with no account, and accounts for
  the rest.
- `kept/` — content a write must keep as it is: three profiles, one named
  `2026`, which JavaScript would move first when it parses the file; a profile
  with a vault of its own, `work.skmv`; an api block; numbers and escapes kept
  as written (`1.50`, `1e2`, `-0`, `é`, `\/`); an empty object and an
  empty array; a key given twice, which keeps its first place and its last
  value; and both files on one line, which a write lays out.
