---
type: decision-record
title: "0007. MCP server root resolution and C3Project handle adoption"
description: >-
  MCP root resolution via mcp-utils `resolveRootFolder` (env/discovery/cwd precedence) and hybrid C3Project handle adoption; rejected alternatives and deliberate non-adoptions ([#94](https://github.com/GenvidTechnologies/construct3-chef/issues/94))
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# 0007. MCP server root resolution and C3Project handle adoption

- **Status:** Accepted
- **Date:** 2026-06-17
- **Issue:** [#94](https://github.com/GenvidTechnologies/construct3-chef/issues/94)

## Context

The MCP server resolved its project root from `--project-dir` or, failing that, `process.cwd()`. Launched without an explicit flag — as the bundled `genvid-c3` plugin does — it silently targeted the shell's working directory rather than any nested C3 project. Fixing this also surfaced ~15 scattered `path.join(root, "eventSheets"|"layouts"|...)` literals across generators, recipe applier, and CLI: the string-join pattern was the only way to derive a canonical directory path, and it had duplicated in every caller.

## Decision

**Root resolution** (#94, mcp-utils#7): the server resolves `PROJECT_ROOT` through `@genvid/mcp-utils@0.5.0`'s `resolveRootFolder`, with precedence:

1. explicit `--project-dir` flag
2. `C3_PROJECT_DIR` environment variable
3. single-child `project.c3proj` discovery at search depth 1
4. cwd fallback

The env var is `C3_PROJECT_DIR` (not a chef-specific name) — shared deliberately with the sibling c3-domain-manager server so one variable targets both. On ambiguous discovery (≥ 2 child markers) or I/O error, `resolveRootFolder` returns an mcpError; the server logs to stderr and falls back to cwd rather than exiting, consistent with the pre-existing warn-only posture for a missing `project.c3proj`.

**C3Project handle** (#94, c3source#36): a module-level `PROJECT` handle (`openProject(root): C3Project` from `@genvid/c3source@1.5.0` (now `@genvidtech/c3source`)) sits beside `PROJECT_ROOT`/`EXTRACTED_DIR` in `server.ts`. Inside each function, `path.join(root, "eventSheets")` etc. are replaced with `project.eventSheetsDir`, `project.layoutsDir`, `project.objectTypesDir`, `project.familiesDir`, `project.scriptsDir`. Because `openProject`'s `*Dir` fields are documented as plain string joins with no I/O, output is byte-identical (locked by an equality assertion) and no barrel-exported signature changes — zero semver exposure and zero golden-test risk.

## Compromise

Three alternative scopes for the C3Project adoption were considered:

**(a) Handle-at-the-edge only** — use the handle in `server.ts` but leave the ~15 duplicated literals in generators, recipeApplier, and CLI untouched. Rejected: the duplication the issue targeted would survive.

**(b) Push the handle into exported signatures** — change barrel-exported functions (`runGenerators`, `applyRecipeInner`, `projectSync`, `includeTree`) to accept a `C3Project`. Rejected: breaks ≥ 5 barrel signatures (semver-breaking at any version), risks golden-output drift from path construction changing, and delivers only a cosmetic win since callers already pass `root` as a string.

**(c) Hybrid (chosen)** — module-level handle in `server.ts` plus a value-preserving internal refactor (the `path.join` → `project.*Dir` substitution inside each function body). No public surface changes; output locked by test.

**Deliberate non-adoptions:** three call sites were left on the old string-join pattern with explicit rationale:

- `sourceWatcher.ts` `SOURCE_DIRS` — already a single-source-of-truth array; no duplication to remove.
- `projectSync.ts` section configs — model 12 disk directories plus per-section metadata and feed the c3source drift API; the handle's 5 dirs cover only a subset, so partial adoption would add surface rather than simplify.
- Barrel-exported `SID_SOURCE_DIRS` — deliberately excludes `families/`, so it is not derivable from the handle's dir set.

The gap for `images/` and secondary section dirs is filed as c3source#38 (resolved in `@genvidtech/c3source@1.6.0`, which added `imagesDir` to `C3Project`). This mirrors the repo's established posture: don't force a partial upstream fit — request the right shape upstream and wait for it.

## Consequences

- Behavioral change: omitting `--project-dir` on `server` now discovers a nested project instead of silently using cwd. This is release-note-worthy but is not a barrel break.
- The "where is the root" resolution lives in `@genvidtech/mcp-utils`; the "what is the project" structural handle lives in `@genvidtech/c3source`. construct3-chef consumes both, consistent with the existing layering.
- Multi-root support (serving > 1 project per server process) is tracked in #95; the single `PROJECT` handle would need to become per-request state. That work is deferred.
- The c3-domain-manager server shares the same `C3_PROJECT_DIR` convention; the companion adoption is tracked in c3-domain-manager#16.
