---
type: decision-record
title: "0033. The MCP docs resource serves wiki/ directly; the pack-time alias is retired"
description: >-
  `@genvidtech/mcp-utils` 0.8.0 shipped the configurable-directory,
  recursive-scan, and enumerable-`list` capabilities ADR 0029 named as its
  retirement condition ([mcp-utils#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15)).
  Chef adopted them by pointing `exposeDocs` straight at `wiki/` and deleting
  `scripts/gen-docs-alias.mjs`, its test, and the `prepack`/`postpack`
  generation step — the docs resource is no longer pack-time-only, no longer
  flattened by a local generator, and its names are now path-shaped
  ([#207](https://github.com/GenvidTechnologies/construct3-chef/issues/207))
tags: [decision, architecture, documentation]
status: stable
generated: { by: process:tech-writer, at: 2026-08-24T00:00:00Z }
---

# 0033. The MCP docs resource serves wiki/ directly; the pack-time alias is retired

- **Status:** Accepted
- **Date:** 2026-08-24
- **Issue:** [#207](https://github.com/GenvidTechnologies/construct3-chef/issues/207), closes [#200](https://github.com/GenvidTechnologies/construct3-chef/issues/200)

## Context

ADR [0029](0029-flat-docs-alias-generated-into-the-tarball.md) generated a
flat `docs/` directory from `wiki/` at `prepack` time, gitignored and never
committed, because upstream `exposeDocs` (`@genvidtech/mcp-utils`) hardcoded a
flat, non-recursive scan of `<packageDir>/docs` with no `list` callback. It
stated its own retirement condition explicitly: delete the generator once
upstream ships an `exposeDocs` that accepts a configurable docs directory,
walks it recursively, and registers a non-`undefined` `list` callback. That
request was filed as
[mcp-utils#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15) and
**closed 2026-08-24** with the release of `@genvidtech/mcp-utils` 0.8.0,
which shipped all three: an optional `docsDir` option, an optional
`recursive` option, and a real `list` callback backing a
`docs:///{+path}` (RFC 6570 reserved expansion) resource template — see
[`wiki/process/leaf-dependency-ledger.md`](../process/leaf-dependency-ledger.md)
§ `@genvidtech/mcp-utils` § 0.8.0 for the full upstream-shipped/adopted/declined
record.

## Decision

Point `exposeDocs` straight at the wiki tier and delete the generator:

```ts
exposeDocs(server, __pkgDir, { docsDir: "wiki", recursive: true });
```

This is the adoption ADR 0029 already named as "Option A" — reverting to
`exposeDocs` pointed straight at `wiki/` — now that upstream's scan shape
actually reaches it. `scripts/gen-docs-alias.mjs`,
`test/wiki/docsAlias.test.ts`, the `docs:alias` npm script, the `prepack`
`docs:alias` step, and the whole `postpack` entry are deleted; `"docs"` is
dropped from `package.json`'s `files`.

**`package.json`'s `files` array already carried `"wiki"`** — the wiki tier
has shipped inside the published package since ADR 0028's consolidation, for
the tarball's own `wiki-schema.md`/`index.md` and the plugin-authoring
surface. So this adoption required **no packaging change** of its own; it is
pure deletion of machinery that existed only to work around a scan shape that
no longer applies.

Two behaviour changes follow directly from serving `wiki/` itself instead of
a filtered, flattened copy:

1. **More pages are served.** The local generator excluded every page
   matching `RESERVED` (`index.md`/`log.md` at any level, the same set
   `gen-wiki-index.mjs` excludes from its own generated indexes). Upstream
   `exposeDocs` has no equivalent concept — it serves every `.md` file under
   `docsDir` — so `index.md` and `log.md` pages become readable at every
   level, including `docs:///index`, which now returns `wiki/index.md`
   itself, the wiki tier's own table of contents.
2. **Names are path-shaped.** The old flat alias served every page at a
   bare stem (`docs:///cli`); the nested `wiki/` layout now surfaces under
   its real relative path (`docs:///reference/cli`). RFC 6570 reserved
   expansion (`{+path}`) matches a name with no separator too, so this is
   additive at the leaf level, not a second breaking rename on top of ADR
   0029's own `TOC` → `index` rename.

**The served set is a rule, not a number**, per the same discipline ADR 0029
established and this record continues: every tracked `*.md` under `wiki/`,
served recursively at its real path relative to `wiki/`. A count quoted here
would be stale the moment the next wiki page is added, and — since this
record is itself a new page under `wiki/` — stale by its own act of being
committed. State the rule; let the count fall out.

**`.gitignore`'s `/docs/` entry is deliberately kept, not removed.** Nothing
generates a `docs/` directory any more, so the entry is vestigial. It stays
anyway: `CLAUDE.md` § "Where to read more" carries a standing rule that
`docs/` as a tracked documentation tier must never be recreated (ADR 0028's
consolidation), and the stale ignore-rule is cheap insurance against that
documented recurring mistake resurfacing as an accidental `docs/` commit —
removing insurance that costs one gitignore line to save a line of clutter is
not a good trade.

### Why #200's repath objection no longer applies

ADR 0029 rejected "Option B" — owning the resource locally with an
enumerable `list` callback, which is functionally what this record now
adopts from upstream — partly because it would repath the ~23 known
`gvt-construct3` references to the flat name scheme. That objection was
sound when written: those 23 references pointed at working flat names, and
repathing them for no functional gain was a real cost with no offsetting
benefit.

It stopped being sound because those 23 references never resolved in the
first place. [gvt-construct3#86](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-construct3/issues/86)
records that the scheme in `gvt-construct3` is `construct3-chef://docs`,
which transposes server and protocol against the actual
`docs://construct3-chef/<name>` shape — every one of the 23 references is
already broken on an unrelated defect, unconditionally of any repath this
record makes. Fixing that transposition requires rewriting all 23 references
regardless of which name scheme they land on, so the repath this record's
path-shaped names cause is not a new cost at all — it is folded into a
rewrite that has to happen either way.

**#200's locally-owned `registerWikiDocs` alternative is superseded by
upstream shipping the capability, not rejected on its merits.** `CLAUDE.md`
§ "Leaf dependencies" states the adoption posture plainly: generic MCP
plumbing is requested and adopted upstream rather than re-implemented
locally. #200 was filed as the fallback for exactly the case where upstream
declined or stalled; upstream instead shipped the full ask, so the posture's
default path — adopt upstream, don't re-implement — is what fired. #200 is
closed by this record rather than actioned.

## Consequences

- **The dev/installed asymmetry ADR 0029 documented disappears.** The old
  resource was empty when running from source (`docs/` was gitignored and
  populated only at `prepack`) and populated only from an installed or
  packed tarball. `wiki/` is a normal tracked directory present in every
  checkout, so `exposeDocs(server, __pkgDir, { docsDir: "wiki", recursive: true })`
  serves identically whether the server runs from source or from an
  installed package. `npm run docs:alias` and its accompanying test are
  gone; nothing needs a pack-and-extract round trip to inspect the docs
  surface any more.
- **The resource is enumerable.** Upstream's `list` callback means
  `resources/list` now returns every served page, where the old
  `exposeDocs` (and, before it, the generated alias) left the templated
  resource unlisted — completions came only from the `complete` callback.
- **No readme collision to guard against.** `exposeDocs` drops a
  `<docsDir>/readme.md` name when a package-root `README.md` exists, since
  the static `docs:///readme` resource would otherwise be shadowed. `wiki/`
  contains no `readme.md` at any level, so this collision-avoidance never
  fires here; noted so a future wiki page is not surprised by it.
- **No local link rewriting, still.** ADR 0029's accepted trade-off carries
  forward unchanged: a served page keeps its original relative links
  (`../decisions/0016-….md`), which resolve against `wiki/`'s real layout
  now rather than against a flattened copy — an improvement over the old
  alias, not a new gap, since the alias's flattening was what broke them in
  the first place.
- **ADR 0029 is superseded, not deleted.** It remains the historical record
  of why the pack-time alias existed and what it traded off; this record
  supersedes it rather than rewriting it, per the "docs describe current
  state" rule applied to a decision that was correct for its moment.
- [mcp-utils#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15)
  is closed. [gvt-construct3#86](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-construct3/issues/86)
  remains open and unaffected by this record — fixing chef's serving side
  does not make a malformed scheme string on the consumer side resolve.

## Related

- [0029. Flat docs/ alias generated into the published tarball, not committed](0029-flat-docs-alias-generated-into-the-tarball.md) — the decision this record supersedes.
- [0028. Documentation consolidated into the wiki tier; docs/ retired](0028-documentation-consolidated-into-the-wiki-tier.md) — the consolidation both records trace back to.
