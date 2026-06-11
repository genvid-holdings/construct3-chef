# MCP Server Architecture

Design rationale and research behind construct3-chef's MCP server (`src/mcp/server.ts`) and the file-based model it wraps. This is the durable reference; the operational summary lives in [CLAUDE.md](../CLAUDE.md) (§ "The two-surface data model", § "MCP server state model"), and the tool-by-tool usage lives in [recipe-reference.md](recipe-reference.md), [generators.md](generators.md), and [cli.md](cli.md).

> **Provenance.** construct3-chef began life inside the Genvid "burbank" monorepo as `bin/c3/` + `bin/mcp/`, developed across ~19 working sessions, then extracted into this standalone package (shared MCP plumbing → `@genvid/mcp-utils`, the C3 JSON domain layer → `@genvid/c3source`, domain-categorization tooling → `domain-manager`). That work was tracked in the now-retired **c3-mcp-server initiative**; its session-by-session plans, completed-feature design docs (packaging, filesystem-independence, session 18, SID-singleton removal), requirements analyses, and the full MCP security audit are recoverable from git history (`git log -- initiatives/c3-mcp-server`). The *forward-looking* parts of that initiative were carried into tracking issues: [#14 C3 Live Editor Integration](https://github.com/genvid-holdings/construct3-chef/issues/14), [#15 `extracted/` Generated On Demand](https://github.com/genvid-holdings/construct3-chef/issues/15), and the granular MCP-tooling follow-up issues (#18–#24).

## Why a file-based MCP server

The same library is exposed two ways — a yargs **CLI** and an **MCP server** — both thin wrappers over the pure functions in `src/c3/`. The MCP server gives Claude Code structured, queryable access to a C3 project (read DSL, search, apply recipes, regenerate, sync) without reading raw files or shelling out to `npm run`.

The decisive constraint is that **the C3 Editor SDK does not expose event-sheet or layout manipulation** (see [SDK capabilities](#c3-editor-sdk-capabilities-research) below). So the highest-value approach is a server that operates directly on the project's on-disk JSON, not one that drives a live editor. A live-editor bridge is *additive*, not essential — it is the subject of issue [#14 C3 Live Editor Integration](https://github.com/genvid-holdings/construct3-chef/issues/14).

```
Claude Code  <--stdio-->  MCP Server (Node.js, local)
                              ├── reads extracted/ files (DSL, scripts, layout summaries, indexes)
                              ├── reads eventSheets/ / layouts/ / objectTypes/ JSON
                              ├── applies recipes (mutates source JSON)
                              └── runs the 6 generators (regenerates extracted/)
```

## Design decisions

- **stdio transport over HTTP.** Claude Code launches the server as a subprocess and talks over stdin/stdout. Simplest setup, no port management, automatic lifecycle, no network exposure. (HTTP/WebSocket transports would add Origin validation and session-management burden for no benefit in a local dev tool.)
- **File-based first.** The SDK limitation makes file-based tools the primary value; the C3 Addon Bridge and browser automation are deferred until file-based usage reveals concrete gaps.
- **Wrap existing functions, don't duplicate logic.** The server calls the same exported `src/c3/` functions as the CLI. The boundary is deliberate: server code calls *exported* library functions (generators, recipe interpreter, project sync) rather than internal helpers, which is what made the standalone-package extraction a matter of packaging rather than refactoring.
- **`Logger` interface for output capture.** MCP stdio uses stdout for JSON-RPC, so any stray `console.log` from a called function would corrupt the protocol. Solution: a `Logger = (...args: unknown[]) => void` type (in `src/c3/types.ts`) threaded through every output-producing function. CLI entry points default to `console.log`; MCP handlers pass a line-accumulating closure and return the captured lines as tool text. No monkey-patching of `console`.
- **`ReadWriteLock` for concurrency safety.** The MCP SDK dispatches handlers concurrently, so two write handlers could interleave at any `await` and corrupt files. A write-preferring `ReadWriteLock` (from `@genvid/mcp-utils`) allows concurrent reads, exclusive writes, and queues new reads behind pending writes to prevent write starvation.
- **Terraform-like plan/apply via `txId`.** A monotonic `txId` counter (owned by the `OptimisticWatcher`, resets on restart) increments on every source-file write. Validate/read tools return the current `txId`; `apply-recipe`/`sync-project` accept an expected `txId` and reject if it has moved (`"State changed: expected 42, got 43"`). The check-and-increment is atomic inside `rwlock.write()`. Prevents TOCTOU between validate and apply in multi-agent or user-concurrent scenarios.
- **Response shape: a single content block, adopted from upstream.** Every tool returns **one** text content block. Success-with-txId tools fold the result text and a trailing `txId: <n>` footer into one block via `@genvid/mcp-utils`' `mcpContent(text, footer)`; errors/rejections use `mcpError(e, { prefix, extraLines })` (`isError: true`, an `Error:` prefix, the `txId: <n>` footer as an extra line); a few txId-less paths (`regenerate`/`generate-sids`/not-found hints) emit `mcpError`/`mcpContent` without the footer. The handler bodies are wrapped in `withMcpErrors(fn, { prefix, onError, extraLines })`, which catches throws, runs the `onError` side-effect hook **before** formatting (hosting each tool's `CancelledError → watcher.bump()` / `extractedDirty = true` catch — `regenerate` is the exception: dirty-only, no bump), then formats via `mcpError` — its `extraLines` thunk runs *after* `onError`, so the `txId` footer reflects the post-bump value. This **replaces** the former local `errorWithTxId`/`caughtError`/`notFound` helpers and the old *two-block* (`text` + separate `txId`) shape. The split that once kept this local was settled the *other* way: **pagination adopted upstream first in [#26](https://github.com/genvid-holdings/construct3-chef/issues/26)** (`paginatedResponse` → `paginatedContent`, single block with the `lines: X-Y / total` footer, stale-warning folded in via the unchanged `appendStaleWarning`; out-of-range now reports the honest `lines: 0 / total`), accepting the client-visible contract-break as fine while the package is young. The error/txId shaping was the remaining holdout, blocked on three upstream capabilities (a `withMcpErrors` `onError` hook, a single-block `txId` footer, a configurable `Error:` prefix) filed as genvid-mcp-utils#5; **`@genvid/mcp-utils@0.4.0` delivered all three** (`mcpContent`, `mcpError`, `withMcpErrors` with `onError`), and [#25](https://github.com/genvid-holdings/construct3-chef/issues/25) adopted them on the back of the [#79](https://github.com/genvid-holdings/construct3-chef/issues/79) `^0.3.0 → ^0.4.0` bump. The two-block → single-block change is a **breaking** response-contract change (flagged for the next release tag). Both contracts are guarded by handler-level characterization tests (`test/mcp/serverHandlers.test.ts`), which invoke registered handlers directly via an internal `reg()` / `__getHandler` seam in `server.ts` against a fixture with a fake watcher — exercising the txId-rejection, stale-warning, single-block pagination ([#26](https://github.com/genvid-holdings/construct3-chef/issues/26)), and `CancelledError`-ordering paths ([#72](https://github.com/genvid-holdings/construct3-chef/issues/72), PR #73).
- **`extractedDirty` flag.** Tracks whether `extracted/` is stale relative to source. Set true on source writes or detected external changes; cleared when `regenerate` (or `apply-recipe` with `regenerate: true`) completes. Read tools serving from `extracted/` append a staleness warning when dirty — they don't block or auto-regenerate (the agent decides). `checkSourceFreshness()` also flips it by comparing source vs. extracted mtimes, so a `git checkout`/editor-save/manual edit is caught even without a watcher event.
- **File-system watcher + self-write suppression.** `createSourceWatcher` (`src/mcp/sourceWatcher.ts`) wires @genvid/mcp-utils' `OptimisticWatcher` over the source dirs + `project.c3proj`. External changes (editor saves, user edits) bump `txId` and set `extractedDirty` (source dirs), or bump `txId` only (`project.c3proj`). To avoid double-counting the server's own writes, mutate tools wrap the write in `watcher.suppress(async () => { … })` (a synchronous suppress window) and, for events that arrive after the window closes, pre-register the path with `watcher.expect(absPath)` (a TTL-based `ExpectedChanges` set, periodically purged). **Editing a mutate tool means you must wrap its writes in `suppress` — and `expect()` any path written outside that call — or the watcher will spuriously mark state dirty.**
- **Cancellation leaves a coherent state.** Long tools check `extra.signal.aborted` between generator steps. A `CancelledError` mid-regeneration still sets `extractedDirty = true`, because source was already written before regeneration was interrupted.

## Concurrency & security posture

Summary of the standalone MCP security/best-practices audit (the full per-issue report is in git history under `initiatives/c3-mcp-server/mcp-audit.md`). Audited against the MCP spec (2025-03-26, 2025-06-18), security best-practices guide, and server-concept docs.

**In place:**

- **Path-traversal guards** (`path.relative()` + `startsWith("..")` containment) on every path-taking surface: `readExtracted`, `read-addon`, `scaffold-layout` (source + output), `scaffold-sprite`, and the `search` glob/path parameter. *Keep these when adding path-taking tools.* `search-docs` reads only `<extractedDir>/c3-reference/` (the local reference cache) and the project's own `addons/`; it never fetches anything and has no network surface.
- **Optimistic concurrency** via `txId` (above).
- **Input validation** — Zod schemas on every tool, with `.describe()` on every parameter.
- **Two-tier error handling** — caught exceptions become `isError: true` content (a single block via upstream `mcpError`/`withMcpErrors`, see the response-shape bullet above); bad input surfaces as protocol errors.
- **Tool annotations** — every tool declares `readOnlyHint`/`destructiveHint`/`idempotentHint` via the `READ_ONLY` / `REGENERATE` / `MUTATE` constants.
- **ReDoS mitigation** on `search` — pattern length cap (500 chars) + match count cap (1000). (`re2` was deferred: a native dependency for marginal benefit against a local stdio threat model.)
- **Lifecycle** — stdio (no network surface), startup validation (warns on missing `project.c3proj` / `extracted/`, auto-generates `extracted/` when absent), graceful SIGINT/SIGTERM shutdown, MCP `logging` capability for watcher-event diagnostics.
- **`search-docs` has no network surface at query time.** It reads only the local `<extractedDir>/c3-reference/` cache and the project's own `addons/`. The PDF fetch + extraction that produces the cache is performed out-of-process by the genvid-c3 `build-reference` plugin skill and is never an MCP tool — so the stdio server keeps its no-network-at-query-time posture.

**Known open items**: no configuration layer for which tools register / where `domain-config.json` lives ([#23](https://github.com/genvid-holdings/construct3-chef/issues/23); matters mainly for non-dev package consumers), and no cursor-based pagination on `list-event-sheets` / `list-layouts` ([#24](https://github.com/genvid-holdings/construct3-chef/issues/24); low priority at ~100 files).

## C3 Editor SDK capabilities (research)

Findings from the C3 addon SDK exploration that justify the file-based-first decision. The editor-side SDK **exposes**:

- Instance manipulation (create/delete instances in layouts; set position/size/rotation/properties)
- Object types (create object types; access animations/frames)
- Plugin properties (`GetPropertyValue`/`SetPropertyValue`)
- Custom editor rendering (`Draw()` for layout-view visuals), file importers (drag-drop ZIP/Blob)
- Undo/redo (`UndoPointChangeObjectInstancesProperty`), project access (`layoutView.GetProject()` → `IProject`)
- Single-global plugins that persist across layouts (ideal for service integrations)

It does **not** expose — and this is the crux — **event-sheet read/write, layout-structure manipulation (layers, layout properties), variable/data manipulation, project filesystem access, or direct inter-plugin communication.** Editor-side code runs on the main browser thread (has `fetch`/`WebSocket`); runtime code uses a DOM messaging bridge (`postToDOM`/`postToDOMAsync`).

**Consequence:** anything touching event sheets or layout structure *must* go through the on-disk JSON (the file-based server). A live bridge can only add instance/property manipulation on top — which is exactly the scope of issue [#14 C3 Live Editor Integration](https://github.com/genvid-holdings/construct3-chef/issues/14).

### C3 addon structure (reference)

An addon is a `.c3addon` ZIP with `addon.json`, `aces.json`, editor scripts (`plugin.js`/`type.js`/`instance.js` over `SDK.IPluginBase` etc.), `c3runtime/` (actions/conditions/expressions/`domSide.js`), and `lang/`. Runtime↔browser communication goes through a `_postToDOM(message, data)` DOM bridge. The single-global pattern (one instance, persists across layouts) is the right shape for a service integration such as an MCP relay.

## Prior art: liauw-media/construct3-mcp

[github.com/liauw-media/construct3-mcp](https://github.com/liauw-media/construct3-mcp) — an MIT-licensed, from-scratch MCP server for C3 projects with its own reader/writer, SID/UID generation, analysis tools, and mutation operations. A full architectural comparison (their type model, analyzers, mutation orchestrator) is preserved in [prior-art-construct3-mcp.md](prior-art-construct3-mcp.md).

**What they have that construct3-chef does not:**

- Event-sheet flow visualization and function mapping
- Dependency graphs and orphaned-object detection
- Asset-usage tracking and performance heuristics
- Imperative event-block mutation tools (add condition / add action / create block)
- Automatic backup before mutations

**What construct3-chef has that they do not:**

- Human-readable DSL with cross-references; extracted TypeScript with named scope types
- Layout summaries and template-scope reference
- A declarative recipe system (batch mutations, builder shorthand)
- DSL index for SID ↔ JSON-path ↔ line lookup

**Takeaways:** their event-flow analysis attacks the same readability problem the DSL was built for, by a different route (structured queries vs. human-readable text) — both valid. Their imperative "add action / add condition" model is simpler for one-off edits; construct3-chef deliberately chose declarative recipes, which shine for batch operations but are heavier for a single tweak. Their analyzers (deps, orphans, asset usage, performance) are the clearest source of ideas for future read-only tooling.
