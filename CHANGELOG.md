# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Package scope changed at 0.11.2.** This package was published as
> **`@genvid/construct3-chef`** through `0.11.1`, and as
> **`@genvidtech/construct3-chef`** from `0.11.2` onward, when the repository moved
> to the GenvidTechnologies GitHub organization. The old `@genvid` scope is frozen
> and deprecated at `0.11.1` and receives no further releases — update your
> dependency to `@genvidtech/construct3-chef`. The leaf dependencies made the same
> move one release earlier; see [0.11.0](#0110---2026-06-30).
>
> **The public API is the `src/index.ts` barrel.** It re-exports each module
> wholesale, so every exported symbol is published API. Since `1.0.0`, removing or
> renaming one is a breaking change requiring a major bump; before `1.0.0` such
> removals were absorbed by a minor, and are listed under **Removed** below.

> **This changelog was reconstructed from git history in 2026-08** and backfilled to
> the first release. Entries for `0.1.0`–`1.0.0` were derived from commit subjects and
> the pull requests they reference, so they summarize *what shipped* rather than
> reproducing release notes written at the time — there were none. Referenced issue
> and PR numbers are authoritative; the grouping and emphasis are editorial.

## [Unreleased]

## [1.2.0] - 2026-08-25

### Changed

- **Consumer-visible rename on the MCP `docs:///` resource.** `exposeDocs` is now
  pointed straight at the `wiki/` tier and walks it recursively, so every document
  surfaces under its **real path relative to `wiki/`** rather than a bare stem —
  `docs:///cli` becomes `docs:///reference/cli`, and `1.1.0`'s `docs:///TOC`
  becomes `docs:///index` (which now returns `wiki/index.md`, the wiki's own table
  of contents). The served set is a **rule, not a number**: every tracked `*.md`
  under `wiki/`, at its real relative path. Two consequences beyond the rename —
  the set is now enumerable through `resources/list` (upstream registers a real
  `list` callback backing a `docs:///{+path}` RFC 6570 reserved-expansion
  template), and pages the retired local generator filtered out as `RESERVED`
  (`index.md`/`log.md` at any level) are now readable. **Anything addressing a
  `docs:///` name from `1.1.0` must be repointed.**
  ([#207](https://github.com/GenvidTechnologies/construct3-chef/issues/207),
  closes [#200](https://github.com/GenvidTechnologies/construct3-chef/issues/200),
  ADR [`0033`](wiki/decisions/0033-mcp-docs-resource-serves-wiki-directly.md))

  > The resolvable form is `@construct3-chef:docs://<path>`
  > (`@server:protocol://resource`). A bare `construct3-chef://docs` transposes
  > server and protocol and has never resolved, independently of this change.

- Bumped `@genvidtech/mcp-utils` to `^0.8.0`, adopting the `docsDir`, `recursive`,
  and enumerable-`list` capabilities behind the change above
  ([mcp-utils#15](https://github.com/GenvidTechnologies/mcp-utils/issues/15)).
  This was the explicit retirement condition ADR
  [`0029`](wiki/decisions/0029-flat-docs-alias-generated-into-the-tarball.md)
  named for itself; that ADR is now **superseded**, and the machinery it
  introduced — `scripts/gen-docs-alias.mjs`, its test, the `docs:alias` npm
  script, and the `prepack`/`postpack` steps — is deleted. The docs resource is
  no longer pack-time-only: it serves identically from a source checkout and an
  installed package. ([#208](https://github.com/GenvidTechnologies/construct3-chef/pull/208))

- **Packaging:** `package.json`'s `files` now ships `wiki` and `raw` in place of
  `docs`. The `docs/` documentation tier was consolidated into `wiki/` and
  retired; `wiki/` is this repo's only documentation tier.
  ([#194](https://github.com/GenvidTechnologies/construct3-chef/pull/194),
  [#197](https://github.com/GenvidTechnologies/construct3-chef/pull/197), ADR
  [`0028`](wiki/decisions/0028-documentation-consolidated-into-the-wiki-tier.md))

### Fixed

- **C3 source JSON is written with no trailing newline**, matching what the C3
  editor itself writes — every file in the pinned canonical fixture ends at its
  closing `}`/`]`. Applies to all `eventSheets/`, `layouts/`, and `objectTypes/`
  writes on **both** surfaces, which now route through a single shared
  `writeSourceJson` helper instead of re-deriving the form at each call site.
  `project.c3proj` is unaffected — it already emitted no trailing newline through
  c3source's `writeProjectManifest`. This **reverses** the previously documented
  two-form rule under which event-sheet and layout writes appended a newline, so a
  project re-synced with this version will show a one-byte diff on each rewritten
  source file. `extracted/` is unchanged and keeps its trailing newline — it is
  chef's own read surface, not C3 source.
  ([#195](https://github.com/GenvidTechnologies/construct3-chef/issues/195), ADR
  [`0030`](wiki/decisions/0030-c3-source-json-written-without-a-trailing-newline.md))

- The MCP `docs:///` resource served **zero** documents and threw `ENOENT` on
  every read between the `docs/` → `wiki/` consolidation and the adoption above.
  `exposeDocs` resolved a hardcoded, flat, non-recursive `<packageDir>/docs`, so
  retiring that directory silently emptied the resource. **The regression never
  reached a release** — `1.1.0` predates the consolidation — and was closed
  first by a pack-time alias generator and then, definitively, by the upstream
  adoption above; a consumer upgrading from `1.1.0` sees only the rename recorded
  under **Changed**, never the gap.
  ([#198](https://github.com/GenvidTechnologies/construct3-chef/issues/198))

### Documentation

- Repointed every intra-repo link that resolved through the retired
  `genvid-holdings` GitHub organization to its canonical `GenvidTechnologies`
  target, and added `test/retiredOrgLinks.test.ts` to guard the class against
  recurrence. Matching is on the **URL form** rather than the bare token, so
  "formerly …" provenance prose stays intact and needs no exclusion — a pointer
  exists to resolve, whereas rewriting the prose would make the sentence false.
  ([#203](https://github.com/GenvidTechnologies/construct3-chef/issues/203), ADR
  [`0032`](wiki/decisions/0032-retired-org-link-targets-are-repointed-prose-is-not.md))

- Documented the `list-global-layers` MCP tool and the `global-layers.txt` report
  format in `wiki/reference/generators.md`, and extended the README inventory
  guard (`test/readmeCommandInventory.test.ts`) to cover the MCP tool tables. The
  generator count in the README's `regenerate` row is now **derived** from
  `GENERATORS.length` rather than restated by hand — it had silently drifted to
  five against six.
  ([#196](https://github.com/GenvidTechnologies/construct3-chef/issues/196),
  [#199](https://github.com/GenvidTechnologies/construct3-chef/issues/199), ADR
  [`0031`](wiki/decisions/0031-mcp-tool-inventory-guard-spans-two-modules.md))
## [1.1.0] - 2026-08-16

### Added

- `[strays]` — a detection-only stray-file report on `validate-project` and
  `sync-project`, both CLI and MCP. A stray is a file under one of the seven
  name-section roots that is neither a `.json` section item nor editor-local
  (e.g. `layouts/notes.txt`, a leftover `Level1.json.bak`). It is
  **informational by default** — the exit code is untouched unless the CLI's
  `validate-project` opts into `--fail-on-strays` (see below) — and sync never
  acts on it either way — a stray has no position in `project.c3proj` and can
  never acquire one. The report is project-wide and is **not** narrowed by
  `--section`, matching `[images]`. This offsets the quieting introduced by the
  c3source 2.0.0 item policy below, which made the section finders skip a stray
  where they used to crash on it. Adds one barrel-exported symbol,
  `reportStrayFiles`.
  ([#177](https://github.com/GenvidTechnologies/construct3-chef/issues/177), ADR 0023)
- `--fail-on-strays` — opt-in flag on the CLI's `validate-project` command that
  turns a non-empty `[strays]` set into a failing exit code. Off by default, so
  the report above stays informational until a project opts in. Composes with
  drift failure as two independent `process.exitCode = 1` statements rather
  than distinct exit codes. MCP `validate-project` gets no gating counterpart —
  exit-code gating is a CLI-only concern; `isError` is reserved for genuine
  tool failure, the same asymmetry `validate-addons` already had undocumented.
  `sync-project` is never gated on either surface, since a stray has no
  manifest position to clear.
  ([#183](https://github.com/GenvidTechnologies/construct3-chef/issues/183), ADR 0025)
- `sync-addon-metadata` — align `project.c3proj`'s `usedAddons` `version`/`author`
  with the bundled `.c3addon` packages. Ships as a CLI subcommand plus a dual MCP
  tool pair (`preview-addon-metadata-sync`, read-only; `sync-addon-metadata`,
  mutating) and is the addon cluster's first mutation — every prior addon tool is
  read-only. A mandatory `--direction` (`manifest-from-package` |
  `package-from-manifest`) names the source of truth; only `manifest-from-package`
  writes, since chef has no `.c3addon` writer. ([#153](https://github.com/GenvidTechnologies/construct3-chef/issues/153), ADR 0017)
- `GENERATORS`, `GeneratorEntry`, `GENERATOR_NAMES`, and `GeneratorName` are now
  exported from `src/c3/generators.ts` — a single source of truth for the six
  generators, replacing a module-private list in `cli.ts` and a hand-written one in
  `server.ts`. Additive, so not breaking, but note these are barrel-exported and
  therefore permanently supported. Consumers can now iterate the generator set
  rather than hard-coding it. ([#178](https://github.com/GenvidTechnologies/construct3-chef/issues/178), ADR 0022)

### Changed

- Bumped `@genvidtech/c3source` to `^2.0.0`, adopting its `.json` item policy — the
  layout and objectType finders now return only `.json` section items. This fixes
  **ten** unguarded `JSON.parse` sites with no code change: each would have thrown
  `SyntaxError` the first time a stray non-`.json` file appeared under `layouts/` or
  `objectTypes/`. The release's other breaking change (dotted extensions) was audited
  and is a verified non-event here — no `src/` module imports any affected symbol.
  ([#175](https://github.com/GenvidTechnologies/construct3-chef/issues/175), ADR 0021)
- **Behavior change on the `list-layouts` MCP tool:** a stray non-`.json` file under
  `layouts/` no longer appears in the tool's response. `list-layouts` renders finder
  output without parsing it, so it is the one consumer where the otherwise
  crash-fixing item policy is visible as an output change rather than a fix. Almost
  certainly the intended behavior — the tool's own description says "List all C3
  layout JSON files" — but it is user-visible. No CLI counterpart exists.
  ([#175](https://github.com/GenvidTechnologies/construct3-chef/issues/175))
- Bumped `@genvidtech/mcp-utils` to `^0.6.0`, adopting its `walkFiles` fix — which
  now guarantees every returned path is a regular file. ([#168](https://github.com/GenvidTechnologies/construct3-chef/issues/168), ADR 0020)
- Bumped `@genvidtech/mcp-utils` to `^0.7.0`, adopting **Layer 3** of
  `OptimisticWatcher` — a per-path content-fingerprint ledger (`ObservedState`)
  that collapses duplicate filesystem events for unchanged content. This fixes a
  **Windows/NTFS** defect where a single `writeFileSync` delivers two `fs.watch`
  events, so `txId` counted watcher events rather than logical changes; MCP
  clients using `txId` for optimistic concurrency saw it advance twice per write.
  Deletions still bump, and genuinely distinct writes still bump once each — only
  duplicates collapse. Adopted with **no `src/` change**: Layer 3 is on by default
  when `observed` is omitted, and `createSourceWatcher` omits it. Does not
  reproduce on Linux (one event per write), so the `ubuntu-latest` gate can
  neither observe the defect nor confirm the fix — coverage is instead a
  deterministic stub-factory test, per ADR 0027.
  ([#191](https://github.com/GenvidTechnologies/construct3-chef/issues/191), ADR 0027)
- Bumped the canonical `construct3-sample` fixture pin to `v0.7.0`. ([#147](https://github.com/GenvidTechnologies/construct3-chef/issues/147))
- **Behavior change on barrel-exported API:** file walks no longer return non-file
  entries (directories, and directory junctions on Windows), which were previously
  emitted and then crashed on use. Not semver-breaking — the old path threw
  `EISDIR`, so nothing could depend on it.
- `reportStrayFiles`' return type widened from `void` to `StrayFile[]`, carrying
  the full detected set alongside the rendering it already logged (which stays
  capped at 20 rows). Additive for the two realistic consumer shapes in this
  repo — call-and-discard, and assignment to a `(root: string) => void`-typed
  slot. ([#183](https://github.com/GenvidTechnologies/construct3-chef/issues/183), ADR 0025)

### Fixed

- `validate-project`, on both CLI and MCP, no longer surfaces a raw uncaught
  stack trace when `project.c3proj` cannot be read or parsed — that failure
  previously escaped uncaught, with no `[images]`/`[strays]` output at all. The
  CLI now prints the underlying error message to stderr and still reports
  `[images]`/`[strays]` (both manifest-independent) to stdout before exiting 1;
  the MCP tool folds the same reports into its `isError: true` response.
  ([#184](https://github.com/GenvidTechnologies/construct3-chef/issues/184), ADR 0025)
- `generate --only templates` no longer throws `ENOENT` on a project whose
  `extracted/` directory does not already exist. `generateTemplateScope` was the one
  generator of six that wrote its output file without first creating the output
  directory, so it worked only because `extractScripts` happened to run before it and
  created the directory as a side effect. The same applied to calling the
  barrel-exported `generateTemplateScope` directly. Every generator is now
  self-sufficient, so run order is presentational rather than a correctness
  constraint. ([#178](https://github.com/GenvidTechnologies/construct3-chef/issues/178), ADR 0022)
- Editor-local writes are no longer treated as source changes. An external edit to
  a `uistate/`/`ts-defs/` directory, a `*.uistate.json` sibling, or `tsconfig.json`
  no longer bumps `txId` or marks `extracted/` dirty. Filtered at the watcher
  factory, since `OptimisticWatcher.handleEvent` bumps `txId` before invoking the
  callback. ([#157](https://github.com/GenvidTechnologies/construct3-chef/issues/157), ADR 0018)
- Closed the remaining editor-local walk residue in `customAceIndex`'s families
  walk and `spriteScaffold`'s objectTypes walk. ([#161](https://github.com/GenvidTechnologies/construct3-chef/issues/161), ADR 0019)
- `discoverAndPlanImageCopies` skips non-file candidates instead of crashing on a
  directory named like an image. ([#163](https://github.com/GenvidTechnologies/construct3-chef/issues/163))
- `search`'s walks exclude editor-local files and non-regular entries, anchoring
  the predicate at the walk's *base* rather than the walked directory — a
  caller-supplied path can itself be the editor-local directory. ([#166](https://github.com/GenvidTechnologies/construct3-chef/issues/166), ADR 0020)

### Documentation

- Documented the three previously-undocumented addon commands and added a guard on
  the README's command inventory. ([#156](https://github.com/GenvidTechnologies/construct3-chef/issues/156))
- Cross-document citations are now name-based, and `docs/issue-triage.md` states
  what the `triaged` label does and does not assert. ([#162](https://github.com/GenvidTechnologies/construct3-chef/issues/162))
- Resolved two unresolvable cross-document section citations and recorded that a
  *bare* `§N` reference is the defect, not `§N` itself. ([#169](https://github.com/GenvidTechnologies/construct3-chef/issues/169))
- Recorded two further premise-failure shapes and the self-example grep trap. ([#174](https://github.com/GenvidTechnologies/construct3-chef/pull/174))
- Corrected the `keep()` predicate's site count, recorded that `CLAUDE.md`'s
  long-form sections are single physical lines, recorded c3source 1.9.0 in the
  leaf-dependency ledger, and stopped pinning a model version in the commit
  trailer. ([#167](https://github.com/GenvidTechnologies/construct3-chef/issues/167), [#171](https://github.com/GenvidTechnologies/construct3-chef/issues/171), [#170](https://github.com/GenvidTechnologies/construct3-chef/issues/170), [#158](https://github.com/GenvidTechnologies/construct3-chef/issues/158))
- Split `CLAUDE.md`'s version-by-version upstream-adoption narrative into `docs/leaf-dependency-ledger.md`, leaving the adoption posture in `CLAUDE.md` § "Leaf dependencies"; added the missing `@genvidtech/mcp-utils` 0.6.0 entry and retired a stale "current pin" claim. ([#172](https://github.com/GenvidTechnologies/construct3-chef/issues/172), ADR 0026)
- Recorded the `@genvidtech/mcp-utils` 0.7.0 entry in the leaf-dependency ledger —
  including a revert-confirm that found **no** overlapping local guard (proven by
  mutation rather than reasoned to) and the accepted gap that stub coverage proves
  the collapsing behaviour but not the native duplicate-delivery trigger. Added
  ADR 0027 on covering a Windows-only defect with cross-platform stub coverage,
  and an eighth grep trap in `CLAUDE.md`: a comment naming a symbol's *absence* is
  an exact match for it, so `grep -c` over source overcounts call sites.
  ([#191](https://github.com/GenvidTechnologies/construct3-chef/issues/191), ADR 0027)

## [1.0.0] - 2026-07-28

First stable release. From here, the `src/index.ts` barrel is semver-locked: removing
or renaming an exported symbol requires a major bump.

The headline of this cycle is the **`.c3addon` tooling cluster** ([#100](https://github.com/GenvidTechnologies/construct3-chef/issues/100)) — seven
read-only capabilities over bundled addon packages, all sharing one hybrid
extracted-dir→zip reader and rendering through shared formatters so the CLI and MCP
outputs stay byte-identical.

### Added

- `read-addon` — addon metadata and ACE listing, over a shared `.c3addon` reader
  exposing the `readAddonEntry` primitive that every sibling tool reuses rather than
  re-unzipping. ([#117](https://github.com/GenvidTechnologies/construct3-chef/issues/117), ADR 0008)
- `validate-addons` — bundled `.c3addon` ↔ `project.c3proj` `usedAddons` metadata
  mismatches and package-integrity failures ([#118](https://github.com/GenvidTechnologies/construct3-chef/issues/118)), extended with
  orphan/missing/duplicate package-consistency detection ([#119](https://github.com/GenvidTechnologies/construct3-chef/issues/119)) and a
  per-locale `aces.json`/`properties` ↔ `lang/*.json` consistency check ([#120](https://github.com/GenvidTechnologies/construct3-chef/issues/120), ADR 0009).
  A `--addon <id|path>` option scopes a run to one addon, so it also works against
  addon-development repos rather than only C3 projects.
- `list-addons` — one row per addon id reconciling bundled packages, `usedAddons`,
  and editor-only addons, classified bundled/editor-only/missing/orphan. Presents
  the same reconciliation `validate-addons` reports as findings, but as a
  never-failing inventory. ([#121](https://github.com/GenvidTechnologies/construct3-chef/issues/121))
- `diff-addon-aces` — diff the ACE contract between two addon versions by
  `(kind, id)` identity, reporting added/removed ACEs and changed parameter
  signatures. Deliberately *not* containment-guarded to `--project-dir`, since the
  point is diffing packages that live outside the project. Local-only in v1. ([#122](https://github.com/GenvidTechnologies/construct3-chef/issues/122))
- `scan-addon-usage` — an addon's presence and call sites across the project, with
  an optional `--from` blast-radius mode that flags call sites hitting a
  changed or removed ACE. Shipped for plugins ([#126](https://github.com/GenvidTechnologies/construct3-chef/issues/126), ADR 0010), then extended to
  behaviors ([#128](https://github.com/GenvidTechnologies/construct3-chef/issues/128), ADR 0011), effects ([#125](https://github.com/GenvidTechnologies/construct3-chef/issues/125), ADR 0012), and expression
  references inside parameter strings ([#138](https://github.com/GenvidTechnologies/construct3-chef/issues/138), ADR 0015) — closing [#100](https://github.com/GenvidTechnologies/construct3-chef/issues/100).

### Changed

- Adopted c3source 1.8.0's `.c3addon` domain layer — deliberately partially. Only
  `stripBom`, `aceIdentity`, `C3ADDON_EXTENSION`, and a new `readAddonAcesModel`
  seam were taken; the hybrid reader, ACE mapping, and tolerant parsers stay local
  on per-module shape-fit grounds. ([#135](https://github.com/GenvidTechnologies/construct3-chef/issues/135), [#137](https://github.com/GenvidTechnologies/construct3-chef/issues/137), ADR 0014)
- The test fixture is now materialized from the canonical `construct3-sample`
  submodule rather than tracked in-tree, and the bundled addons' archive sources
  moved upstream into that repository, ending the copy-drift risk. ([#140](https://github.com/GenvidTechnologies/construct3-chef/issues/140), [#141](https://github.com/GenvidTechnologies/construct3-chef/issues/141), [#142](https://github.com/GenvidTechnologies/construct3-chef/issues/142), ADR 0013)
- Renamed `.genvid-agent.json` to `.gvt-agent.json`. ([#127](https://github.com/GenvidTechnologies/construct3-chef/issues/127))

### Fixed

- Two `validate-addons` false positives: effect addons are exempt from the
  `aces.json` required-entry check (effects ship no ACEs), and the metadata check
  no longer compares the `name` field, whose divergence is legitimate — a package's
  display name differs from the user-assigned instance name. ([#134](https://github.com/GenvidTechnologies/construct3-chef/issues/134))
- The shared reader strips a UTF-8 BOM. Real C3-exported `.c3addon` files ship one
  on `aces.json`/`addon.json`, which `JSON.parse` rejects — silently emptying the
  ACE set for *every* addon tool. Latent until the first real (non-synthetic)
  behavior fixture. ([#128](https://github.com/GenvidTechnologies/construct3-chef/issues/128))

## [0.11.2] - 2026-06-30

### Changed

- **Renamed the npm scope to `@genvidtech`.** The package is now published as
  `@genvidtech/construct3-chef`; `@genvid/construct3-chef` is frozen and deprecated
  at `0.11.1`. Consumers must update their dependency — there is no automatic
  redirect. ([#115](https://github.com/GenvidTechnologies/construct3-chef/issues/115))

## [0.11.1] - 2026-06-30

Final release under the `@genvid` scope.

### Fixed

- Pointed the package URLs at the GenvidTechnologies organization. A stale
  `repository.url` after the org move fails the OIDC `--provenance` publish with a
  422 and burns the version, so the URLs must be corrected before tagging. ([#114](https://github.com/GenvidTechnologies/construct3-chef/issues/114))

## [0.11.0] - 2026-06-30

### Changed

- Migrated both leaf dependencies to the GenvidTechnologies org scope:
  `@genvid/c3source` → `@genvidtech/c3source` ([#102](https://github.com/GenvidTechnologies/construct3-chef/issues/102)) and `@genvid/mcp-utils` →
  `@genvidtech/mcp-utils` ([#112](https://github.com/GenvidTechnologies/construct3-chef/issues/112)). The old scopes are frozen at c3source 1.5.0 and
  mcp-utils 0.5.0.
- Adopted `@genvidtech/c3source` 1.7.0 — the completed `C3Project` handle (all
  section and asset directories, with matching `has*()`/`findAll*()`) plus
  comparison-operator annotation in the DSL renderer, inherited transparently. ([#105](https://github.com/GenvidTechnologies/construct3-chef/issues/105))
- Pointed the CI recipe at `GenvidTechnologies/public-github-actions`. ([#103](https://github.com/GenvidTechnologies/construct3-chef/issues/103))

## [0.10.2] - 2026-06-18

### Fixed

- The MCP server resolves its project root by precedence — `--project-dir` >
  `C3_PROJECT_DIR` > single-child `project.c3proj` discovery > cwd — fixing
  nested-project targeting. `C3_PROJECT_DIR` is shared with the sibling
  c3-domain-manager server, so one variable targets both. ([#96](https://github.com/GenvidTechnologies/construct3-chef/issues/96), ADR 0007)

## [0.10.1] - 2026-06-12

### Fixed

- Hardened the `search-docs` cache merge against a `source: "addon"` double-count. ([#91](https://github.com/GenvidTechnologies/construct3-chef/issues/91), [#92](https://github.com/GenvidTechnologies/construct3-chef/issues/92))

## [0.10.0] - 2026-06-12

### Added

- **User-defined ops** — parameterized recipe templates. Each `.json` file in the
  configurable `ops/` directory becomes a typed MCP tool `op-<name>` and a CLI
  `apply-op <name>` command, with `list-ops` on both surfaces and hot reload when
  the ops directory changes. ([#89](https://github.com/GenvidTechnologies/construct3-chef/issues/89))

### Fixed

- Emit and validate `customActionObjectClass` for family-provided custom actions.
  Without it a recipe-inserted call fails to resolve at C3 runtime — while passing
  editor validation and rendering byte-identical DSL, so nothing else surfaces it. ([#90](https://github.com/GenvidTechnologies/construct3-chef/issues/90))

## [0.9.0] - 2026-06-11

### Added

- `search-docs` — C3 documentation lookup on both the CLI and MCP, rendered once
  through a shared formatter so both surfaces stay identical. ([#87](https://github.com/GenvidTechnologies/construct3-chef/issues/87))

## [0.8.0] - 2026-06-11

### Added

- Pagination for `list-event-sheets` and `list-layouts`. ([#82](https://github.com/GenvidTechnologies/construct3-chef/issues/82))
- `navigation-graph` exposed as an MCP tool. ([#85](https://github.com/GenvidTechnologies/construct3-chef/issues/85))
- Image-drift reporting in `sync-project`. ([#78](https://github.com/GenvidTechnologies/construct3-chef/issues/78))
- Editor-strictness validation at the event-sheet write chokepoint, via c3source
  1.4.0's `validateForEditor` — hard-failing before any write if a node would make
  the C3 editor reject the project on import. ([#86](https://github.com/GenvidTechnologies/construct3-chef/issues/86))

### Changed

- **MCP responses are now a single content block.** Adopted mcp-utils'
  `paginatedContent` ([#77](https://github.com/GenvidTechnologies/construct3-chef/issues/77)) and its error/`txId` helpers ([#80](https://github.com/GenvidTechnologies/construct3-chef/issues/80)), retiring the local
  two-block shape: success folds `txId: <n>` into the block, and every handler is
  wrapped for uniform error responses. **Breaking for any client parsing the
  two-block format.**
- Routed `list-event-sheets`/`list-layouts` through c3source finders. ([#83](https://github.com/GenvidTechnologies/construct3-chef/issues/83))

## [0.7.0] - 2026-06-05

### Added

- Configurable `navigation-graph` convention. The graph is no longer hardwired to a
  project-specific wrapper — it detects C3's built-in go-to-layout actions by
  default and is overridable via `navigation.targetPatterns` /
  `navigation.definitionMarkers`. ([#43](https://github.com/GenvidTechnologies/construct3-chef/issues/43), [#68](https://github.com/GenvidTechnologies/construct3-chef/issues/68))

## [0.6.0] - 2026-06-04

### Added

- Configurable `extracted/` directory name via an optional
  `construct3-chef.config.json` at the project root, path-contained to the project. ([#23](https://github.com/GenvidTechnologies/construct3-chef/issues/23), [#65](https://github.com/GenvidTechnologies/construct3-chef/issues/65))
- Global-variable scope markers, cascading `remove-layer`, and a standalone tool. ([#58](https://github.com/GenvidTechnologies/construct3-chef/issues/58), [#60](https://github.com/GenvidTechnologies/construct3-chef/issues/60))

### Changed

- Prettier is now enforced by `npm run lint`, and the 21 non-conforming source
  files were conformed in one isolated commit. ([#54](https://github.com/GenvidTechnologies/construct3-chef/issues/54), [#59](https://github.com/GenvidTechnologies/construct3-chef/issues/59))

### Fixed

- Adopted c3source 1.3.0, inheriting two drift fixes: a timeline's on-disk
  `transitions/` directory serializes as an unnamed subfolder, and image members
  resolve their extension from the declared `fileType` MIME rather than an assumed
  `.png`. ([#66](https://github.com/GenvidTechnologies/construct3-chef/issues/66))

## [0.5.0] - 2026-06-02

### Added

- `--version` on the CLI. ([#51](https://github.com/GenvidTechnologies/construct3-chef/issues/51))
- Include discovery and function signatures from c3source 1.1.0, closing a latent
  nested-include gap in the include tree. ([#55](https://github.com/GenvidTechnologies/construct3-chef/issues/55))
- An `[images]` drift report in `validate-project` — detection-only, never a sync
  write-back target. ([#53](https://github.com/GenvidTechnologies/construct3-chef/issues/53))
- A `test:file` script for single-file test runs. ([#56](https://github.com/GenvidTechnologies/construct3-chef/issues/56))

### Changed

- Routed name-section project sync through c3source 1.0.0's structured
  path-bearing drift API, replacing ~250 lines of local logic. ([#47](https://github.com/GenvidTechnologies/construct3-chef/issues/47), [#53](https://github.com/GenvidTechnologies/construct3-chef/issues/53))
- Routed the sid-registry walk through c3source's `walkSids`. ([#39](https://github.com/GenvidTechnologies/construct3-chef/issues/39), [#50](https://github.com/GenvidTechnologies/construct3-chef/issues/50))

### Removed

- `readDiskDirNames` and `syncNameFolder`, both barrel-exported. Barrel-breaking,
  absorbed by a minor at this pre-1.0 stage. ([#47](https://github.com/GenvidTechnologies/construct3-chef/issues/47))

## [0.4.0] - 2026-06-02

### Changed

- The DSL formatter drives its traversal through c3source's `visitEvents` while
  keeping rendering local — the split that settled this project's upstream-adoption
  posture. ([#27](https://github.com/GenvidTechnologies/construct3-chef/issues/27), [#37](https://github.com/GenvidTechnologies/construct3-chef/issues/37), ADR 0006)
- Sourced editor-local classification and manifest parsing from c3source in
  `projectSync`. ([#46](https://github.com/GenvidTechnologies/construct3-chef/issues/46))
- Adopted the c3source 0.5.0 file finder in the navigation graph, and bumped
  c3source to `^0.6.0`. ([#40](https://github.com/GenvidTechnologies/construct3-chef/issues/40), [#44](https://github.com/GenvidTechnologies/construct3-chef/issues/44))

### Removed

- `formatEvent` and `EventCounter`, both barrel-exported. Barrel-breaking, absorbed
  by a minor at this pre-1.0 stage. ([#27](https://github.com/GenvidTechnologies/construct3-chef/issues/27))

### Fixed

- `insert-event` with `after: "sid:X"` resolves the live position instead of a
  stale index snapshot, which misplaced or appended the node. ([#45](https://github.com/GenvidTechnologies/construct3-chef/issues/45))
- Project sync skips the `layouts/uistate` directory. ([#41](https://github.com/GenvidTechnologies/construct3-chef/issues/41))

## [0.3.0] - 2026-05-31

### Added

- DSL-index content parity, including `searchText` and matched-content display. ([#18](https://github.com/GenvidTechnologies/construct3-chef/issues/18), [#33](https://github.com/GenvidTechnologies/construct3-chef/issues/33))
- A matched line in `read-event-sids` output. ([#19](https://github.com/GenvidTechnologies/construct3-chef/issues/19))
- A global-layers generator and matching tool. ([#20](https://github.com/GenvidTechnologies/construct3-chef/issues/20))

### Changed

- Adopted c3source's layer-finder API, dropping the hand-rolled layout walks. ([#29](https://github.com/GenvidTechnologies/construct3-chef/issues/29), [#34](https://github.com/GenvidTechnologies/construct3-chef/issues/34))
- Migrated the backlog from `initiatives/` docs to GitHub issues. ([#30](https://github.com/GenvidTechnologies/construct3-chef/issues/30))

> **No 0.2.0 release exists.** Version `0.2.0` was merged to `main` but never
> tagged, and since the tag push — not the merge — is what publishes, it was never
> released. The gap in this changelog is intentional.

## [0.1.0] - 2026-05-31

Initial public release, extracted from the retired c3-mcp-server initiative.

### Added

- The core library (`src/c3/`) surfaced two ways: a yargs **CLI** and an **MCP
  server**, both thin wrappers over the same pure library.
- The two-surface data model — source JSON as the write surface, a generated
  `extracted/` read surface (DSL text, index, TypeScript, layout summaries, SID
  registry) regenerated from source and committed alongside it.
- The SID-addressed recipe pipeline: interpreter, applier, event-sheet mutator, and
  composite template workflow ops (`extract-template`, `templatize-in-place`,
  `clone-replica-to-layouts`, `replace-instance-with-replica`) with matching MCP
  tools. ([#3](https://github.com/GenvidTechnologies/construct3-chef/issues/3), [#4](https://github.com/GenvidTechnologies/construct3-chef/issues/4), [#9](https://github.com/GenvidTechnologies/construct3-chef/issues/9))
- A `generate-sids` MCP tool, and removal of the SID singleton in favour of an
  explicit module-level SID context. ([#6](https://github.com/GenvidTechnologies/construct3-chef/issues/6))
- Publication to npm as `@genvid/construct3-chef` through the shared CI recipe. ([#13](https://github.com/GenvidTechnologies/construct3-chef/issues/13))

### Fixed

- Recipe action/condition shorthand validation gaps. ([#3](https://github.com/GenvidTechnologies/construct3-chef/issues/3))
- `validate-recipe` exercises the apply paths during a dry run, so a recipe that
  would fail on apply fails in validation too. ([#7](https://github.com/GenvidTechnologies/construct3-chef/issues/7))
- `read-event-sids` matches condition and action content. ([#8](https://github.com/GenvidTechnologies/construct3-chef/issues/8))
- The DSL extractor marks disabled conditions with `[DISABLED]`. ([#5](https://github.com/GenvidTechnologies/construct3-chef/issues/5))

[Unreleased]: https://github.com/GenvidTechnologies/construct3-chef/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.11.2...v1.0.0
[0.11.2]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.10.2...v0.11.0
[0.10.2]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/GenvidTechnologies/construct3-chef/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/GenvidTechnologies/construct3-chef/releases/tag/v0.1.0
