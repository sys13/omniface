---
'@omniface/cli': patch
'@omniface/testing': patch
---

A bare `--json` on a generated CLI now means `--output json` instead of failing with
`--json needs a value`. `--json '{…}'` still passes the full input: the flag takes the next token
only when that token is a JSON object, which input always is. `--json=…` is always input.

The conformance harness drives every CLI case with both spellings, and with a terminal on stdout,
so a bare `--json` that stopped selecting JSON output fails the generated suite.
