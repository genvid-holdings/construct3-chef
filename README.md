# construct3-chef

A toolkit for automating Construct 3 project mutations: event sheet recipes, generators, layout scaffolding, sprite scaffolding, and an MCP server for AI-assisted editing.

## What it does

Construct 3 stores project data as JSON files on disk (event sheets, layouts, object types). construct3-chef provides:

- **Recipes** — JSON-driven mutation scripts that insert/remove/patch events, actions, conditions, and layout instances without opening the C3 editor
- **Generators** — extract human-readable DSL, TypeScript, and layout summaries from C3 JSON, committed alongside source for diffing and code review
- **Scaffolding** — clone layouts or sprite objectTypes with remapped UIDs and SIDs
- **MCP server** — exposes all of the above as Model Context Protocol tools for AI coding agents

## Installation

```bash
npm install @genvidtech/construct3-chef
```

Requires Node.js 22+. The installed CLI binary is named `construct3-chef`.

## Quick Start

All commands accept a global `--project-dir` option (defaults to `cwd`). Point it at the root of your C3 project — the directory containing `project.c3proj`.

```bash
# Generate extracted/ files from C3 JSON (run after editing event sheets)
npx @genvidtech/construct3-chef generate --project-dir /path/to/c3project

# Apply a recipe
npx @genvidtech/construct3-chef apply-recipe my-recipe.json --project-dir /path/to/c3project

# Validate project.c3proj matches disk
npx @genvidtech/construct3-chef validate-project --project-dir /path/to/c3project

# Start the MCP server
npx @genvidtech/construct3-chef server --project-dir /path/to/c3project
```

If you install globally or add to `package.json` scripts, you can omit `npx`.

## CLI Overview

21 subcommands — all accept `--project-dir <path>` (defaults to `cwd`). The table below is kept in lockstep with `src/cli.ts` by `test/readmeCommandInventory.test.ts`.

| Subcommand | Purpose |
| ---------- | ------- |
| `server` | Start the MCP server over stdio |
| `generate [--only <type>]` | Generate all extracted/ files, or one type: `scripts`, `dsl`, `layouts`, `templates`, `sid-registry`, `global-layers` |
| `apply-recipe <file>` | Apply an event sheet mutation recipe |
| `rename-symbol <from> <to>` | Rename a symbol across all event sheet scripts |
| `validate-project` | Dry-run: check that `project.c3proj` matches files on disk |
| `sync-project` | Write `project.c3proj` to match files on disk |
| `scaffold-layout` | Clone a layout with remapped UIDs/SIDs |
| `scaffold-sprite` | Clone a sprite objectType with remapped SIDs and copied images |
| `remove-layer` | Remove a layer from a layout |
| `list-templates` | List all template instances across layouts |
| `navigation-graph` | Print GoToLayout calls (or write a PlantUML diagram) |
| `search-dsl <pattern>` | Regex search across extracted DSL files |
| `search-docs` | Search the C3 ACE reference (action/condition/expression ids, param names) for custom addons and the built-in reference cache |
| `read-addon [name]` | Read a C3 addon's metadata + ACE summary (or a raw entry, or list all addons); works on extracted and archive-only addons |
| `validate-addons [--addon <id|path>]` | Validate bundled `.c3addon` packages against `project.c3proj.usedAddons` (metadata, integrity, orphan/missing/duplicate) and each addon's `aces.json`/`plugin.js` properties against its `lang/*.json` locales; `--addon` scopes to one addon (by id or source-tree path). Read-only, non-zero exit on findings |
| `list-addons` | Unified addon inventory — bundled `.c3addon` packages, `project.c3proj.usedAddons` entries, and editor-only addons — one row per addon with status, version, and package path. Read-only, never fails |
| `diff-addon-aces <from> <to>` | Diff the ACE contract between two addon versions: added/removed ACEs plus changed param signatures. Sources are local (a `.c3addon` path, a discovered id, or an extracted dir). Read-only |
| `scan-addon-usage <addon>` | Find where a plugin, behavior, or effect addon is used: object/family presence, event-sheet ACE call sites, and expression references. `--from` reports blast radius against a prior version, exiting non-zero when any affected site exists. Read-only |
| `sync-addon-metadata --direction <manifest-from-package\|package-from-manifest>` | Sync a bundled `.c3addon` package's `version`/`author` with its `project.c3proj.usedAddons` entry; `manifest-from-package` writes, `package-from-manifest` is a read-only report (chef has no `.c3addon` writer). `--addon` scopes to one addon by id only. `--dry-run` previews. Exits non-zero iff outstanding human work remains |
| `list-ops` | List available user-defined ops |
| `apply-op <name>` | Apply a user-defined op by name |

See [wiki/reference/cli.md](./wiki/reference/cli.md) for full flag documentation (addon-tooling commands — `read-addon`, `validate-addons`, `list-addons`, `diff-addon-aces`, `scan-addon-usage`, `sync-addon-metadata` — are in [wiki/reference/cli-addons.md](./wiki/reference/cli-addons.md)).

## Recipes

Recipes are JSON files that describe mutations to event sheets and layouts. They are the primary way to modify C3 projects programmatically.

```bash
# Validate without writing
npx @genvidtech/construct3-chef apply-recipe my-recipe.json --dry-run

# Show script diffs
npx @genvidtech/construct3-chef apply-recipe my-recipe.json --preview

# Apply and regenerate extracted/
npx @genvidtech/construct3-chef apply-recipe my-recipe.json
```

See [wiki/reference/recipe-reference.md](./wiki/reference/recipe-reference.md) for the full recipe format, all 15 event sheet operations, all 12 layout operations, and the builder shorthand syntax.

## Generators

The `generate` subcommand produces `extracted/` files that make C3 JSON human-readable:

| Type | Output | Description |
| ---- | ------ | ----------- |
| `scripts` | `extracted/**/*.ts` | TypeScript extracted from event sheet script actions |
| `dsl` | `extracted/**/*.dsl.txt` | Human-readable event sheet DSL |
| `dsl` | `extracted/**/*.dsl.idx.txt` | JSON-path and SID index for recipe targeting |
| `layouts` | `extracted/**/*.layout.txt` | Layer/instance summary for each layout |
| `templates` | `extracted/template-scope.txt` | Cross-layout template instance map |
| `sid-registry` | `extracted/sid-registry.txt` | Sorted list of all SIDs in the project |

It is recommended to commit `extracted/` alongside C3 source files for diffability and code review. Run `generate` after editing event sheets or layouts.

See [wiki/reference/generators.md](./wiki/reference/generators.md) for internals, output format, and cross-reference syntax.

## MCP Server

`construct3-chef server` starts a Model Context Protocol server over stdio. AI coding agents can connect to it to read and mutate a C3 project interactively.

### Starting the server

```bash
npx @genvidtech/construct3-chef server --project-dir /path/to/c3project
```

Configure it in your MCP client (example for Claude Desktop or similar):

```json
{
  "mcpServers": {
    "construct3-chef": {
      "command": "npx",
      "args": ["@genvidtech/construct3-chef", "server", "--project-dir", "/path/to/c3project"]
    }
  }
}
```

### Available MCP tools

The server can host more than one C3 project root at once (see [Multi-project support](#multi-project-support) below). Every tool listed here except `list-projects` accepts an optional `project` id parameter to target a non-default registered project; omit it to target the default project. `txId` values are the composite `<projectId>:<counter>` string described in [Optimistic concurrency](#optimistic-concurrency).

**Read tools** (read-only, idempotent):

| Tool | Description |
| ---- | ----------- |
| `list-event-sheets` | List all event sheet JSON files in the project |
| `list-layouts` | List all layout JSON files in the project |
| `list-global-layers` | List each global layer with its source layout, overriding layouts, and instance count |
| `read-dsl` | Read the human-readable DSL for an event sheet |
| `read-dsl-index` | Read the JSON-path/SID index for recipe targeting (supports grep filter) |
| `read-event-sids` | Read SIDs directly from source JSON (useful after apply-recipe, before regenerate) |
| `read-scripts` | Read the extracted TypeScript for an event sheet |
| `read-layout` | Read the layout summary (layers, instances, templates) |
| `read-template-scope` | Read the cross-layout template scope reference |
| `read-sid-registry` | Read the global SID registry |
| `list-include-tree` | Show the transitive include tree for an event sheet |
| `search` | Regex search across extracted files (DSL, TypeScript, layout summaries, JSON) |
| `search-docs` | Search the C3 ACE reference (action/condition/expression ids, param names) for custom addons and the built-in reference cache |
| `resolve-anchor` | Look up a DSL coordinate by line number, SID, or name pattern |
| `navigation-graph` | Show the layout navigation graph as a from→to→line table, or as PlantUML with `format:"plantuml"` |
| `validate-recipe` | Validate a recipe JSON without applying it (returns txId) |
| `validate-project` | Dry-run project.c3proj sync check |
| `read-addon` | Read a C3 addon's metadata + ACE summary (or a raw entry, or list all addons); works on extracted and archive-only addons |
| `validate-addons` | Validate bundled `.c3addon` packages against `project.c3proj.usedAddons` (metadata, integrity, orphan/missing/duplicate) and each addon's `aces.json`/`plugin.js` properties against its `lang/*.json` locales; optional `addon` param scopes to one addon (by id or source-tree path). Read-only |
| `list-addons` | Unified addon inventory — one row per addon reconciling bundled `.c3addon` packages, `usedAddons` entries, and editor-only addons, with status and version |
| `diff-addon-aces` | Diff the ACE contract between two addon versions: added/removed ACEs plus changed param signatures |
| `scan-addon-usage` | Find where a plugin, behavior, or effect addon is used: object/family presence, event-sheet ACE call sites, and expression references; `from` reports blast radius against a prior version |
| `preview-addon-metadata-sync` | Dry-run report of `version`/`author` drift between bundled `.c3addon` packages and `project.c3proj.usedAddons` — the read-only preview for `sync-addon-metadata`. Optional `addon` param scopes to one addon by id. Never writes |
| `list-ops` | List the target project's user-defined ops (parameterized recipe templates) with their parameters |
| `get-state` | Return server state for the target project: txId and extractedDirty flag |
| `list-projects` | List every project registered at launch (id, root, extractedDir, default). The only tool with no `project` parameter — it enumerates the registry itself |

**Mutate tools** (modify source files):

| Tool | Description |
| ---- | ----------- |
| `apply-recipe` | Apply a recipe JSON string, optionally regenerate extracted/ |
| `sync-project` | Sync project.c3proj to match disk |
| `scaffold-layout` | Clone a layout with new UIDs/SIDs |
| `scaffold-sprite` | Clone a sprite objectType with new SIDs and copied images |
| `remove-layer` | Remove a layer from a layout; strict by default, with `cascade` / `removeInstances` overrides |
| `extract-template` | Extract an instance + its scene-graph children into a reusable master template, converting the original into a replica |
| `templatize-in-place` | Convert an existing instance into the master template on its current layout |
| `clone-replica-to-layouts` | Add a replica of an existing template to one or more target layouts in one call |
| `replace-instance-with-replica` | Remove an instance and place a replica of a named template in its spot (same layer, same world props) |
| `sync-addon-metadata` | Sync `project.c3proj.usedAddons` `version`/`author` fields against bundled `.c3addon` packages; only `direction: "manifest-from-package"` writes. Optional `addon` param scopes to one addon by id |

**Non-idempotent read tool** (reads source only, but returns different output per call — do not treat as idempotent for retry or caching):

| Tool | Description |
| ---- | ----------- |
| `generate-sids` | Mint fresh unique C3 SIDs seeded from `sid-registry.txt`; minted SIDs are **not** persisted back to the registry |

**Regenerate tool**:

| Tool | Description |
| ---- | ----------- |
| `regenerate` | Run all 6 generators and update extracted/ |

### Optimistic concurrency

Each registered project maintains its own `txId` counter that increments on every source-file mutation, emitted and accepted on the wire as a composite `<projectId>:<counter>` string (e.g. `alpha:12`) rather than a bare integer — a bare integer would make an equal counter across two projects, the common case, silently acceptable against the wrong one. Read the current `txId` from `validate-recipe` or `get-state`, then pass it to `apply-recipe` or `sync-project`. If the target project changed between validate and apply, or the token names a different project than the call's `project` parameter, the server rejects the operation and returns the current `txId` so you can re-validate.

### Multi-project support

`server` can host more than one C3 project root in a single process: pass `--project-dir` repeatedly (each optionally prefixed `<id>=`), or set `C3_PROJECT_DIRS` (a `path.delimiter`-separated list of the same `[<id>=]<path>` specs). A bare `--project-dir` or `C3_PROJECT_DIR` continues to register exactly one project, unchanged. Every tool call targets exactly one project, selected by the optional `project` id parameter (see `list-projects` to discover registered ids); user-defined ops are namespaced per project as `op-<projectId>_<opName>`. See [wiki/reference/cli.md](./wiki/reference/cli.md#server) for the full launch-config precedence and [wiki/decisions/0034](./wiki/decisions/0034-mcp-server-multi-project-support.md) for the design.

## Project structure expected

construct3-chef expects the standard C3 "project folder" layout:

```
project.c3proj
eventSheets/
layouts/
objectTypes/
scripts/
  ts-defs/
    instanceTypes.d.ts
    objects.d.ts
files/
images/
addons/
```

The `extracted/` directory is written by `generate` and read by the MCP server. It does not need to exist before the first `generate` run — the server auto-generates it on startup if missing.

## Documentation

All project documentation lives in the [wiki](./wiki/index.md) — reference manuals, architecture and research notes, process docs, and the decision records. Start at [wiki/index.md](./wiki/index.md); the most-used pages are:

- [wiki/reference/recipe-reference.md](./wiki/reference/recipe-reference.md) — Complete recipe reference: format, SID addressing, all 15 event sheet operations, all 12 layout operations, builder shorthands, gotchas
- [wiki/reference/generators.md](./wiki/reference/generators.md) — Generator internals, output format, cross-referencing C3 errors, localVars matching
- [wiki/reference/cli.md](./wiki/reference/cli.md) — Full CLI flag documentation for all subcommands
- [wiki/reference/cli-addons.md](./wiki/reference/cli-addons.md) — Addon-tooling commands (`read-addon`, `validate-addons`, `list-addons`, `diff-addon-aces`, `scan-addon-usage`, `sync-addon-metadata`)
