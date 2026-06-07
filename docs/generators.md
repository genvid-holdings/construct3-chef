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

**`sid-registry.txt` excludes editor-local state.** The SID walk over `eventSheets/`/`layouts/`/`objectTypes/` skips editor-local paths (e.g. `layouts/uistate/*.instancesBar.json`) via c3source's `isEditorLocalPath` — mirroring the skip `projectSync` applies. Those files only *reference* instance SIDs the layout already owns, so walking them would emit duplicate rows; the registry lists each SID once at its owning node.

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

### Generator signatures: the `generateSidRegistry` dir asymmetry (gotcha)

The six generators do **not** share one calling convention. Five — `extractScripts`, `generateDSL`, `generateLayoutSummaries`, `generateTemplateScope`, `generateGlobalLayers` — take an **absolute** `outDir` and use it directly. `generateSidRegistry(projectRoot, extractedDir = "extracted", log)` is the odd one out: it takes a **relative** dir and re-joins `projectRoot` internally (`path.join(projectRoot, extractedDir)`).

So a caller that iterates the six uniformly with the absolute `EXTRACTED_DIR` produces a *doubled* path for `generateSidRegistry` (`path.join(root, /root/extracted)`) — silently wrong on POSIX (registry written to a junk location, the real `sid-registry.txt` never refreshed), an **ENOENT crash on Windows** (the drive-letter path is invalid). `cli.ts`'s `runGenerators` special-cases it (passes the relative dir); `server.ts`'s `GENERATOR_STEPS` did **not**, which shipped a real bug in the untested MCP regenerate path (fixed in #73 by passing `path.relative(PROJECT_ROOT, EXTRACTED_DIR)`). **When wiring a new generator-runner, pass `generateSidRegistry` the relative dir.** Normalizing the signature to drop the asymmetry is tracked in [#74](https://github.com/genvid-holdings/construct3-chef/issues/74).

---

## Selective Cleanup

When multiple generators share a single output directory (`extracted/`), each generator must only clean files it owns. This prevents one generator from deleting another's output:

```typescript
cleanOwnedFiles(outDir, ".dsl.txt");     // DSL generator
cleanOwnedFiles(outDir, ".layout.txt");  // Layout generator
cleanOwnedFiles(outDir, ".ts");          // Script extractor
```

This avoids the naive `rmSync(outDir, { recursive: true })` approach. The shared directory structure allows related outputs to sit side-by-side.
