---
type: decision-record
title: "0006. Upstream ownership boundary and young-package adoption posture"
description: >-
  Traversal/discovery/domain-facts to `c3source`, MCP/config plumbing to `mcp-utils`, rendering local; young-package adoption posture and the forced-partial-fit anti-pattern
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# 0006. Upstream ownership boundary and young-package adoption posture

- **Status:** Accepted (retroactively documented)
- **Date:** 2026-05-31

## Context

Recorded retroactively — this posture formed with the first upstream adoption (2026-05-31, [#12](https://github.com/GenvidTechnologies/construct3-chef/issues/12)); the `docs/decisions/` convention was introduced later (ADR 0007).

construct3-chef sits atop two young `@genvid` packages (`@genvid/c3source` (now `@genvidtech/c3source` as of 1.6.0), `@genvid/mcp-utils` (now `@genvidtech/mcp-utils` as of 0.5.1)) and a sibling tool (`c3-domain-manager`). Capabilities are constantly pulled in both directions — some rightly belong upstream (reducing duplication across the two sibling tools), some rightly stay local (presentation and rendering specific to this tool's invented read surface). Without an explicit boundary, each decision is re-litigated ad-hoc and workarounds entrench.

## Decision

The boundary runs as follows:

- **Push into `@genvid/c3source`**: traversal, numbering, discovery, and C3 domain facts — `visitEvents`, `isCountingEvent`, the `find_all_*_path` finders, `walkSids`, `openProject`, `isEditorLocalPath`, `readProjectManifest`, `detectManifestDrift`, `extractIncludes`, `extractFunctions`, `validateForEditor`. These are C3 on-disk schema facts and traversal primitives.

- **Push into `@genvidtech/mcp-utils`**: generic MCP/config plumbing — `loadProjectConfig`, `resolveWithin`, `resolveRootFolder`, response-shaping helpers (`paginatedContent`, `mcpContent`, `mcpError`, `withMcpErrors`), concurrency primitives (`ReadWriteLock`, `OptimisticWatcher`, `ExpectedChanges`).

- **Keep local**: rendering and presentation — the `extracted/` read surface (DSL text, DSL index, layout summaries, `sid-registry.txt`, `template-scope.txt`) is this tool's invention, not C3 on-disk schema, and must not move upstream even when a c3source helper could shave lines. The `ChefConfig` schema, the recipe interpreter/applier, `customAceIndex`, and all op-template logic are also local.

**Young-package adoption posture**: while a `@genvid` package is young / pre-1.0, **prefer adopting upstream + accepting a local contract break** over entrenching a local workaround. When a needed primitive's *shape* doesn't fit the consuming operation, **request the right shape upstream and gate the local issue on it** rather than forcing a partial fit. The `#42 → c3source#21` case (a detection-only flat `detectManifestDrift` that couldn't back a mutating nested op; waited for the path-bearing `SectionDrift`/`DriftEntry` API) is the canonical "request the right shape, wait" precedent.

See [CLAUDE.md](../../CLAUDE.md) § "Leaf dependencies" for the adoption posture, and the [leaf-dependency ledger](../process/leaf-dependency-ledger.md) for the version-by-version history and the specific adoption decisions — including the deliberate declines, recorded there so they are not re-litigated.

## Compromise

Two boundary-collapse alternatives were rejected:

**(a) Roll everything locally** — avoiding upstream coordination at the cost of duplication across construct3-chef and c3-domain-manager. The `#36 uistate-drift` case proved this: duplicated manifest-membership logic in both tools diverged, and the fix required upstream coordination anyway. Local duplication is not cheaper; it defers the cost and compounds it.

**(b) Push presentation upstream** — coupling `@genvid/c3source`'s C3 on-disk schema layer to the DSL/index/layout-summary read surface, which is this tool's invented abstraction. The DSL formatter's rendering logic, cross-reference format, and `sid-registry.txt` row shape are implementation details of construct3-chef, not C3 platform facts.

The forced-partial-fit anti-pattern (adopting an upstream primitive whose shape is wrong for the consuming op) was also explicitly ruled out: the `#42` case tried to route `projectSync.runSync` through `detectManifestDrift` before the path-bearing API existed; the right move was to file c3source#21 and wait, which delivered a net-negative adoption (−250 lines) once the shape fit.

## Consequences

- Governs the whole adoption issue stream (#25, #26, #27, #28, #42, #47, #94, and future issues).
- Barrel-breaking removals (symbols deleted from re-exported modules) are semver-breaking at any version; they are noted in commit bodies and flagged at release tags.
- ADR 0007 is itself an instance of this posture: `resolveRootFolder` (plumbing) moved to `mcp-utils`, `openProject`/`C3Project` (domain handle) moved to `c3source`, rendering stayed local.
- When an upstream primitive is missing, file an intent request on the upstream repo rather than re-rolling it locally. See CLAUDE.md § "Leaf dependencies" for the `c3source` vs. `mcp-utils` routing guidance.
