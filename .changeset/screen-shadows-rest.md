---
'omniface': patch
---

`omniface lint` warns when a web screen and a REST route share a method and path, which happens
when `facets.web.path` puts the console on the API's routes (`path: ''`). The warning names the op,
the route, and which facet answers it. It never fails the lint: a console that owns browser
traffic at the root is a legitimate setup, and the warning only says so out loud.
