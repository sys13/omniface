# Criteria — first-pass feature triage

A rubric light enough to apply in a minute per feature, so a first pass can happen
without a meeting. Verdicts are revisable; the point is a defensible default.

## The six questions

Score each **0 / 1 / 2**. Max 12.

| # | Question | 0 | 1 | 2 |
| --- | --- | --- | --- | --- |
| **L** | **Leverage** — does one declaration fan out across facets? | one facet only | 2 facets | every enabled facet |
| **C** | **Core-thesis proof** — does it demonstrate "one definition, many faces" or "concerns as plugins"? | unrelated | supports it | a demo is unconvincing without it |
| **D** | **Drift prevention** — does it stop facets behaving differently? | no | partially | makes divergence impossible or tested |
| **T** | **Tax** — added concepts a user must learn (inverted: less is better) | new mental model | a new option/trait | invisible / convention |
| **B** | **Build cost** (inverted) | weeks + ongoing maintenance | days | hours |
| **E** | **Escape-hatch safe** — can users bypass it when it's wrong for them? | locks them in | awkward bypass | trivially bypassed or opt-in |

## Hard gates (override the score)

- **Gate 1 — No facet may bypass a concern.** Any design that puts auth/limits/validation in a facet
  adapter instead of the pipeline is rejected regardless of score.
- **Gate 2 — Must be expressible in code.** If it needs a config file or DSL to work, redesign or reject.
- **Gate 3 — No REST-shaped core.** A feature that only makes sense if operations *are* HTTP endpoints
  belongs in the REST facet's overrides, not the core.
- **Gate 4 — Someone else does it well and it isn't the thesis.** Integrate (plugin/adapter), don't build.
  (e.g. OAuth provider internals, a tracing backend, a job queue.)
- **Gate 5 — Interfaces, not applications.** facet projects operations that are already declared.
  Data models, migrations, screens for things that are not ops, and whole apps are maxstack's job.
  A console that renders declared ops passes this gate the same way the CLI does; a page builder or
  a schema designer does not.
  *(Revised 2026-09-19. The earlier wording — "generating UIs … is maxstack's job" — ruled out a
  category rather than a boundary, and was reversed by [BACKLOG E12](BACKLOG.md#e12--web-facet),
  which carries the fence that makes the narrower reading testable.)*

**Table stakes exception:** a feature without which the facet is unusable for real
traffic (e.g. CORS for REST) is **want** regardless of score. Keep it minimal and
default-on.

## Verdicts

| Score | Verdict | Meaning |
| --- | --- | --- |
| **9–12** | **want** | In the MVP or the phase right after |
| **6–8** | **maybe** | Worth doing; needs a concrete user pull or a cheaper design |
| **3–5** | **later** | Real but not now; park with a note on what would promote it |
| **0–2** or failed gate | **no** | Out of scope; record why so it isn't re-litigated |

**Tiebreak:** prefer the feature that makes the **MVP demo** more convincing —
~50 lines of definition → REST + TS SDK + CLI + MCP, and adding `rateLimit()` changes all four.

## How to use it

1. Add the feature to [FEATURES.md](FEATURES.md) with a one-line description.
2. Score `L C D T B E`, check gates, write the verdict.
3. One sentence of rationale — especially for `no` and `later`.
4. The human pass only needs to look at disagreements, not every row.
