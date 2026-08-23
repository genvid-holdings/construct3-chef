# Decision records

Numbered ADRs, chronological by when the decision landed (earliest first).
0001-0005 trace to the 2026-04-03 initial release, ordered by dependency.

See the [wiki index](../index.md) for the other sections.

* [0001. Two-surface data model](0001-two-surface-data-model.md) -
  Source JSON as write surface + committed `extracted/` as read surface;
  rejected direct-edit and on-demand-only alternatives
* [0002. SID-based node addressing](0002-sid-based-node-addressing.md) -
  SID-based recipe targeting over positional/JSON-path addressing; the
  `indexInParent` staleness rationale (gotcha #34)
* [0003. Recipe pipeline split: pure interpreter vs. I/O applier](0003-recipe-pipeline-pure-interpreter-vs-io-applier.md) -
  `recipeInterpreter.ts` (pure, no I/O) split from `recipeApplier.ts`
  (orchestrator with I/O); two pre-write validation chokepoints
  (`assertEditorValid`, `validateInsertedCustomActions`)
* [0004. Dual CLI + MCP surface over one shared pure library and shared formatters](0004-dual-surface-shared-library-and-formatters.md) -
  CLI + MCP as thin wrappers over `src/c3/`; shared formatters keep outputs
  byte-identical across both surfaces
* [0005. MCP server optimistic-concurrency model](0005-mcp-server-optimistic-concurrency-model.md) -
  `txId` optimistic concurrency + `extractedDirty` staleness flag +
  `ReadWriteLock`; rejected locks-only and no-watcher alternatives
* [0006. Upstream ownership boundary and young-package adoption posture](0006-upstream-ownership-boundary-and-adoption-posture.md) -
  Traversal/discovery/domain-facts to `c3source`, MCP/config plumbing to
  `mcp-utils`, rendering local; young-package adoption posture and the
  forced-partial-fit anti-pattern
* [0007. MCP server root resolution and C3Project handle adoption](0007-mcp-server-root-resolution-and-c3project-adoption.md) -
  MCP root resolution via mcp-utils `resolveRootFolder` (env/discovery/cwd
  precedence) and hybrid C3Project handle adoption; rejected alternatives and
  deliberate non-adoptions
  ([#94](https://github.com/genvid-holdings/construct3-chef/issues/94))
* [0008. Addon reader: hybrid extracted-dir/archive sourcing](0008-addon-reader-hybrid-sourcing.md) -
  Shared addon reader prefers extracted dir, falls back to reading the
  `.c3addon` zip archive directly; parser-only sharing with `aceRegistry`,
  off-barrel placement, `fflate` for sync zip reads
  ([#106](https://github.com/GenvidTechnologies/construct3-chef/issues/106),
  part of the #100 c3addon-tooling umbrella)
* [0009. Addon aces.json/properties ↔ lang consistency check](0009-addon-lang-consistency-check.md) -
  Aces.json/properties ↔ lang/*.json cross-validation folded into
  `validate-addons` (not a separate `validate-addon` command); lang check
  gated on `lang/` presence; best-effort string-literal scan for JS-declared
  plugin `properties`
  ([#98](https://github.com/GenvidTechnologies/construct3-chef/issues/98),
  part of the #100 c3addon-tooling umbrella)
* [0010. `scan-addon-usage`: plugins-only v1 scope](0010-scan-addon-usage-plugins-only-v1.md) -
  `scan-addon-usage` scans plugin ACE call sites in event sheets only;
  behavior/effect/expression usage split into follow-ups (#123/#124/#125);
  `readProjectObjects`/`ObjectDefn` shared seam; blast-radius match-set
  widening for dangling calls to removed ACEs
  ([#110](https://github.com/GenvidTechnologies/construct3-chef/issues/110),
  part of the #100 c3addon-tooling umbrella)
* [0011. `scan-addon-usage`: behavior addon support](0011-scan-addon-usage-behavior-support.md) -
  `scan-addon-usage` extended to behavior addons via a `UsageMatcher` seam;
  `behaviorTypes[]`-keyed presence; the family-member call-site attribution
  rule; built-in behaviors (Timer, Persist) unscannable by id; the
  prerequisite BOM-stripping fix in `addonReader.ts`
  ([#124](https://github.com/GenvidTechnologies/construct3-chef/issues/124),
  part of the #100 c3addon-tooling umbrella)
* [0012. `scan-addon-usage`: effect addon support](0012-scan-addon-usage-effect-support.md) -
  `scan-addon-usage` extended to effect addons via a dedicated
  `scanEffectUsage` path (not a `UsageMatcher` extension, course-correcting
  ADR 0011's prediction); the four-site presence model (object
  type/family/layer/layout); presence-only, `--from` blast = every application
  site
  ([#125](https://github.com/GenvidTechnologies/construct3-chef/issues/125),
  part of the #100 c3addon-tooling umbrella)
* [0013. Canonical sample fixture: chef as prototype consumer](0013-canonical-sample-fixture-consumption.md) -
  Chef seeded the new canonical `GenvidTechnologies/construct3-sample` fixture
  repo from its own in-tree fixture (prototype/superset consumer) and then
  migrated its own in-tree fixture onto the submodule (pinned `v0.7.0`,
  `scripts/prep-fixture.mjs` as the `pretest` hook, a `.gitignore`-negation
  overlay, since
  [#139](https://github.com/GenvidTechnologies/construct3-chef/issues/139) the
  12-file `extracted/` golden only); the submodule/prep-script consumption
  mechanism itself is recorded canonically in that repo's own ADR 0001, not
  duplicated here
  ([#130](https://github.com/GenvidTechnologies/construct3-chef/issues/130))
* [0014. Partial adoption of the c3source 1.8.0 `.c3addon` domain layer](0014-adopt-c3source-addon-domain-layer.md) -
  Partial adoption of c3source 1.8.0's `.c3addon` domain layer: adopted
  `stripBom`/`aceIdentity`/`C3ADDON_EXTENSION` + a new `readAddonAcesModel`
  (`DiscoveredAddon → AcesModel`) seam for #123; the bulk of the local
  `addon*` layer stays local on per-module shape-fit grounds (hybrid reader,
  `AceEntry` order/tolerance, tolerant metadata/manifest/objectType parses vs
  strict upstream)
  ([#136](https://github.com/GenvidTechnologies/construct3-chef/issues/136),
  part of the #100 c3addon-tooling umbrella)
* [0015. scan-addon-usage: expression usage & the resolution layer](0015-scan-addon-usage-expression-support.md) -
  `scan-addon-usage` extended to event-sheet expression usage
  (`Object.expr`/`Object.Behavior.expr` in parameter strings) via a parallel
  `expressionSites` collection + a `UsageMatcher.matchExpression` seam
  extension (fits, unlike effects in ADR 0012) + a distinct
  `expressionSiteCount`; resolves through c3source
  `extractExpressionReferences`/`findExpression` over the `readAddonAcesModel`
  seam, with blast-mode model widening for dangling removed-expression
  references — closes the last child of the #100 umbrella
  ([#123](https://github.com/GenvidTechnologies/construct3-chef/issues/123))
* [0016. Adopt c3source's shared file walk only where its shape fits](0016-shared-file-walk-adoption-triage.md) -
  C3source's shared file walk adopted at one site (`find_all_eventsheets_path`
  in `buildSheetNameMap` — the named collector carries the three-dimension
  editor-local predicate) and declined at three (`projectSync.readDiskDir`,
  `generators.findJsonFiles`, and the `descend` parameter, which has no
  consumer); corrects the issue's proposed `find_all_files_path` snippet
  ("reachability is not classification" — it still accepts
  `Foo.uistate.json`), so the adoption never needed the 1.9.0 bump
  ([#146](https://github.com/GenvidTechnologies/construct3-chef/issues/146))
* [0017. `sync-addon-metadata`: a separate command, not a fold](0017-sync-addon-metadata-separate-mutation-command.md) -
  `sync-addon-metadata` ships as its own CLI subcommand + MUTATE MCP tool
  rather than folding into `validate-addons`/`sync-project` (ADR 0009's
  naming-collision precedent doesn't transfer — no colliding name here);
  mandatory no-default `--direction` (only `manifest-from-package` writes —
  chef has no `.c3addon` writer); `project.c3proj` byte-fidelity via
  parse-by-identity/mutate-in-place and the file's no-trailing-newline form;
  two writers of `project.c3proj` sharing one unenforced discipline; "exit 1
  iff outstanding human work remains" exit-code policy — closes the #100
  c3addon-tooling umbrella's last capability
  ([#145](https://github.com/GenvidTechnologies/construct3-chef/issues/145),
  part of the #100 c3addon-tooling umbrella)
* [0018. Editor-local writes bump neither `txId` nor `extractedDirty`](0018-editor-local-writes-are-not-source-changes.md) -
  Editor-local writes (uistate, ts-defs, tsconfig.json) bump neither `txId`
  nor `extractedDirty`; a filtering decorator over the watcher's factory seam,
  not a filter inside `onExternalChange` (which cannot stop
  `OptimisticWatcher`'s unconditional bump); classification via a shared
  `isEditorLocalPath`-based `src/c3/editorLocal.ts`, generalizing the
  ops-registry precedent
  ([#151](https://github.com/GenvidTechnologies/construct3-chef/issues/151))
* [0019. Two walk primitives, one classification rule — closing the editor-local walk residue](0019-two-walk-primitives-one-classification-rule.md) -
  Closes the editor-local walk residue: `customAceIndex` adopts
  `C3Project.findAllFamilies()` with a contextual rethrow (loud on
  present-but-unreadable `families/`, correcting #152's inverted severity
  claim), `spriteScaffold` keeps `walkFiles` + `isEditorLocalPathUnder`
  (bare-directory contract, barrel-exported callers), and the two-primitive
  selection rule is stated once; the vacuous `serverHandlers` uistate
  assertions are replaced with a seeded three-part anti-vacuity device
  ([#152](https://github.com/GenvidTechnologies/construct3-chef/issues/152),
  [#149](https://github.com/GenvidTechnologies/construct3-chef/issues/149))
* [0020. Anchor `search()`'s editor-local filter at `baseRoot`, not the walked directory](0020-search-walk-editor-local-anchor.md) -
  Closes the last editor-local walk residue named by ADR 0019: `search()`'s
  four `walkFiles` sites plus its two single-file branches now filter via one
  shared predicate anchored at `baseRoot` (not the walked directory, which
  #159 prescribed and which fails when the walked directory is itself
  editor-local); also adds a `statSync().isFile()` guard against directory
  junctions/dangling symlinks, correcting a wrong upstream claim in
  mcp-utils#10 that a predicate can't fix it
  ([#159](https://github.com/GenvidTechnologies/construct3-chef/issues/159))
* [0021. `find_all_section_items_path` does not reopen ADR 0016's walk declines](0021-section-item-axis-does-not-reopen-walk-declines.md) -
  C3source 2.0.0's new both-dimension `find_all_section_items_path` doesn't
  reopen ADR 0016's `readDiskDir`/`findJsonFiles`/`descend` declines (all
  three stand), but weakens the `findJsonFiles` "buys nothing" argument to
  costs-alone, since the classification gap that argument relied on is now
  closed upstream; names what *would* reopen it (`walkFiles`-grade error
  tolerances, not a new axis)
  ([#175](https://github.com/GenvidTechnologies/construct3-chef/issues/175))
* [0022. `generators.ts` owns the generator inventory as a single exported source of truth](0022-single-exported-generator-inventory.md) -
  `GENERATORS` in `src/c3/generators.ts` becomes the single source of truth
  for the six generators, replacing `cli.ts`'s private
  `GENERATOR_NAMES`/`generators` array and letting `server.ts`'s
  `GENERATOR_STEPS` derive rather than hand-list; this is what makes
  `test/c3/generatorOutDir.test.ts`'s structural "every generator creates its
  own outDir" guard self-extending; rejects hoisting a single `mkdirSync` into
  the caller and hand-enumerating generators inside the test;
  `recipeApplier.ts`'s fixed three-generator sequence stays deliberately
  unrouted; does not fix
  [#181](https://github.com/GenvidTechnologies/construct3-chef/issues/181)
  (`extractScripts` still requires a pre-existing `importsForEvents.ts`)
  ([#178](https://github.com/GenvidTechnologies/construct3-chef/issues/178))
* [0023. Stray files are a detection-only `[strays]` report, called standalone](0023-stray-files-are-a-detection-only-report.md) -
  C3source 2.0.0's `detectStrayFiles` surfaced as an informational `[strays]`
  report at the four `[images]` surfaces (2 CLI + 2 MCP), never affecting the
  exit code and never a sync write-back target (a stray has no manifest
  position and can never acquire one); called standalone rather than reading
  the `drift.strays` value `runSync` already drops — correcting the issue's
  mechanically wrong `--section`-inheritance framing of that fork — and always
  emitting a line on a clean project, because silence would render "no strays"
  and "reporter absent" identically; declines a `models3d` filter (reporting
  is not syncing) and `--section` narrowing (the `[images]` precedent), keeps
  upstream's `[strays]` term and renames the colliding chef-local test
  vocabulary to "untracked", caps output at 20 rows for the unpaginated MCP
  block, and pins that an `extractedDir` nested under a section root *is*
  reported
  ([#177](https://github.com/GenvidTechnologies/construct3-chef/issues/177))
* [0024. `runSync` writes `project.c3proj` through c3source's shared serializer](0024-project-c3proj-shared-serializer.md) -
  `runSync`'s hand-rolled `project.c3proj` write is routed through c3source's
  `writeProjectManifest`, the writer `applyAddonMetadataSync` already used,
  closing the byte-drift risk between the two writers; only the serialization
  half becomes structural — parse-by-identity/mutate-in-place stays purely
  conventional, so both cross-reference comments are narrowed rather than
  dropped, correcting the issue's claim that they could be dropped entirely;
  the read path (strict `readProjectManifest`) is untouched, and the guard
  test was mutation-checked rather than assumed
  ([#154](https://github.com/GenvidTechnologies/construct3-chef/issues/154))
* [0025. Stray-file gating is CLI-only, and `[strays]`/`[images]` survive a manifest failure](0025-stray-gating-is-cli-only-and-survives-a-manifest-failure.md) -
  `--fail-on-strays` ships as an opt-in CLI-only exit-code gate on
  `validate-project` (widening `reportStrayFiles`'s return to `StrayFile[]`,
  converting its terminal `process.exit(1)` to a composable `process.exitCode
  = 1`, no MCP counterpart — `isError` stays reserved for genuine tool
  failure, never a findings threshold), and a `project.c3proj` that won't
  read/parse still surfaces `[images]`/`[strays]` via a call-site catch
  (Option A, not a new command) rather than a raw stack trace with nothing
  else printed
  ([#183](https://github.com/GenvidTechnologies/construct3-chef/issues/183),
  [#184](https://github.com/GenvidTechnologies/construct3-chef/issues/184))
* [0026. Split the leaf-dependency version narrative out of `CLAUDE.md`](0026-leaf-dependency-ledger-split-from-claude-md.md) -
  `CLAUDE.md`'s version-by-version upstream narrative moves to
  `wiki/process/leaf-dependency-ledger.md` (one section per package, oldest
  entry first), leaving only the adoption posture in `CLAUDE.md` § "Leaf
  dependencies"; rejects `CHANGELOG.md` as the home (different axis and
  lifecycle) and strictly-chronological single-file ordering (interleaving is
  what let the mcp-utils 0.6.0 entry go missing); the deliberate declines move
  with their version entries, reachable via their indexed ADRs and a routing
  pointer left in `CLAUDE.md`
  ([#172](https://github.com/GenvidTechnologies/construct3-chef/issues/172))
* [0027. Cover a Windows-only defect with cross-platform stub coverage, not manual verification](0027-cross-platform-stub-coverage-over-manual-windows-verification.md) -
  Mcp-utils 0.7.0's `OptimisticWatcher` Layer 3 (Windows/NTFS
  duplicate-`fs.watch`-event fix) is covered by injected-stub-factory tests
  instead of the issue's proposed manual Windows run, on the rule that a
  platform-specific trigger does not imply platform-specific testability;
  rejects manual verification as the merge gate, relying on the unmodified
  pre-existing suite (vacuous — every prior test fires its path once), and
  `observed: null` (forfeits the fix); records the accepted gap that stub
  coverage proves the collapsing behaviour but not the native
  duplicate-delivery trigger itself
  ([#191](https://github.com/GenvidTechnologies/construct3-chef/issues/191))
* [0028. Documentation consolidated into the wiki tier; docs/ retired](0028-documentation-consolidated-into-the-wiki-tier.md) -
  All of `docs/` — reference manuals, architecture and research notes, process
  docs, and the 27 decision records — moves into the `wiki/` OKF bundle,
  retiring `docs/` entirely and inverting the previous routing rule that kept
  wiki content restricted to knowledge with no other repo home; records the
  hardcoded-`docs/` plugin-contract breakages the move exposes (gvt-dev
  #389/#390) and why they are accepted rather than worked around
* [0029. Flat docs/ alias generated into the published tarball, not committed](0029-flat-docs-alias-generated-into-the-tarball.md) -
  Restores the MCP `docs:///{name}` resource, emptied by ADR 0028's `docs/` →
  `wiki/` consolidation because upstream `exposeDocs` hardcodes a flat,
  non-recursive `<packageDir>/docs` scan it cannot be pointed at `wiki/`; a
  new `scripts/gen-docs-alias.mjs` regenerates a flat `docs/` from `wiki/` at
  `prepack`/`postpack` time only, gitignored and never committed, serving
  every non-`RESERVED` wiki page plus a generated manifest (a naive
  un-generated alias would serve only the 4 bundle-root files); records the
  accepted no-link-rewriting and no-`TOC`-compat-alias trade-offs, the
  `exposeDocs` non-enumerability limitation (confirmed non-structural against
  the installed MCP SDK), and the retirement condition once upstream gains a
  configurable, recursive, enumerable docs surface
  ([#198](https://github.com/GenvidTechnologies/construct3-chef/issues/198))
* [0030. C3 source JSON is written without a trailing newline](0030-c3-source-json-written-without-a-trailing-newline.md) -
  All nine C3-source JSON write sites (`eventSheets/`, `layouts/`,
  `objectTypes/`) are routed through a new shared `src/c3/sourceJson.ts`
  `writeSourceJson`, dropping the `+ "\n"` idiom copy-pasted from the
  project's first commit — the C3 editor writes no trailing newline, so the
  extra byte produced a spurious whole-file diff on every editor round-trip;
  follows the precedent ADR 0024 set for `project.c3proj`, reverses the "two
  forms" framing in `CLAUDE.md` § "Conventions" to a single uniform rule, and
  is proven by mutation rather than by going green
  ([#195](https://github.com/GenvidTechnologies/construct3-chef/issues/195))
* [0031. The MCP tool inventory guard spans two modules, anchored on quote style](0031-mcp-tool-inventory-guard-spans-two-modules.md) -
  The README's `### Available MCP tools` inventory guard parses **two** source
  modules — `src/mcp/server.ts`'s `reg()` calls and `src/mcp/opsRegistry.ts`'s
  `registerTool()` calls — because `list-ops` is a static, unconditionally
  registered tool that lives outside `server.ts` and a single-module parse is
  structurally blind to it; the dynamic `op-<name>` tools are excluded by
  anchoring on a **double-quoted** string literal rather than by an exception
  list, since they register from a template literal
  ([#199](https://github.com/GenvidTechnologies/construct3-chef/issues/199),
  [#196](https://github.com/GenvidTechnologies/construct3-chef/issues/196))
