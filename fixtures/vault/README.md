# The fixture vault

`likeness.skmv` is a sekreto minivault, written by `node tools/make-vault.mjs`.
The secrets corpus copies it into each run's configuration directory, so no
entry changes the committed file.

The passphrases are public test values. Nothing real is ever stored here.

| key | passphrase | may |
| --- | --- | --- |
| `master` | `fixture master passphrase` | everything |
| `ci` | `fixture ci passphrase` | read `joplin.apikey` |
| `deploy` | `fixture deploy passphrase` | read and overwrite `joplin.apikey` and `linear.apikey` |

| secret | value |
| --- | --- |
| `joplin.apikey` | `joplin-mock-token` |
| `notion.apikey` | `notion-fixture-token` |

`linear.apikey` is granted to `deploy` and absent from the vault, so the corpus
can show that a restricted key may overwrite a secret but never create one.

Every key uses 1000 PBKDF2 rounds rather than sekreto's default, so that
opening the vault costs each entry almost nothing.
