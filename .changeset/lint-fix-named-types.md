---
'omniface': minor
---

`omniface lint --fix` inserts the `t.named()` the named-type rules ask for, and the recursive-schema
rule now fires on the shape a recursive type actually has.

- **The rule was checking for the wrong thing.** It looked for `$defs`, and zod 4 does not emit
  one: a recursive type comes out as a bare `{ "$ref": "#" }` at the recursion point, with no
  `$defs` anywhere — so the `error` never fired for the case it exists for. Any internal `$ref` now
  counts as recursion, which is the property that matters: an anonymous self-referential type gives
  the reference nothing to point at, and every generator downstream has to invent a name or inline
  forever.
- **`--fix` prefers the name the schema already has.** `const Task = z.object({…})` becomes
  `const Task = t.named('Task', z.object({…}))`, which fixes every op sharing it at once; an
  expression written inline gets the derived name (`TasksCreateOutput`). The `t` import is added if
  the file does not already bind one, and `Task as z.ZodObject<any>` is seen through, since an
  assertion says something about the type rather than about which schema the op was handed.
- **A wrong edit never survives.** The edits are made by a scanner — facet has no TypeScript parser
  at runtime — so every fix is checked by re-linting in a fresh process, fresh because the
  rewritten files are modules the fixing process already imported. If the app stops loading, or a
  finding the fix claimed to resolve is still there, every file is restored byte for byte. Shapes
  the scanner does not recognise, including a schema imported from another file, are declined with
  the edit to make by hand rather than guessed at.
- `omniface lint --json` prints the findings as data, each carrying the op it is about and the fix it
  would accept. New exports: `planNamedTypeFixes`, `applyNamedTypeFixes`, `applyFixPlans`,
  `captureDefinitionSites`, `definitionSite`.
- `captureDefinitionSites()` is off by default. Recording where each op was written costs a stack
  capture per op, which is pure cost to an app that is only going to run; `omniface lint --fix` turns
  it on before importing the entry.
