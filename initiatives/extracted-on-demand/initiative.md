# Initiative: `extracted/` Generated On Demand

> **Status: design only, not started.** An architectural change to the *read surface* of construct3-chef. Carved out of the retired c3-mcp-server initiative. Read [docs/mcp-architecture.md](../../docs/mcp-architecture.md) and CLAUDE.md § "The two-surface data model" first — this initiative proposes flipping one half of that model from committed-to-disk to generated-on-demand.

## Today

The repo has two views of a project:

- **Source JSON** (`eventSheets/`, `layouts/`, `objectTypes/`) — the write surface, the actual C3 project.
- **`extracted/`** (DSL, indexes, extracted TypeScript, layout summaries, `template-scope.txt`, `sid-registry.txt`) — the read surface, regenerated from source by the 5 generators and **committed alongside source** so it shows up in PR diffs and IDE search.

Committing `extracted/` has a cost: every source mutation makes it stale until regenerated, and the regenerated files produce diff noise on every change. CLAUDE.md and [docs/generators.md](../../docs/generators.md) currently document it as committed-and-required.

## Goal

Make `extracted/` a **convenience output, not a dependency**: generated on demand (in-memory for MCP responses, into a temp dir for CI), with on-disk generation optional and the committed copy eventually removed from version control.

## Proposed transition

1. **MCP server generates in-memory.** DSL, scripts, layouts, indexes produced on the fly by calling the `src/c3/` generator functions directly — no disk writes needed to serve a read tool. (The server already imports these functions; the change is to return generator output directly rather than reading pre-generated files.)
2. **CI generates into a temp dir.** `typecheck`-of-extracted and any validation run against freshly generated output, not committed files.
3. **Optional disk generation.** `construct3-chef generate` still writes `extracted/` for developers who want files on disk (PR diffs, IDE grep), but it's opt-in rather than required.
4. **Gitignore `extracted/`.** Remove it from version control, eliminating commit noise and regeneration friction.

## Key architectural change

MCP read tools call generator functions **in-process** and return results directly, rather than reading pre-generated files from disk. The `extractedDirty` / `checkSourceFreshness` machinery (see [docs/mcp-architecture.md § Design decisions](../../docs/mcp-architecture.md#design-decisions)) loses most of its purpose once reads are always generated fresh — that interaction needs to be designed, not just bolted on.

## Open questions / risks

- **Performance** — does in-process generation per read tool call stay fast enough, or is caching needed? (Original note: disk is simpler and always fresh; in-memory trades that for no staleness window but adds per-call generation cost.)
- **Diff/review workflow loss** — committed `extracted/` is currently how reviewers read C3 changes in PRs. Gitignoring it removes that unless an alternative is provided (e.g. a CI-rendered artifact, or keeping DSL committed while dropping the rest).
- **`sid-registry.txt`** — recipes seed their SID context from this file (`readRegistryFile`). If it stops being committed, recipe application must regenerate it first. Confirm the apply path handles a missing/on-demand registry.
- **Staleness semantics** — reconcile `extractedDirty`/`txId` with always-fresh reads; decide what these mean once `extracted/` is no longer a persisted cache.

## Why deferred

Not blocking any current workflow — the committed `extracted/` works. This is a friction/cleanliness improvement, worth doing when commit-noise from regeneration becomes a real maintenance drag or when a consumer genuinely cannot keep `extracted/` on disk.
