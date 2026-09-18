# Implementation rationale

The Aontu sources define shared corpora and schemas. Compile them into the JSON consumed by each port; preserve the committed expectations when changing implementation comments.

SDK revisions are part of the reproducible test environment. A checkout at the expected revision must also have a clean working tree before its source can be used as a file dependency.

Parity compares identical semantic output while retaining distinct port names in raw transcripts. The comparison's negative test proves that a disagreement is detected.

See [the development process](PROCESS.md) and [the repository guide](README.md).
