---
type: decision-record
title: "0034. MCP server multi-project support"
description: >-
  One server process hosts N C3 project roots; every tool call targets
  exactly one project via a per-call `project` selector (`ProjectContext` +
  `ProjectRegistry`), a readable composite `<projectId>:<counter>` txId
  format, and per-project `op-<projectId>_<opName>` tool names. Records all
  eleven declined alternatives and the general one-lock-acquisition-per-call
  rule ([#95](https://github.com/GenvidTechnologies/construct3-chef/issues/95))
tags: [decision, architecture, mcp, concurrency]
status: stable
generated: { by: process:tech-writer, at: 2026-08-27T00:00:00Z }
---

# 0034. MCP server multi-project support

- **Status:** Accepted
- **Date:** 2026-08-27
- **Issue:** [#95](https://github.com/GenvidTechnologies/construct3-chef/issues/95)

## Context

Before this change, `src/mcp/server.ts` carried seven module-level per-project
globals (`PROJECT_ROOT`, `EXTRACTED_DIR`, `PROJECT`, `rwlock`, `extractedDirty`,
`watcher`, `expectedChanges`) — one server process could serve exactly one C3
project root. ADR [0005](0005-mcp-server-optimistic-concurrency-model.md) and
ADR [0007](0007-mcp-server-root-resolution-and-c3project-adoption.md) both
named this issue as where the singletons would need to become per-request
state. #95 is not an umbrella: there are no independently-shippable parts —
"half the tools are project-aware" is not a shippable state — so it landed as
one cross-cutting seam across a single branch.

## Decision

**Every tool call targets exactly one project. No fan-out, no cross-project
operation, no merged results.**

- **`ProjectContext`** (`src/mcp/projectContext.ts`, off-barrel) collapses the
  seven former globals — plus `GENERATOR_STEPS`, `txIdLine`, the `OpsRegistry`
  instance, and the watcher's `ObservedState` LRU — behind one object per
  registered project. `id`/`root`/`extractedDir`/`project`/`rwlock`/`expected`/
  `config` are getter-only over `readonly #private` fields: an accidental
  assignment throws `TypeError` at runtime (ESM modules are always strict),
  which makes the old "reassign `PROJECT_ROOT` and remember to reassign
  `PROJECT` too, or it goes stale" convention (CLAUDE.md § "MCP server state
  model", pre-#95) a structural guarantee instead of a discipline. `watcher`
  and `ops` stay mutable — both are wired onto a context by the caller after
  construction, since each needs a finished `ProjectContext` to close over.

- **`ProjectRegistry`** (`src/mcp/projectRegistry.ts`, off-barrel) is a
  `Map<id, ProjectContext>` with one designated default. `resolve(sel?)` is a
  **pure `Map` lookup**: no filesystem access, no `path.resolve`, no
  `openProject` call — the module imports neither `node:path`, `node:fs`, nor
  `@genvidtech/c3source`, which is a structural guarantee of that property, not
  a style choice. A selector that names no registered id — including anything
  that merely *looks like* a path (`"../other"`, `"C:/tmp"`, `"./x"`) — returns
  an error enumerating the known ids rather than being treated as a root to
  open. Ids may not contain `:` (enforced at `add()`), because that is the
  separator the composite txId format reserves.

- **Launch surface**: repeated `--project-dir [<id>=]<path>` (server subcommand
  only — the global `--project-dir` stays `string` everywhere else) >
  `C3_PROJECT_DIRS` (`path.delimiter`-separated) > `C3_PROJECT_DIR` (unchanged)
  > `resolveRootFolder` discovery (unchanged) > cwd, plus an optional
  `--default-project <id>`. Two or more specs resolve every root explicitly (no
  `resolveRootFolder` call, since there is nothing left to discover); zero or
  one spec routes through the exact pre-#95 `resolveRootFolder` call, byte-for-
  byte, including its cwd-fallback stderr warning — so an operator who never
  adopts the new surface sees no behavior change. An explicit `<id>=` prefix
  always wins over derivation; a derived id is the sanitized basename, deduped
  with a `-2`/`-3` suffix plus a stderr warning on collision.

- **`regP`** injects the optional `project` param into every project-scoped
  tool's schema and resolves the call's `ProjectContext` before dispatch.
  `list-projects` is the sole tool kept on plain `reg` — it enumerates the
  registry itself, so it cannot belong to one project.
  **Locking stays in handler bodies, never in `regP`.** `ReadWriteLock` (from
  `@genvidtech/mcp-utils`) has no owner tracking: `acquireWrite` queues
  unconditionally once `writing === true`, and `acquireRead` requires
  `writeQueue.length === 0` (write-preferring). A lock acquired inside `regP`
  would nest inside a handler's own `ctx.rwlock.read`/`.write` call — and, for
  a mutate tool, inside `applyRecipeWithConcurrency`'s own write lock too —
  hanging every call permanently. **The general rule is exactly one lock
  acquisition per call, taken in the handler body** — not the narrower "no
  nested writes": because `acquireRead` is write-preferring, a `read()` nested
  inside a `read()` also deadlocks whenever a write queues between the two
  acquisitions, so the read path carries the same hazard as the write path.

- **txId is a composite `<projectId>:<counter>` string.** `src/mcp/txToken.ts`
  (off-barrel) owns the codec: `formatTxToken`/`parseTxToken`/`compareTxToken`.
  Ten txId-accepting schemas converted from `z.number()` to `z.string()`; six
  comparisons route through `compareTxToken`; both emissions (`txIdLine` and
  `get-state`'s inline literal) route through `formatTxToken`. Every rejection
  carries the current token as a `txId: <current>` footer. Per-site trailing
  verbs (`applying`/`syncing`/`scaffolding`) are preserved byte-identically via
  `compareTxToken`'s optional `action` parameter — omitting it yields the bare
  `— re-validate`, so the token-format change is the only observable diff at
  each of those six sites. This conversion landed (F4) while the registry still
  held exactly one project, which is what made it atomic by construction across
  the full static-emission set: one context meant one counter, so no
  intermediate state could misattribute a token.

- **Op tools are `op-<projectId>_<opName>`**, including for the default
  project — there is no special-cased flat form (see decline 10 below). `_` is
  the separator because op names match `/^[a-z0-9][a-z0-9-]*$/i` and project
  ids allow `-`, so `op-<id>-<name>` is genuinely ambiguous (project `a` + op
  `b-c` and project `a-b` + op `c` both yield `op-a-b-c`); neither charset
  admits `_`, so the composite is collision-free. Verified against the real MCP
  SDK before committing (`tools/list`/`tools/call` both handle an underscore-
  bearing name). `OpsRegistry` is now one instance per registered project, each
  built with `applyRecipe` closed over its own `ProjectContext` — an op tool
  can therefore never reach another project's tree, structurally, not by
  convention. `list-ops` was hoisted out of `OpsRegistry` into a normal
  `regP`-registered tool in `server.ts` reading `ctx.ops`, because a static
  per-context `list-ops` registration does not scale to N registered projects
  (N contexts would each try to register the same static name).

- **Three breaking changes** ship to the MCP tool surface: every schema gains
  a `project` parameter, the txId wire format changes from a bare integer to
  the composite string, and every `op-<name>` tool is renamed
  `op-<projectId>_<name>`. Backward-compatibility breakage was accepted
  up front — `v1.2.0` released with 0 unreleased commits specifically so this
  work could break contracts without straddling a release. **Zero npm barrel
  exposure**: `ProjectContext`, `ProjectRegistry`, `txToken.ts`, and
  `launchConfig.ts` are all off `src/index.ts`, so none of this is published
  library API.

## Compromise

Eleven alternatives were considered and declined.

### 1. DECLINE — a global txId counter

One counter shared across every registered project. No false accepts (a token
is never silently valid against the wrong project, since there is only one
project's worth of state), but project B's every mutation invalidates project
A's outstanding validate→apply plan. In a two-project server that cross-
invalidation is the **steady state**, not an edge case, so the plan/apply loop
would never converge for a client working two projects in one session.

### 2. DECLINE — bare per-project counters (no id prefix)

Give each `ProjectContext` its own counter, but keep the wire format a bare
integer. Both counters start at 0 and increment per mutation, so an **equal
counter across two projects is the common case**, not a coincidence requiring
bad luck. A token minted for project alpha at counter 12, presented against
project beta also sitting at 12, would be **silently accepted** — destroying
the one property ADR 0005 introduced `txId` to provide.

### 3. DECLINE — a mutable `CURRENT` pointer set per call

Keep one module-level context variable, reassigned to the resolved project at
the top of each handler before dispatch — the minimal-diff path, and silently
wrong. `rwlock.read()` permits concurrent reads and every handler is `async`,
so two calls resolving different projects can interleave at the first `await`
inside either handler body; the second call's reassignment clobbers the
pointer the first call is still reading from underneath it. For a read tool
that's a wrong-project read; under `apply-recipe` it's a wrong-project
**write**.

### 4. DECLINE — `AsyncLocalStorage`

Thread the resolved context through `node:async_hooks`' `AsyncLocalStorage`
instead of an explicit parameter. Concurrency-safe (each call gets its own
storage frame), but it buys nothing over `regP`'s explicit parameter while
hiding the dependency from every function signature that reads it — a reader
has to know to look for `.getStore()` rather than seeing `ctx` in the
signature. It also revives exactly the late-binding hazard `ProjectContext`
was built to kill: a helper that captures `als.getStore()` once, outside the
per-call frame, silently observes a stale context the same way the old
module-level globals could.

### 5. DECLINE — a path-valued `project` selector

Let the `project` tool parameter be a path rather than an id, resolved the
same way `--project-dir` is at launch. This inverts ADR
[0007](0007-mcp-server-root-resolution-and-c3project-adoption.md)'s posture
deliberately: `--project-dir` is **not** path-contained, because an
*operator* sets it once at server launch and is trusted to do so. A tool
parameter is set by the **model**, per call — accepting an arbitrary caller-
supplied path there would mean re-deriving containment/allowlist logic at
every call site, and it would mean `ProjectRegistry.resolve` could no longer
be the entire security answer for project selection (see `resolve`'s own
docstring). The id-only selector keeps that answer a pure `Map` lookup against
a set fixed at launch.

### 6. DECLINE — scraping `resolveRootFolder`'s ambiguity message

`resolveRootFolder` (from `@genvidtech/mcp-utils`) already computes the full
set of ambiguous root candidates internally when discovery finds ≥ 2 markers,
but surfaces them only as prose inside an `mcpError` string. Parsing that
string to recover the candidate list would be the first place in this repo
treating an error message as structured data: upstream may reword it at any
patch release with no version signal, and a regex miss degrades **silently**
to an empty registry rather than a visible failure. Declined; filed instead as
[`GenvidTechnologies/mcp-utils#20`](https://github.com/GenvidTechnologies/mcp-utils/issues/20),
asking upstream for the structure directly (recorded in
`wiki/process/leaf-dependency-ledger.md`, since it's a version-scoped ask
rather than a durable posture).

### 7. DECLINE — multi-root auto-discovery in v1

Extend discovery so every ambiguous-discovery candidate is registered
automatically, rather than requiring explicit `--project-dir` specs. A
registry keyed by id needs ids; discovery as it exists today produces bare
paths, with no id-derivation step built in. Building that step now would mean
inventing it against an unstructured error string (decline 6) rather than a
real candidate list. Deferred to v2; the upstream request
(mcp-utils#20, decline 6 above) is filed now rather than waiting for the gap
to recur, per this repo's reactive-vs-proactive follow-up practice.

### 8. DECLINE — `list-projects` reporting per-project txIds

Have `list-projects` include each registered project's live `txId` alongside
its id/root/extractedDir/default flag. Declined for two reasons that compound:
`list-projects` deliberately stays on plain `reg` (not `regP`) and needs no
`ctx.rwlock.read`, because it reads only the registry's static, getter-only
metadata — no mutable shared state to serialize against. Reading a live txId
means reading `ctx.watcher.txId` for every registered context, which
reintroduces exactly the lock-acquisition question the tool was built to
avoid. It would also blur the one-project-per-call rule: a single response
carrying N projects' counters invites a client to hold a token it did not
obtain from a call against that project, which is the confusion the composite
token exists to prevent.

### 9. DECLINE — lock acquisition inside `regP`

Acquire `ctx.rwlock` inside the `regP` wrapper itself, once, before calling
into the handler — removing the need for every handler body to acquire its
own lock. This is the re-entrancy deadlock described in the Decision section
above: `ReadWriteLock` has no owner tracking, so a lock taken in the wrapper
nests inside the handler's own acquisition (and, for mutate tools, inside
`applyRecipeWithConcurrency`'s write lock too), hanging every call. Proved by
mutation against production code (inject the wrapper-level acquisition,
confirm the injection landed, confirm the affected test goes red on a
timeout, then revert) rather than by reversion, since the correct
implementation is green from birth and reversion cannot demonstrate that a
row *can* fail.

### 10. DECLINE — special-casing the default project's op names

Keep the pre-#95 flat `op-<name>` template for the default project's ops,
applying `op-<projectId>_<name>` only once a second project is registered.
Declined because it makes a live tool's name depend on **an unrelated
project's configuration**: the moment a second `--project-dir` is added at
some later launch, every one of the default project's existing op tools would
need to be renamed out from under a client that has already discovered them
under the flat form. Uniform naming from the first registered project avoids
that class of client-visible rename entirely.

### 11. DECLINE — unifying the `navigation` config lifetime during Seam A

`navConvention` resolution has a pre-existing three-lifetime inconsistency
(loaded fresh in some call paths, cached in others) that #95's Seam A (the
globals → `ProjectContext` refactor) touches in passing. Fixing it there was
declined: Seam A's entire warrant is "behaviour-preserving," and a green-from-
birth mutation guard over a step that also smuggles in a real behavior change
is untrustworthy by construction — the guard would keep passing for the wrong
reason. Filed as [construct3-chef#211](https://github.com/GenvidTechnologies/construct3-chef/issues/211)
instead, scoped to the three-lifetime inconsistency alone.

## Consequences

- **One project per call removes multi-lock acquisition entirely** — there is
  no scenario in this design where a single call needs to hold locks on two
  contexts at once, so no lock-ordering discipline is needed to avoid a
  cross-context deadlock. The only residual deadlock risk is **re-entrancy**
  within a single call, per decline 9 — the rule that guards it is general:
  **exactly one lock acquisition per call, taken in the handler body.**
- **Per-context watchers are load-bearing, not incidental.**
  `OptimisticWatcher.suppress()` is a per-instance depth counter, so a watcher
  shared across two projects' contexts would let project A's self-suppressed
  write blind project B's external-change detection for the duration of A's
  suppress window (and vice versa) — `ProjectContext.watcher` is therefore
  always a distinct instance per context, never shared. `startServer` wires the
  watcher and the ops registry together in one per-project loop
  (`wireAllProjects`), so every registered project has both.

  That loop's shape is load-bearing rather than stylistic. An earlier revision
  of this work wired ops per-project but left `setupWatchers(defaultCtx)`
  outside the loop. Because `ProjectContext.watcher` carries a
  definite-assignment assertion, a non-default context then held `undefined`,
  and the first `ctx.watcher.txId` read threw at runtime — which is most of the
  tx-tracked surface (`txIdLine`, `compareTxToken`, `get-state`). Multi-project
  was, in effect, broken for every project but the default.

  Every test suite stayed green through it, and the reason is worth recording:
  the cross-project suites install contexts via `__setRegistry` and hand each
  one a fake watcher, so they exercised the selector logic while never running
  the wiring that was wrong. A test that supplies the missing piece itself
  cannot detect that production never supplied it. The regression guard
  (T-W1) therefore drives `__wireAllProjects()` — the real function
  `startServer` calls — against contexts deliberately given no watcher.

  **Genuine v1 limit, distinct from the above:** startup validation and
  auto-generation still run for the default project only. A non-default
  project's `extracted/` may be stale at launch until `regenerate` is run
  against it. That is a scope decision, not a defect — the tools work, they
  simply report staleness.
- **`ctx.expected` (`ExpectedChanges`) is per-context for cohesion, not
  necessity.** Unlike the watcher, nothing about its correctness requires
  per-project isolation — its keys are already root-disjoint absolute paths,
  so a single shared `ExpectedChanges` instance would serve N roots correctly
  today. It lives on `ProjectContext` anyway, alongside the state that *does*
  need isolation, so the container's contract stays uniform rather than
  carving out one field as a documented exception.
- The three breaking changes (schema `project` param, composite txId, `op-*`
  renaming) are release-note-worthy and require a downstream pin-bump request
  to `claude-code-plugin-gvt-construct3` with a tool-surface reconciliation
  re-run, per CLAUDE.md § "Releasing" and the #207 precedent — filed after the
  release tag, not as part of this branch.

## Supersedes / amends

- Amends ADR [0005](0005-mcp-server-optimistic-concurrency-model.md) and ADR
  [0007](0007-mcp-server-root-resolution-and-c3project-adoption.md): both
  named #95 as where the module-level singletons would need to become
  per-request state, deferred. That work is done; both ADRs' Consequences
  sections now cite this record in the present tense instead.
- Mechanism note on ADR [0002](0002-sid-based-node-addressing.md): unrelated
  to multi-project support, but its description of a module-level SID context
  (`initSidContext`/`resetSidContext`) is superseded by the current stateless
  `mintUniqueSid(usedSids)` API — noted there directly, not here.
- Supersedes the "spans two modules" framing in ADR
  [0031](0031-mcp-tool-inventory-guard-spans-two-modules.md): with `list-ops`
  hoisted into `server.ts` (this record), the static MCP tool inventory guard
  now has only one module with a static double-quoted registration.
