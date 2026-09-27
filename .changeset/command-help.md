---
'omniface': patch
---

`omniface <command> --help` (or `-h`) prints that command's usage line and every flag it reads,
including the ones the top-level usage has no room for, such as `conformance --op` and
`diff --quiet`. Before, `omniface dev --help` tried to load `--help` as the entry module.
