---
'omniface': patch
---

An op with the `deprecated` trait now says so in its MCP tool description (`Deprecated: <message>`
in front, or `Deprecated.` for a bare `true`), and in its action line inside a grouped tool. MCP has
no `deprecated` flag, and the description is what an agent reads. A description that already starts
with the marker is left alone, so apps that wrote it by hand do not get it twice.
