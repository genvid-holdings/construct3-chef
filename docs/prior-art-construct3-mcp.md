# construct3-mcp: Architecture Deep Dive

> _Imported from the monorepo where construct3-chef was first developed. Path mapping: `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared MCP utils → `@genvid/mcp-utils`, domain tooling → `domain-manager`. Reference/design record; the digestible summary is in [mcp-architecture.md § Prior art](mcp-architecture.md#prior-art-liauw-mediaconstruct3-mcp)._

Analysis of [liauw-media/construct3-mcp](https://github.com/liauw-media/construct3-mcp) for comparison with Burbank's C3 tooling.

## 1. Overview

**construct3-mcp** is a Model Context Protocol (MCP) server that gives AI assistants structured, safe access to Construct 3 game projects. It exposes read, analysis, and mutation capabilities as MCP tools over stdio transport.

| Field | Value |
|-------|-------|
| Version | 1.5.0 |
| License | MIT |
| Author | Omnitronix |
| Runtime | Node.js >= 18 |
| Dependencies | `@modelcontextprotocol/sdk` ^1.26.0, `zod` ^3.23.8 |
| TypeScript | ES2022 target, NodeNext modules, strict mode |
| Project format | Folder-format C3 projects only (no `.c3p` ZIP support) |
| Status | Phases 1-4 complete; Phase 5 (advanced features) in development |

The server accepts a project path via CLI arg, `C3_PROJECT_PATH` env var, or cwd. It validates that a `.c3proj` file exists, then registers handlers in sequence: resources, query tools, analysis tools, workflow prompts, mutation tools.

## 2. Architecture

### 2.1 Directory Structure

```
src/
  index.ts                          — MCP server entry point
  construct3/
    types.ts                        — All C3 type definitions (discriminated union for events)
    project-reader.ts               — Read-only project access with caching
    project-writer.ts               — Safe write operations (backup/validate/verify)
    id-generator.ts                 — SID/UID generation with collision avoidance
    templates.ts                    — Factory functions for all C3 JSON structures
    analyzers/
      index-builder.ts              — Cross-reference index (singleton, lazy-loaded)
      event-flow.ts                 — Include graph + function map
      object-deps.ts                — Object dependency graph + orphan detection
      performance.ts                — Heuristic performance analysis
      asset-usage.ts                — Asset reference tracking
  tools/
    query.ts                        — 9 read-only query tools
    analysis.ts                     — 6 analysis tools (wrappers over analyzers)
    mutations.ts                    — Mutation orchestrator (imports 5 domain modules)
    event-tools.ts                  — Event sheet CRUD (create/add/delete/update events)
    event-helpers.ts                — Zod schemas, recursive block builder, SID finder
    object-tools.ts                 — Object type CRUD
    layout-tools.ts                 — Layout CRUD + instance placement
    animation-tools.ts              — Animation management
    project-tools.ts                — Project metadata updates
    shared.ts                       — Name validation, path validation, result formatting
  resources/
    project.ts                      — MCP resources (project info, structure, addons, entity details)
    docs.ts                         — C3 documentation links and topic lookup
  prompts/
    workflows.ts                    — 6 guided workflow prompts (analyze, review, optimize, etc.)
```

### 2.2 Layered Design

The architecture has four layers:

1. **Data layer** (`construct3/`): `Construct3ProjectReader` for reads, `Construct3ProjectWriter` for writes, `IdGenerator` for SID/UID allocation, `templates.ts` for JSON factory functions. All stateful, class-based.

2. **Analysis layer** (`construct3/analyzers/`): `ProjectIndex` singleton builds a cross-reference index on first use. Four specialized analyzers (`event-flow`, `object-deps`, `performance`, `asset-usage`) consume the index.

3. **Tool layer** (`tools/`): MCP tool registrations that validate inputs (Zod), call the data/analysis layers, and format results. Separated by domain (events, objects, layouts, animations, project).

4. **Interface layer** (`resources/`, `prompts/`): Static MCP resources for project metadata and guided workflow prompts for common tasks.

### 2.3 Data Flow

```
AI Assistant
    │
    ▼
MCP stdio transport (index.ts)
    │
    ├─► Resources (project.ts, docs.ts)     → project-reader → JSON response
    ├─► Query tools (query.ts)               → project-reader → JSON response
    ├─► Analysis tools (analysis.ts)         → analyzers → ProjectIndex → JSON response
    ├─► Mutation tools (mutations.ts)         → event/object/layout-tools → project-writer → disk
    └─► Workflow prompts (workflows.ts)       → project-reader → structured prompt
```

All write operations flow through `project-writer.ts`, which enforces the safety pipeline (backup, validate, write, verify, invalidate caches). All analysis operations flow through `ProjectIndex`, which is built lazily on first use and cached as a module-level singleton.

## 3. C3 JSON Parsing

### 3.1 Type Model

The type system (`types.ts`) models C3 JSON structures as TypeScript interfaces. The central design decision is a **discriminated union for events** using the `eventType` field.

**C3Event discriminated union** (7 variants + catch-all):

| Variant | eventType | Key fields |
|---------|-----------|------------|
| `BlockEvent` | `'block'` | conditions, actions, children, disabled, isElse, sid |
| `VariableEvent` | `'variable'` | name, type, initialValue, isStatic, isConstant, comment, sid |
| `FunctionBlockEvent` | `'function-block'` | functionName, functionDescription, functionCategory, functionReturnType, functionCopyPicked, functionIsAsync, functionParameters, conditions, actions, children, sid |
| `GroupEvent` | `'group'` | title, description, disabled, isActiveOnStart, children, sid |
| `IncludeEvent` | `'include'` | includeSheet |
| `CommentEvent` | `'comment'` | text |
| `ScriptEvent` | `'script'` | script (top-level script blocks, not inline actions) |
| `UnknownEvent` | `string` | (catch-all for unrecognized types) |

**Action discriminated union** (3 variants):

| Variant | Discriminant | Key fields |
|---------|-------------|------------|
| `StandardAction` | has `id` + `objectClass` | id, objectClass, sid, parameters, behavior-type, disabled |
| `FunctionCallAction` | has `callFunction` | id, objectClass, sid, callFunction, parameters, disabled |
| `ScriptAction` | `type: 'script'` | script, disabled |

**Condition**: id, objectClass, sid, parameters, behavior-type, isInverted, isOr

### 3.2 Other Structures

**ObjectType**: name, plugin-id, sid, isGlobal, instanceVariables (array of `InstanceVariable`), behaviorTypes (array of `BehaviorType`), effectTypes, animations (`AnimationsContainer` — recursive tree with `items` and `subfolders`), singleglobal-inst (for plugin objects like Audio, JSON, etc.)

**Layout**: name, layers (array of `Layer`), sid, eventSheet binding, dimensions, projection, nonworld-instances, scene-graphs-folder-root, effectTypes

**Layer**: name, sid, instances (array of `Instance`), visibility/interaction flags, parallax, blend mode, z-elevation, global flag, color/background, rendering settings

**Instance**: type (object name), properties, uid, sid, tags, instanceVariables, behaviors, showing, locked, world (position/size/angle/color)

**Project**: Complete c3proj structure — metadata, containers (objectTypes, families, layouts, eventSheets, timelines as nested `items`/`subfolders`), rootFileFolders (script, sound, music, video, font, icon, general), properties (full project settings).

### 3.3 Fields They Track vs. Fields We Track

| Field | construct3-mcp | Burbank |
|-------|---------------|---------|
| Block events | Yes | Yes |
| Variable events | Yes (isStatic, isConstant) | Yes (DSL formatter + recipe builder) |
| Function blocks | Yes (all metadata) | Yes (all metadata, including functionDescription) |
| Groups | Yes (title, active, disabled) | Yes |
| Includes | Yes | Yes |
| Comments | Yes | Yes |
| Script events | Yes (top-level) | Not modeled separately (rare in our project) |
| Custom ACE blocks | **No** | **Yes** (ace keyword in DSL, recipe builder) |
| Template/replica modes | **No** | **Yes** (layout summaries, template-scope) |
| Scene-graph hierarchy | Partial (stores raw JSON) | **Yes** (parent-child nesting in layout summaries) |
| Container groups | **No** | **Yes** (presence markers in layout summaries) |
| Tag lists | Partial (raw string) | **Yes** (parsed in layout summaries) |
| Animation frames | Yes (full model) | No (not needed for our workflow) |
| Addon metadata | Yes (plugins, behaviors, effects) | Partial (extracted addon folders, not runtime) |

Their model is broader (covers objects, layouts, animations, addons, project settings) because they support creation of all entity types. Our model is deeper in event sheet semantics (custom ACEs, template hierarchies, container groups).

## 4. Analysis Tools

### 4.1 ProjectIndex (`analyzers/index-builder.ts`)

The foundation for all analysis. A **singleton cross-reference index** built lazily on first use, cached at module level.

**Data structures** (12 maps):

```
objectToEventSheets:  Map<objectName, ObjectReference[]>
  └─ ObjectReference = { objectName, eventSheet, path, context: 'condition'|'action' }

eventSheetIncludes:   Map<sheetName, includedSheetNames[]>    (forward)
eventSheetIncludedBy: Map<sheetName, includingSheetNames[]>   (reverse)

layoutToEventSheet:   Map<layoutName, sheetName>
objectToLayouts:      Map<objectName, layoutNames[]>

functionDefinitions:  Map<funcName, { sheet, params }>
functionCalls:        Map<funcName, { sheet, path }[]>

familyMembers:        Map<familyName, objectNames[]>
objectToFamilies:     Map<objectName, familyNames[]>

allEventSheets:       string[]
allObjects:           string[]
allLayouts:           string[]
warnings:             string[]
```

**Build algorithm**:

1. Read all event sheets via bulk read (cached by project-reader)
2. For each sheet, traverse events using an iterative stack (no recursion):
   - Extract objectClass references from conditions and actions, recording sheet name + JSON path + context
   - Track include directives (forward graph)
   - Track function definitions (name, sheet, parameters) and function call actions (call sites)
3. Build reverse include map from forward map
4. Read all layouts, index instance types and layout-to-eventSheet bindings
5. Read all families, build bidirectional membership maps
6. Collect inventory lists (allEventSheets, allObjects, allLayouts)

**Safety limits**: MAX_NODES = 100,000 (traversal halts), MAX_DEPTH = 50 (stack depth). Warnings collected rather than thrown.

**Query methods**:
- `getEventSheetsForObject(name)` — unique sheets referencing an object
- `getCoOccurringObjects(name)` — objects appearing in the same event sheets
- `countEvents(events)` — recursive event count for a subtree

**Caching**: Module-level `cachedIndex` persists after first build. `resetProjectIndex()` clears it (called by project-writer after mutations).

### 4.2 Event Flow Analysis (`analyzers/event-flow.ts`)

Two analysis functions:

**`getEventSheetFlow(scope?, detail)`**:
- Builds flow graph of event sheet include relationships
- Optional `scope` parameter filters to sheets reachable from a specific root (DFS traversal)
- Three detail levels: `summary` (edges only), `standard` (+ function/event counts), `full` (+ all metadata)
- Outputs as JSON array of `EventSheetFlowNode` objects:
  ```
  { name, includes[], includedBy[], layout?, eventCount, functionCount, groupCount }
  ```
- Also generates **Mermaid diagram** syntax: `graph TD` with solid edges for includes, dashed edges for layout bindings

**`getFunctionMap(detail)`**:
- Catalogs all function definitions with their call sites
- Output per function: name, defining sheet, parameter list, call count, call sites (sheet + path)
- Summary statistics: total functions, total call sites, uncalled function count
- Sorted by call frequency descending
- Identifies **uncalled functions** (defined but never invoked)

### 4.3 Object Dependencies (`analyzers/object-deps.ts`)

Two analysis functions:

**`getObjectDependencies(objectName?, detail)`**:
- For a specific object: event sheet references, layout placements, family memberships, co-occurring objects
- Project-wide: top-20 most-connected objects by reference count
- Co-occurrence computed from shared event sheet presence (objects that appear together in the same sheets)

**`findOrphanedObjects()`**:
- Three-criterion orphan detection:
  1. Zero event sheet references (not used in any condition or action)
  2. Zero layout placements (no instances in any layout)
  3. No family membership that itself has event sheet references (family usage doesn't save it unless the family is actually referenced)
- Returns orphan list with plugin-id and isGlobal metadata
- Filters out known global plugins (Audio, Mouse, Touch, etc.) since those are used implicitly

### 4.4 Performance Heuristics (`analyzers/performance.ts`)

Nine heuristic checks, each producing `PerformanceIssue` objects:

| Check | Threshold | Severity | Category |
|-------|-----------|----------|----------|
| Large event sheet | > 200 top-level events | warning | event-complexity |
| Deep nesting | > 5 levels | warning | event-complexity |
| Every-tick blocks | Any block with no trigger condition | info | performance |
| Inline script actions | Any script action in events | info | code-organization |
| Large layout | > 500 instances in a single layout | warning | layout-complexity |
| Many animation frames | > 50 frames on a single sprite | info | memory |
| Large active groups | > 50 children in an active group | info | performance |
| Orphaned objects | Objects with no references | info | cleanup |
| Unused addons | Addons in c3proj not referenced by any object | info | cleanup |

Each issue includes: severity (`info`/`warning`/`critical`), category, location (specific file/object), descriptive message, and actionable suggestion.

### 4.5 Asset Usage (`analyzers/asset-usage.ts`)

**`getAssetUsage(type?, detail)`**:
- Collects assets from all rootFileFolders (sound, music, video, font, icon, general) plus sprite frames from object animations
- Tracks where each asset is referenced (event sheets, layouts, global objects)
- Three detail levels: `summary` (aggregate stats only), `standard` (top 50 assets), `full` (complete listing)
- Output: total count, breakdown by type, unused count, top-10 most-referenced

## 5. Mutation System

### 5.1 Imperative Model

Mutations are **individual MCP tool calls**, each performing a single operation:

**Event tools** (6 operations):
| Tool | Operation | Addressing |
|------|-----------|------------|
| `create_event_sheet` | Create new sheet (optional includes) | By name |
| `add_event_to_sheet` | Add group/function/variable/include/comment | By sheet name + position (start/end) |
| `add_event_block` | Add block with conditions, actions, nested children | By sheet name + optional group path |
| `delete_event_sheet` | Remove sheet file + c3proj entry | By name |
| `delete_event_from_sheet` | Remove event by SID or include ref | By SID (global search) or include name |
| `update_event_block` | Modify conditions/actions/disabled | By SID + index |

**Object tools** (3): create, update properties, delete
**Layout tools** (4): create, add instance, delete, update
**Animation tools** (2): add animation, update properties
**Project tools** (1): update metadata

### 5.2 Safety Pipeline

All writes flow through `Construct3ProjectWriter`, which enforces a five-step safety pipeline:

```
1. BACKUP    — Create .bak file (skipped for new files)
2. VALIDATE  — Stringify JSON, check size (5MB max), parse back to verify round-trip
3. WRITE     — Write JSON to disk with 2-space indentation
4. VERIFY    — Read file back from disk and parse JSON
5. INVALIDATE — Clear caches in project-reader, project-index, and id-generator
```

Additional safety features:
- **Addon auto-registration**: `ensureAddonRegistered()` adds known Scirra addons to c3proj if missing, but blocks unknown third-party addons (requires manual registration)
- **Reference checking before deletion**: `delete_event_sheet` checks for layout bindings and include references before removing; `delete_object` checks event sheet references, layout placements, and family memberships
- **Dependency protection**: Cannot delete a sheet that is included by other sheets or bound to a layout (unless `force: true`)
- **c3proj management**: `addToProject()` and `removeFromProject()` handle subfolder-aware container array updates

### 5.3 Input Validation

All mutation inputs are validated with Zod schemas before execution:

```typescript
// Example: condition schema
conditionSchema = z.object({
  id: z.string(),                           // ACE id (kebab-case)
  objectClass: z.string(),                  // Object name or "System"
  'behavior-type': z.string().optional(),
  parameters: z.record(z.unknown())
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Max 50KB'),
  isInverted: z.boolean().optional(),
  isOr: z.boolean().optional(),
});
```

**Object class validation**: All objectClass references are checked against project objects + families + "System". On mismatch, `findNearestName()` provides up to 5 fuzzy suggestions.

**Safety limits for event building**:
- MAX_NESTING_DEPTH = 5 (block nesting)
- MAX_TOTAL_EVENTS = 50 (per tool call)
- MAX_ITEMS_PER_BLOCK = 100 (conditions or actions)
- MAX_SEARCH_NODES = 100,000 (SID traversal)
- MAX_SEARCH_DEPTH = 50 (tree depth)

**Semantic warnings** (non-fatal):
- Else blocks with conditions (C3 ignores them)
- `isOr` on the first condition (meaningless, no prior condition to OR with)

### 5.4 Comparison to Our Recipe Approach

| Aspect | construct3-mcp | Burbank recipes |
|--------|---------------|-----------------|
| **Interaction model** | Imperative tool calls (one at a time) | Declarative JSON recipes (batched) |
| **Event addressing** | SID-based (globally unique, survives reordering) | Path-based from DSL index (`events[0].children[17]`) |
| **Operation count** | 6 event operations | 14+ recipe operations |
| **Batch support** | Single operation per call | Multi-file, multi-operation recipes |
| **Builder shorthand** | Zod-validated JSON with objectClass/id/params | Builder shorthand (`{ "script": [...] }`, `{ "call": "func" }`) |
| **Dry run** | No | Yes (`--dry-run` validates without writing) |
| **Preview** | No | Yes (`--preview` shows script diffs) |
| **Backup** | Yes (`.bak` files) | No |
| **Post-write verification** | Yes (read-back + parse) | No |
| **Object class validation** | Yes (with fuzzy suggestions) | No (trusts recipe author) |
| **SID generation** | Collision-checked (full project scan) | Random (no collision check) |
| **Symbol rename** | No | Yes (`rename-symbol` operation + standalone CLI) |
| **Script patching** | No (replace whole script) | Yes (`patch-script` with targeted string replacement) |
| **Regeneration** | No (no generated files) | Yes (auto-regenerates extracted files after apply) |
| **CI validation** | No | Yes (extracted files validated in CI) |

**Their strengths**: Write safety (backup + verify), input validation (Zod + object class checks), SID collision avoidance. These protect against data corruption at the individual operation level.

**Our strengths**: Batch operations, dry-run/preview, targeted script patching, symbol renaming, generated file regeneration, CI validation. These support complex multi-step refactoring workflows with confidence.

## 6. SID/UID Generation

### 6.1 Their Approach (`id-generator.ts`)

**SID generation**: Random 15-digit integers in range [100,000,000,000,000, 999,999,999,999,999], collision-checked against a set of ALL existing SIDs in the project.

**Full project scan** (lazy, on first use):
- c3proj file items (rootFileFolders)
- All object types: object SID, behavior SIDs, behaviorType SIDs, instance variable SIDs, animation SIDs (recursive tree including frames), singleglobal-inst SID/UID
- All event sheets: sheet SID, event SIDs (iterative stack traversal), condition SIDs, action SIDs, function parameter SIDs
- All layouts: layout SID, layer SIDs, instance SIDs/UIDs, nonworld-instance SIDs/UIDs
- All families: family SIDs

**UID generation**: Sequential starting from highest existing UID + 1.

**Reset**: `reset()` clears everything so next use triggers fresh scan. Called by project-writer after mutations to pick up newly created IDs.

**Retry limit**: 100 attempts before throwing. Given 900 trillion possible values, collision is astronomically unlikely even in large projects.

### 6.2 Our Approach

Our `recipeInterpreter.ts` generates random 15-digit SIDs without scanning existing values. The collision probability is effectively zero (~10^-10 for a project with 100K existing SIDs), but it is not formally guaranteed.

We do not generate UIDs (layout instance placement is rare for us and handled by Python scripts when needed).

### 6.3 Assessment

Their approach is more correct. The practical risk of our approach is near-zero, but their full-scan pattern would be low-effort to add if we ever need it (scan all eventSheet JSON files for `"sid":` values, build a Set, check before returning).

## 7. Query Tools

Nine read-only tools registered in `tools/query.ts`:

| Tool | Input | Output |
|------|-------|--------|
| `list_objects` | (none) | All object type names, sorted |
| `list_eventsheets` | (none) | All event sheet names with paths |
| `list_layouts` | (none) | All layout names with paths |
| `list_families` | (none) | All family names |
| `get_object_details` | name | Full object JSON (plugin, vars, behaviors, animations) |
| `get_eventsheet_details` | name | Full event sheet JSON |
| `get_layout_details` | name | Full layout JSON (layers, instances) |
| `search_objects` | pattern | Filtered object list (case-insensitive substring) |
| `get_project_summary` | (none) | Metadata, counts, addons, viewport, properties |

All error handlers include fuzzy name suggestions via `findNearestName()`.

**Comparison to Burbank**: We do not need explicit query tools because Claude Code reads files directly. Our equivalent is `Grep` + `Read` + extracted files (DSL, layout summaries, domain index). Their query layer is necessary because MCP tools cannot access the filesystem directly — the server mediates all access.

## 8. Resources

### 8.1 Project Resources (`resources/project.ts`)

**Static resources** (always available):
- `construct3://project-info` — project metadata as JSON
- `construct3://project-structure` — object types, event sheets, layouts, families, addon counts
- `construct3://project-addons` — plugins, behaviors, effects categorized by type

**Dynamic resource templates** (parameterized):
- `construct3://objects/{name}` — specific object type details
- `construct3://eventsheets/{name}` — specific event sheet data
- `construct3://layouts/{name}` — specific layout information

### 8.2 Documentation Resources (`resources/docs.ts`)

C3 documentation index with topic lookup mapping to construct.net manual URLs. Provides contextual documentation links for common C3 concepts.

### 8.3 Workflow Prompts (`prompts/workflows.ts`)

Six guided workflow prompts:
- `analyze_project` — comprehensive project assessment with naming/organization recommendations
- `find_object_usage` — search all sheets/layouts for object references
- `explain_eventsheet` — explain logic flow, includes, optimization opportunities
- `review_game_logic` — architecture analysis (organization, separation of concerns, patterns)
- `document_object` — generate documentation (purpose, properties, behaviors, usage patterns)
- `optimize_project` — performance, asset, event structure, and best practice suggestions

**Comparison to Burbank**: Our Claude Code skills (`.claude/skills/`) serve a similar purpose but are tailored to Burbank-specific patterns. Their prompts are generic (any C3 project). Our skills include project-specific knowledge (domain structure, naming conventions, known gotchas) that generic prompts cannot provide.

## 9. Portability Assessment

### Port (high value, moderate effort)

**Function call-site index**
Their `functionCalls` map records where every function is called from (sheet + path). Our domain index lists function definitions but does not track callers. Adding a call-site map to `bin/c3/generators.ts` during domain index generation would improve impact analysis when renaming or modifying functions. Implementation: during DSL generation, when encountering a `call FuncName()` action, record the calling sheet + cross-reference. Output as a "callers" section in domain detail pages and a "Called by" column in the function list.

**Reverse include graph**
Their `eventSheetIncludedBy` map answers "which sheets include this sheet?" Our domain index include graphs are forward-only. Adding reverse edges would help assess blast radius when modifying a shared utility sheet. Implementation: invert the existing forward include data during domain index generation.

**Uncalled function detection**
Their function map identifies functions defined but never invoked anywhere in the project. This would be useful for cleanup. Implementation: compare function definitions (from DSL `function` lines) against call sites (from DSL `call` lines) across all sheets. Could be a standalone CLI tool or integrated into domain index generation.

### Inspire (worth studying, implementation would differ)

**Write safety pipeline (backup + verify)**
Their backup-validate-write-verify-invalidate pipeline is a good pattern. For our recipe system, the most valuable additions would be: (a) `.bak` file creation before writing eventSheet JSON, and (b) JSON parse verification after writing. These are low-effort additions to `recipeInterpreter.ts`. We would not need the full class-based writer since our writes are batched in recipes.

**Object class validation with fuzzy suggestions**
Their Zod-validated objectClass checking with fuzzy name suggestions on mismatch is a nice UX pattern. For our recipes, adding optional validation that checks objectClass references against `objectTypes/` folder contents would catch typos before writing. Implementation would differ since our recipes use builder shorthand, not raw objectClass/id/parameters.

**SID collision checking**
Their full-project SID scan ensures uniqueness. While our collision probability is effectively zero, a lightweight version (scan only the target eventSheet file before generating SIDs for it) would add formal correctness with minimal performance cost.

**ProjectIndex singleton pattern**
Their lazy-built, module-level cached index is a clean pattern for expensive cross-reference data. Our domain index is pre-generated to disk, which is better for our use case (consumed by humans and AI reading files), but the singleton pattern could be useful if we ever build interactive tools.

**Performance heuristics**
Their nine checks (large sheets, deep nesting, every-tick blocks, etc.) provide automated health signals. The specific thresholds would need heavy tuning for our project (we likely have sheets with 500+ events that are fine by design). The pattern of structured `PerformanceIssue` objects with severity/category/location/message/suggestion is worth adopting if we build a project health tool.

### Skip (not relevant)

**Object/layout/animation CRUD tools**
We do not create C3 objects, layouts, or animations programmatically. Our C3 editor workflow handles these. Their tools solve a problem we do not have.

**MCP query tools**
We do not need a query layer because Claude Code reads files directly. Our extracted files (DSL, layout summaries, domain index) provide richer queryability than raw JSON responses.

**MCP resources and docs links**
Our `docs/` folder with project-specific documentation (architecture.md, construct3-guide.md, coding-conventions.md, etc.) provides deeper, more relevant context than generic C3 manual links.

**Workflow prompts**
Our Claude Code skills are project-specific and encode domain knowledge that generic prompts cannot replicate.

**Asset usage tracking**
Asset management is not a pain point for us. Our assets are managed through the C3 editor and CI build process.

**Addon auto-registration**
Our addons are stable and managed through the C3 editor. We do not add addons programmatically.

## 10. Gaps in Their Approach

Things we do that they do not, and why ours is better for our use case.

### DSL Generation

They return raw event sheet JSON to the AI. We generate human-readable DSL (`extracted/*.dsl.txt`) that shows all eventSheet logic — conditions, actions, function calls, variable declarations — in a scannable format with cross-references to extracted TypeScript. For understanding what an event sheet does, DSL is orders of magnitude more efficient than parsing raw JSON.

### TypeScript Extraction with Scope Types

They treat inline scripts as opaque strings. We extract full IDE-quality TypeScript files (`extracted/*.ts`) with imports, named scope types (intersection composition for nested localVars), and cross-references back to DSL. This makes embedded TypeScript searchable, type-checkable, and navigable as proper code.

### Declarative Batch Mutations (Recipes)

Their imperative one-operation-at-a-time model requires many round trips for complex changes. Our recipe system batches multiple operations across multiple files in a single declarative JSON file, with dry-run validation and preview diffs. For refactoring workflows (rename a function, update all callers, add new variables, restructure events), recipes are far more efficient.

### Script Patching and Symbol Renaming

They can only replace entire script actions. Our `patch-script` operation does targeted string replacement within a script action (with `replaceAll` support). Our `rename-symbol` operation walks entire event trees to rename symbols across all script actions in a sheet, with longest-first sorting for substring safety. The standalone `npm run rename-symbol` command handles cross-sheet renames without even needing a recipe file.

### Domain-Based Organization

Their analysis organizes by entity type (flat lists of objects, sheets, layouts). Our domain index organizes by semantic domain (8 primary: Authentication, Play Simulation, Watch Content, etc. + 13 shared subdomains: Chat, Video Playback, Progress Tracking, etc.). When investigating a feature area, domain organization narrows the search space far more effectively than entity lists.

### Layout Summaries with Template Hierarchies

They return raw layout JSON. We generate scannable layout summaries (`extracted/*.layout.txt`) showing layers, instances grouped by type with counts, scene-graph hierarchy (parent-child nesting), container group membership with presence markers, template bindings, and non-world instances. Template scope tracking (`extracted/template-scope.txt`) provides cross-layout template availability.

### DSL Index Files for Path Addressing

They use SID-based addressing (globally unique but requires traversal to find). We generate DSL index files (`extracted/*.dsl.idx.txt`) that map every event tree node to its exact JSON path (`events[N].children[M]`). This makes recipe `path` fields deterministic without runtime traversal. SID addressing is more robust to reordering, but path addressing from a pre-computed index is faster and works offline.

### CI Validation of Generated Files

They have no equivalent to our CI validation pipeline. Our extracted files (DSL, TypeScript, layout summaries, domain index) are committed to the repository and validated in CI. Any drift between event sheets and extracted files is caught automatically. This provides a continuous correctness guarantee that their runtime-only approach lacks.

### Custom ACE Block Support

Their type system has no model for `custom-ace-block` events (third-party addon triggers/conditions/actions). Our DSL formatter and recipe builder fully support custom ACE blocks, which are used by several addons in our project.

### Project-Specific Knowledge

Their tooling is generic — it works with any C3 project but knows nothing about any specific project's conventions, patterns, or architecture. Our tooling encodes deep project knowledge: 8 semantic domains, naming conventions, known gotchas (variable scoping, function return types, block concurrency), design patterns (barrel namespaces, signal-based async), and a comprehensive documentation suite.

## 11. MCP Tool Design Patterns to Adopt

Patterns from their source code that we should adopt when building our MCP server, regardless of the underlying tool implementations.

### Must-have for our MCP server

**Detail level parameter with token budget hints**
Every tool returning variable-length output should accept `detail: 'summary' | 'standard' | 'full'` with descriptions like `"summary (<2K tokens)"`. Tells the LLM how much context each level consumes, preventing context window bloat.

**Fuzzy name suggestions on every error path**
Every "not found" error should call a `findNearestName()` equivalent and append "Did you mean: X? Use list-Y to see available names." Prevents the LLM from spiraling on a typo. Implementation: Levenshtein distance or case-insensitive substring matching against the entity name list.

**`toolResult`/`toolError` formatting layer**
Single pair of functions wrapping all MCP responses. Guarantees consistent structure across all tools and makes format changes trivial.

**Safety limits on recursive/freeform inputs**
Any MCP tool accepting event structures, recipe JSON, or freeform parameters needs hard limits: max nesting depth, max total items, max payload size. Prevents LLM-generated unbounded structures from corrupting the project.

**Truncated responses with follow-up guidance**
When returning lists, cap at a reasonable size and include a note: "Showing first N items. Use list-X for complete data." Prevents the LLM from treating a partial list as exhaustive.

### Worth adopting for recipe safety

**Post-write JSON verification**
After writing eventSheet JSON, read it back and parse it. Catches filesystem corruption, encoding issues, or broken JSON from mutation bugs. Trivial to add to `recipeInterpreter.ts`.

**Backup before write**
Create `.bak` copy of each file before mutating. Our recipes currently have no backup mechanism — if a recipe corrupts a file, the only recovery is `git checkout`.

**Reference checking before `remove-event`**
Check if a removed function-block has callers or if a removed include is referenced. Block with a structured warning unless `force: true`. Our `remove-event` currently removes silently.

### Reference data to extract

**Known Scirra plugin/behavior ID lists**
32 plugin IDs and 26 behavior IDs with display names from `templates.ts`. Useful for validation in our recipe system and for the MCP server's object class checking.

**Default instance properties per plugin**
Per-plugin defaults for Sprite (`initially-visible`, `initial-animation`, `enable-collisions`), Text (font config), TiledBg, NinePatch. Useful for our Python layout editing scripts.

**Plugin classification**
`GLOBAL_PLUGINS` (singleglobal-inst: Audio, AJAX, etc.) vs. `NONWORLD_GLOBAL_PLUGINS` (Arr, Json, Dictionary — isGlobal but placed as nonworld instances). Important for routing objects to the correct location when adding to layouts.

## 12. Complementarity Assessment

**Could we run both servers side by side?**

Technically yes — Claude Code supports multiple MCP servers. But the overlap is too large for it to be practical:

- Both parse C3 JSON, both mutate event sheets, both track project structure
- Their raw JSON output would be redundant with our DSL/layout summaries
- Their imperative mutations would conflict with our recipe workflow
- Two servers = double the tool list = LLM confusion about which tool to use

**Where running both would help:**

- Their analysis tools (orphan detection, performance heuristics, function map) — but these are easy to port
- Their object/layout CRUD — but we rarely need this outside the C3 editor

**Verdict:** Build one server, borrow their best ideas. The three analysis features worth porting (function call-site index, reverse include graph, uncalled function detection) are ~100 LOC total in our codebase. The MCP design patterns (detail levels, fuzzy suggestions, safety limits) are structural decisions for our server, not code to copy.
