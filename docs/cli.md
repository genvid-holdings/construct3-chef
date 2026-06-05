# CLI Reference

All subcommands are provided by the `construct3-chef` binary. Every subcommand accepts the global `--project-dir` option.

```bash
npx construct3-chef <subcommand> [options]
```

## Global Options

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--project-dir <path>` | `cwd` | Root directory of the C3 project (must contain `project.c3proj`) |

---

## Configuration file

Drop an optional `construct3-chef.config.json` at the project root (`--project-dir`) to override defaults. It is read by both the CLI and the MCP server; there are no per-key CLI flags. A missing, malformed, or out-of-bounds config falls back to defaults rather than erroring.

| Field | Default | Description |
| ----- | ------- | ----------- |
| `extractedDir` | `"extracted"` | Directory (relative to the project root) for the generated read-surface files. Must resolve **inside** the project root. |
| `navigation.targetPatterns` | the two `System.go-to-layout…` patterns | Regexes (each with **one capture group** = the target layout name) that [`navigation-graph`](#navigation-graph) scans the DSL for. Override when your project navigates through a wrapper function instead of the built-in System action. |
| `navigation.definitionMarkers` | `[]` | Substrings that mark a line as a function *definition* (not a call) so it is skipped — e.g. `"function GoToLayout"` to keep a wrapper's own definition out of the graph. |

```json
{ "extractedDir": "c3-extracted" }
```

With the above, every command that reads or writes the read surface — `generate`, `apply-recipe`, `scaffold-layout`, `remove-layer`, `rename-symbol`, `navigation-graph`, `search-dsl`, and the server's auto-generate/regenerate — targets `c3-extracted/` instead of `extracted/`. The C3-fixed source directories (`eventSheets/`, `layouts/`, `objectTypes/`, `families/`, `scripts/`) are not configurable.

By default `navigation-graph` detects the built-in `System.go-to-layout` and `System.go-to-layout-by-name` actions, so it works on any project with no config. A project that wraps navigation in its own function points the graph at the wrapper instead — a bad regex is dropped (the rest of the config still loads):

```json
{
  "navigation": {
    "targetPatterns": ["GoToLayout\\(\"([^\"]+)\""],
    "definitionMarkers": ["function GoToLayout"]
  }
}
```

---

## server

Start the MCP server over stdio. AI coding agents connect to this to read and mutate the project interactively.

```bash
npx construct3-chef server [--project-dir <path>]
```

The server auto-generates `extracted/` on startup if it does not exist. It warns but does not fail if `project.c3proj` is not found.

See [README.md](../README.md#mcp-server) for the full list of MCP tools.

---

## generate

Generate all `extracted/` files from C3 JSON, or a specific type.

```bash
npx construct3-chef generate [--only <type>] [--project-dir <path>]
```

| Option | Description |
| ------ | ----------- |
| `--only <type>` | Generate only one type: `scripts`, `dsl`, `layouts`, `templates`, `sid-registry`, `global-layers` |

When run without `--only`, all six generators run in sequence:

1. **scripts** — Extract TypeScript from event sheet script actions → `extracted/**/*.ts`
2. **dsl** — Generate human-readable DSL and index → `extracted/**/*.dsl.txt`, `*.dsl.idx.txt`
3. **layouts** — Generate layout summaries → `extracted/**/*.layout.txt`
4. **templates** — Generate cross-layout template scope → `extracted/template-scope.txt`
5. **sid-registry** — Generate sorted global SID list → `extracted/sid-registry.txt`
6. **global-layers** — Generate global-layer report (source + overriding layouts + instance counts) → `extracted/global-layers.txt`

---

## apply-recipe

Apply a JSON recipe file. Modifies event sheets, layouts, and objectTypes as described by the recipe.

```bash
npx construct3-chef apply-recipe <recipe> [options] [--project-dir <path>]
```

| Argument/Option | Description |
| --------------- | ----------- |
| `recipe` | Path to the recipe JSON file (required positional) |
| `--dry-run` | Validate and preview without writing any files |
| `--preview` | Show diff of script changes (implies `--dry-run`) |
| `--regenerate` / `--no-regenerate` | Regenerate `extracted/` after applying (default: `true`) |

After applying, `generate` runs automatically unless `--no-regenerate` is passed.

See [recipe-reference.md](recipe-reference.md) for the recipe JSON format.

---

## rename-symbol

Rename symbols across all event sheet script actions. Equivalent to a `rename-symbol` recipe op applied globally, but invokable as a standalone command.

```bash
# Inline: single replacement
npx construct3-chef rename-symbol <from> <to> [options]

# From file: multiple replacements
npx construct3-chef rename-symbol --replacements <file.json> [options]
```

| Argument/Option | Description |
| --------------- | ----------- |
| `from` | Symbol to find (positional, mutually exclusive with `--replacements`) |
| `to` | Replacement symbol (positional, mutually exclusive with `--replacements`) |
| `--replacements <file>` | Path to JSON file with `[{ "from": "...", "to": "..." }]` pairs |
| `--dry-run` | Show what would change without writing |
| `--preview` | Show diff of script changes (implies `--dry-run`) |
| `--regenerate` / `--no-regenerate` | Regenerate `extracted/` after applying (default: `true`) |

Replacements file format:

```json
[
  { "from": "oldNamespace.funcA(", "to": "newNamespace.funcA(" },
  { "from": "oldNamespace.funcB(", "to": "newNamespace.funcB(" }
]
```

Replacements are sorted longest-first to prevent substring corruption.

---

## validate-project

Dry-run check that `project.c3proj` matches files on disk. Exits with code 1 if drift is detected.

It additionally reports **image drift** as `[images]` lines: image files expected by an object type (derived from `objectTypes/` JSON — an `image` key, or `animations` frames) but missing from `images/` on disk, or files in `images/` no object type references. Image drift is **detection-only** — informational output that does **not** affect the exit code or `sync-project`'s write-back (images are referenced inside object-type JSON, not declared as `project.c3proj` entries).

```bash
npx construct3-chef validate-project [--section <section>] [--project-dir <path>]
```

| Option | Description |
| ------ | ----------- |
| `--section <section>` | Only validate one section (see `sync-project` for valid values) |

---

## sync-project

Write `project.c3proj` to match files on disk. Adds missing entries and removes stale ones.

```bash
npx construct3-chef sync-project [--section <section>] [--project-dir <path>]
```

| Option | Description |
| ------ | ----------- |
| `--section <section>` | Only sync one section |

Run this after adding or removing files in tracked C3 directories (event sheets, layouts, object types, scripts, etc.).

---

## scaffold-layout

Clone an existing layout to create a new one. Remaps all UIDs and SIDs for uniqueness, sets the layout name and event sheet, writes the new layout JSON, and syncs `project.c3proj`.

```bash
npx construct3-chef scaffold-layout \
  --source <source-layout.json> \
  --out <new-layout.json> \
  --name <LayoutName> \
  --event-sheet <EventSheetName> \
  [--no-regenerate] \
  [--project-dir <path>]
```

| Option | Required | Description |
| ------ | -------- | ----------- |
| `--source <path>` | yes | Path to the source layout JSON file |
| `--out <path>` | yes | Output path for the new layout JSON file |
| `--name <name>` | yes | Name for the new layout (shown in C3 editor) |
| `--event-sheet <name>` | yes | Event sheet name to associate with the new layout |
| `--no-regenerate` | no | Skip regenerating `extracted/` after scaffolding |

After scaffolding, `project.c3proj` is automatically synced and `extracted/` is regenerated.

---

## scaffold-sprite

Clone a sprite objectType to create a new one. Remaps all SIDs and imageSpriteIds for uniqueness, copies associated image files, writes the new objectType JSON, and syncs `project.c3proj`.

```bash
npx construct3-chef scaffold-sprite \
  --source <SourceSpriteName> \
  --name <NewSpriteName> \
  [--project-dir <path>]
```

| Option | Required | Description |
| ------ | -------- | ----------- |
| `--source <name>` | yes | Source objectType name (plain name, no path or extension) |
| `--name <name>` | yes | Target objectType name |

The command:
- Reads `objectTypes/<source>.json`
- Clones it with new SIDs and the next available imageSpriteId
- Writes `objectTypes/<name>.json`
- Copies `images/<source>-*.png` to `images/<name>-*.png`
- Syncs `project.c3proj`

---

## remove-layer

Remove a layer from a layout. Strict by default — fails if the layer has instances or sublayers unless the appropriate flag is passed.

```bash
npx construct3-chef remove-layer \
  --layout <layout.json> \
  --layer <LayerName> \
  [--cascade] \
  [--remove-instances] \
  [--dry-run] \
  [--no-regenerate] \
  [--project-dir <path>]
```

| Option | Description |
| ------ | ----------- |
| `--layout <path>` | Relative path to the layout JSON within `layouts/` (e.g. `'Main Layout.json'`) |
| `--layer <name>` | Name of the layer to remove |
| `--cascade` | Remove the entire sublayer subtree recursively |
| `--remove-instances` | Force removal even when the layer contains instances |
| `--dry-run` | Validate and preview without writing any files |
| `--regenerate` / `--no-regenerate` | Regenerate `extracted/` after applying (default: `true`) |

```bash
# Remove an empty layer from a layout
npx construct3-chef remove-layer \
  --layout "Main Layout.json" \
  --layer "layer 0" \
  --dry-run

# Cascade-remove a parent layer and all its sublayers (even with instances)
npx construct3-chef remove-layer \
  --layout "Main Layout.json" \
  --layer "UI" \
  --cascade \
  --remove-instances
```

---

## list-templates

List all template instances across layouts, grouped by layout.

```bash
npx construct3-chef list-templates [--project-dir <path>]
```

Prints a grouped report:

```
Heroes/HeroesLayout:
  HeroCard
  HeroCard

Watch/WatchLayout:
  VideoCard
```

---

## navigation-graph

Show all navigation calls found in extracted DSL files, or write a PlantUML component diagram. By default it detects the built-in `System.go-to-layout` / `System.go-to-layout-by-name` actions; configure `navigation.targetPatterns` (see [Configuration file](#configuration-file)) to scan a project-specific wrapper function instead.

```bash
# Print to stdout
npx construct3-chef navigation-graph [--project-dir <path>]

# Write PlantUML
npx construct3-chef navigation-graph --plantuml <output.puml> [--project-dir <path>]
```

| Option | Description |
| ------ | ----------- |
| `--plantuml <file>` | Write a PlantUML component diagram to this file |

When printing to stdout, each row shows the source event sheet, the target layout, and the line number in the extracted DSL file. Entries are sorted by source sheet then line number.

Requires `extracted/` to be up to date (run `generate` first if needed).

---

## search-dsl

Regex search across extracted DSL files. Returns matching lines with file path and line number.

```bash
npx construct3-chef search-dsl <pattern> [--glob <subdir>] [--project-dir <path>]
```

| Argument/Option | Description |
| --------------- | ----------- |
| `pattern` | Regex pattern to search for (required positional) |
| `--glob <subdir>` | Restrict search to a subdirectory within `extracted/` |

Results are capped at 1000 matches; narrow the pattern or glob if truncated.

```bash
# Search all DSL files
npx construct3-chef search-dsl "loadHero\("

# Search only Goals/ subdirectory
npx construct3-chef search-dsl "loadHero\(" --glob Goals
```

Requires `extracted/` to be up to date.
