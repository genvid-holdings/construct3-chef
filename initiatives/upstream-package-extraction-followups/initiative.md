# Initiative: Upstream Package Extraction — Follow-ups

> **Status: open (low priority).** Successor to the completed `upstream-package-extraction` initiative (its work-requests shipped as c3source@0.3.0 + genvid-mcp-utils@0.2.0; the downstream consumption landed across ~14 commits on the `upstream-updates` branch). This captures the few downstream adoptions that were **evaluated and deliberately deferred or declined** during that consumption, so they aren't silently re-attempted.

Full rationale (with the semantic/type-mismatch details) is in the session memory `upstream-extraction-downstream-followup.md`. Everything below is low priority — the codebase is correct and clean without it.

## Deferred — needs a contract decision

- **`mcpError` / `withMcpErrors` (server.ts).** genvid-mcp-utils ships these, but adopting them changes the **client-visible error response structure**: the current handlers return two content blocks (`Error: <msg>` + `txId: N`) and prefix `Error:`; `mcpError` collapses to one block and drops the prefix. One catch (`runWorkflowRecipe`) also runs a `CancelledError` side-effect (`watcher.bump()`) that `withMcpErrors` can't host. **Adopt only if a response-format change is acceptable** (and update any client/tests that parse it).
- **`paginatedResponse` → `paginatedContent` (server.ts).** Same class of issue: `paginatedContent` emits the page text + range footer as a single content block, whereas `paginatedResponse` emits the stale-warning-bearing page and the range line as **two** blocks. Client-visible structure change.

## Improvements — optional, low value

- **`formatEvent` → c3source `visitEvents`.** The main DSL formatter still threads a manual `EventCounter`. It *could* route through `visitEvents` (whose `eventNumber` is the canonical counter), and the sample-project DSL golden would guard the rewrite — but `formatEvent` interleaves DSL line-number tracking + blank-line-between-siblings + multi-line event bodies, so it's a large rewrite for marginal dedup. `buildShallowSidMap` and `buildSidIndex` already adopted `visitEvents` where it was clean.
- **`navigationGraph.findDslFiles` → `walkFiles`.** The last hand-rolled `.dsl.txt` walker. Left local because its per-level-sorted DFS order can't be reproduced by `walkFiles` (global, unsorted) and `findGoToLayoutCalls`' raw entry order isn't test-guarded (the PlantUML output *is* edge-sorted, so the risk is low but unverified). Swap if a navigation-graph test is added first.

## Declined — would require an upstream change first

- **In-memory layout visitors (`visitLayers` / `visitInstances`).** c3source's `visitLayers` builds a dotted, global-resetting `fullLayerName` and visits all layers with no early-exit; the ~12 downstream layout walks instead match bare `layer.name`, early-exit (finders), need a parent array (removers), or build `>`-separated display names (`layoutFormatter`). Plus layoutMutator/layoutScaffold operate on `Record<string,unknown>` (`LayerJson`), so each adoption needs `as unknown as Layout` casts — a lateral move, not a tidy-up. **Adoptable only if c3source adds** an early-exit/`findFirst`-style layout visitor and/or a bare-name option — a candidate upstream work-request (cf. the `canHaveChildren` request, c3source issue #4).

## Not in scope

The purely-local cleanups the original initiative flagged as "tracked separately" (the `patch-script` path/node merge, the `runMutation` MCP orchestrator, CLI↔server scaffold dedup, removing the deprecated `autoAdjust` machinery) were never part of upstream-package-extraction and are not tracked here.
