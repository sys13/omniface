---
'omniface': minor
---

`omniface dev` listens on `127.0.0.1` by default, so the dev server is not reachable from other
machines unless you ask: `--host 0.0.0.0` binds every interface. `serve()` takes a `host` option;
left unset it binds as it did before, on every interface, and a deployment that means that can now
say so.
