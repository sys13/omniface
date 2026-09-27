---
'omniface': patch
---

`fileKeyStore` now says what it always was: one process per file. Its writes are serialised by an
in-process queue, not a file lock, so two processes sharing the file can lose each other's writes,
revocations included. Use `sqlKeyStore` when more than one process serves the same keys.
