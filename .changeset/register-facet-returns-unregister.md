---
'omniface': patch
---

`registerFacet` returns a function that takes the facet back out, for a test fixture facet to
call in `afterAll`. Only the call that added the module can remove it: registering a module that
is already registered returns a no-op, so it cannot be used to remove a built-in facet.
