# Initiative: MCP Tooling Follow-ups

> **Status: open backlog.** Incremental enhancements to the shipped **file-based** MCP server and recipe system — no live-editor dependency (that's [c3-live-editor-integration](../c3-live-editor-integration/initiative.md)). Carved out of the retired c3-mcp-server initiative; architecture rationale and the security audit live in [docs/mcp-architecture.md](../../docs/mcp-architecture.md). Items are independent and roughly priority-ordered by observed friction.

## 1. Known read-tool gaps (highest signal — observed in real sessions)

These two gaps are the most concrete: each was hit during an actual authoring session, and the fix is well-understood.

### `read-dsl-index` has the same condition/action content limitation `read-event-sids` already fixed

`read-event-sids` was widened (2026-05-28) so its grep matches over condition/action **content** (parameter values, `[behaviorType]`, `[DISABLED]`, `NOT`) via a `searchText` field. `read-dsl-index` — which `filterIndex`-greps over `.dsl.idx.txt` — was **not** widened and still has the original shape:

- `formatBlockLike` pushes a `DslIndexEntry` per **action** but **no row per condition**, so `read-dsl-index grep=on-touched-object` can't match a condition row that doesn't exist.
- Action rows are built with `describeAction`, which **drops** parameter values / `[behaviorType]` / `[DISABLED]`, so `read-dsl-index grep=BattleLayout` keeps failing exactly where `read-event-sids grep=BattleLayout` now succeeds.

**Proposal:** push a `condition[N]` `DslIndexEntry` row in `formatBlockLike` right after each `when:` line (mirroring the per-action row), and either widen `describeAction` to include parameter values / `[behaviorType]` / `[DISABLED]` or have `formatBlockLike` use `formatAction` directly for index-entry descriptions. Cleanest version: factor the `summarize` logic in `buildShallowSidMap` and the per-condition/per-action `indexEntries.push` loop in `formatBlockLike` into **one shared helper** so the two surfaces can't drift again. (Note: `search type=dsl` already covers the underlying content by grepping rendered `.dsl.txt`, but it returns file/line hits, not SIDs — so users still come back to `read-dsl-index`/`read-event-sids` for SID coordinates.)

**Observed in:** the 2026-05-28 code-review pass that produced the `read-event-sids` fix.

### `read-event-sids` matched rows give no signal of *what* matched

When `grep` hits via the new `searchText` field, the rendered table row still shows only the `description` column (typically just `block` / `block [OR]` / `function "name"`). The caller gets a SID but no idea *which* condition/action triggered the match — so the workflow degrades to `read-event-sids grep=X` → 3 SIDs → `read-dsl` each to disambiguate, partly undoing the point of the filter.

**Proposal:** when filtering, render one extra indented line per row showing the first `searchText` line the regex matched, e.g. `  ↳ matched: System.go-to-layout(layout=BattleLayout)`. Keeps the pipe-delimited header row stable for parsers; skip the extra line when a row matched only via `description`, to avoid clutter. Low priority (`read-dsl` is a cheap follow-up) but worth doing alongside the next `read-event-sids` work.

**Observed in:** same 2026-05-28 code-review pass.

## 2. Global layer override extraction

C3 layouts can carry "global" layers defined in one layout and overridden in others. There is **no extracted file** listing which layers are global, where they originate, and which layouts override them — unlike templates (`template-scope.txt`) and containers (`containers.txt`). Finding where to add an instance-level override (e.g. a Grayscale effect on a `HeroSelected` instance living on a global layer shared between `HeroLayout` and `HeroSelectLayout`) currently requires hand-searching layout JSON.

**Proposal:** a `global-layers.txt` extraction (6th generator output) listing, per global layer:

- the layer name,
- the originating layout (where `"global": true` appears *without* `"overriden": 1`),
- all layouts that override it (layer name appears with matching name),
- instance counts per override.

Optionally also a `list-global-layers` MCP tool that returns this on demand without regeneration.

**Observed in:** story-battle-menu — needed to add a Grayscale override to `HeroSelected` on `HeroSelectLayout`, but that layer is global, overridden from `HeroLayout`; locating the correct override site required manual JSON inspection. This gap is referenced from [docs/c3/layout-reference.md § Tooling gap](../../docs/c3/layout-reference.md).

## 3. User-defined ops (reusable parameterized recipe templates)

Let teams register their own ops with the MCP server so common mutations ("add a new screen", "wire up a button handler", "create a VOD entry point") don't require writing raw recipe JSON each time.

- **Ops directory** — the server watches a configurable directory (e.g. `ops/` at project root) for `.json` op files.
- **Registration as tools** — each op file becomes an MCP tool (`ops/add-screen.json` → `op-add-screen`); tool description and parameters derive from op metadata.
- **Parameterization** — ops declare placeholders (`{{SCREEN_NAME}}`, `{{OBJECT_TYPE}}`) that the tool accepts as input and substitutes before applying.
- **Listing** — a `list-ops` tool enumerates registered ops with descriptions and parameters.
- **Hot reload** — adding/removing/editing op files updates the tool set via MCP `tools/list_changed`.

This builds on the existing recipe interpreter (the op file is a parameterized recipe). Resolved open question from the original initiative: raw recipe JSON stays available for one-off mutations; reusable patterns become named ops.

## 4. `search-docs` — official C3 documentation lookup

A tool that wraps a web search of `construct.net` to look up C3 plugin/behavior parameters, expression syntax, and condition/action IDs. Prevents incorrect parameter names (the recurring class of recipe gotchas — e.g. `object` vs `objectClass`, RUM `action` vs `name`). Could query a local API-reference cache first before hitting the web. Deferred originally for lack of a clean offline cache strategy; revisit if parameter-name mistakes remain a frequent failure mode.

## 5. Open MCP audit items

Carried from the MCP security/best-practices audit (full report recoverable via `git log -- initiatives/c3-mcp-server/mcp-audit.md`):

- **No configuration layer** — the server hardcodes `domain-config.json` location, the `extracted/` directory name, and registers all tools unconditionally. A config (`mcp.config.json` or init options) would let other projects customize which tools register / where config lives. Matters mainly for non-dev package consumers; N/A in the current dev context. (Source dir names — `eventSheets`, `layouts`, etc. — are fixed by C3 and correctly hardcoded.)
- **No pagination on list tools** — `list-event-sheets` / `list-layouts` return all entries in one response. Fine at ~100 files; the spec recommends cursor-based pagination for growth. Low priority.

## Related future work

- The **`extracted/` directory transition** (generate-on-demand + gitignore) is tracked separately in [extracted-on-demand](../extracted-on-demand/initiative.md) — it's an architectural shift to the read surface rather than a tool addition.
