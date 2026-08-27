---
type: reference
title: "User-Defined Ops"
description: >-
  User-defined ops: op file format, param types, substitution rules, MCP (`list-ops` / `op-<projectId>_<opName>` / hot reload) and CLI (`list-ops` / `apply-op`) surfaces, and the `ops.dir` / `ops.watch` config keys
tags: [reference, ops, config]
status: stable
stale_after: 2027-02-20
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# User-Defined Ops

User-defined ops are parameterized recipe templates. A team drops JSON op files into a configurable `ops/` directory; each file becomes a reusable, typed mutation tool available on both the MCP server and the CLI.

This is phase 3 of the configuration-layer architecture (#23), building on `extractedDir` (phase 1) and `navigation` convention (phase 2).

See [recipe-reference.md](./recipe-reference.md) for the recipe body format that goes inside an op file, and [cli.md](./cli.md) for the `list-ops` / `apply-op` CLI command flags.

---

## Op file format

Each op is a single JSON file in the ops directory. The file name (without `.json`) becomes the op name.

```json
{
  "description": "Add a new screen layout + event sheet",
  "params": [
    { "name": "SCREEN_NAME", "type": "string", "required": true, "description": "PascalCase screen name" },
    { "name": "DEPTH", "type": "number", "default": 0 }
  ],
  "recipe": {
    "files": {
      "eventSheets/{{SCREEN_NAME}}.json": {
        "create": true,
        "events": []
      }
    }
  }
}
```

### Top-level fields

| Field | Required | Description |
| ----- | -------- | ----------- |
| `description` | yes | One-line description shown in `list-ops` and in MCP tool metadata. |
| `params` | no | Array of parameter declarations (see below). Defaults to `[]`. |
| `recipe` | yes | A normal construct3-chef recipe with `{{PARAM}}` placeholders. Validated against the recipe schema after substitution. |

### Param declaration fields

| Field | Required | Description |
| ----- | -------- | ----------- |
| `name` | yes | The placeholder identifier used in the recipe (e.g. `SCREEN_NAME`). |
| `type` | yes | `"string"`, `"number"`, or `"boolean"`. Determines the typed value injected during substitution. |
| `description` | no | Human-readable description shown in `list-ops` and in the MCP tool's input schema. |
| `required` | no | Whether the param must be supplied. Defaults to `true`. |
| `default` | no | Value used when `required` is `false` and no arg is provided. Must match the declared `type`. |

A param with `required: false` and no `default` is optional with no fallback — omitting it leaves the placeholder unresolved, which the substitution guard catches (see below).

---

## Op naming

The op name is derived from the filename sans `.json`. It must match `/^[a-z0-9][a-z0-9-]*$/i`. The corresponding MCP tool is named `op-<projectId>_<opName>` — every registered project gets its own `OpsRegistry` instance, scoped to that project's `ops/` directory, so `alpha`'s `ops/add-screen.json` registers as `op-alpha_add-screen`, not the flat `op-add-screen` a single-project server previously used. The separator is `_`, never `-`: op names allow `-` and so do project ids, so `op-<id>-<name>` is ambiguous (project `a` + op `b-c` and project `a-b` + op `c` both yield `op-a-b-c`); neither charset admits `_`. This applies uniformly, including to the default project — there is no flat fallback form. See ADR [0034](../decisions/0034-mcp-server-multi-project-support.md).

Files whose names fail this check are skipped (a load error is reported by `list-ops`).

---

## Substitution semantics

Placeholders take the form `{{PARAM}}` where `PARAM` is a declared param name. Substitution is applied recursively to all strings and object keys in the recipe.

**Typed whole-value substitution.** When a string is exactly `"{{PARAM}}"` (nothing else), it is replaced by the param's typed value: a `number` param yields a real JSON number, `boolean` yields a boolean, `string` yields a string. This is how `"count": "{{MAX}}"` becomes `"count": 5` rather than `"count": "5"`.

**Text interpolation.** When `{{PARAM}}` appears embedded in a larger string (`"Screen_{{NAME}}"`), the token is replaced by `String(value)` and the result stays a string.

**Object key interpolation.** `{{PARAM}}` in an object key is always text-interpolated (keys are always strings). This is how `"layouts": { "{{SCREEN_NAME}}": { … } }` resolves to the correct layout key.

### Substitution guards

All four checks run before any file is written. Any failure produces an error message and aborts the op.

| Guard | Trigger |
| ----- | ------- |
| Missing required param | A `required: true` param has no supplied arg and no default. |
| Unknown argument | An arg key is not declared in the op's `params`. |
| Unresolved placeholder | A `{{token}}` remains in the serialized recipe after substitution (e.g. a misspelled param name or a param that was declared optional with no default). |
| Recipe validation failure | `validateRecipe` rejects the substituted recipe (same validator used by `apply-recipe`). |

---

## Configuration

Add an `ops` block to `construct3-chef.config.json` at the project root to override defaults:

```json
{
  "ops": {
    "dir": "ops",
    "watch": true
  }
}
```

| Field | Default | Description |
| ----- | ------- | ----------- |
| `ops.dir` | `"ops"` | Directory scanned for op files. Path-contained to the project root (an escaping path falls back to `<root>/ops` with a warning). |
| `ops.watch` | `true` | MCP hot-reload via `fs.watch`. Set `false` to disable (ops are then scanned once at server startup; changes need a server restart). The CLI ignores `watch` — it always re-reads the ops dir on each invocation. |

A missing `ops` block is equivalent to the defaults above. The ops dir need not exist — an absent directory is treated as empty (no error).

---

## MCP surface

### `list-ops` (read-only)

Returns the same formatted list as the CLI `list-ops` command (shared `formatOpsList` formatter) for the target project. Each entry shows the op name, description, and parameters with their types and required/optional/default qualifiers.

Accepts the standard optional `project` id parameter (omit for the default project); no other input.

### `op-<projectId>_<opName>` (mutate)

One tool per op per registered project, registered as `op-<projectId>_<opName>` (e.g. `op-alpha_add-screen`) — see [Op naming](#op-naming) for why the id is baked into the tool name rather than passed as a `project` parameter. The input schema is derived from the op's `params` array — each param becomes a typed, optionally-described input field.

Applying an op tool:
1. Substitutes params into the recipe template.
2. Validates the substituted recipe.
3. Applies the recipe through the same path as `apply-recipe` (writes source JSON, regenerates `extracted/`).
4. Returns the apply result, including the updated `txId`.

Substitution errors (unknown args, missing required params, unresolved placeholders, invalid recipe) are returned as `isError: true` content rather than thrown — the server stays running.

### Hot reload

When `ops.watch` is `true` (the default), the `OpsRegistry` watches the ops directory with `fs.watch`. Adding, editing, or removing an op file triggers a debounced reconcile:

- **New op file** → registers a new `op-<projectId>_<opName>` tool (MCP `tools/list_changed` notification sent automatically by the SDK).
- **Edited op file** → updates the existing tool's description and input schema in place.
- **Removed op file** → removes the tool.

Hot reload requires the ops directory to exist when the server starts. If the directory does not exist at startup, watching is skipped; create the directory and restart the server to enable it.

---

## CLI surface

### `list-ops`

```bash
npx construct3-chef list-ops [--project-dir <path>]
```

Prints the same formatted list as the MCP `list-ops` tool. Load errors (malformed files, bad op names) are reported below the op list.

Example output:

```
op: add-screen
  Add a new screen layout + event sheet
  params:
    SCREEN_NAME [string] (required) — PascalCase screen name
    DEPTH [number] (default: 0)
```

### `apply-op`

```bash
npx construct3-chef apply-op <name> [options] [--project-dir <path>]
```

| Argument/Option | Description |
| --------------- | ----------- |
| `name` | Op name to apply (positional, required). E.g. `add-screen`. |
| `--param KEY=VALUE` | Supply a param value. Repeatable. Overrides values from `--params-file`. |
| `--params-file <path>` | Path to a JSON file containing `{ "PARAM": value }` pairs (base values; `--param` entries override). |
| `--dry-run` | Validate and preview without writing any files. |
| `--preview` | Show diff of script changes (implies `--dry-run`). |
| `--regenerate` / `--no-regenerate` | Regenerate `extracted/` after applying (default: `true`). |

CLI args are always strings (from the shell). The `apply-op` command coerces each `--param` value to the param's declared type before substitution:

- `number` params: parsed via `Number()` — errors if the result is `NaN`.
- `boolean` params: accepts only `"true"` or `"false"` — errors on anything else.
- `string` params: left as-is.

Values supplied via `--params-file` are already parsed JSON and are passed through with their native types (no coercion needed if the file contains `5` rather than `"5"`).

```bash
# Apply add-screen with a required param
npx construct3-chef apply-op add-screen --param SCREEN_NAME=Heroes

# Apply with both required and optional params
npx construct3-chef apply-op add-screen --param SCREEN_NAME=Heroes --param DEPTH=2

# Dry-run to preview changes
npx construct3-chef apply-op add-screen --param SCREEN_NAME=Heroes --dry-run

# Supply params from a file, override one on the command line
npx construct3-chef apply-op add-screen --params-file params.json --param SCREEN_NAME=Override
```
