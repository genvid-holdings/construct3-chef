# Initiative: C3 MCP Server

> **About this initiative.** This is the home initiative for **construct3-chef** — the recipe system, generators, scaffolding, CLI, and MCP server in this repository. It was originally developed inside the Genvid "burbank" monorepo and extracted into this standalone package; that extraction is the work described under [Package Extraction](#package-extraction--shipped), now shipped. This document is imported from that monorepo and remains the living roadmap and knowledge base for the tool. Historical session-by-session plans live in [`archive/`](archive/).
>
> **Reading the old paths.** Text written during monorepo development refers to the layout there. Map it to this repo as follows:
>
> | In this document | In this repo |
> | --- | --- |
> | `bin/c3/…` | `src/c3/…` |
> | `bin/mcp/server.ts` | `src/mcp/server.ts` |
> | `bin/construct3-chef.ts` | `src/cli.ts` |
> | `bin/mcp/rwlock.ts`, `expectedChanges.ts`, `pagination.ts` | the **`genvid-mcp-utils`** package (`ReadWriteLock`, `ExpectedChanges`, `paginateText`) |
> | `bin/c3/c3source.ts` | the **`c3source`** package |
> | `test/C3/…` | `test/c3/…` |
> | `npm run generate-c3` / `apply-recipe` / `sync-c3proj` | `construct3-chef generate` / `apply-recipe` / `sync-project` |
> | domain-config / domain-index / `domainAnalysis.ts` / `list-uncategorized` / `read-domain-config` tools | the separate **`domain-manager`** package — **not** part of construct3-chef (see [What's Complete](#whats-complete)) |
>
> Tool counts in this document (e.g. "27 tools") count the domain-manager tools that were built alongside construct3-chef in the same initiative. construct3-chef itself ships ~21 MCP tools; the domain-management tools were split into `domain-manager`.

## Goals

Build an MCP (Model Context Protocol) server that exposes Construct 3 project editing capabilities as tools for Claude Code, enabling AI-assisted C3 development with richer context and direct manipulation. (construct3-chef is the result; this section captures the original framing.)

## Problem

Claude Code's current C3 workflow relies on:

1. **Reading extracted files** (DSL, scripts, layout summaries) for context
2. **Manually applying recipes** via `npm run apply-recipe` for mutations
3. **Regenerating extracted files** after changes
4. **No live connection** to the C3 editor

This works well but has friction: Claude Code can't directly query project structure, must read files from disk, and has no way to interact with a running C3 editor session.

## Current State (Exploration Findings)

### C3 Editor SDK Capabilities (from SDK at c3addon-genvid-datadog-rum/SDK)

The C3 addon SDK exposes editor-side APIs for:

- **Instance manipulation**: Create/delete instances in layouts, set position/size/rotation/properties
- **Object types**: Create object types, access animations/frames
- **Properties**: Read/write plugin properties via `GetPropertyValue`/`SetPropertyValue`
- **Rendering**: Custom Draw() method for editor layout view visuals
- **File importers**: Drag-drop handler with ZIP/Blob support
- **Undo/redo**: `UndoPointChangeObjectInstancesProperty` for property changes
- **Project access**: `layoutView.GetProject()` returns IProject interface
- **Single-global plugins**: Persist across layouts, ideal for service integrations

**Not exposed by the SDK:**

- Event sheet read/write (no programmatic event sheet API)
- Layout structure manipulation (layers, layout properties)
- Variable/data manipulation
- Project file system access
- Direct inter-plugin communication

**Communication**: Editor-side code runs in the main browser thread with access to browser APIs (fetch, WebSocket). Runtime code uses a DOM messaging bridge (`postToDOM`/`postToDOMAsync`).

### MCP Protocol

- **Transports**: stdio (local process), Streamable HTTP, custom (including WebSocket)
- **SDK**: `@modelcontextprotocol/sdk` for Node.js/TypeScript
- **Claude Code config**: `.mcp.json` at project root or `~/.claude.json`
- **stdio** is simplest: Claude Code launches the server process, communicates via stdin/stdout
- **Tool definitions**: name, description, inputSchema (JSON Schema), handler function
- **Dynamic tools**: Servers can notify `tools/list_changed` to add/remove tools at runtime

### Existing C3 Addon Architecture (from Genvid_Datadog_RUM)

- Addon = ZIP archive (`.c3addon`) with `addon.json`, `aces.json`, editor scripts, `c3runtime/`, `lang/`
- Editor-side: `plugin.js`, `type.js`, `instance.js` (SDK.IPluginBase, etc.)
- Runtime-side: `c3runtime/` (actions.js, conditions.js, expressions.js, domSide.js)
- DOM bridge: `_postToDOM(message, data)` for runtime ↔ browser API communication
- Single-global pattern for service integrations (one instance, persists across layouts)

## Architecture

### Key Insight

Since the C3 Editor SDK doesn't expose event sheet or layout manipulation APIs, the most valuable approach is a **file-based MCP server** that wraps the existing CLI tools. A C3 Addon Bridge adds value only for live instance/property manipulation.

### File-Based MCP Server (Primary Value)

```
Claude Code  <--stdio-->  MCP Server (Node.js, local)
                              |
                              ├── reads extracted/ files
                              ├── reads eventSheets/ JSON
                              ├── applies recipes
                              └── runs generators
```

A Node.js MCP server launched via stdio that exposes the existing `bin/` tools as MCP tools. This gives Claude Code structured, queryable access to the C3 project without reading raw files.

**Tools to expose:**

| Tool | Description | Wraps |
|------|-------------|-------|
| `read-dsl` | Read DSL for an event sheet | `extracted/*.dsl.txt` |
| `read-dsl-index` | Read DSL index (JSON paths) | `extracted/*.dsl.idx.txt` |
| `read-scripts` | Read extracted TypeScript | `extracted/*.ts` |
| `read-layout` | Read layout summary | `extracted/*.layout.txt` |
| `read-domain-index` | Read domain index | `extracted/domain-index/` |
| `read-template-scope` | Read template scope | `extracted/template-scope.txt` |
| `list-event-sheets` | List all event sheets | `eventSheets/` glob |
| `list-layouts` | List all layouts | `layouts/` glob |
| `search` | Search extracted files by regex (`type`: dsl/ts/layout/md/json/idx; `path`: subdirectory or file; `context`: surrounding lines) | grep on extracted/ |
| `resolve-anchor` | Resolve DSL anchor bidirectionally (line↔SID↔name↔JSON path) | `extracted/*.dsl.idx.txt` |
| `apply-recipe` | Apply a mutation recipe | `bin/applyRecipe.ts` |
| `validate-recipe` | Dry-run validate a recipe | `bin/applyRecipe.ts --dry-run` |
| `regenerate` | Regenerate extracted files | `bin/generateAll.ts` |
| `validate-project` | Validate c3proj matches disk | `bin/syncC3Proj.ts --dry-run` |
| `sync-project` | Sync c3proj to disk | `bin/syncC3Proj.ts` |
| `search-docs` | Search C3 official docs *(not implemented — deferred)* | Web search `site:construct.net` + fetch |
| `read-addon` | Read local addon plugin source (ACEs, params) | `addons/plugin/` and `addons/effect/` |
| `scaffold-layout` | Clone a layout with remapped UIDs/SIDs | `bin/c3/layoutScaffold.ts` |
| `scaffold-sprite` | Clone an objectType with images, remapped SIDs | `bin/c3/spriteScaffold.ts` |

**Documentation and plugin tools:**

- `search-docs` — *(not implemented, deferred)* wraps web search of `construct.net` to look up C3 plugin/behavior parameters, expression syntax, and conditions/actions. Prevents incorrect parameter names (e.g., RUM `action` vs `name`). Could also query local [c3-api-reference.md](../../c3-api-reference.md) memory notes as a fast cache before hitting the web
- `read-addon` — ✅ implemented. Reads extracted addon source files in `addons/plugin/` and `addons/effect/` to look up actual parameter names, action IDs, and condition IDs from installed custom plugins

**Resources to expose:**

| Resource | Description |
|----------|-------------|
| `c3://domain-index` | Master domain index |
| `c3://domain/{name}` | Per-domain detail page |
| `c3://template-scope` | Template scope reference |

**User-Defined Ops:**

End users need the ability to register their own ops with the MCP server. This enables teams to build reusable mutation templates for common operations (e.g., "add a new screen", "wire up a button handler", "create a VOD entry point") without writing raw recipe JSON each time.

- **Ops directory**: The server watches a configurable directory (e.g., `ops/` at project root) for `.json` op files
- **Registration as tools**: Each op file is exposed as an MCP tool (e.g., `ops/add-screen.json` → `op-add-screen`). Tool description and parameters are derived from the op metadata
- **Parameterization**: Ops can declare parameters (placeholders like `{{SCREEN_NAME}}`, `{{OBJECT_TYPE}}`) that the MCP tool accepts as input and substitutes before applying
- **Listing**: A `list-ops` tool lists all registered user ops with their descriptions and parameters
- **Hot reload**: Adding/removing/modifying op files updates the available tools (via MCP `tools/list_changed` notification)

**Benefits:**

- Claude Code can query project structure without reading multiple files
- Recipes can be applied directly as tool calls (no `npm run` indirection)
- Search across DSL files with structured results
- Automatic regeneration after mutations
- No C3 editor dependency — works on project files directly
- Teams can codify common C3 patterns as reusable, parameterized ops

### C3 Addon Bridge (Optional, Additive)

```
Claude Code  <--stdio-->  MCP Server  <--WebSocket-->  C3 Addon (in browser)
```

Adds a WebSocket relay to the MCP server and a C3 editor addon that connects to it. Limited to what the SDK exposes:

**Additional tools (live editor):**

| Tool | Description | SDK API |
|------|-------------|---------|
| `list-instances` | List instances in current layout | IProject → layout → instances |
| `create-instance` | Create object instance in layout | objectType.CreateWorldInstance() |
| `set-instance-property` | Set instance property | instance.SetPropertyValue() |
| `set-instance-position` | Set instance position/size | instance.SetXY(), SetSize() |
| `get-instance-property` | Read instance property | instance.GetPropertyValue() |
| `create-object-type` | Create new object type | project.CreateObjectType() |
| `refresh-layout` | Refresh layout view | layoutView.Refresh() |

**Architecture:**

- MCP server starts a WebSocket server on a local port
- C3 addon (single-global plugin) connects via WebSocket from the editor
- Tool calls are forwarded to the addon, which executes SDK methods
- Responses are relayed back through the MCP server
- Request correlation via UUID, timeout handling, reconnection

**Addon structure:**

```
c3-mcp-bridge/
  addon.json              (single-global plugin)
  aces.json               (connect/disconnect actions, status expressions)
  plugin.js               (editor: SetIsSingleGlobal, properties for port/host)
  type.js                 (editor: type boilerplate)
  instance.js             (editor: instance boilerplate)
  c3runtime/
    plugin.js             (runtime: plugin boilerplate)
    type.js               (runtime: type boilerplate)
    instance.js           (runtime: WebSocket client, command dispatcher)
    actions.js            (runtime: connect, disconnect)
    conditions.js         (runtime: isConnected)
    expressions.js        (runtime: connectionStatus)
    domSide.js            (runtime: DOM-side WebSocket via browser API)
  lang/en-US.json
```

### C3 Editor Browser Automation (Playwright)

```
Claude Code  <--stdio-->  c3-mcp-server (Node.js)
                              ├── File tools (read DSL, apply recipes, etc.)
                              └── Editor tools (uses playwright library internally)
                                    ├── manages a persistent browser session
                                    ├── c3-editor-save
                                    ├── c3-editor-preview
                                    ├── c3-editor-read-errors
                                    └── c3-editor-dismiss-dialog
```

Uses `playwright` as a **Node.js library** within the same c3-mcp-server process — not a separate MCP server. The Playwright MCP (`@playwright/mcp`) is installed separately for **exploration only** (manually discovering C3 editor DOM selectors). Once selectors are known, the wrapper tools call Playwright's API directly.

**Exploration workflow:**

1. Install `@playwright/mcp` in `.mcp.json` (done)
2. Use raw Playwright MCP tools (`browser_navigate`, `browser_snapshot`, `browser_click`) to explore C3 editor DOM
3. Document reliable selectors for each operation
4. Encode those selectors into stable wrapper tools in c3-mcp-server

**Tools to expose:**

| Tool | Description | Browser Action |
| ---- | ----------- | -------------- |
| `editor-save` | Save the open project | Menu → Project → Save (or Ctrl+S) |
| `editor-preview` | Start/stop project preview | Click Preview button (or F5-equivalent) |
| `editor-read-errors` | Read any open error/warning dialogs | Snapshot dialog DOM, extract text |
| `editor-dismiss-dialog` | Click OK/Cancel on a dialog | Find dialog button, click |
| `editor-open-project` | Open a cloud project by name | Navigate to editor, open from cloud |
| `editor-snapshot` | Read current editor state | Accessibility tree snapshot of key UI areas |

**Considerations:**

- **Authentication**: C3 editor requires login. Use a persistent browser profile (`--user-data-dir`) so the session stays logged in across tool calls
- **DOM stability**: C3's menu/dialog DOM may change across editor versions. Selectors should be documented and easy to update
- **Canvas limitations**: Layout editor viewport is canvas-rendered — not automatable via DOM. But menus, dialogs, toolbar, and project bar are regular DOM
- **Native file dialogs**: "Open local project" triggers OS file picker (not automatable). Use cloud save or drag-and-drop workarounds
- **Session lifecycle**: The browser instance is long-lived — launched on first editor tool call, reused across subsequent calls, closed when the MCP server exits

**Why not a separate MCP?** One MCP server = one process lifecycle, one `.mcp.json` entry, unified `*` namespace. File tools and editor tools often work together (e.g., apply recipe → save in editor → preview → check errors). A single server can coordinate this without cross-MCP communication (which MCP doesn't support).

### Advanced Integration (Future)

- **Bidirectional sync**: C3 editor changes push notifications to MCP server
- **Live preview**: MCP server triggers C3 preview builds
- **Collaborative editing**: Multiple Claude Code sessions share C3 state
- **Internal API exploration**: Investigate undocumented C3 editor internals beyond SDK

## Next Up

All gaps represent direct client needs (agents falling back to filesystem tools or manual workarounds). Equal priority — order by session readiness, not importance.

- ~~**`include` shorthand on `insert-event` ops**~~ — ✅ Already implemented.
- ~~**Filesystem Independence**~~ — ✅ Done in Session 17. `search` tool (replaces `search-dsl`, adds `type`/`path`/`context` params), read tool `offset`/`limit` pagination on all 7 read tools, `resolve-anchor` tool (bidirectional DSL anchor lookup). See [requirements](filesystem-independence-requirements.md), [design](filesystem-independence-design.md), [plan](filesystem-independence-plan.md).
- ~~**DSL Anchor Resolution**~~ — ✅ Done in Session 17 as `resolve-anchor` tool. Bidirectional lookup between DSL line numbers, SIDs, names, and JSON paths. Included in Filesystem Independence (Phase 2).
- ~~**Recipe Validator Improvements**~~ — ✅ Done across Sessions 12, 16, 18. Unknown field rejection (S12), `add-include` + path-based warning (S12), `include` in create mode docs (S12), `PARAM_TYPE_RULES` for 7 action/condition IDs (S16, S18), `callFunction` params-as-object warning (S18).
- ~~**Structural Refactoring Tools: `wrap-in-group`**~~ — ✅ Done in Session 18. Wraps events by SID into a new group node. See [recipe-reference.md § wrap-in-group](../../docs/recipe-reference.md#wrap-in-group).
- **Structural Refactoring Tools: `move-variable`** — Move variables between global/local scope. See [Future: EventSheet Structural Refactoring Tools](#future-eventsheet-structural-refactoring-tools).

Not blocking current workflows:

- C3 Editor Browser Automation (Playwright)
- `extracted/` directory transition

## Design Decisions

- **stdio transport over HTTP** — Claude Code launches the server as a subprocess. Simplest setup, no port management, automatic lifecycle
- **File-based first** — The SDK limitation makes file-based tools the primary value. The C3 Addon Bridge is additive, not essential
- **Wrap existing tools** — Don't duplicate logic. The MCP server calls the same functions as `bin/` CLI tools
- **Start in-repo, extract later** — Start as `bin/mcp/` with direct imports from `bin/c3/` tools. The MCP server is a thin wrapper over existing functions, so in-repo avoids duplication. When the tool surface stabilizes, extract to a standalone package that takes the project root as a parameter. The key boundary: MCP server code should call exported functions from `bin/c3/` (generators, recipe interpreter, etc.) rather than importing internal helpers — this makes future extraction a matter of packaging, not refactoring
- **C3 Addon Bridge deferred** — Will be reconsidered after File-Based MCP Server usage reveals the limitations of the file-based approach
- **Browser automation in same MCP server** — Playwright is used as a Node.js library inside c3-mcp-server, not as a separate MCP. One process, one config entry, unified `*` namespace. The standalone `@playwright/mcp` package is for exploration only (discovering DOM selectors)
- **Persistent browser profile** — Editor tools use `--user-data-dir` to maintain login state across tool calls. Browser launched lazily on first editor tool call, reused for the session
- **Logger interface for output capture** — MCP stdio transport uses stdout for JSON-RPC; any `console.log` from called functions corrupts the protocol. Solution: `export type Logger = (...args: unknown[]) => void` defined in `generators.ts`, threaded through all output-producing functions. CLI entry points default to `console.log`; MCP handlers pass a line-accumulating closure `(...args) => lines.push(args.map(String).join(" "))` and return captured lines as tool text. No monkey-patching.
- **ReadWriteLock for concurrency safety** — MCP SDK (JSON-RPC) dispatches handlers concurrently; without a lock, two write handlers could interleave at any `await` and corrupt files. `ReadWriteLock` in `bin/mcp/rwlock.ts`: shared read lock (multiple concurrent reads allowed), exclusive write lock (blocks all reads and other writes). Write-preferring: new reads queue behind pending writes to prevent write starvation. Promise-based, no dependencies.
- **Terraform-like plan/apply (txId)** — A monotonic `txId: number` counter (module-level, resets on restart) tracks source file writes. Validate tools (dry-run) return the current txId; apply tools accept an optional `txId` and reject with a clear error if the current value doesn't match ("State changed: expected 42, got 43"). Prevents TOCTOU between validate and apply in multi-agent or user-concurrent scenarios. `txId` check and increment are atomic inside `rwlock.write()`.
- **extractedDirty flag** — `extractedDirty: boolean` tracks whether `extracted/` is stale relative to source. Set `true` when source files change (watcher event or MCP write without regeneration). Set `false` when `regenerate` or `apply-recipe` with `regenerate: true` completes. Read tools that serve from `extracted/` append a staleness warning when dirty; they don't block or auto-regenerate (agent decides). `get-state` returns `{ txId, extractedDirty }` for cheap polling.
- **File system watcher + self-write suppression** — `fs.watch()` on source directories (`eventSheets/`, `layouts/`, `objectTypes/`, `families/`, `scripts/`) detects external changes (C3 editor saves, user edits) and increments `txId` + sets `extractedDirty`. To prevent double-counting our own MCP writes: write tools register each file path in `expectedChanges: Set<string>` before writing; the watcher skips the increment if the path is in the set and removes it. Stale entries cleaned in `finally` blocks. `project.c3proj` watched for `txId` only (does not affect `extracted/` content). `fs.watch` recursive on Windows requires Node.js 22+; fall back to per-directory watches or `chokidar` if needed.

## Recipe Gaps Discovered

Gaps found during story-battle-menu initiative (Session 13):

~~**`variable` builder ignores `isStatic` and `initialValue`**~~ — ✅ Fixed (Session 15). `buildVariable` and `VariableShorthand` now accept `initialValue`/`isStatic`/`isConstant` as aliases for `value`/`static`/`constant`. Error if both forms provided simultaneously.
- ~~**`function-block` builder can't put actions directly on the function**~~ — **Corrected**: `FunctionBlockShorthand` already has `actions?: BuilderAction[]` (recipeInterpreter.ts:383). Use `"actions": [...]` on the function-block shorthand directly. Gotcha #48 updated in docs.
- ~~**`read-dsl-index` output too large for inline viewing**~~ — ✅ Fixed (Session 15). `read-dsl-index` now accepts an optional `grep` parameter that filters index entries by regex before returning. `filterIndex()` in `dslFormatter.ts` preserves headers and filters data rows.

Gaps found during story-battle-menu initiative (Session 11a):

- ~~**Add/modify function-block parameters**~~ — ✅ Implemented (`patch-function-block` op). Targets function-block or custom-ace-block by SID or path. `addParam` appends a new parameter (name, type, initialValue) with generated SID. `removeParam` removes a parameter by name.

Resolved gaps from Session 11a:

- ~~**`$symbol` refs for same-recipe inserts**~~ — **Not a bug.** `$symbol` refs DO work for same-recipe inserts (via `id: "$name"` on `insert-event`). The original report was incorrect — the symbol table is populated dynamically during execution, not pre-built. Pre-existing events are NOT in the symbol table; use `"in": "sid:X"` for those. Gotcha #43 corrected.
- ~~**`matchAction: { callFunction }` for `patch-action-param`**~~ — **Not a bug.** `matchAction` is a string field, not an object. Passing `matchAction: "myFunc"` works correctly for FunctionCallAction (tested). The original report used object syntax `{ callFunction: "name" }` which fails because it's the wrong type. Gotcha #45 corrected.

Gaps found during episode-list-battle initiative:

- **`patch-action-param`** — ✅ Implemented. Updates C3 action parameter values by path + actionIndex or matchAction. Supports single param (`param` + `value`) or multi-param (`params` object). See [recipe-reference.md](../../docs/recipe-reference.md).
- **`custom-ace-block` builder shorthand** — ✅ Implemented (`be8189175`). Supports `aceType`, `aceName`, `objectClass` alongside standard function-block fields. See [recipe-reference.md](../../docs/recipe-reference.md).
- **`add-inst-vars` recipe operation** — ✅ Implemented (`8a5b0b069`). Recipe-level `addInstVars` section adds instVars to objectType JSON + all layout instances + `instanceTypes.d.ts`. Pure functions in `bin/c3/instVarMutator.ts`.
- **Sprite cloning in recipes** — ✅ Exposed via MCP. `scaffold-sprite` wraps `cloneSprite` from `bin/c3/spriteScaffold.ts` (copies objectType JSON, animation frames, images, remaps SIDs/imageSpriteIds) and `scaffold-layout` wraps `cloneLayout` from `bin/c3/layoutScaffold.ts` (remaps UIDs/SIDs). Not integrated into the recipe system itself, but accessible as standalone MCP tools alongside recipes.

Gaps found during fix-goal-layout initiative (2026-05-04):

- **`copyInstance` + `templatize` not exposed as a recipe op or MCP tool** — Fixing the IconContainerWithAmount bug (cross-layout `create-hierarchy: true` with empty `template-name` picked up Level1Layout's cross-layer instance after a project-tree reorder) required adding a same-layer master template for `IconContainerWithAmount` to `UI_ComponentsLayout`. The proper API combo already exists in `layoutMutator.ts`: `copyInstance({ sourceLayout: ShopLayout, targetLayout: UI_ComponentsLayout, instanceType: "IconContainerWithAmount", includeChildren: true, targetLayer: "Layer 0", childrenLayer: "Layer 0", sidGenerator: () => generateUniqueSid() })` followed by `templatize(UI_ComponentsLayout, "IconContainerWithAmount", "IconContainerWithAmount")`. `copyInstance` even takes a `childrenLayer` separate from the source's, which is exactly the fix the cross-layer case needed. **The gap**: neither operation is reachable from a recipe (`recipeInterpreter.ts` has no `copy-instance` / `templatize` op) or from the MCP server (`apply-recipe` only handles event-sheet ops). So c3-implementer fell back to hand-editing ~355 lines of JSON. **Knock-on bug**: hand-editing bypassed `generateUniqueSid()` from `sidUtils.ts`, producing 18-digit SIDs that exceeded `Number.MAX_SAFE_INTEGER` and made C3 reject the file with "invalid SID" — a follow-up commit (`5565d230c`) had to swap them. **Proposed fix**: add `copy-instance` and `templatize` (and likely `replicify`, `add-replica`, `move-instance`) recipe ops in `recipeInterpreter.ts`, wired to the existing `layoutMutator` functions with `generateUniqueSid()` plumbed in. Verify whether `templatize` alone produces a working template or whether `scene-graphs-folder-root.items` also needs the new sid appended (the hand-edit added it; the API does not). Until exposed, every layout-instance change goes through hand-editing, with the SID-overflow risk that implies.

## Recipe Bugs Discovered

- **`remove-action` wrong index** — ✅ Fixed via SID-based addressing (`in: "sid:X"`). Events are now identified by SID, not position — preceding removals can't shift the index. Root cause: design bug — see Recipe Addressing Redesign below
- **autoAdjust multi-op-type misplacement** — ✅ Fixed via SID-based addressing. `autoAdjust` is now deprecated (emits a warning, no-ops). SID refs are immune to array position shifts. Root cause: design bug — see Recipe Addressing Redesign below
- **`sid: 0` is not safe anywhere in recipe-generated C3 JSON** — ✅ Fixed. Replaced all `sid: 0` placeholders across `eventSheetMutator.ts`, `instVarMutator.ts`, `recipeInterpreter.ts`, and `applyRecipe.ts` with `generateUniqueSid()` from a new `bin/c3/sidUtils.ts` module. A persistent `extracted/sid-registry.txt` (generated by `npm run generate-c3`) seeds the SID context on each recipe run, ensuring new SIDs are unique across the project. All builders now emit valid non-zero unique SIDs.
- **`insert-actions` action shorthand silently drops unknown keys (`objectClass` vs `object`)** — ✅ Fixed (2026-05-27). Did both (b) and (c): `expandAction`/`expandCondition` now accept `objectClass` as an alias for `object` (preferring `object` when both are present), and `validateRecipe` rejects genuinely-unknown keys on action/condition shorthands via new `ACTION_SHORTHAND_SCHEMAS`/`CONDITION_SHORTHAND_SCHEMAS` (folded into `validateActionParams`/`validateConditionParams`, which run at all 6 action/condition call sites). As a backstop, `expandAction`/`expandCondition` now throw on an `id`/`custom-action` shorthand with no resolvable object class instead of silently emitting `[unknown action]`. _Original report:_ The action shorthand expects `"object"` to name the target object class, but the on-disk eventSheet JSON stores the same field as `"objectClass"`. An author who reads the JSON, infers the field name, and writes `{ "id": "destroy", "objectClass": "IconContainerWithAmount" }` in a recipe gets a silent failure: `validate-recipe` passes, the recipe applies cleanly, and the resulting DSL shows `[unknown action: id, sid]` with no `object`/`objectClass` set. Reproduced with the `BuildAchievementsList` `IconContainerWithAmount.destroy()` insert — first apply produced `[unknown action: id, sid]`, second apply (with `"object"` instead) produced the correct `IconContainerWithAmount.destroy()`. **Proposed fix** (pick one): (a) `validateRecipe` rejects unknown keys on action-shorthand entries, (b) accept `objectClass` as an alias and normalize at parse time, or (c) both. Same risk likely exists for other shorthand fields where the on-disk name differs from the recipe-input name — worth auditing the action/condition shorthand schema for the full set of mismatches.
- **DSL extractor hides `disabled: true` state on conditions** — ✅ Fixed (2026-05-28). Added `formatConditionWithDisabled()` helper in `dslFormatter.ts` that prepends `[DISABLED] ` when a condition has runtime `disabled === true`, mirroring the existing action prefix from c3source's `formatAction`. Wired into the `when:` condition loop in `formatBlockLike` and the `// Context:` comment in `generators.ts`. Disabled blocks/groups/actions were already marked (`[DISABLED]` flag / prefix) — only conditions were missing because the c3source `Condition` type doesn't declare `disabled` and `formatCondition` only handled `isInverted`. 3 new tests in `dslFormatter.test.ts` cover the bare, `NOT`-combined, and enabled-regression cases. _Original report:_ Found 2026-05-08 reviewing the `inline-event-asset-frames` branch. The DSL output rendered disabled nodes (`"disabled": true` in source JSON) identically to enabled ones — no `[disabled]` marker, no comment wrapper, no prefix. Concrete impact: a reviewer flagged the deletion of two `NOT compare-boolean-eventvar(hasCheckedTitleNewsPopupOnBattleLayout)` conditions (sids `969513000111828`, `414452253306203` in `SubLayoutsNavbarEvents.json`) as a behavioral guard removal that needed user attention; the conditions had been disabled in the parent revision, so the edit was pure JSON cleanup with no behavioral effect. The DSL diff couldn't disambiguate "live behavior removed" from "already-dead JSON pruned". Same gap meant re-enabling a node (removing `"disabled": true`) was invisible in DSL diffs.
- **`insert-actions` builder omits `objectClass: "System"` for `wait-for-previous-actions`** — ✅ Fixed (2026-05-27). Added `SYSTEM_ACTION_IDS` (`wait`, `wait-for-previous-actions`, `wait-for-signal`, `signal`) in `recipeInterpreter.ts`; `expandAction` auto-defaults `objectClass: "System"` for those object-less System action ids, and `validateRecipe` exempts them from the new missing-object check. The set is kept deliberately small so the default never masks a real missing-object error. _Original report:_ The c3-implementer used a recipe to add `wait-for-previous-actions` after `callFunction sendEndGameData` in `ModalEvents.json`. The recipe builder emitted the action without `objectClass: "System"`, which made the DSL render the action as `[unknown action: id, sid]`. The c3-implementer had to hand-patch the JSON to add the missing field, then regenerate. Same flavor as the `objectClass` vs `object` silent-drop bug above — the action-shorthand schema for well-known System actions (`wait-for-previous-actions`, `wait`, `signal`, etc.) should default `objectClass: "System"` automatically. **Proposed fix**: audit the action-shorthand schema in `construct3-chef` for the standard System actions and have the builder auto-emit `objectClass: "System"` for them (or accept it as a shorthand alias). Until fixed, recipe authors adding System actions via shorthand should explicitly include `objectClass: "System"` in the shorthand entry and verify the DSL output after regeneration.
- **`validate-recipe` accepts condition SIDs as `in:` targets that `apply-recipe` rejects** — ✅ Fixed (2026-05-28). Root cause was deeper than the title: the `dryRun: true` branch of `applyRecipeInner` (`src/c3/recipeApplier.ts`) only logged per-op summaries and never ran the actual mutators against in-memory state, so SID kind mismatches plus every other apply-time error (missing layer, missing instance type, …) sailed through validation. Fix: dry-run now executes each section against clones — files via a new `executeFileOpsWithHints` wrapper (used by both dry-run and apply so the hint surfaces in both surfaces), layouts via a new `applyLayoutOp` dispatch helper called with a no-op logger. The wrapper delivers the bug report's "bonus": when `executeFileOps` throws `SID N not found in event sheet` (or the kind-mismatch `target … does not support actions`), it scans the sheet for that SID and, if it lives on a condition / action / function-block parameter slot, rethrows with `Hint: SID N exists on a condition, not on an event. … walk up to the enclosing block.sid`. The dry-run section order now also matches the apply order (objectTypes → addInstVars → layouts → files) so cross-section dependencies surface consistently. Other gaps closed in the same PR via code-review follow-ups: `processAddInstVars` is `pendingObjectTypes`-aware so a recipe that creates X via `objectTypes` + adds inst vars to X in the same recipe validates cleanly; the dry-run layouts pass populates a shared layout cache so cross-layout `copy-instance from: A` sees A's in-recipe mutations; both paths defensively clone the ops array so `executeFileOps`'s in-place `remove-event` normalization doesn't surprise the caller; `autoAdjust` is threaded into the dry-run executeFileOps call so the deprecation warning fires there too; preview output preserves recipe insertion order; `Math.max(...allUids)` replaced with a for-loop max to avoid the V8 spread-limit cliff. 19 tests in `test/c3/dryRunValidation.test.ts` cover condition / action / function-parameter SIDs (with hint text), kind-mismatch hint, apply-path hint parity, unknown SIDs, valid-block regression, layout-mutator errors, no-writes during dry-run, preview script diffs, no caller-recipe mutation, file-create dry-run, plugin-SKIP fast-path, pending-objectType addInstVars, and the cross-layout dry-run cache. _Original report:_ Found 2026-05-15 during `fix-daily-logins-bad-display`. SID-based `in:` addressing for ops like `patch-action-param` expects an **event block** SID, but `validate-recipe` performs no existence/kind check on the resolved SID — only `apply-recipe` surfaces the mismatch (`SID not found in event sheet`). The trap: when a for-each block contains a condition with its own SID, `read-dsl-index`-style searches surface the condition SID more prominently than the enclosing block SID, so an agent that grabs "the SID near the for-each" often grabs the condition SID. The recipe drafted with that SID passes `validate-recipe` (txId increments, no warnings) and only fails on apply — costing a second authoring iteration. Reproduced in the original branch: condition `for-each` SID `814990094992272` accepted by validator, rejected on apply; enclosing block SID `848814785436182` was the correct target.
- **`generateUniqueSid()` is not exposed via the construct3-chef package's `exports` field** — ✅ Fixed (2026-05-28). Two-PR resolution. **PR 1** added the `./sid-utils` subpath to `package.json` `exports` / `publishConfig.exports` (covering `mintUniqueSid`, `readRegistryFile`, `collectSids`, plus the legacy `init*`/`reset*`/`generateUniqueSid` lifecycle), the `generate-sids` MCP tool (`NON_IDEMPOTENT_READ` annotation, read lock, `extraUsedSids` parameter, `checkRegistryFreshness` mtime check), and two related correctness fixes: `generateSidRegistry` now scans `layouts/` in addition to `eventSheets/` and `objectTypes/` (was missing layer/instance SIDs), and the legacy `'npm run generate-c3'` hint became `'construct3-chef generate --only sid-registry'`. **PR 2** removed the `_usedSids` singleton entirely — added `SidGenerator` type + `freshSidGen()` helper, threaded `sidGen: SidGenerator` through every builder (`buildBlock`/`buildAction`/etc. in `eventSheetMutator.ts`), the `addInstVarsToObjectType` mutator, the recipe interpreter (`expandAction`/`expandCondition`/`expandEvent`/`executeOp`/`executeFileOps`/`createSheet`/`executeRecipe`), and the recipe applier (`createObjectType`/`applyNonworldInstance`/`processAddInstVars`/`applyRecipeInner`/`applyParsed`). Deleted `initSidContext`/`initSidContextFromSet`/`resetSidContext`/`_usedSids`/stateful `generateUniqueSid` from `sidUtils.ts`. Also consolidated `layoutScaffold.generateUniqueSid` (which had range `[0, 1e15)` — could return SID 0, documented as unsafe — and an unbounded retry loop) onto the threaded `sidGen` using `mintUniqueSid` semantics (`[1e14, 1e15)`, capped at 100 attempts). Subpath surface is now four stateless symbols: `collectSids`, `freshSidGen`, `mintUniqueSid`, `readRegistryFile`. The original `loadSidContext` reference in this entry was a misremembering — the disk-loading entry point is `readRegistryFile(registryPath)`. _Original report:_ Discovered 2026-05-21 during `debug-loadouts` work. See [sid-singleton-removal-plan.md](sid-singleton-removal-plan.md) for the PR 2 plan. Three separate subagent dispatches (move handlers, add ParsingKey instVar, restructure parse-success signaling) each needed fresh 15-digit SIDs and each had to re-implement the `generateUniqueSid()` algorithm inline (write a temp Node script that re-encodes the `[1e14, 1e15)` random-with-uniqueness-check logic). The implementation lives in `bin/c3/sidUtils.ts` in the consumer repo and equivalent `dist/c3/sidUtils.js` in the construct3-chef package, but neither is reachable from a programmatic `import`. Each round trip costs ~30 seconds of script-writing and risks the inline implementation drifting from canonical behavior (e.g., the registry-collision check order). **Proposed fix**: expose `generateUniqueSid` (and the related `loadSidContext` helper for the registry-seed pattern) through the construct3-chef package's `exports` field — e.g. `"./sid-utils": "./dist/c3/sidUtils.js"`. Subagent code can then `import { generateUniqueSid } from "construct3-chef/sid-utils"` without re-implementing or writing tmpfiles. Cross-repo benefit: any consumer of construct3-chef (other game projects, tooling) gets the canonical helper for free. Until fixed, the c3-implementer agent's gotcha #18 documents the inline-import pattern.

## Recipe Addressing Redesign (✅ Implemented)

The `remove-action` and `autoAdjust` bugs were symptoms of a **design-level flaw**: the recipe system used position-based addressing (`events[N]`, `actionIndex`) which became stale the moment any preceding operation mutated the array. `autoAdjust` attempted to compensate via offset arithmetic, but only worked for homogeneous operation types and silently broke for mixed types.

### Root Cause

The recipe system conflated two models:

- **What the author sees (declarative)**: "Make these changes to this event sheet"
- **What the system does (imperative)**: Apply op1 → mutate array → adjust indices → apply op2 → ...

`autoAdjust` was a leaky bridge between them. `sortRemoveEventOps` (which pre-sorted consecutive removes to prevent index-shift bugs) was a local patch for the same problem class. `matchScript`/`matchAction` content-based targeting were partial escapes from position-based addressing — pointing in the right direction.

### Implemented Fix: SID-based addressing

Replace position-based paths with SID-based addressing for existing elements, and symbolic names for elements created within the same recipe:

**Existing elements** — address by SID instead of `events[N]`:

```json
{ "insert-actions": { "in": "sid:100234567890123", "actions": [...] } }
```

**New elements** — assign a symbolic name at creation, reference it later:

```json
{ "insert-event": { "id": "$loginBlock", "after": "sid:100234567890456", "block": { ... } } }
{ "insert-actions": { "in": "$loginBlock", "actions": [...] } }
```

The interpreter maintains a symbol table during recipe execution. `autoAdjust` is now deprecated and no-ops with a warning. `sortRemoveEventOps` was removed. See [recipe-reference.md § SID-Based Addressing](../../docs/recipe-reference.md#sid-based-addressing).

### SID Churn Constraint

C3 reassigns SIDs when structural changes happen in the editor (adding a parent group, adding/removing a condition on the parent, etc.). This means:

- SIDs are **session-stable** (valid for a recipe applied to the current JSON), not long-term stable
- SIDs must **not** appear in committed `.dsl.txt` files — they would create noisy diffs identical to the eventSheet JSON churn the DSL was designed to avoid
- The committed DSL stays clean; SIDs are surfaced on-demand for recipe authoring

### What SIDs to expose

Not all elements need SID exposure in recipes. The scope:

| Element | SID addressing | Notes |
| ------- | -------------- | ----- |
| Events (block, function, group, custom-ace, variable) | Yes | Primary targeting level |
| Conditions within a block | Yes | Direct condition targeting |
| Actions within a block | Yes | Direct action targeting |
| Function/ACE parameter **definitions** | Yes | Bug source — must be unique |
| Function call **arguments** | No | Expressions, not SID-bearing objects in C3 |

### DSL index: SID column added

`.dsl.idx.txt` now includes a `§XXXXXXXXXXXXXXX` SID column between JSON Path and DSL Line. Authors copy the SID from this column and write `"in": "sid:X"` in recipes. The idx remains committed (still useful for position-based JSON paths and human descriptions). The long-term direction (on-demand generation) is still possible but deferred.

Original direction (for reference):

- **Not committed** — generated on demand from current JSON (always reflects current SIDs after C3 editor edits)
- **Gains SID column** — two-way lookup: path ↔ SID ↔ human-readable description
- **Used internally** — recipe interpreter builds the same structure in memory for fast SID→path resolution during execution

Example format:

```text
events[0]                §100234567890123  block
events[0].conditions[0]  §100234567890124  on-start-of-layout
events[0].actions[0]     §100234567890125  call myFunc
events[2]                §100234567890456  function "myLoader"
events[2].params[0]      §100234567890457  p1: string
```

### Agent authoring workflow

1. `read-dsl SheetName` — read clean DSL to understand the event sheet
2. `read-dsl-index SheetName` — read on-demand idx with SIDs to get targeting coordinates
3. Write recipe using `sid:XXXXXXXXXXXXXXX` paths and `$symbol` references for new elements

Named elements (functions, ACEs, groups) can be addressed by name directly — no idx lookup needed for those.

## Known Bugs (Resolved)

### ~~Bug: `insert-event` with SID-based `after` appends to end instead of inserting after target~~

**Status:** Fixed in `95228dbf5`. The `after` SID is now resolved within the container's children array, and `.indexOf()` finds the correct insertion position. Tests cover happy path, error case (after ref not in container), and numeric `after` backward compatibility.

### ~~Bug: `validateRecipe` accepts bare file names that `apply-recipe` rejects~~

**Status:** Superseded by path normalization. Originally fixed in `0d2a64aa5` to reject bare names; now `normalizeRecipePaths()` accepts and auto-expands them instead.

### Normalize path conventions across MCP tools and recipes

MCP read tools take bare relative paths without prefix or extension (e.g., `Goals/GoalsEvents`), but recipe `files` keys required full relative paths with prefix and extension (`eventSheets/Goals/GoalsEvents.json`). The `eventSheets/` prefix is redundant — the `files` section only targets eventSheets, just like `layouts` only targets layouts.

**Status:** Implemented. `normalizeRecipePaths()` in `recipeInterpreter.ts` expands bare keys automatically at the start of `validateRecipe()` and `applyParsed()`. Both bare (`"Goals/GoalsEvents"`) and full (`"eventSheets/Goals/GoalsEvents.json"`) paths are accepted. Layout keys and `copy-instance`/`add-replica` `from` fields are also normalized.

## Open Questions

1. ~~**Tool granularity** — Should `read-dsl` take a sheet name and return content, or should it list available sheets? Both?~~ Resolved: separate list + read tools (e.g., `list-event-sheets` + `read-dsl`)
2. **Recipe authoring assistance** — ~~Should the MCP server expose recipe-building helpers, or is the current approach (Claude Code writes recipe JSON) sufficient?~~ Resolved: the server will support user-defined parameterized ops in an `ops/` directory, exposed as individual MCP tools. Claude Code can still write raw recipe JSON for one-off mutations, but reusable patterns should be saved as named ops
3. **Performance** — Should the MCP server cache extracted files in memory, or read from disk on each tool call? Disk is simpler and always fresh

## Future: `extracted/` Directory Transition

Once the MCP server is working, `extracted/` can transition from committed-and-validated to generated-on-demand:

1. **MCP server generates in-memory** — DSL, scripts, layouts, domain index produced on the fly by calling `bin/c3/` generator functions directly, no disk writes needed for MCP tool responses
2. **CI generates into temp dir** — `typecheck:extracted` and validation run against freshly generated output, not committed files
3. **Optional disk generation** — `npm run generate-c3` still writes to `extracted/` for developers who want files on disk (PR diffs, IDE search), but it's opt-in rather than required
4. **Gitignore `extracted/`** — remove from version control, eliminating commit noise and regeneration friction

The key architectural change: MCP tools call generator functions in-process and return results directly, rather than reading pre-generated files from disk. This makes the `extracted/` directory a convenience output, not a dependency.

## ~~Future: `domain-config.json` Managed by MCP~~ (✅ Implemented — Sessions 6, 19)

Full domain-config management through MCP:
- **S6:** `list-uncategorized`, `list-stale-overrides` (read-only analysis)
- **S19:** `read-domain-config` (formatted view with section filter), `set-overrides` (add/update with validation), `remove-overrides` (remove by key). Library: `formatDomainConfig`, `collectValidDomainNames`, `validateOverrideKeys`, `validateOverrideValues`. 10 validation tests.

Domain/subdomain structure mutations (add/remove domains, change directory mappings) remain hand-edit — they're rare and low-friction. The override CRUD covers the actual workflow need.

## Future: Layout Mutation Enhancements

Two layout recipe gaps surfaced during the story-battle-menu initiative. Both have workarounds but add friction to recipe-driven layout work.

### ~~Remove Layer (`remove-layer`)~~ (✅ Implemented — Session 13)

Implemented as `remove-layer` layout recipe op. Removes empty layers with strict validation (fails if instances or sublayers exist).

### ~~Remove Instance by Layer (`remove-instance` layer filter)~~ (✅ Implemented — Session 13)

Added optional `layer` param to `remove-instance` layout op. When specified, only removes instances on that layer (and its sublayers).

### ~~List Include Tree (`list-include-tree`)~~ (✅ Implemented — Session 16)

Implemented as `list-include-tree` MCP tool (22nd tool). Library in `bin/c3/includeTree.ts`. Supports transitive include resolution with deduplication, optional function listing, and flat mode. 16 tests.

## ~~Future: Mid-Session SID Discovery~~ (✅ Implemented — Session 19)

Implemented as `read-event-sids` MCP tool (24th tool). Reads source eventSheet JSON directly, returns pipe-delimited SID map. No regeneration needed. Supports grep filter. Library function `buildShallowSidMap` in `dslFormatter.ts`.

### Gap: `grep` filter only matches event descriptions

The `grep` parameter filters against the `description` column (comment text, function names), but not action content (function call targets, parameter values, object classes). When looking for the SID of a block that calls `GoToLayout("BattleLayout")` or has a condition on `end-game-continue`, the grep returns no matches — forcing fallback to raw `Grep` on the JSON file and manual SID extraction.

**Proposal:** Expand `grep` matching to include a serialized summary of conditions and actions (e.g., function call names, parameter values, object classes). This would let `grep=GoToLayout` or `grep=end-game-continue` find the relevant blocks. The `buildShallowSidMap` description builder in `dslFormatter.ts` would need to incorporate action/condition summaries.

**Observed in:** Story battle menu session — needed SID of the `else` block calling `GoToLayout("BattleLayout")` in ModalEvents. `grep=BattleLayout`, `grep=else`, `grep=end-game-continue` all returned nothing.

## Future: Recipe Validator Improvements

### ~~Reject unknown fields on typed ops~~ (✅ Implemented — Session 12)

Implemented via `OP_FIELD_SCHEMAS` in `recipeInterpreter.ts`. All 16+ ops have required/optional field schemas with misspelling suggestions (e.g., `old`/`new` → `find`/`replace`, `actions` → `action`).

### ~~Validate C3 parameter value types~~ (✅ Implemented — Sessions 16, 18)

`PARAM_TYPE_RULES` registry validates 8 action/condition IDs across S16 and S18: `compare-two-values`, `set-layer-visible`/`layer-is-visible`/`set-layer-interactive`/`is-on-layer`, `set-animation`, `on-touched-object` (S18), plus `callFunction` params-as-object warning (S18). `call` shorthand auto-stringifies numeric params (fixes gotcha #39).

### ~~Warn on `add-include` + path-based targeting in same recipe~~ (✅ Implemented — Session 12)

Implemented in `validateRecipe()`. Detects recipes containing `add-include` AND path-based `path`/`after` references, emits warning about index shift risk.

### ~~Document `include` in create mode events array~~ (✅ Implemented — Session 12)

Added `{ "include": "SheetName" }` to Builder Shorthands § Events section in recipe-reference.md.

## ~~Future: Staleness Detection Improvements~~ (✅ Implemented — Session 19)

Implemented via `checkSourceFreshness()` in `server.ts`. Compares source file mtime against extracted file mtime on 5 read handlers (`read-dsl`, `read-dsl-index`, `read-scripts`, `resolve-anchor`, `read-layout`). Sets `extractedDirty` + increments `txId` when source is newer, regardless of how the change happened (git checkout, editor save, manual edit).

## ~~Future: SID ↔ Line Number Lookup Tools~~ → DSL Anchor Resolution (Planned — Session 17)

Reframed from narrow "SID ↔ line number lookup" to broader **DSL Anchor Resolution** — bidirectional lookup between all DSL anchor systems (line numbers, SIDs, function/group names, JSON paths). Designed as a single `resolve-anchor(sheet, by, value)` tool with `by: "line" | "sid" | "name"`. Included in Filesystem Independence Phase 2. See [design](filesystem-independence-design.md) and [plan](filesystem-independence-plan.md).

## Future: Global Layer Override Extraction

**Problem:** C3 layouts can contain "global" layers that are defined in one layout and overridden in others. When a global layer is overridden, the overriding layout's JSON contains a layer entry with the same name but potentially different instance properties (effects, positions, visibility). Currently there is no extracted file that lists which layers are global, where they originate, and which layouts override them — similar to how `template-scope.txt` lists template origins and `containers.txt` lists container relationships.

This makes it difficult to know where to add instance-level overrides (e.g., adding a Grayscale effect to a `HeroSelected` instance that lives on a global layer shared between HeroLayout and HeroSelectLayout). You have to manually search layout JSON files to find which layout defines the global layer and which layouts override it.

**Proposed tool/extraction:** Add a `global-layers.txt` (or similar) extracted file that lists:

- Each global layer name
- The originating layout (where `isGlobal: true`)
- All layouts that override it (where the layer appears with matching name)
- Instance counts per override

Optionally, add a `list-global-layers` MCP tool that returns this information on demand without requiring extraction.

**Observed in:** Story battle menu — needed to add Grayscale effect instance override to `HeroSelected` on `HeroSelectLayout`, but the `HeroSelected` layer is a global layer overridden from `HeroLayout`. Finding the correct override location required manual JSON inspection.

## Future: EventSheet Structural Refactoring Tools

Two recurring refactoring patterns currently require hand-editing eventSheet JSON or complex recipes. Dedicated recipe operations or MCP tools would be safer and faster.

### Wrap Events in Group (`wrap-in-group`)

**Problem:** When an eventSheet grows, a flat list of blocks/variables needs to be wrapped in a new group or subgroup for organization. This is the canonical structure convention (includes → variables → main group), but restructuring after the fact requires moving JSON nodes, generating a new group SID, and adjusting indentation.

**Proposed tool:** A recipe operation or MCP tool that takes a target eventSheet, a range of events (by SID or index), and a group title, then wraps those events in a new group node. Must handle SID generation for the new group, preserve all child SIDs, and maintain JSON formatting.

### Move Variable Between Scopes (`move-variable`)

**Problem:** Converting a global variable to a local variable (or vice-versa) touches multiple files: the variable declaration in `globalVars.d.ts` or the eventSheet JSON, all script references (`runtime.globalVars.X` ↔ `localVars.X`), and potentially C3 expression parameters that reference the variable name. Currently requires manual edits across all these locations.

**Proposed tool:** A recipe operation or MCP tool that moves a variable declaration between global and local scope, rewrites all script references in affected eventSheets, and updates `globalVars.d.ts` accordingly.

## Implementation Plan

### File-Based MCP Server

#### Session 1 (✅ Done)

1. ✅ Set up MCP server skeleton with `@modelcontextprotocol/sdk` — `bin/mcp/server.ts`, stdio transport
2. ✅ Implement read tools (DSL, scripts, layouts, domain index) — `read-dsl`, `read-dsl-index`, `read-scripts`, `read-layout`, `read-template-scope`, `read-domain-index`
3. ✅ Implement search tools (DSL grep) — `search-dsl` with regex + glob filter
4. ✅ Implement listing tools — `list-event-sheets`, `list-layouts`
5. ✅ Configure in `.mcp.json` — `c3` server entry added alongside Playwright

#### Session 2 (✅ Done) — Infrastructure (P-steps)

1. ✅ `ReadWriteLock` (`bin/mcp/rwlock.ts`) + server state (`txId`, `extractedDirty`, `expectedChanges`, `fs.watch` watcher) + wrap 9 existing tools with read lock + `get-state` tool
2. ✅ Thread `Logger` through `generators.ts` (6 functions) + `generateAll.ts`
3. ✅ Thread `Logger` through `applyRecipe.ts`; export `applyParsed(recipe, dryRun, preview, regenerate, log?)`; change validation `process.exit` → throw
4. ✅ Thread `Logger` through `syncC3Proj.ts`; extract `runSync(rootDir, dryRun, log): { changes, clean }`

#### Session 3a — Harden Infrastructure (P-steps) (✅ Done)

1. ✅ Move `Logger` type from `generators.ts` to dedicated `bin/c3/types.ts`
2. ✅ Refactor `applyParsed()` to use options object API (`ApplyOptions` interface) instead of 4 positional booleans
3. ✅ Expand `runSync()` return type with per-section summary for richer MCP server status
4. ✅ Address `expectedChanges` race condition — `ExpectedChanges` class with TTL-based expiry + periodic purge
5. ✅ Add unit tests for `ExpectedChanges` (9 tests: path normalization, TTL expiry, purge, concurrent adds, consume-once)

#### Session 3b — Tools (F-steps) (✅ Done)

1. ✅ `validate-recipe` (read lock) + `apply-recipe` (write lock, txId check, regeneration)
2. ✅ `regenerate` (write lock, all 6 generators, clears `extractedDirty`)
3. ✅ `validate-project` (read lock) + `sync-project` (write lock, txId check)
4. ✅ `read-addon` (read lock, list + read modes)
5. ✅ Staleness warning (`appendStaleWarning`) on all 7 extracted/ read tools
6. ✅ Guard `applyRecipe.ts` CLI with main-module check (import side-effect fix)
7. ✅ `suppressWatcher` flag for write tools + path traversal fix in read-addon
8. ✅ Server tested: all 16 tools registered, initialization/state/validate-project/read-addon verified (now 20 with scaffold + domain analysis tools)

#### Session 4 — Library/CLI Separation (✅ Done)

Extracted business logic from all 6 CLI scripts into `bin/c3/` library modules, leaving thin yargs CLI wrappers. Eliminated import side-effects, module-level `rootDir` state, and main-module guards.

1. ✅ `scaffoldLayout.ts` → `bin/c3/layoutScaffold.ts` (UID/SID collection, layout cloning)
2. ✅ `applyRecipe.ts` → `bin/c3/recipeApplier.ts` (applyParsed, renameSymbols, regenerateExtracted)
3. ✅ `syncC3Proj.ts` → `bin/c3/projectSync.ts` (types, configs, runSync)
4. ✅ `listTemplates.ts` → `bin/c3/templateLister.ts` (findTemplates)
5. ✅ `navigationGraph.ts` → `bin/c3/navigationGraph.ts` (buildLayoutEventSheetMap, findGoToLayoutCalls, generatePlantUML)
6. ✅ `scaffoldSprite.ts` → `bin/c3/spriteScaffold.ts` (collectAllObjectTypeSids, cloneSprite)
7. ✅ MCP server imports updated to use new library modules
8. ✅ CLAUDE.md Key Files section updated

**Retro:**

- Clean mechanical refactoring — no logic changes, all 805 tests pass
- `rootDir` threading was simpler than expected: most functions already took directory paths as parameters; only `applyRecipe` needed significant `rootDir` parameter additions
- Subagent delegation worked well for parallel independent extractions (tasks 2-6 ran concurrently)
- `rename` → `renameSymbols` rename improves clarity for library consumers
- `process.exit(1)` → `throw new Error()` in rename validation makes the library testable

#### Session 6 — Audit Fixes + Domain Analysis Tools (✅ Done)

Applied high-priority fixes from the MCP audit report and added read-only domain management tools.

1. ✅ Renamed server from `c3` to `construct3-chef` (McpServer name + `.mcp.json` key)
2. ✅ Fixed path traversal gap in `search-dsl` glob parameter
3. ✅ Added ReDoS mitigation to `search-dsl` (pattern length cap 500 chars + match count cap 1000)
4. ✅ Added MCP tool annotations to all 18 tools (READ_ONLY, REGENERATE, MUTATE categories)
5. ✅ Added startup validation (`project.c3proj` + `extracted/` checks, stderr diagnostics)
6. ✅ Added graceful shutdown (SIGINT/SIGTERM) + converted `suppressWatcher` boolean to counter
7. ✅ Added `bin/c3/domainAnalysis.ts` library (`listUncategorized`, `listStaleOverrides`) with 10 unit tests
8. ✅ Added `list-uncategorized` and `list-stale-overrides` MCP tools (18→20 tools)
9. ✅ Updated initiative.md and CLAUDE.md

#### Session 7 — Audit Hardening + UX Polish (✅ Done)

Batch of practical audit fixes improving MCP spec compliance and agent UX.

1. ✅ Restructured write tool responses to multi-block content (audit #7) — separate text blocks for output and metadata (`txId: N`) instead of `JSON.stringify`
2. ✅ Added progress reporting via `progressToken` to long tools (audit #4) — `sendProgress()` helper + `GENERATOR_STEPS` array centralize generator execution with progress notifications
3. ✅ Added `extracted/` auto-generation on startup when missing (audit #17) — calls `runGenerators()` with stderr progress logging
4. ✅ Declared MCP logging capability and emit log notifications (audit #6) — `emitLog()` helper, warning on external file changes
5. ✅ Added cancellation support for long-running tools (audit #5) — `checkCancelled()` between generator steps, `CancelledError` sets `extractedDirty = true`
6. ✅ Updated mcp-audit.md (5 more issues fixed: #4, #5, #6, #7, #17) and initiative docs

**Retro:**

- All 5 audit issues were clean, self-contained changes to `server.ts` — no library changes needed
- `GENERATOR_STEPS` array + `runGenerators()` eliminated 3 copies of the inline 6-generator sequence
- Progress reporting and cancellation share the `Extra` type from the SDK — clean integration
- The MCP SDK's `extra` parameter (second arg to tool callbacks) provides `signal`, `_meta.progressToken`, and `sendNotification` — all three used in this session

#### Session 8 — Unified CLI Entry Point (`construct3-chef`) (✅ Done)

Consolidated 12 fragmented CLI scripts into a single `construct3-chef` command with 13 yargs subcommands, mirroring the MCP tool surface.

1. ✅ Created `bin/construct3-chef.ts` skeleton with yargs, `--project-dir` global option, `server` subcommand (dynamic import), and `generate` subcommand (all 6 generators + `--only` filter)
2. ✅ Ported recipe subcommands (`apply-recipe`, `rename-symbol`) and project subcommands (`validate-project`, `sync-project`)
3. ✅ Ported scaffold subcommands (`scaffold-layout`, `scaffold-sprite`) with direct library calls (replaced `execSync`), plus `list-templates` and `navigation-graph`
4. ✅ Added 3 new CLI-only subcommands (`search-dsl`, `list-uncategorized`, `list-stale-overrides`)
5. ✅ Updated `package.json` scripts to use `construct3-chef`, updated `.mcp.json` to use `construct3-chef server`, deleted 12 replaced CLI scripts
6. ✅ Code review, CLAUDE.md and initiative docs update

**Key design decisions:**

- `server` subcommand uses dynamic import — `await import("./mcp/server")` loads the module, then calls `startServer(projectDir)`. The module is a clean library (no side effects on import); `startServer()` handles initialization, watchers, signal handlers, and transport connection
- Scaffold subcommands call library functions directly — replaced `execSync("npm run sync-c3proj")` and `execSync("npm run generate-c3")` with direct `runSync()` and `runGenerators()` calls
- MCP server renamed from `construct3-chef` to `construct3-chef` in McpServer name
- Old CLI scripts deleted entirely — `package.json` aliases point to construct3-chef subcommands

#### Session 11 — Clean Module Import (✅ Done)

Refactored `bin/mcp/server.ts` to be a clean importable module with no side effects on import.

1. ✅ Removed auto-start `startServer().catch(...)` call at module scope — importing the module no longer starts the server
2. ✅ Moved `process.on("SIGINT"/"SIGTERM")` signal handlers inside `startServer()` — only registered when server actually starts
3. ✅ Updated initiative docs (stale references to "module does all setup on import")

#### Session 12 — Recipe Validator Hardening (✅ Done)

Hardened `validateRecipe()` to catch common recipe authoring errors at validation time.

**Commits:** `ce5bd2b`..`f77e389`

1. ✅ Defined `OP_FIELD_SCHEMAS` mapping all 16 ops to required/optional fields and known misspellings
2. ✅ Implemented per-op field validation — errors on missing required fields, warnings on misspellings and unknown fields
3. ✅ Added `add-include` + path-based targeting warning (prevents gotcha #38)
4. ✅ Documented `include` shorthand in Builder Shorthands § Events
5. ✅ Fixed TypeScript errors caught by code review

**21 new tests**, 883 total passing. Exported `VALID_OPS` and `OP_FIELD_SCHEMAS` for test access.

#### Session 13 — Remaining Recipe & Layout Ops (✅ Done)

Added 4 enhancements: `read-sid-registry` MCP tool, `remove-layer` layout op, `remove-instance` layer filter, `patch-function-block` recipe op.

**Commits:** `380f698`..`bfe42f7`

1. ✅ `read-sid-registry` MCP tool — reads `sid-registry.txt` from extracted (same pattern as `read-template-scope`)
2. ✅ `remove-layer` layout op — removes empty layers, strict validation (fails if instances or sublayers exist)
3. ✅ `remove-instance` layer filter — optional `layer` param restricts removal to a specific layer
4. ✅ `patch-function-block` recipe op — add/remove function-block parameters by SID or path targeting

### Session 12 Retro

**What went well:** TDD P-step/F-step split worked cleanly — schema data first, tests second, implementation third. Code review caught a real TypeScript error before it landed on a non-WIP commit.

**Lessons learned:**
- Schema-based validation duplicates some existing specific checks (rename-symbol). Acceptable tradeoff — schema catches the general case, specific checks add detail
- `include` shorthand works in `expandEvent()` (create mode) but not `extractInlineEvent()` (insert-event ops) — a gap worth noting but low priority since `add-include` covers the common case

#### Session 16 — Param Type Safety + Include Tree (✅ Done)

Added C3 parameter type validation to recipe validator and a transitive include tree tool.

1. ✅ Updated initiative — `include` shorthand on `insert-event` already implemented (strikethrough in Next Up)
2. ✅ Auto-stringify `call` shorthand numeric params — eliminates gotcha #39 at the builder level
3. ✅ `PARAM_TYPE_RULES` + validation in `validateRecipe` — 6 action/condition IDs, 19 tests
4. ✅ `bin/c3/includeTree.ts` library — transitive include resolution with deduplication, function listing, 16 tests
5. ✅ `list-include-tree` MCP tool (22nd tool) — read-only, supports tree/flat modes and function listing
6. ✅ Code review, docs update

**947 tests passing** (up from 909).

### Session 16 Retro

**What went well:** Clean implementation with no blockers. Code review caught the "cycle" vs "already included" semantic mismatch — fixed before final commit. All features were small, well-scoped, and independently testable.

**Lessons learned:**
- "Next Up" lists decay — the `include` shorthand gap was already fixed but never struck from the initiative. Periodic reconciliation against actual code prevents planning already-done work
- `PARAM_TYPE_RULES` registry pattern is cleanly extensible — adding new rules requires only a new entry, no structural changes
- Include tree deduplication is not the same as cycle detection — shared diamond includes (A→B→Shared, A→C→Shared) are normal C3 patterns, not errors. Marker text should reflect this

#### Session 17 — Filesystem Independence (✅ Done)

Implemented full MCP coverage of `extracted/` so clients without filesystem access lose no functionality.

1. ✅ Replaced `search-dsl` with `search` tool — `type` parameter (`dsl`, `ts`, `layout`, `md`, `json`, `idx`), `path` for single-file/subdirectory targeting, `context` for surrounding lines
2. ✅ Added `offset`/`limit` pagination to all 7 read tools (`read-dsl`, `read-dsl-index`, `read-scripts`, `read-layout`, `read-template-scope`, `read-sid-registry`, `read-domain-index`)
3. ✅ Added `resolve-anchor` tool — bidirectional lookup between DSL line numbers, SIDs, event names, and JSON paths (23rd tool)
4. ✅ Updated agent configs, docs, and initiative for renamed tool

**Tool count: 23** (up from 22).

#### Session 18 — Recipe Reliability + `wrap-in-group` (✅ Done)

Added `wrap-in-group` recipe op, verified `replace-action` gotchas, and extended param validation.

1. ✅ `WrapInGroupOp` — wraps events (by SID) into a new group. Supports `in` for non-root containers, `$symbol` assignment, deduplication, same-parent validation. 12 tests.
2. ✅ `replace-action` regression tests (R1) — gotchas #41/#46 don't reproduce. 4 tests prove correct behavior for path-based and SID-based cross-type replacement. Gotchas marked as verified in docs.
3. ✅ `PARAM_TYPE_RULES`: `on-touched-object` type enum. `validateActionParams`: `callFunction` params-as-object warning. 4 tests.
4. ✅ Docs: `wrap-in-group` section in recipe-reference, gotchas #41/#46 strikethrough.

**1021 tests passing** (up from 947).

### Session 18 Retro

**What went well:** Plan compression — the exhaustiveness check on `FileOp` forced combining P1-P4 (types/schemas) and F1 (implementation) into one atomic commit, which was the right call. Design investigation saved significant time by confirming gotchas #41/#46 don't reproduce, pivoting R1 from debugging to regression testing. All tests green on first full validation.

**Lessons learned:**
- Exhaustiveness checks (`const exhaustive: never = op`) mean new union members and their switch cases must ship together — can't split type addition from implementation across commits
- `IncludeEvent` has no `sid` field, so `EventSheetEvent.sid` doesn't exist on the union type. SID-bearing code needs casts when working with the generic union
- `insert-event` `after: -1` means "insert at index 0" (computed as `-1 + 1`), not "append at end." Omitting `after` is the correct way to append to a container

#### Session 19 — Mid-Session SID Discovery + Staleness Detection + Closing (✅ Done)

Added `read-event-sids` tool and mtime-based staleness detection. Initiative housekeeping and closing assessment.

1. ✅ `buildShallowSidMap()` library function in `dslFormatter.ts` — recursive walk of source JSON, collects jsonPath/sid/description. 9 tests.
2. ✅ `read-event-sids` MCP tool (24th tool) — reads source eventSheet JSON directly, returns pipe-delimited SID map. Supports grep filter.
3. ✅ `checkSourceFreshness()` helper in `server.ts` — compares source mtime vs extracted mtime. Wired into 5 read handlers.
4. ✅ Initiative housekeeping — struck 8 completed Future items, updated stats, added closing assessment.

5. ✅ `formatDomainConfig()` in `domainFormatter.ts` — formatted text view of config with section filter.
6. ✅ `collectValidDomainNames`, `validateOverrideKeys`, `validateOverrideValues` in `domainAnalysis.ts` — validation for override mutations. 10 tests.
7. ✅ `read-domain-config` MCP tool — view raw domain config (domains, subdomains, overrides) through MCP.
8. ✅ `set-overrides` MCP tool — add/update overrides with domain name + path prefix validation.
9. ✅ `remove-overrides` MCP tool — remove overrides by key, compose with `list-stale-overrides` for cleanup.

**1040 tests passing** (up from 1021). **Tool count: 27** (up from 23).

### Session 19 Retro

**What went well:** Clean session — all P-steps and F-steps landed without blockers. Parallel subagent delegation worked well for independent concerns. Domain-config tools completed the filesystem independence story: agents can now manage domain assignments without touching `domain-config.json` directly.

**Lessons learned:**
- Initiative doc decay is real — 8 Future items were already done but not struck. Periodic reconciliation is important.
- `read-event-sids` fills a genuine gap: agents can now get SIDs for newly-inserted events without running `regenerate`.
- The domain-config management scope was narrower than initially planned (`update-domain-config` for structure changes) — override management covers the actual need.

### Filesystem Independence — Full MCP Coverage of `extracted/`

Goal: a client that cannot access `extracted/` directly loses no functionality. All read and search operations are available through MCP tools. ✅ Implemented in Session 17.

#### Unified Search Tool

Replace `search-dsl` with a generalized `search` tool that accepts a file type/extension filter:

| Extension filter | Searches | Replaces |
| ------------------ | ---------- | ---------- |
| `dsl` (default) | `*.dsl.txt` | current `search-dsl` |
| `ts` | `*.ts` | new — extracted TypeScript |
| `layout` | `*.layout.txt` | new — layout summaries |
| `md` | `*.md` (domain-index/) | new — domain index pages |
| `json` | raw `eventSheets/*.json`, `layouts/*.json` | new — original C3 JSON |
| `idx` | `*.dsl.idx.txt` | new — DSL index files |

Parameters:

- `pattern` — regex (existing)
- `type` — file type filter (replaces `glob` for most uses)
- `path` — optional subdirectory restriction (replaces current `glob` parameter)
- `context` — number of context lines around each match (like `grep -C`)

The `json` type would search the actual source files (`eventSheets/`, `layouts/`), not `extracted/`. This gives agents access to raw C3 JSON when needed (e.g., verifying exact parameter values) without filesystem access.

#### Read Tool Enhancements

Add optional `offset`/`limit` parameters (line-based) to existing read tools:

- `read-dsl` — read lines X–Y of a DSL file (useful for large event sheets)
- `read-scripts` — read a line range of extracted TypeScript
- `read-layout` — read a section of a layout summary
- `read-domain-index` — read a section of a domain page

This mirrors Claude Code's `Read` tool UX and helps agents that need only a specific section of a large file without consuming full context window.

#### Missing Read Tools

- **`read-sid-registry`** — read `extracted/sid-registry.txt` (used for SID lookups)

#### Backward Compatibility

`search-dsl` was renamed to `search` with no alias — single consumer, no migration complexity. All CLAUDE.md references and agent configs updated to use `search`.

### C3 Editor Browser Automation

1. Explore C3 editor DOM with raw Playwright MCP tools
2. Document reliable selectors for save, preview, dialogs, error panels
3. Add `playwright` as a dependency to the MCP server
4. Implement browser session manager (lazy launch, persistent profile, reuse)
5. Implement editor tools (save, preview, read-errors, dismiss-dialog)
6. Test full workflow: apply recipe → save in editor → preview → check errors

### C3 Addon Bridge

1. Create C3 addon skeleton (single-global plugin)
2. Implement WebSocket client in addon's domSide.js
3. Add WebSocket server to MCP server
4. Implement relay pattern (request correlation, timeouts)
5. Add live editor tools (instance CRUD, properties)
6. Package as `.c3addon` and test in C3 editor

## Related Initiatives

- **C3 Mutation Tooling** (initiative closed) — The recipe system, DSL index, and extracted file generators that this MCP server wraps. File-Based MCP Server tools are thin MCP wrappers over the `src/c3/` functions built in that initiative (recipe interpreter, DSL formatter, layout formatter, generators). Reference docs: [recipe-reference.md](../../docs/recipe-reference.md), [generators.md](../../docs/generators.md), and the [C3 platform reference](../../docs/c3/README.md)

## Prior Art: construct3-mcp (liauw-media)

[github.com/liauw-media/construct3-mcp](https://github.com/liauw-media/construct3-mcp) — MIT-licensed MCP server for C3 projects. Built from scratch with its own C3 project reader/writer, SID/UID generation, analysis tools, and mutation operations.

**What they have that we don't:**
- Event sheet flow visualization and function mapping
- Dependency graphs and orphaned object detection
- Asset usage tracking and performance heuristics
- Direct event block mutation tools (add condition, add action, create event block)
- Automatic backup before mutations
- ~~Collision-checked SID/UID generation (vs. our SID=0 sentinel)~~ ✅ Implemented via `sidUtils.ts` + `extracted/sid-registry.txt`

**What we have that they don't:**
- Human-readable DSL with cross-references
- Extracted TypeScript with named scope types
- Layout summaries and template scope reference
- Domain index (8 primary + 13 shared subdomains)
- Declarative recipe system (batch mutations, builder shorthand)
- DSL index for JSON path lookup

**Key considerations:**
- Our MCP server will include our TypeScript game scripts alongside the C3 tools — it's not purely a C3 project tool. Their server is generic C3-only
- There is real overlap: both parse C3 JSON, both generate SIDs, both mutate event sheets. Starting from their codebase and extending could have avoided duplicating that foundation
- Their event sheet flow analysis addresses the same problem our DSL was introduced for — making C3 event sheets readable and navigable. Different approaches (structured queries vs. human-readable text), both valid
- Their imperative mutation model (add action, add condition) is what we evaluated and rejected in favor of recipes — but their model is simpler for small edits, while recipes shine for batch operations
- Their analysis tools (flow graphs, dependency chains, orphan detection) are independently valuable and could complement our DSL/domain index

**Decision:** Build our own MCP server wrapping existing `bin/c3/` tools (too much invested to switch), but study their codebase for:
1. Analysis tool ideas to port (flow graphs, dependency analysis, orphan detection)
2. Their C3 JSON parsing approach (may reveal gaps in ours)
3. Their mutation safety patterns (backup, validation, verification)
4. Tool naming and granularity conventions

See detailed investigation notes in [construct3-mcp-analysis.md](construct3-mcp-analysis.md).

## Status Checkpoint

### What's Complete

The core file-based MCP server is mature across 14 sessions (1-4, 6-8, 11-13, 16-19), plus package extraction:

- **28 MCP tools** covering read (9), search (1), anchor resolution (1), listing (3), mutation (2), scaffolding (2), analysis (2), project management (3), state (1), SID discovery (2), domain config (2). *In construct3-chef proper this is ~22 tools — the analysis (2) and domain config (2) tools shipped in the separate `domain-manager` package.*
- **1040+ tests** with comprehensive coverage of recipe interpreter, validators, generators, and library functions
- **Full filesystem independence** — clients without `extracted/` access lose no functionality (S17)
- **SID-based addressing** with `$symbol` references, eliminating position-based recipe corruption (S5-S8)
- **Recipe validator** with field schemas, misspelling detection, param type rules, and path-shift warnings (S12, S16, S18)
- **Unified CLI** (`construct3-chef`) mirroring the MCP tool surface (S8)
- **Concurrency safety** via ReadWriteLock, txId state tracking, and mtime-based staleness detection (S2, S3, S19)
- **Package extraction shipped** — `genvid-mcp-utils`, `c3source`, `construct3-chef` extracted to `packages/` and consumed via `.packages/*.tgz` (PRs #4275 c3-mcp-package, #4279 packaging phase 0 docs, #4280 phase 1, #4283 phase 2, #4284 phase 2 fixes). Domain-manager migrated to `packages/domain-manager/` (PR #4277).

### What's Next

| Item | Scope | Status | Notes |
|------|-------|--------|-------|
| ~~**Package extraction**~~ | ~~Medium~~ | ~~Done~~ | ✅ Shipped. See [Package Extraction](#package-extraction--shipped) for the historical design. |
| `move-variable` | Medium | Needs analysis | Cross-file refactoring (global ↔ local scope). Touches eventSheet JSON, scripts, type declarations. |
| User-defined ops (`ops/` directory) | Medium | Designed, not started | Parameterized recipe templates exposed as MCP tools. Hot reload via `tools/list_changed`. See [Architecture § User-Defined Ops](#user-defined-ops). |
| Editor automation (Playwright) | Large | Designed, not started | Browser session, DOM selectors, save/preview/errors. See [Architecture § C3 Editor Browser Automation](#c3-editor-browser-automation-playwright). |
| `extracted/` transition | Medium-Large | Designed, not started | In-memory generation, gitignore extracted/. See [Future: `extracted/` Directory Transition](#future-extracted-directory-transition). |
| C3 Addon Bridge | Large | Designed, not started | WebSocket relay, SDK-limited scope. See [Architecture § C3 Addon Bridge](#c3-addon-bridge-optional-additive). |
| ~~`domain-config.json` management~~ | ~~Small~~ | ~~Done~~ | ✅ S6+S19. Spun off into the separate **`domain-manager`** package — not part of construct3-chef. |

All remaining items are needed but not yet scheduled. Each has design notes and architecture documented in earlier sections of this initiative — this document is the knowledge base for all C3 MCP work.

## Package Extraction (✅ Shipped)

Implemented across PRs #4275 (initial extraction + pnpm workspaces), #4279 (phase 0 docs), #4280 (phase 1), #4283 (phase 2), #4284 (phase 2 fixes). Packages now live at `packages/{genvid-mcp-utils,c3source,construct3-chef,domain-manager}` and are consumed via `.packages/*.tgz` plus `bin/download-packages.mjs`. Original design retained below for historical reference.

### Goal

Extract construct3-chef and its dependencies into local npm packages under `packages/` within the monorepo. This is a stepping stone toward eventually moving each to its own repository. The packages should be consumable by any project, not just Burbank.

### Package Map

```text
packages/
├── genvid-mcp-utils/       # Shared MCP server utilities (Logger, ReadWriteLock, pagination)
│   ├── rwlock.ts            # ReadWriteLock
│   ├── expectedChanges.ts   # Watcher suppression
│   └── pagination.ts        # Text pagination
├── c3source/                # C3 project JSON reader — types and visitors
│   └── c3source.ts          # Layout/objectType/eventSheet parsing
└── construct3-chef/         # C3 MCP server + CLI
    ├── mcp/server.ts        # MCP server (depends on genvid-mcp-utils, c3source)
    ├── c3/                  # Recipe system, generators, scaffolding
    └── cli.ts               # CLI entry point
```

**Dependency graph:**

```text
construct3-chef ──► genvid-mcp-utils
                ──► c3source

ddd-utils       ──► genvid-mcp-utils

bin/checkObstacles.ts ──► c3source
bin/dropshadow.ts     ──► c3source
bin/loc.ts            ──► c3source
```

### Motivation

1. **Reusability**: Other C3 projects should be able to use construct3-chef without copying `bin/c3/` and `bin/mcp/` into their tree. `c3source` is independently useful for any tooling that reads C3 project JSON. `genvid-mcp-utils` is reusable by any MCP server needing concurrency/watcher/pagination.
2. **Clear boundary**: Today, construct3-chef code (`bin/mcp/`, `bin/c3/`, `bin/construct3-chef.ts`) is interleaved with Burbank-specific scripts in `bin/`. Packaging forces clean dependency boundaries.
3. **Future extraction**: Once the package works as a local dependency, moving to its own repo is a packaging change, not a refactoring one.

### Current State

All construct3-chef code lives under `bin/` in the monorepo root:

```text
bin/
├── construct3-chef.ts          # CLI entry point (yargs, 375 lines)
├── mcp/
│   ├── server.ts               # MCP server (1,251 lines)
│   ├── rwlock.ts               # ReadWriteLock
│   └── expectedChanges.ts      # Watcher suppression
└── c3/
    ├── recipeInterpreter.ts    # Recipe system
    ├── generators.ts           # 5 C3 generators
    ├── dslFormatter.ts         # DSL output
    ├── layoutScaffold.ts       # Layout cloning
    ├── spriteScaffold.ts       # Sprite cloning
    ├── ... (22 files total)    # ~9,500 lines
    └── types.ts                # Shared types
```

Invoked via `npx tsx bin/construct3-chef.ts` — no compilation, no package boundary.

### Target Structure

```text
packages/
├── genvid-mcp-utils/
│   ├── package.json            # name: "genvid-mcp-utils"
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # Re-exports all utilities
│       ├── rwlock.ts           # ReadWriteLock (from bin/mcp/rwlock.ts)
│       ├── expectedChanges.ts  # Watcher suppression (from bin/mcp/expectedChanges.ts)
│       └── pagination.ts       # Text pagination (from bin/c3/pagination.ts)
├── c3source/
│   ├── package.json            # name: "c3source"
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # Re-exports all types and visitors
│       └── c3source.ts         # C3 JSON types and visitors (from bin/c3/c3source.ts)
└── construct3-chef/
    ├── package.json            # name: "construct3-chef"
    ├── tsconfig.json
    └── src/
        ├── cli.ts              # CLI entry point (from bin/construct3-chef.ts)
        ├── mcp/
        │   └── server.ts       # MCP server
        └── c3/
            ├── recipeInterpreter.ts
            ├── generators.ts
            └── ... (remaining bin/c3/ files, minus c3source.ts and pagination.ts)
```

### Requirements

#### R1: Package Identity

Each package must have its own `package.json` declaring name, dependencies, and entry points:

1. **`genvid-mcp-utils`** — Shared MCP server utilities. Dependencies: none (pure Node.js). Exports: `ReadWriteLock`, `ExpectedChanges`, `paginateText`.
2. **`c3source`** — C3 project JSON reader. Dependencies: none (pure Node.js `fs`/`path`). Exports: types (`Layout`, `Layer`, `ObjectType`, `Effect`, `EventSheet`, etc.) and visitors (`visit_layers_in_layouts`, `visit_instances_in_layouts`, `find_all_layouts_path`, etc.).
3. **`construct3-chef`** — C3 MCP server + CLI. Dependencies: `genvid-mcp-utils`, `c3source`, `@modelcontextprotocol/sdk`, `yargs`, `zod`. Exports: `startServer`, library functions. Declares `bin` entry for CLI.

No package may rely on dependency hoisting from the root — all dependencies must be explicit.

#### R2: Root Project Integration

1. The root `package.json` must reference all three local packages (e.g., `"construct3-chef": "file:packages/construct3-chef"` or npm workspaces).
2. Existing root `package.json` scripts (`npm run generate-c3`, `npm run apply-recipe`, etc.) must continue to work.
3. `.mcp.json` must be updated to launch the packaged server.
4. No Burbank-specific logic in any package — each takes a `projectDir` parameter and operates on whatever project it's pointed at.
5. Burbank scripts (`bin/checkObstacles.ts`, `bin/dropshadow.ts`, `bin/loc.ts`, `bin/checkOverridenLayers.ts`) update their imports to `import { ... } from "c3source"`.
6. Domain-manager (`bin/domain/server.ts`) updates its imports to `import { ... } from "genvid-mcp-utils"`.

#### R3: Test Migration

1. Tests that test package code must move into the corresponding package.
2. Tests must run both from within each package and from the root.
3. Test fixtures and helpers used by these tests must move with them.

#### R4: Clean Dependency Boundary

1. Package code must NOT import from outside its package boundary.
2. All interaction with the host project is via the `projectDir` parameter.
3. Dependencies between packages flow one way only (see dependency graph above). No circular dependencies.
4. `construct3-chef` depends on `genvid-mcp-utils` and `c3source`. `c3source` and `genvid-mcp-utils` are independent of each other.

#### R5: Future Repo Extraction

1. Each package directory must be self-contained enough to be copied to its own repo with minimal changes (add CI config, update publish config).
2. No circular dependencies between packages or between any package and the root project.

### Cross-Boundary Dependencies

Audit of code outside the package boundary that imports from `bin/c3/` or `bin/mcp/`. All resolved by the three-package split:

#### Burbank scripts importing `bin/c3/c3source.ts`

| Script | What it imports |
| --- | --- |
| `bin/checkObstacles.ts` | `visit_layers_in_layouts` |
| `bin/checkOverridenLayers.ts` | `visit_layers_in_layouts` |
| `bin/dropshadow.ts` | `Effect`, `InstanceVisitor`, `ObjectType`, `find_all_objectTypes_path`, `get_all_global_layers`, `visit_instances_in_layouts` |
| `bin/loc.ts` | `Layer`, `Layout`, `find_all_layouts_path` |

**Resolution:** Import from `c3source` package. These scripts are consumers of C3 project-reading utilities — exactly what `c3source` provides.

#### ddd-utils (formerly domain-manager) importing `bin/mcp/` and `bin/c3/` utilities

| File | What it imports |
| --- | --- |
| `bin/domain/server.ts` | `ReadWriteLock` from `../mcp/rwlock` |
| `bin/domain/server.ts` | `ExpectedChanges` from `../mcp/expectedChanges` |
| `bin/domain/server.ts` | `paginateText` from `../c3/pagination` |
| `bin/domain/domainGenerator.ts` | types and functions from `../c3/c3source` |

**Resolution:** `server.ts` imports from `genvid-mcp-utils` package. `domainGenerator.ts` stays in root as a Burbank-specific integration script that consumes both `c3source` (for file listing) and `ddd-utils` (for classification/formatting) — it is not part of either package.

### Constraints

- The domain-manager MCP server (`bin/domain/`) is NOT part of this extraction — it was already separated in the current branch and has its own lifecycle.
- The package should work with `tsx` for development (no mandatory compile step for local dev) but should also support `tsc` compilation for distribution.
- Existing branch work (domain-manager extraction) must be completed or rebased before this work begins — both touch `bin/mcp/server.ts` and `bin/c3/`.
- Cross-boundary dependencies (Group 1 and Group 2 above) must be resolved as part of the migration — they cannot be left as broken imports.

### Migration Strategy

Two viable approaches:

**A. Move files, update imports** — Move `bin/c3/`, `bin/mcp/`, `bin/construct3-chef.ts` into `packages/construct3-chef/src/`. Update all import paths. Root `package.json` adds workspace dependency. Burbank scripts update to import from the package. Domain-manager gets copies of shared utilities.

**B. Copy-then-delete** — Copy files to the package, get it building and tests passing in isolation, then delete originals and update root imports. Safer but more steps.

Approach A is preferred — git tracks renames, history is preserved, and there's less duplication risk.

### Packaging Decisions To Make

1. **Workspace tooling**: npm workspaces, or just `file:` dependency? npm workspaces add complexity (hoisting, lockfile changes) but enable `npm run test` from root to cascade. `file:` is simpler.
2. **Build step**: Should the package ship compiled JS (with `tsc`) or run via `tsx` like today? Compiled is faster at runtime and required for npm publishing; `tsx` is simpler for local dev.
3. **What about `test/c3/` fixtures?** Some tests use fixture files (sample eventSheets, layouts). These need to move into the package or be generated by test helpers.

## References

- [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [C3 Editor SDK](https://github.com/Scirra/Construct-Addon-SDK.git)
- [Community Tips for C3SDKV2](https://github.com/katsopolis/C3SDKV2Guide)
- Installed addon example: `addons/plugin/Genvid_Datadog_RUM/`
