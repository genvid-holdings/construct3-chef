---
type: decision-record
title: "0030. C3 source JSON is written without a trailing newline"
description: >-
  All nine C3-source JSON write sites (`eventSheets/`, `layouts/`,
  `objectTypes/`) are routed through a new shared `src/c3/sourceJson.ts`
  `writeSourceJson`, dropping the `+ "\n"` idiom copy-pasted from the
  project's first commit — the C3 editor writes no trailing newline, so the
  extra byte produced a spurious whole-file diff on every editor round-trip;
  follows the precedent ADR 0024 set for `project.c3proj`, reverses the
  "two forms" framing in `CLAUDE.md` § "Conventions" to a single uniform
  rule, and is proven by mutation rather than by going green
  ([#195](https://github.com/GenvidTechnologies/construct3-chef/issues/195))
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-22T21:00:00Z }
---

# 0030. C3 source JSON is written without a trailing newline

- **Status:** Accepted
- **Date:** 2026-08-22
- **Issue:** [#195](https://github.com/GenvidTechnologies/construct3-chef/issues/195)

## Context

Chef wrote every C3 **source** JSON file (`eventSheets/`, `layouts/`,
`objectTypes/`) as `JSON.stringify(x, null, "\t") + "\n"` — an idiom
introduced in `acb2739` ("feat: Initial release") and copy-pasted to nine
call sites across `recipeApplier.ts`, `cli.ts`, and `server.ts`. The C3
editor writes no trailing newline: all 27 source files in the pinned
canonical fixture (`test/fixtures/construct3-sample/project`) end at their
closing `}` (26 files) or `]` (1 file), and none ends in a newline byte.
The divergence produced a spurious one-byte whole-file diff every time a
chef-touched project was round-tripped through the editor.

**Not independently verifiable.** The downstream field report that
motivated this issue lives in another repo and was corrected before it was
committed there, so it is absent from that repo's own history. The ground
truth this record rests on is the fixture byte evidence above, not the
original report.

## Decision

Route all nine C3-source writes through a new shared writer,
`src/c3/sourceJson.ts` → `writeSourceJson(filePath, value)`, which emits
tab-indented JSON with no trailing newline
(`writeFileSync(filePath, JSON.stringify(value, null, "\t"))`).

- **Off-barrel deliberately.** `src/index.ts` re-exports modules wholesale,
  so barrelling an internal write helper would make it published public API
  and its later removal semver-breaking at 1.0.0 — the same pattern already
  used for `src/c3/addonValidator.ts` / `src/c3/editorLocal.ts`.
- **Synchronous deliberately.** Two call sites in `src/mcp/server.ts` write
  inside a `watcher.suppress(async () => { … })` window and rely on the
  write landing before that window closes.
- **`extracted/` is unaffected and must stay that way.** Chef's own read
  surface (layout summaries, `<extractedDir>/tsconfig.json` via
  `generators.ts`) legitimately keeps its trailing newline and is
  byte-diffed by the golden test — this decision governs C3 *source* JSON
  only, never the read surface.
- **`project.c3proj` is untouched by this change.** It was already correct,
  written via c3source's `writeProjectManifest`/`serializeProjectManifest`
  per ADR [0024](0024-project-c3proj-shared-serializer.md); `writeSourceJson`
  explicitly is not for that file.
- **The rule is now uniform.** C3 source JSON and `project.c3proj` both end
  at `}`/`]`. `CLAUDE.md` § "Conventions" previously documented this as
  "two forms — do not apply the first one to `project.c3proj`"; that
  framing is reversed by this record to a single rule with no exception.

**Proof.** The guard is proven by mutation, not by going green: a unit test
(`test/c3/sourceJson.test.ts`) proves `writeSourceJson` itself, and a
second layer (`test/mcp/serverHandlers.test.ts`) drives real MCP handlers
end to end — `apply-recipe`'s `addInstVars` mutate path plus the
`scaffold-layout`/`scaffold-sprite` create paths — and asserts on the raw
last byte of what lands on disk, because the wiring at a call site is what
could regress (a stray bare `writeFileSync` reintroducing the suffix),
which a helper-only test cannot see. Reintroducing `+ "\n"` inside
`writeSourceJson` takes all three end-to-end rows red with
`last byte was 0xa, expected 0x7d`. Verified twice — once by the
implementer, once independently — and the mutation was confirmed present on
disk before either run was read, per this repo's mutation-proof discipline
(`CLAUDE.md` § "Conventions").

## Compromise

**Rejected — delete `+ "\n"` at each of the nine call sites individually**,
as #195 originally prescribed. Both options touch the same three files
(`recipeApplier.ts`, `cli.ts`, `server.ts`); the shared writer costs one
small additional module and three imports. In exchange, the invariant
becomes assertable in **one** place instead of nine, which addresses the
cause of the original drift (nine independent copies of one idiom that
were free to diverge unnoticed) rather than only its symptom (nine wrong
suffixes). Direct repo precedent: ADR
[0024](0024-project-c3proj-shared-serializer.md) made exactly this same
call for the sibling `project.c3proj` writer, for the same reason.

## Consequences

- `CLAUDE.md` § "Conventions" is updated (in the same effort, by a sibling
  task) to state the now-uniform no-trailing-newline rule for both C3
  source JSON and `project.c3proj`, replacing the "two forms" framing.
- **ADR [0017](0017-sync-addon-metadata-separate-mutation-command.md) is
  deliberately left unedited.** An ADR is a historical record; 0017's own
  decision (`project.c3proj` takes no trailing newline) remains correct
  today. Only its incidental citation of the old general-convention framing
  goes stale, and this record supersedes that framing rather than rewriting
  0017's history.
- A future C3-source write site should call `writeSourceJson` rather than
  `writeFileSync(path, JSON.stringify(...))` directly — the nine-site
  duplication this record closes should not reopen.
