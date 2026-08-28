---
type: decision-record
title: "0005. MCP server optimistic-concurrency model"
description: >-
  `txId` optimistic concurrency + `extractedDirty` staleness flag + `ReadWriteLock`; rejected locks-only and no-watcher alternatives
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# 0005. MCP server optimistic-concurrency model

- **Status:** Accepted (retroactively documented)
- **Date:** 2026-04-03

## Context

Recorded retroactively — the mechanism arrived at the repo's initial release (2026-04-03), imported from the prior c3-mcp-server initiative; the `docs/decisions/` convention was introduced later (ADR 0007).

Unlike the stateless CLI, the MCP server serves concurrent read requests alongside serialized writes, while external file edits (from the C3 editor or the user) are possible at any time. Without a staleness and conflict-detection mechanism, a validate→apply sequence can operate on stale source, and two simultaneous write handlers can interleave at any `await` and corrupt files.

## Decision

The server uses an optimistic-concurrency model with three interlocking mechanisms:

- **`txId`** — a monotonic counter owned by the `OptimisticWatcher`, incremented via `watcher.bump()` on every source-file mutation. Read tools and `validate-recipe` return the current `txId`; `apply-recipe` and `sync-project` accept an expected `txId` and reject if it has moved. This is the Terraform-like plan/apply check-and-act guard.

- **`extractedDirty` flag** — set true on source writes or detected external changes; cleared when `regenerate` (or `apply-recipe` with `regenerate: true`) completes. Read tools serving from `extracted/` append a staleness warning when dirty — they do not block or auto-regenerate. `checkSourceFreshness()` also flips it by comparing source vs. extracted mtimes, catching external edits that arrive without a watcher event.

- **`ReadWriteLock`** (from `@genvidtech/mcp-utils`) — allows concurrent reads, exclusive writes, queues new reads behind pending writes. The check-and-increment of `txId` is atomic inside `rwlock.write()`.

Self-induced writes are masked by wrapping them in `watcher.suppress(async () => { … })` plus `watcher.expect(absPath)` for paths whose watcher event may land after the suppress window closes. `CancelledError` paths still bump `txId` and set `extractedDirty`, because source was already written before regeneration was interrupted.

Tools are tagged `READ_ONLY` / `REGENERATE` / `MUTATE` via shared annotation constants.

**`wiki/architecture/mcp-architecture.md` is the canonical in-depth reference** for this model — including the stdio transport rationale, the watcher suppress/expect mechanics, the `Logger` and `ReadWriteLock` design decisions, and the full concurrency/security posture. This ADR records the decision and rejected alternatives; consult that doc for implementation depth.

## Compromise

Two weaker alternatives were rejected:

**(a) Locks-only without an optimistic `txId`** — a `ReadWriteLock` alone serializes concurrent writes but does not detect cross-client TOCTOU races: a validate done in one client session and an apply done in another can still operate on different project states. The `txId` check is what catches that.

**(b) No watcher or dirty tracking** — without `extractedDirty` and `checkSourceFreshness`, external edits (editor saves, `git checkout`) are silently invisible: read tools serve stale `extracted/` content with no warning, and the agent has no signal to regenerate before acting.

## Consequences

- Editing a mutate tool requires wrapping its writes in `watcher.suppress` — and `watcher.expect(absPath)` for any path written outside that call — or the watcher will spuriously mark state dirty and bump `txId`.
- `CancelledError` handling in every long tool must still set `extractedDirty = true` and call `watcher.bump()` when source was already written before cancellation.
- The `regenerate` tool is the exception: it sets `extractedDirty = false` on success but does **not** bump `txId` (regeneration does not mutate source).
- Multi-root support (> 1 project per server process) shipped in [#95](https://github.com/GenvidTechnologies/construct3-chef/issues/95); the single `PROJECT` module-level handle became per-request state as `ProjectContext`, one instance per registered project, with `txId`/`extractedDirty`/`ReadWriteLock` all following it — see ADR [0034](0034-mcp-server-multi-project-support.md).
