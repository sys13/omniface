---
'omniface': patch
---

`omniface build` emitted a generated SDK that did not compile when a named type was a union.

`t.named('PaymentMethod', z.discriminatedUnion(…))` rendered as
`export interface PaymentMethod { … } | { … }`, which is not parseable TypeScript, so the whole
generated package failed to typecheck rather than just that type. The declaration emitter chose
`interface` by asking whether the rendered body started with `{`, which a union of objects also
does; it now asks the schema for branch keys. A named union is emitted as a `type` alias, and a
named object is still an `interface`.

`omniface lint --fix` also reported the wrong reason for declining to name a schema that is declared
inside a function rather than at the top level of a file — the shape an app that generates its ops
in a loop always has. Declining is still correct; the message now says why and what to do instead.

Both were found by modelling Stripe and Kubernetes in `examples/expressibility`
([docs/EXPRESSIBILITY.md](../docs/EXPRESSIBILITY.md)).
