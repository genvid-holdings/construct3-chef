@CONVENTIONS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

construct3-chef mutates Construct 3 projects, which store their data as JSON files on disk (`eventSheets/`, `layouts/`, `objectTypes/`, `scripts/`). It exposes the same library two ways: a yargs **CLI** (`src/cli.ts`) and an **MCP server** (`src/mcp/server.ts`). Both are thin wrappers over the pure library in `src/c3/`. When adding a capability, implement it in `src/c3/`, then surface it in both `cli.ts` and `server.ts`.

## Where to read more

- **`docs/mcp-architecture.md`** — MCP server design rationale (stdio transport, file-based-first, the `txId`/`extractedDirty`/watcher concurrency model, the `Logger` and `ReadWriteLock` decisions), the concurrency/security posture, the C3 Editor SDK capabilities research, and the prior-art comparison. The durable knowledge base, distilled from the (retired) c3-mcp-server initiative.
- **`docs/recipe-reference.md`** — all event-sheet + layout + workflow recipe ops, SID addressing, builder shorthands, and the numbered **recipe gotchas and bugs** (read this before touching the recipe interpreter/validator).
- **C3 *platform* reference** (event sheet & layout JSON structure, scripting API, the async/concurrency model — the *why* behind the recipe gotchas) now lives in the **genvid-c3** Claude Code plugin at `${CLAUDE_PLUGIN_ROOT}/docs/c3/*`. construct3-chef keeps the *tooling* docs (`docs/recipe-reference.md`, `docs/generators.md`, `docs/cli.md`); the plugin owns the platform knowledge.
- **GitHub issues + `initiatives/`** — forward-looking work is tracked as GitHub issues for visibility and prioritization; large multi-step efforts additionally get an `initiatives/<name>/` plan doc when they're picked up (produced by the `genvid:plan-task` skill). The existing backlog was migrated from `initiatives/` to issues for better tracking/exposure: the two big-ticket items are [#14 C3 Live Editor Integration](https://github.com/genvid-holdings/construct3-chef/issues/14) (Playwright automation, addon bridge) and [#15 `extracted/` Generated On Demand](https://github.com/genvid-holdings/construct3-chef/issues/15); the former "MCP Tooling Follow-ups" and "Upstream Package Extraction Follow-ups" umbrellas were split into individual issues (#18–#29: user-defined ops, `search-docs`, global-layer extraction, read-tool gaps, MCP-audit items, upstream-package adoptions) — browse the [`enhancement`-labelled issues](https://github.com/genvid-holdings/construct3-chef/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement). The completed c3-mcp-server initiative (its session plans and per-feature design docs) lives in git history: `git log -- initiatives/c3-mcp-server`.

## Commands

This repo uses **npm** (committed `package-lock.json`). It's published to npmjs.com as `@genvid/construct3-chef` via the genvid-public-ci GitHub Actions recipe (`.github/workflows/`); the gate runs `npm ci`.

```bash
npm install                             # install deps (fetches @genvid/* from npm)
npm test                                # mocha + tsx + chai, all test/**/*.test.ts
npm test -- --grep "foo"                # run tests matching a name (npm needs `--` before forwarded args)
npm test -- test/c3/sidUtils.test.ts    # run a single file
npm run lint                            # eslint over src/ AND test/, --max-warnings 0
npm run typecheck                       # tsc --noEmit — checks src/ ONLY (test/ has known type errors; see commit 0b4c515)
npm run build                           # tsc → dist/, then prepends a node shebang to dist/cli.js
```

There is no dev script for the CLI. Run it in-place with `npx tsx src/cli.ts <subcommand> --project-dir <path>` — tsx compiles the `.ts` on the fly, so no build is needed. The package's `main`/`types`/`exports` point at the built `dist/` (what published consumers import); the `construct3-chef` bin also only exists after `npm run build` (it points at `dist/cli.js`).

### Releasing

Cutting a release is a tag push, not a manual `npm publish`:

1. Bump `package.json` `version` on a topic branch (`npm version X.Y.Z --no-git-tag-version`) and commit.
2. PR → squash-merge to `main`.
3. Tag the **merged** commit: `git tag vX.Y.Z` (annotated is fine) → `git push origin vX.Y.Z`.

The `v*.*.*` tag triggers `.github/workflows/publish.yml`: the gate job runs `npm ci` + lint/typecheck/test/build/`publish --dry-run`, then the publish job runs `npm publish --provenance --access public` via OIDC trusted publishing (no stored npm token). **The publish job fails the "Verify tag matches package version" step if the tag minus its `v` ≠ `package.json` version** — so always tag the commit that already carries the bump (don't tag `main` before the bump merges). Released tags so far: `v0.1.0`, `v0.3.0` (npm `latest` = `0.3.0`; `0.2.0` was merged to `main` but never tagged, so it was never published).

**Golden test.** `test/c3/sampleProjectGolden.test.ts` regenerates `extracted/` from the real-project fixture `test/fixtures/sample-project/` and diffs it against the committed golden (`…/extracted/`), guarding the generate→`extracted/` pipeline (esp. layout-summary `fullLayerName`/global composition + DSL coordinates). When a generator change *intentionally* alters output, regenerate the golden:
```bash
npx tsx src/cli.ts generate --project-dir test/fixtures/sample-project
```

## Leaf dependencies

`@genvid/c3source` and `@genvid/mcp-utils` are public Genvid packages on npm; `npm install` fetches them from the registry like any other dependency. Versions are pinned in `package.json`. (These were once private tarballs pulled from Azure Blob via a `download-deps` + 1Password bootstrap; that machinery was retired when the packages went public — `git log` for the history.)

> **Checking for a new upstream release:** use `npm view <pkg> version --prefer-online` (or check the package's GitHub tags). Plain `npm view` and the editor's "new version available" banner both read a *cached* registry index and lag fresh publishes — don't conclude you're current off the cached read when deciding whether to adopt.

- **`@genvid/c3source`** — the C3 JSON domain layer: type definitions (`EventSheet`, `Condition`, `Layout`, …), file discovery (`find_all_eventsheets_path`), and primitives like `extractScriptsFromSheet`, `formatCondition`. Treat it as the source of truth for C3's on-disk schema.
- **`@genvid/mcp-utils`** — MCP plumbing: `ReadWriteLock`, `ExpectedChanges`, `paginateText`, `exposeDocs`, `Logger`.

**Adoption posture (the recurring "should this live upstream?" call).** Push **traversal, numbering, and discovery** into c3source — that's domain logic (`visitEvents`/`visitLayers`, the `isCountingEvent` event counter, the `find_all_*_path` finders). Keep **rendering/presentation** local — the `extracted/` read-surface (DSL text, index, layout summaries) is *this tool's* invention, not C3 on-disk schema, so it must not move upstream even when a c3source helper could shave a few lines. The split was settled in #27 (the DSL formatter drives traversal via `visitEvents` but renders locally) and guides the remaining adoption issues (#25/#26/#28). When a needed traversal/discovery primitive is missing upstream (e.g. #28 wanted a `.dsl.txt` file finder that c3source doesn't export), file an intent request on `genvid-holdings/c3source` rather than re-rolling it here. **Owning the *fact* upstream isn't sufficient — check the primitive's *shape* fits the consuming *operation*.** A detection-only/flat upstream API can't back a *mutating, nested* op: #42 adopted c3source's editor-local *fact* (`isEditorLocalPath`) and manifest *parse* (`readProjectManifest`), but could **not** route `projectSync.runSync` through `detectManifestDrift` — that returns flat bare-name drift with no subfolder path, so it can't locate where to mutate the nested two-way sync (it also omits `families` and models `objectTypes` as flat files). Adoption there was deferred behind a request for a *structured, path-bearing* drift primitive (c3source#21 → #47); using the flat one would net +30–60 lines / 0 removed.

## Module system gotchas

ESM throughout (`"type": "module"`, `NodeNext`). **Relative imports must use the `.js` extension even though the files are `.ts`** (e.g. `import { foo } from "./generators.js"`). `strict` is on. Two tsconfigs: `tsconfig.json` (src-only, emits to `dist/`, used by build + typecheck) and `tsconfig.test.json` (adds `test/`, `noEmit` — exists for editors, not wired into the `typecheck` script).

**Public-API surface = the `src/index.ts` barrel.** It re-exports each module wholesale (`export * from "./c3/dslFormatter.js"`, …), so *every exported symbol* a module declares becomes published API the moment it ships in `dist/`. Deleting or renaming an exported function/type/interface is therefore **semver-breaking** even when nothing inside the repo still imports it (e.g. #27 removed the unused-internally `formatEvent`/`EventCounter` — breaking for any consumer importing them from `@genvid/construct3-chef`). At `0.x` this is acceptable; note such removals in the commit body and flag them at the next release tag (see [Releasing](#releasing)). To keep a symbol internal, don't re-export its module from `src/index.ts`.

## The two-surface data model

This is the central idea. There are two views of the project:

- **Source JSON** (`eventSheets/`, `layouts/`, `objectTypes/`) — the write surface. The actual C3 project. Never hand-edit blindly; mutate via recipes.
- **`extracted/`** (DSL `.dsl.txt`, index `.dsl.idx.txt`, TypeScript `.ts`, layout summaries, `template-scope.txt`, `sid-registry.txt`) — the read surface. Human/AI-readable, regenerated from source by the 6 generators in `src/c3/generators.ts`. Committed alongside source for diffing.

> **Adding a generator touches ~9 sites in lockstep.** `GENERATOR_STEPS` in `src/mcp/server.ts` is the only real driver (the regenerate loop iterates it); the rest are a hardcoded count that silently drifts if missed: `GENERATOR_NAMES` + the `generators` array in `cli.ts`; the four `totalSteps`/`progressTotal` constants in `server.ts` (the `runGenerators` default and the apply-recipe / clone-layout / workflow tool handlers — each is "N + generators", so all bump by one) and the `regenerate` tool's description string; the golden test's `before` hook (`test/c3/sampleProjectGolden.test.ts`); plus `docs/generators.md` / `docs/cli.md` / `docs/TOC.md` / `docs/mcp-architecture.md` and the count in this file. Grep `totalSteps`/`progressTotal`/`GENERATOR_STEPS` after wiring a new one. (Cf. the objectType lockstep note below.)

Workflow loop: **read `extracted/` to locate a target → write a recipe targeting it by SID → apply to source JSON → regenerate `extracted/` → sync `project.c3proj`.** After any source mutation, `extracted/` is stale until regenerated.

### SIDs are the addressing system

C3 nodes carry a stable `sid` (a random integer in `[1e14, 1e15)`). Recipes target nodes by SID (`"in": "sid:123…"`) rather than fragile JSON paths — you discover SIDs from the `.dsl.idx.txt` index or via the `resolve-anchor` MCP tool. `src/c3/sidUtils.ts` holds a **module-level SID context** that must be initialized (`initSidContext` from `sid-registry.txt`, or `initSidContextFromSet`) before any SID is generated, and reset after. `recipeApplier.applyParsed` wraps the whole apply in `initSidContext`/`resetSidContext` so every newly generated SID is globally unique against the registry. Tests that touch SID generation must init the context themselves.

## Recipe pipeline

- **`recipeInterpreter.ts`** — declares the `Recipe` type (`objectTypes`, `addInstVars`, `files`, `layouts`), all the op shorthands, `validateRecipe`, and the **pure** execution functions (`executeRecipe`, `executeFileOps`, `applyReplacements`) that transform in-memory `EventSheet` objects with no I/O.
- **`recipeApplier.ts`** — the orchestrator with I/O. `applyRecipeInner` applies in a fixed order: **objectTypes → addInstVars → layouts → files**, then writes files and regenerates. Adding an objectType touches three places in lockstep: the `objectTypes/*.json`, `scripts/ts-defs/instanceTypes.d.ts`, and `scripts/ts-defs/objects.d.ts`. Layout ops dispatch into `layoutMutator.ts`.
- **`workflowExpansion.ts`** — composite **workflow ops** (`extract-template`, `templatize-in-place`, `clone-replica-to-layouts`, `replace-instance-with-replica`) expand into primitive layout ops in a pre-pass before the layout-file loop runs, fanning out across multiple layout keys when needed. Dispatch and dry-run logging iterate the expanded `Map`, so workflows are validated as their primitive sequence.
- **`eventSheetMutator.ts`** — low-level builders (`buildBlock`, `buildAction`, …) and tree edits (`insertEvent`, `resolveNode`, SID-index building) over a single sheet.

> **`SidIndexEntry.indexInParent` is a snapshot, not a live index.** `buildSidIndex` records each node's position once; the `parentArray` reference stays valid but the stored index goes stale the moment an earlier op in the same recipe batch splices that array. Any op that positions relative to a resolved node (insert-after, remove, move) must recompute with `parentArray.indexOf(node)` — never trust `indexInParent` for placement. (This was gotcha #34: the `insert-event` `after: "sid:X"` branch used the stale snapshot and misplaced/appended.)

The recipe reference (all event-sheet + layout ops, SID addressing, builder shorthands) lives in `docs/recipe-reference.md`; generator internals in `docs/generators.md`.

## MCP server state model (`src/mcp/server.ts`)

The CLI is stateless; the server adds a concurrency layer worth understanding before editing it:

- **`txId`** — the `OptimisticWatcher`'s monotonic counter (`watcher.txId`, incremented via `watcher.bump()`) — bumped on every source-file mutation. Optimistic concurrency: read tools / `validate-recipe` return the current `txId`; `apply-recipe` / `sync-project` accept an expected `txId` and reject if it has moved.
- **`extractedDirty`** — true when source has changed since the last regenerate; read tools append a stale warning and `checkSourceFreshness` flips it by comparing mtimes. Stays module-level (project-specific); set from the watcher's `onSourceChange` callback.
- **File watchers** — `createSourceWatcher` (`src/mcp/sourceWatcher.ts`) wires @genvid/mcp-utils' `OptimisticWatcher` over the source dirs + `project.c3proj`. External source edits bump `txId` and set `extractedDirty` (via `onSourceChange`); `project.c3proj` edits bump `txId` only. Self-induced writes are masked by wrapping them in `watcher.suppress(async () => { … })` (synchronous suppress window) plus `watcher.expect(absPath)` for paths whose watcher event may land after the window closes — when editing a mutate tool, wrap its writes in `suppress` (and `expect()` anything written outside that call) or the watcher will spuriously mark state dirty.
- **`ReadWriteLock`** serializes writes, allows concurrent reads. Tools are tagged `READ_ONLY` / `REGENERATE` / `MUTATE` annotations.
- `CancelledError` paths still bump `txId` (`watcher.bump()`) and set `extractedDirty` because source was already written before regeneration was interrupted.

## Conventions

- C3 JSON is written tab-indented with a trailing newline: `JSON.stringify(x, null, "\t") + "\n"`. Match this when writing project files.
- Prettier: 120 cols, spaces for `.ts`, **tabs** for `.json`. ESLint extends prettier and disables `no-unused-vars` / `no-explicit-any`.
- All file I/O is rooted at a `--project-dir` (defaults to cwd); paths inside recipes/tools are relative to that root. Mutate tools include path-traversal guards — keep them.

## Commit Format

Conventional Commits: `<type>: <subject>`, where `type` is one of `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Subject is imperative, lowercase, no trailing period. Body (optional) explains the *why* and any non-obvious *what*, wrapped at ~72 cols. When a commit is authored with Claude Code, end the message with the trailer:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

Squash-merged PRs carry a `(#N)` suffix on the subject (added by the merge), e.g. `feat: composite template workflow ops + MCP tools (#9)`.

## Pull Request Format

Host is **GitHub** (`gh` CLI). PR title follows the same Conventional Commit shape as the squash subject. The body should summarize what changed and why, call out verification done (lint/typecheck/test), and note any follow-ups. When generated with Claude Code, append the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` footer.

**Put `Closes #N` (or `Fixes #N`) in the PR body** for every issue the PR fully resolves — one per issue — so the squash-merge auto-closes them. The `(#N)` *subject* suffix that squash-merging adds is **not** a closing keyword: it only links, it doesn't close. (This is how #19/#20 ended up implemented-but-open — their squash subjects referenced the issues but no body carried `Closes`.) For work that's blocked on or split across other issues, link them in prose instead of `Closes` so they stay open.

## Branching

Default/base branch is `main`. Do feature work on a topic branch (this repo has used names like `upstream-updates`); never commit directly to `main`. Rebase onto `main` to integrate upstream changes; squash-merge topic branches into `main` via PR. Stacked branches rebase with `--onto` after a parent squash-merges.
