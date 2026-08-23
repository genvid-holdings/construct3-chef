---
type: decision-record
title: "0001. Two-surface data model"
description: >-
  Source JSON as write surface + committed `extracted/` as read surface; rejected direct-edit and on-demand-only alternatives
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# 0001. Two-surface data model

- **Status:** Accepted (retroactively documented)
- **Date:** 2026-04-03

## Context

Recorded retroactively — the mechanism arrived at the repo's initial release (2026-04-03), imported from the prior c3-mcp-server initiative; the `docs/decisions/` convention was introduced later (ADR 0007).

C3 stores a project as JSON on disk (`eventSheets/`, `layouts/`, `objectTypes/`, `scripts/`). Raw C3 JSON is verbose and not reasoning-friendly: event trees are deeply nested, SIDs are opaque integers, and TypeScript scripts are embedded as JSON string blobs. Humans and AI agents need a readable, diffable view to locate mutation targets and review changes without parsing raw JSON.

## Decision

The project is exposed through two distinct views:

- **Source JSON** (`eventSheets/`, `layouts/`, `objectTypes/`) — the **write surface**: the actual C3 project files, mutated only via recipes, never hand-edited directly.
- **`extracted/`** — the **read surface**: human/AI-readable DSL (`.dsl.txt`), DSL index (`.dsl.idx.txt`), extracted TypeScript (`.ts`), layout summaries (`.layout.txt`), `template-scope.txt`, `sid-registry.txt`, and `global-layers.txt`. Regenerated from source by the 6 generators, committed alongside source for PR diffing. The directory name defaults to `"extracted"` but is configurable via `extractedDir` in an optional `construct3-chef.config.json`.

The core workflow loop is: **read `extracted/` to locate a target → write a recipe targeting it by SID → apply to source JSON → regenerate `extracted/` → sync `project.c3proj`.**

See [CLAUDE.md](../../CLAUDE.md) § "The two-surface data model" for the operational summary, and [wiki/reference/generators.md](../reference/generators.md) for generator internals and output format.

## Compromise

Two alternatives were rejected:

**(a) Edit source JSON directly** — no readable target-discovery surface, fragile for AI reasoning, and mutation errors are invisible until C3 loads the file.

**(b) Generate the read surface on demand only / not committed** — loses PR diff visibility that makes recipe effects reviewable in code review. The on-demand-only variant is tracked separately as [#15](https://github.com/GenvidTechnologies/construct3-chef/issues/15) (`extracted/` Generated On Demand) as a potential *additive* future mode, but is not the default.

## Consequences

- After any source mutation, `extracted/` is stale until regenerated; read tools in the MCP server append a staleness warning when `extractedDirty` is true.
- Adding a generator touches approximately 9 sites in lockstep — see CLAUDE.md § "The two-surface data model" for the full checklist.
- The golden test (`test/c3/sampleProjectGolden.test.ts`) guards the generate pipeline by diffing regenerated output against committed golden files.
- The `extracted/` source-JSON directory names are C3-fixed and stay hardcoded; only the `extracted/` name is configurable.
