---
type: reference
title: "Generators Reference"
description: >-
  The 6 generators, `extracted/` output format, cross-referencing, localVars matching
tags: [reference, generators, extracted]
status: stable
stale_after: 2027-02-20
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# Generators Reference

Reference for the six C3 generators that produce `extracted/` files from C3 JSON. Useful for contributors extending the generators. For day-to-day usage, see the CLI reference.

The `extracted/` directory should be committed alongside C3 source files. If you change event sheets, layouts, or scripts, run `generate` and commit the updated files.

**Prefer extracted files over raw JSON** when verifying event sheet state, exploring logic, or reviewing changes. Read the extracted `.dsl.txt` and `.ts` files instead of grepping raw event sheet JSON. When writing plans or documents that reference event sheet locations, use DSL cross-references (e.g., `GoalsEvents_Event48_Act1`) and DSL line numbers — they are stable across edits while JSON line numbers shift.

---

## Running the Generators

```bash
npx construct3-chef generate                        # Run all 6 generators
npx construct3-chef generate --only scripts         # Extract TypeScript from eventSheet JSON
npx construct3-chef generate --only dsl             # Generate human-readable DSL
npx construct3-chef generate --only layouts         # Generate layout summaries
npx construct3-chef generate --only templates       # Generate template scope reference
npx construct3-chef generate --only sid-registry    # Generate SID registry
npx construct3-chef generate --only global-layers   # Generate global-layer report
```

All accept `--project-dir <path>` (defaults to `cwd`).

---

## Output Structure

Extracted files mirror the event sheet directory structure:

```
extracted/
├── template-scope.txt                  <- cross-layout template map
├── sid-registry.txt                    <- sorted global SID list (one row per owning node)
├── global-layers.txt                   <- global layers: source + overriding layouts + instance counts
├── Goals/
│   ├── GoalsEvents.dsl.txt             <- human-readable DSL
│   ├── GoalsEvents.dsl.idx.txt         <- JSON-path / SID index
│   ├── GoalsEvents.ts                  <- aggregated extracted TypeScript
│   ├── GoalsEvents_e3_a1.ts            <- individual script block
│   └── ...
├── Login/
│   ├── LoginLayout.layout.txt          <- layout layer/instance summary
│   └── ...
└── ...
```

Event sheet file names encode the C3 event/action coordinates: `{SheetName}_e{eventIndex}_a{actionIndex}.ts`. Each extracted `.ts` file contains a named function with:

- Real imports (fully typed, not `any`)
- A typed `localVars` parameter when scope variables are present
- The original script body, with a header comment showing the C3 location and human-readable event path

The generator also produces a `tsconfig.json` under `extracted/` that includes all C3 type definitions, so editors can resolve types without per-file `/// <reference>` directives.

**`sid-registry.txt` excludes editor-local state.** The SID walk over `eventSheets/`/`layouts/`/`objectTypes/` skips editor-local paths (e.g. `layouts/uistate/*.instancesBar.json`) by applying c3source's `isEditorLocalPath` post-hoc over each path *segment*, which covers both a `uistate/` directory and a `*.uistate.json` sibling. Those files only *reference* instance SIDs the layout already owns, so walking them would emit duplicate rows; the registry lists each SID once at its owning node. (This used to say it mirrored a skip in `projectSync`. That has been false since #47 rerouted name-section sync through c3source's `detectManifestDrift`, which delegates internally — `projectSync` applies no such skip of its own. See ADR `wiki/decisions/0016`.)

---

## C3 Event Numbering

C3 identifies script blocks by a 1-indexed positional coordinate: `EventSheet, event N, action N, line N`. Events are numbered by **depth-first traversal** of the events tree:

| Event type | Increments counter? |
| ---------- | ------------------- |
| `block` | Yes |
| `function-block` | Yes |
| `custom-ace-block` | Yes |
| `group` | Yes (even though groups have no actions) |
| `variable` | No |
| `comment` | No |
| `include` | No |

Actions within a block are numbered 1-indexed within that block's `actions` array.

> This table is **descriptive, not a spec the generators re-implement.** Since #27 the counter is owned by c3source's `visitEvents` (the `eventNumber` it yields) and its `isCountingEvent` predicate — the single authority for the counting rule. The DSL formatter (`src/c3/dslFormatter.ts`) drives its traversal through `visitEvents` and reads `ctx.eventNumber`; it does not maintain its own counter. If the increments-counter column ever looks wrong, the fix belongs upstream in c3source, not here.

---

## Cross-Referencing C3 Errors

When C3 reports an error like `GoalEvents, event 5, action 1, line 12`:

1. Find the extracted file matching those coordinates: `GoalEvents_e5_a1.ts`
2. Go to line 12 in that file (line numbers match the original script array)
3. Fix the issue in the extracted file, then port the fix back to the event sheet JSON

DSL cross-references in `.dsl.txt` files (e.g., `// -> SheetName_Event3_Act1`) link multi-line script actions to the corresponding extracted `.ts` file.

---

## DSL Index Format (`.dsl.idx.txt`)

The index file maps every event tree node to its JSON path and SID. This is the primary source for recipe targeting. Each row is a pipe-delimited record: `Event | JSON Path | SID | DSL Line | Description`.

```
# GoalsEvents — DSL Coordinate Index
# Regenerate: npm run generate-dsl
#
# Event | JSON Path | SID              | DSL Line | Description
#-------|-----------|------------------|----------|-----------
  1     | events[0] | §100234567890123 | 4        | block ⟪search⟫ System.on-start-of-layout() System.go-to-layout(layout="Main Layout")
  2     | events[1] | §100234567890789 | 9        | function "LoadGoals" ⟪search⟫ System.compare(...) Functions.call("fetch")
```

- SIDs appear with a `§` prefix. To use one in a recipe: strip the `§` and write `"in": "sid:100234567890123"`.
- **Hidden search tail.** Each block / function-block / custom-ace-block row carries a `⟪search⟫` sentinel followed by the block's full conditions and actions content (parameter values, `[behaviorType]`, `[DISABLED]`, `NOT`), produced by `buildBlockSearchText`. The visible Description column stays short; the tail makes the row's content greppable. `read-dsl-index`'s `filterIndex` regex-tests the whole line, so `grep` now matches condition/action content — parity with `read-event-sids` (both derive their search text from the same `buildBlockSearchText` helper). `resolve-anchor` strips the tail before matching/displaying names, so name lookups stay clean.
- **No per-action rows.** The index lists one row per event node, not a row per action. To find an `actionIndex` for `patch-script` / `patch-action-param`, read the action ordering in the corresponding `.dsl.txt` (actions are 1-indexed within their block's `actions` array).

> **Format coupling — don't add pipe columns.** `resolve-anchor`'s `parseIndexText` (`src/c3/anchorResolver.ts`) parses each row positionally: it splits on `|` and treats *everything after the 4th `|`* as the Description (`descParts.join("|")`). So a new trailing `|`-delimited column would silently fold into the Description and corrupt name matching/display. That is why the #18 search content is appended **in-band** behind the `SEARCH_SENTINEL` (`" ⟪search⟫ "`, defined in `dslFormatter.ts` and imported by `anchorResolver.ts`) rather than as a 6th column — and why `parseIndexText` strips from the sentinel onward before assigning the Description. Any future index-format change must keep the first four columns (`Event | JSON Path | SID | DSL Line`) stable and put new content inside the Description, behind a sentinel, or `resolve-anchor` breaks.

Use the `resolve-anchor` MCP tool to look up a specific SID, line number, or name pattern without reading the full index.

---

## Global Layers Report Format (`global-layers.txt`)

Generator 6 renders one line per global layer, after a three-line `#` header block. Read it with the `list-global-layers` MCP tool, or open the file directly.

```
# C3 Global Layers
# Source: layouts/**/*.json
# Global layers are shared across layouts; one layout defines instances, others override.

global layer: source="Second Layout", overridingLayouts=[Main Layout], instanceCount=2
previously local: source="Main Layout", overridingLayouts=[Second Layout], instanceCount=1
```

Each data line is `${name}: source="${sourceLayout}", overridingLayouts=[${names}], instanceCount=${n}`, and rows are sorted by layer name.

> ⚠️ **`global layer` above is a layer *name*, not a literal prefix.** The canonical fixture happens to contain a layer literally named "global layer", which makes the first line read as though every row began with a fixed label. It doesn't — the second line is the shape to reason from.

The report has four rendered elements beyond the data line:

| Element | When |
| ------- | ---- |
| `# C3 Global Layers` header block | always — three `#` lines, then a blank line |
| `(no global layers found)` | the report is empty; the file is still written, with the header |
| `overridingLayouts=[(none)]` — the literal `(none)` *inside* the brackets, which are always emitted | the layer has no overriding layouts |
| An indented `[WARNING: …]` line | the same layer name qualifies as a source in more than one layout |

The warning is indented by **two** spaces and follows the row it belongs to:

```
global layer: source="Second Layout", overridingLayouts=[Main Layout], instanceCount=2
  [WARNING: global layer "global layer" defined in multiple source layouts: "Second Layout", "Main Layout"]
```

Two rules govern which layers appear and what `instanceCount` means. Neither is inferable from the column names, and getting either wrong means misreading the report rather than failing to find something in it.

- **`instanceCount` is counted deep, from the source layer only.** `countInstancesDeep` recurses through sublayers and sums each one's `instances`, so a layer with populated sublayers reports the whole subtree. But `buildGlobalLayerReport` applies it to the **source** layer alone — a shadowing layout's same-named layer keeps its own `instances` in the JSON, and those are *structurally excluded* from the count. That matches runtime, where the source layout's instances are the ones that exist.
- **A global layer with zero instances never appears at all.** Source detection requires `layer.global && !isOverriden(layer) && hasInstances(layer)`. A layer failing the last clause is absent from the report entirely — it is **not** listed with `instanceCount=0`. So "not in the report" means either "not a global layer" or "a global layer nobody put anything on", and the report cannot distinguish them.

---

## localVars Matching

Each script block may have access to local variables from:

- `eventType: "variable"` declarations in scope (current block + all ancestor groups)
- `functionParameters` from the enclosing `function-block` or `custom-ace-block`

The extractor collects these into a "scope vars" set and generates an inline object type for each function's `localVars` parameter (e.g., `{ myVar: string; count: number }`). Types are derived directly from the event sheet source.

In extracted `.ts` files, `localVars` always uses inline object types derived from the event sheet source. This avoids unstable SID references.

---

## Variable Scope Markers

Event-variable **declarations** carry a scope marker in the DSL read surface (`.dsl.txt`, the `.dsl.idx.txt` Description column, and `read-event-sids`). A `variable` event at the event-sheet **root** is a **global**; nested inside a group/block it is **local**. Globals are rendered with a leading `global ` word before the `const`/`static`/`var` keyword; locals are unmarked:

```
global var score: number = 0      # sheet-root → global
global static hp: number = 100
global const MAX: number = 5
var temp: number = 0              # nested in a group/block → local (no marker)
```

Scope is **positional**, not a flag — a sheet-root variable is global regardless of `isStatic`. The formatter derives it from `ctx.depth === 0` on the render path and from the absence of a `.children` segment in the jsonPath on the index/`read-event-sids` paths (the marker stays inside the Description column, so it does not disturb `resolve-anchor`'s positional parse). This is the same positional model the `move-variable` recipe op uses.

> **Reference-site markers are not yet emitted.** `set-eventvar-value` / `compare-eventvar` *references* are not annotated with their target's scope. Doing so correctly needs the System eventvar ACE-id list (a C3 platform fact owned by c3source) plus shadowing-aware name→declaration resolution; it is deferred pending the [c3source#26](https://github.com/genvid-holdings/c3source/issues/26) classifier and tracked on [construct3-chef#58](https://github.com/genvid-holdings/construct3-chef/issues/58).

---

## Generator Output Stability

Generators that output to `extracted/` must produce deterministic output across platforms:

1. **Sort directory listings**: `readdirSync` returns different orders on Windows vs Linux/macOS. Always sort before iterating.

2. **Normalize line endings in C3 data**: C3 JSON files may contain `\r\n` in expressions and comments. Normalize to `\n` before processing.

3. **Sort output lists**: Any list in formatted output (functions, files, dependencies) should be sorted.

4. **Use `.gitattributes` for line endings**: Add `extracted/** text eol=lf` to ensure git stores generated files with LF endings regardless of platform.

CI validates that `extracted/` matches regenerated output. If validation fails, run `generate` and commit.

---

## Formatter/CLI Architecture

The generators follow a strict separation between formatting logic and CLI I/O:

```
src/c3/*Formatter.ts    <- pure functions (unit-testable, no filesystem access)
src/generate*.ts        <- CLI wrapper (yargs, file I/O, directory management)
test/C3/*.test.ts       <- unit tests for formatters only
```

Each generator has a `generate` subcommand (writes files) and a `summary` subcommand (prints stats without writing). Formatters receive parsed data and return strings — they never read files or interact with the filesystem.

| Formatter | Output |
| --------- | ------ |
| `dslFormatter.ts` | `.dsl.txt` and `.dsl.idx.txt` |
| `layoutFormatter.ts` | `.layout.txt` |

New generators should follow this formatter/CLI separation pattern to keep formatting logic testable without filesystem mocking.

### Generator signatures: all six take an absolute `outDir`

All six generators share one calling convention: each takes an **absolute** output directory and uses it directly. `generateSidRegistry(projectRoot, outDir, log)` keeps `projectRoot` (it walks the SID-bearing source dirs and computes relative paths from it), but writes to the absolute `outDir` like `extractScripts`, `generateDSL`, `generateLayoutSummaries`, `generateTemplateScope`, and `generateGlobalLayers`. **When wiring a new generator-runner, pass every generator the same absolute `EXTRACTED_DIR`.**

> **History (resolved by [#74](https://github.com/genvid-holdings/construct3-chef/issues/74)):** `generateSidRegistry` used to be the odd one out — it took a **relative** `extractedDir` (defaulting to `"extracted"`) and re-joined `projectRoot` internally. A caller that iterated the six uniformly with the absolute `EXTRACTED_DIR` produced a *doubled* path (`path.join(root, /root/extracted)`): silently wrong on POSIX (registry written to a junk location), an **ENOENT crash on Windows**. That asymmetry shipped a real bug in the untested MCP regenerate path (`server.ts`'s `GENERATOR_STEPS`), band-aided in #73 with `path.relative(...)`. #74 removed the asymmetry by normalizing the signature, so the band-aid and the footgun are both gone. The signature change is **semver-breaking** (the symbol is re-exported via the `src/index.ts` barrel) — see CLAUDE.md § Releasing.

> **History (resolved by [#178](https://github.com/GenvidTechnologies/construct3-chef/issues/178), ADR `wiki/decisions/0022`):** the *signature* convention above was normalized by #74, but that audit didn't check the *outDir-creation* convention — a second, independent axis of the same "all six generators behave uniformly" property. `generateTemplateScope` was the one generator that wrote its output file without first calling `mkdirSync(outDir, { recursive: true })`; it only worked because `extractScripts` happened to run before it in the fixed CLI/MCP order and created the directory as a side effect. `generate --only templates` on a project without an existing `extracted/` threw `ENOENT`. Fixed by adding the missing `mkdirSync` call, matching the placement convention the other five generators already use. `test/c3/generatorOutDir.test.ts` now enforces this structurally by iterating the shared `GENERATORS` inventory (below), so a future generator that skips its own `mkdirSync` is caught automatically rather than only surfacing as a `--only`-specific bug report.

### Generator inventory: `GENERATORS`

The six generators are enumerated once, as `GENERATORS: readonly GeneratorEntry[]` (`{ name, label, run }`, keyed by the `GeneratorName` `--only` value) exported from `src/c3/generators.ts`. Both surfaces derive from it rather than maintaining their own list: `cli.ts`'s `runGenerators` filters it by `--only`, and `server.ts`'s `GENERATOR_STEPS` is `.map()`-derived from it for MCP progress notifications. Adding a seventh generator here is picked up by both surfaces without further wiring — see CLAUDE.md's generator-lockstep note for what still needs a manual edit elsewhere, and ADR `wiki/decisions/0022` for the full rationale.

---

## Selective Cleanup

When multiple generators share a single output directory (`extracted/`), each generator must only clean files it owns. This prevents one generator from deleting another's output:

```typescript
cleanOwnedFiles(outDir, ".dsl.txt");     // DSL generator
cleanOwnedFiles(outDir, ".layout.txt");  // Layout generator
cleanOwnedFiles(outDir, ".ts");          // Script extractor
```

This avoids the naive `rmSync(outDir, { recursive: true })` approach. The shared directory structure allows related outputs to sit side-by-side.
