# The fixture vaults

`likeness.skmv` and `empty.skmv` are sekreto minivaults, written by
`node tools/make-vault.mjs`. The corpus copies one into a run's configuration
directory, so no entry changes a committed file. `empty.skmv` holds a master
key, with the passphrase below, and no secret, as `secrets init` leaves a vault.

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
