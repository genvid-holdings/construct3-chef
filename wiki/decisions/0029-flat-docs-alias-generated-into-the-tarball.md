---
type: decision-record
title: "0029. Flat docs/ alias generated into the published tarball, not committed"
description: >-
  Restores the MCP `docs:///{name}` resource, emptied by ADR 0028's `docs/` →
  `wiki/` consolidation because upstream `exposeDocs` hardcodes a flat,
  non-recursive `<packageDir>/docs` scan it cannot be pointed at `wiki/`; a
  new `scripts/gen-docs-alias.mjs` regenerates a flat `docs/` from `wiki/` at
  `prepack`/`postpack` time only, gitignored and never committed, serving
  every non-`RESERVED` wiki page plus a generated manifest (a naive
  un-generated alias would serve only the 4
  bundle-root files); records the accepted no-link-rewriting and
  no-`TOC`-compat-alias trade-offs, the `exposeDocs` non-enumerability
  limitation (confirmed non-structural against the installed MCP SDK), and
  the retirement condition once upstream gains a configurable, recursive,
  enumerable docs surface ([#198](https://github.com/GenvidTechnologies/construct3-chef/issues/198))
tags: [decision, architecture]
status: superseded
generated: { by: process:maintain-wiki, at: 2026-08-22T16:00:00Z }
---

# 0029. Flat docs/ alias generated into the published tarball, not committed

- **Status:** Accepted, superseded by [0033](0033-mcp-docs-resource-serves-wiki-directly.md)
- **Date:** 2026-08-22
- **Issue:** [#198](https://github.com/GenvidTechnologies/construct3-chef/issues/198)

> **Superseded 2026-08-24.** The retirement condition this record names below
> — a configurable docs directory, a recursive scan, and a non-`undefined`
> `list` callback — shipped as [mcp-utils#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15)
> in `@genvidtech/mcp-utils` 0.8.0. Chef adopted it and deleted
> `scripts/gen-docs-alias.mjs` and the pack-time mechanism this record
> describes. See [0033](0033-mcp-docs-resource-serves-wiki-directly.md) for
> the adoption. The rest of this record is kept unchanged as a historical
> account of a decision that was correct for its moment.

## Context

`exposeDocs` (upstream `@genvidtech/mcp-utils`, not editable locally) backs
the MCP `docs:///{name}` resource. It does two things chef cannot configure:
it resolves a **hardcoded** `path.resolve(packageDir, "docs")`, and it scans
that directory **flat and non-recursive** (a single `readdirSync`, no
subdirectory walk). ADR
[0028](0028-documentation-consolidated-into-the-wiki-tier.md) retired
`docs/` into `wiki/`'s nested `reference/`/`architecture/`/`process/`/`decisions/`
layout and, in the same commit, dropped `docs` from `package.json`'s `files`
— so the resource has served **zero** documents (an `ENOENT` on every read)
since that consolidation, and the published tarball no longer even carries a
`docs/` directory for it to find.

The obvious fix — alias `wiki/` to `docs/`, or symlink one to the other —
does not clear the floor `exposeDocs`'s scan shape imposes. `wiki/` holds 46
tracked `.md` files, but a flat, non-recursive read of `wiki/` itself sees
only the 4 files at the bundle root (`wiki-schema.md`,
`local-verification-practice.md`, `index.md`, `log.md`) — 4 of 46, under 9%,
and the numerator is the stable half: a flat scan reaches bundle-root pages
and nothing else, whatever the corpus grows to,
and **zero** of them were ever actually served by the pre-consolidation
`docs/` (none is `recipe-reference`, `ops`, or `cli`, the three names the
only known downstream consumer, the `gvt-construct3` plugin, references by
filename). A naive alias fails the same way the retirement did — it just
fails at a different percentage.

## Decision

Generate a **flat `docs/`, from `wiki/`, into the published npm tarball
only** — never the working tree, never committed. A new
`scripts/gen-docs-alias.mjs` walks the bundle root plus every
`gen-wiki-index.mjs` `SECTIONS` directory, copies each page **verbatim** to
`docs/<stem>.md`, and excludes exactly what `RESERVED` (also exported from
`gen-wiki-index.mjs`, so the generator and the alias agree on the page set
without a second exclusion rule) already excludes from the wiki's own
indexes: every `index.md` and `log.md`, at every level. `package.json` wires
it through `prepack` (`npm run build && npm run docs:alias`) and `postpack`
(`… --clean`), mirroring `dist/`'s existing gitignored-but-shipped shape.
`exposeDocs` itself is untouched; the only local control surface stays its
existing `packageDir` argument — this fix works entirely by shaping what
that argument resolves to at pack time.

**The served set is a rule, not a number: every tracked `wiki/**/*.md` whose
basename does not match `RESERVED`, plus one generated `docs/index.md`
manifest** (listing every served name in `docs:///<name>` form, so an agent
has a working map even without `resources/list` — see the limitation below).
`RESERVED` is `/^(index|log)\.md$/`, imported from `gen-wiki-index.mjs`
rather than re-derived, so this generator, that one, and the OKF conformance
walk cannot disagree about what counts as a page. At the time of writing that
resolves to **41**: 46 tracked pages, minus 5 `index.md`, minus 1 `log.md`,
plus the manifest.

⚠️ **Do not quote that 41 as a fixed property — it moves with every wiki page
added, and this record is itself an instance.** The figure was corrected twice
during the fix, for unrelated reasons. First it was *defective*: the design
derived 41 as `45 − 5 index.md + 1`, having not accounted for `RESERVED` also
covering `log.md`; the corrected figure at 45 pages was **40**. Then it
*decayed*, self-referentially — committing this very ADR took the corpus
`45 → 46` and the served set back to **41**, the same number as the original
mistake but for an entirely different reason. The issue's acceptance criteria
were corrected both times, and now assert a `≥` threshold with
`gen-docs-alias.mjs --check` as the exact-match oracle, precisely so that
adding a wiki page cannot falsify them.

Three consequences are accepted rather than engineered around:

- **No link rewriting.** A flattened page keeps its original relative links
  (e.g. `../decisions/0016-….md`), which do not resolve once the directory
  structure they were written against is gone. This is declined
  deliberately, not an oversight: MCP delivers this content as inline text
  to a model, not a browsable filesystem tree, so a dead relative link costs
  little; a markdown-link rewriter is its own small language with its own
  escaping edge cases, and building one to fix links a text-delivery
  consumer mostly won't follow is not a good trade. The generated
  `docs/index.md` manifest is the intended navigation aid instead — it gives
  an agent a working `docs:///<name>` map without needing any link in a
  served page to resolve.
- **No `docs/TOC.md` compatibility alias.** Of the 10 names the `1.1.0`-era
  `docs/` served, 9 return under the flat alias with identical stems; the
  tenth, `TOC`, does not — it was folded into `wiki/index.md` by ADR 0028
  and now returns as `docs:///index` instead. This is a **deliberate
  rename**, not a gap: resurrecting the `TOC` name for zero live referrers
  would recreate exactly the "keep a shim to satisfy a hardcoded path" shape
  ADR 0028 itself rejected (its own § "Alternatives rejected", "Keep `docs/`
  as a thin shim").
- **Dev/installed asymmetry.** `docs/` is gitignored and simply absent in a
  source checkout; it exists only inside a packed or installed tarball,
  populated by `prepack` and removed again by `postpack`. `npm run
  docs:alias` is the documented one-liner for anyone who wants to inspect
  the generated surface locally. This asymmetry is also why this fix's own
  acceptance criteria assert against an actual packed-and-extracted tarball
  rather than the working tree — there is nothing in the working tree to
  assert against.

**Known limitation, carried forward unchanged from `exposeDocs`.**
`exposeDocs` constructs its `ResourceTemplate` with `list: undefined`, so
the `docs:///{name}` template is never enumerated by `resources/list` — only
the separately-registered static `docs:///readme` resource is listed;
completions for the templated names come from the `complete` callback
instead. This is **specific to `exposeDocs`'s implementation, not a
structural MCP limitation**: reading the installed MCP SDK
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`) confirms
its `ListResourcesRequestSchema` handler skips a registered template only
when `template.resourceTemplate.listCallback` is falsy — a template
registered with a real `list` callback *is* enumerated, alongside ordinary
resources, in the same response. A local implementation of this resource
could therefore be enumerable where `exposeDocs` is not; that is the tracked
"Option B" alternative below, not a limitation of MCP itself.

## Compromise

**Retirement condition, stated explicitly.** This alias exists only because
`exposeDocs` hardcodes its scan directory and shape. It should be **deleted**
— reverting to `exposeDocs` pointed straight at `wiki/` — once upstream
`@genvidtech/mcp-utils` ships an `exposeDocs` that accepts an optional
docs-directory argument, walks it recursively, and registers a non-`undefined`
`list` callback. That request covering all three is filed as
[mcp-utils#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15);
until it lands and ships, this generator is the supported path. Note
consumers pin `^0.7.0`, which excludes `0.8.0` — so adopting the fix will be
an explicit dependency bump, not a transparent pickup.

**Rejected — (a) a naive, un-generated `wiki/` → `docs/` alias.** See
Context: a flat, non-recursive scan of `wiki/` itself reaches only the 4
bundle-root pages (4 of 46 at the time of writing), none of which were ever
served pre-consolidation. Fails the basic
floor of "restore what was serving before" before any other trade-off is
even considered.

**Rejected for now — (b) own the resource locally**, registering
`docs:///{+path}` (or similar) directly in `src/mcp/server.ts` with a real
recursive walk and a real `list` callback. Strictly more capable than the
generated alias — it would be enumerable, need no pack-time step, and serve
the nested `wiki/` layout directly with no flattening. Rejected as the
immediate fix because it re-implements MCP resource-registration plumbing
that `CLAUDE.md` § "Leaf dependencies" routes upstream by design; it would
require repathing all ~23 known downstream references (in the
`gvt-construct3` plugin) rather than just correcting their currently
malformed `construct3-chef://docs` scheme; and it would have to re-register
the existing static `docs:///readme` resource without double-registering
it. Tracked as a genuine follow-up, not discarded — see the local Option-B
issue this branch also files.

**Rejected for now — (c) drop the resource entirely**, removing
`exposeDocs` from `src/mcp/server.ts` and treating the docs surface as
CLI/wiki-only. The `gvt-construct3` plugin references it from 23 occurrences
across 13 shipped files, and its own `CHANGELOG.md` (as of `2.2.1`) records
*increasing* reliance on the resource over time — removing it is a breaking
change to a live consumer that needs their explicit agreement first. Kept
as a fallback if that agreement is reached, not the default path.

**Rejected — (d) wait for the upstream fix before shipping anything.**
Cannot land before the next `mcp-utils` tag regardless of how the request is
prioritized, and even the narrowest possible upstream fix (an optional
`docsDir` argument alone, without the recursive-scan and `list`-callback
asks) would still only reach the 4-of-45 floor of option (a) unless `wiki/`'s
nested layout were also flattened — which is this generator's actual job.
Shipping the generator now and retiring it later is strictly better than
leaving the resource broken in the interim.

## Consequences

- The resource is restored today without any change to `exposeDocs` or to
  the `wiki/` bundle layout ADR 0028 chose — this fix is entirely additive
  packaging machinery.
- `docs/` re-enters the published tarball's `files` list; a consumer
  installing this package again receives a `docs/` directory, generated
  fresh on every `npm pack`/`npm publish`, never stale relative to `wiki/`
  at release time.
- The three accepted trade-offs above (no link rewriting, no `TOC` alias,
  dev/installed asymmetry) are permanent as long as this alias exists — they
  are not deferred work, they are the shape of the decision.
- This ADR is retired, and the generator deleted, only when the upstream
  capability named above ships; until then, `scripts/gen-docs-alias.mjs` and
  its `--check` flag are the source of truth for whether the alias matches
  `wiki/`.
- Three follow-up issues are filed from this branch, none of them blocking
  this fix:
  - [mcp-utils#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15)
    — the upstream request, and this ADR's retirement path.
  - [gvt-construct3#86](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-construct3/issues/86)
    — its `construct3-chef://docs` transposes server and protocol and has
    never resolved; 23 occurrences across 13 shipped files. Independent of
    this regression: fixing chef does not make that string resolve.
  - [#200](https://github.com/GenvidTechnologies/construct3-chef/issues/200)
    — Option B (local `docs:///{+path}` with an enumerable `list`), tracked
    rather than discarded, to be picked up only if enumeration or nested
    addressing is actually needed.

## Related

- [0028. Documentation consolidated into the wiki tier; docs/ retired](0028-documentation-consolidated-into-the-wiki-tier.md) — the consolidation whose plugin-contract impact enumeration this ADR completes.
