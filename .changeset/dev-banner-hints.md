---
'omniface': patch
---

The `omniface dev` banner shows the MCP tool count, the web screen count and the command to run
the generated CLI again. A facet module can write its own banner line with the optional
`devHint(settings, base, manifest)`; one without it still shows its `summary`.
