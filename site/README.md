# site

The marketing page for facet. One file, `index.html`, with no build step and no
external requests except the Google Fonts stylesheet. Open it directly, or serve
the repo root so the `../docs/*.md` links resolve.

## The message

> **Define the operation once. Prove every interface agrees.**

That is the H1 and nothing else competes with it above the fold. When a full
sentence is needed — a meta description, an intro paragraph, someone asking
what it is:

> **facet is a TypeScript framework where your REST API, TypeScript SDK, CLI and
> MCP server are all facets of one protocol-neutral definition — and the
> definition generates the conformance suite that fails when any two of them
> disagree.**

Both halves matter. The first clause is *what it is*; the second is *why you'd
switch*. Cut the second and it reads like every other codegen tool.

## Rules this page is held to

1. **No typed digits.** Every number on the page came out of a command run in
   this repo, and the page says which command and on what date. Current
   figures, captured 2026-09-19:

   | Figure | Command |
   | --- | --- |
   | 425 tests, 25 files | `pnpm check` |
   | 10 ops, 4 facets | `omniface build examples/tasks/src/app.ts` |
   | 44 conformance cases | `omniface conformance src/app.ts` in `examples/tasks` |
   | 8 plugins, 5 auth adapters | `ls packages/omniface/src/plugins packages/omniface/src/auth` |

   The README said 347 tests and 42 cases when this page was written; both were
   stale. Re-run the commands before editing a number, and treat any figure in
   prose as a claim to re-verify rather than a fact to copy. The test count then
   moved from 411 to 425 within the hour, when `omniface build` learned to write an
   SDK package — which is this rule earning its keep, not an argument against it.
   That same change also falsified a Limits card ("no generated SDK package"),
   so re-read Limits against `README.md`'s "Not yet" whenever the tree moves.

2. **No negative claim about a named competitor.** The comparison table says
   what Stainless, Speakeasy, Fern, tRPC, oRPC, Smithy, TypeSpec and Better Auth
   are *good at*, then states how facet's shape differs. A claim that rests on
   someone else lacking something stops being true the day they ship a changelog
   entry, and nothing here re-checks it. A claim about our own mechanism is
   falsified by our own test suite.

3. **No speedup or size multiple.** There is no control arm — no "same API,
   hand-built, measured" run — so no *N× less code* appears anywhere. The Limits
   section says this out loud; keep it there.

4. **The Limits section is load-bearing.** "Not on npm" is the first card on
   purpose. A reader who discovers that at install time is a reader you lost
   honestly and avoidably.

5. **Verbatim output, or none.** The `omniface inspect` block and the `omniface diff`
   block are copied from real runs, not written to look like real runs. If the
   output format changes, re-run and re-paste.

## Design

One definition is white light; the four facets are the spectrum it refracts
into. So the brand accent is ink, and colour is spent only where it names a
facet — REST amber, SDK violet, CLI teal, MCP rose — and nowhere else. The
four-stop gradient in each section eyebrow is that idea in miniature.

Type is Bricolage Grotesque for display, IBM Plex Sans for body, IBM Plex Mono
for anything a terminal would print. Light and dark are both defined as token
sets on `:root`, with a `data-theme` toggle that wins over the OS in either
direction.

## Still to do

- An `og.png` — the `og:image` tags point at one that does not exist yet.
- A real domain. The canonical URL says `omniface.dev`, which is aspirational.
- A link-checking gate, so `../docs/*.md` links can't rot silently.
