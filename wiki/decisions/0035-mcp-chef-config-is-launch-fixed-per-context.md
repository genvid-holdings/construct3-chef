---
type: decision-record
title: "0035. MCP chef config is launch-fixed per project context"
description: >-
  The `navigation-graph` handler loaded `construct3-chef.config.json` fresh on
  every call while every other consumer read the copy `createProjectContext`
  loaded once per context. The per-call path was collapsed into the cached one
  rather than the reverse: `extractedDir` and `ops.dir` are wired into the file
  watcher and `OpsRegistry` at launch, so config that cannot hot-reload sets the
  ceiling for config that can. `DEFAULT_CHEF_CONFIG`'s use by the test seams is
  deliberate and was left alone
  ([#211](https://github.com/GenvidTechnologies/construct3-chef/issues/211))
tags: [decision, architecture, mcp, configuration]
status: stable
generated: { by: process:plan-task, at: 2026-08-28T00:00:00Z }
---

# 0035. MCP chef config is launch-fixed per project context

- **Status:** Accepted
- **Date:** 2026-08-28
- **Issue:** [#211](https://github.com/GenvidTechnologies/construct3-chef/issues/211)

## Context

ADR [0034](0034-mcp-server-multi-project-support.md) replaced `server.ts`'s
module-level globals with a per-project `ProjectContext` (Seam A). Its
**decline 11** recorded a pre-existing three-lifetime inconsistency in
`navigation` config resolution and deliberately left it alone: Seam A's entire
warrant was "behaviour-preserving," and a green-from-birth mutation guard over a
step that also smuggles in a real behaviour change is untrustworthy by
construction — the guard would keep passing for the wrong reason. This record
carries that deferred decision.

The three lifetimes, named rather than counted:

1. **Never loaded** — `DEFAULT_CHEF_CONFIG` (`server.ts`), a hardcoded
   synchronous literal seeding `defaultCtx` at module scope and reused by the
   `__setProjectRoot` / `__resetTestState` test seams.
2. **Loaded once per context** — `createProjectContext` calls
   `loadChefConfig(root, overrides)`; the result is consumed by
   `wireAllProjects` and by every `ctx.extractedDir` read.
3. **Loaded fresh per call** — the `navigation-graph` handler, the only
   `loadChefConfig` call in `server.ts`.

Two facts shaped the decision more than the inconsistency itself.

**The per-call path also dropped `overrides`.** `createProjectContext(id, root,
overrides)` merges an overrides argument; the per-call reload passed none and
structurally could not see them. So the two paths were not guaranteed to agree
even in principle, not merely doing redundant I/O. This is latent in production
today — `cli.ts` is the only `startServer` caller and always passes `undefined`
— but it is what made the fix falsifiable (see Consequences).

**Nothing observed the divergence.** No test exercised a `navigation` block
through the MCP handler, and there is no `construct3-chef.config.json` anywhere
in the repository, fixture included. Both paths therefore resolved to
`defaultNavConvention()` and agreed. That agreement is precisely why the defect
survived #95 review and every suite.

## Decision

**MCP chef config is launch-fixed per project context.** Lifetime 3 collapses
into lifetime 2: the handler resolves its nav convention from `ctx.config`, the
config its `ProjectContext` loaded at construction. No handler performs a
per-call `loadChefConfig`.

### Why not the reverse — make every path per-call

Structurally unavailable, not merely undesirable. `extractedDir` and `ops.dir`
are consumed by `wireAllProjects` to construct the file watcher and the
`OpsRegistry` **at launch**. Re-reading them per call would hand a handler a
value the running watcher is not watching — `extractedDir` would point somewhere
the watcher does not observe, and `ops.dir` would disagree with the
`OpsRegistry` already reconciled against the old path. Config that *cannot*
hot-reload sets the ceiling for config that can, so the only lifetime every
consumer can share is the launch-fixed one.

### Why lifetime 1 is not unified

`DEFAULT_CHEF_CONFIG` has two uses wearing one literal, and only one is
incidental. The module-scope seed is superseded the moment `startServer` runs.
The `__setProjectRoot` / `__resetTestState` seams' use is **deliberate**, and
the comment above `__setProjectRoot` already defends it: it hardcodes the
`extracted` default rather than loading `construct3-chef.config.json`, matching
that seam's pre-#95 behaviour exactly, since it never read chef config either.

So "make every path consistent," read literally, would change **test-harness**
behaviour that a comment defends, not production behaviour. Lifetime 1 is
documented as deliberate rather than unified. The issue's own framing — a
three-lifetime inconsistency to collapse into one — turned out to be one
lifetime too many.

### DECLINE — a `reload-config` tool

Rejected as scope, not on merit. Hot-reloading config is a new capability with
its own design questions (what happens to a watcher mid-reload; whether
`extractedDir` may move under a live `OpsRegistry`), and this issue is about
consistency. Recorded here so it is not re-proposed as though it were part of
this fix.

## Consequences

- **A config edit now requires a server restart to affect `navigation-graph`.**
  It never affected `extractedDir` or `ops.dir` mid-session; the asymmetry
  *was* the defect. This is the user-visible half of the change and is recorded
  in the CHANGELOG.

- **The dropped `overrides` is what made the fix testable.** The obvious guard
  — "the handler reads `ctx.config`" — is green from birth, since both paths
  resolve identically in every existing fixture. A context built with a
  `navigation` **override that diverges from the on-disk file** separates them:
  the file's convention wins before the fix, the override's after. That guard
  was committed **red**, showing the file's convention applied where the
  override was expected, before the fix landed. It is a genuine red→green
  transition rather than a green-from-birth row needing a mutation proof.

- **A test can no longer steer the handler by writing a config file into a
  `__setProjectRoot` temp root.** The seam's `DEFAULT_CHEF_CONFIG` wins, and it
  can never carry a `navigation` block. Any test needing one must go through
  `createProjectContext` + `__setRegistry` — the T-W1 pattern from ADR 0034's
  own regression guard. This is a testability change, not only a production
  one, and it points the same direction ADR 0034 already argued: drive the real
  construction path rather than handing the harness the answer.

- **Nothing automated enforces the import cleanup.** Dropping the per-call load
  left the `loadChefConfig` value import unused, and neither gate catches that:
  `.eslintrc.cjs` sets both `no-unused-vars` and
  `@typescript-eslint/no-unused-vars` to `"off"`, and `tsconfig.json` sets
  `strict` but not `noUnusedLocals`. The import was demoted to
  `import type { ChefConfig }` and pinned by an acceptance-criteria grep rather
  than by lint.

## Related

- ADR [0034](0034-mcp-server-multi-project-support.md) — decline 11 deferred
  this decision; its `ProjectContext` is what made a single cached lifetime
  available in the first place.
- [#211](https://github.com/GenvidTechnologies/construct3-chef/issues/211) —
  the issue, carrying the pledged acceptance criteria.
