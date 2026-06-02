# Recipe Reference

Recipes are JSON files that describe mutations to C3 event sheets and layouts. Apply them with:

```bash
npx construct3-chef apply-recipe <recipe.json> [--dry-run] [--preview] [--no-regenerate]
```

Or via the MCP server's `apply-recipe` tool.

## Top-Level Structure

All sections are optional, but at least one must be present.

```json
{
  "autoAdjust": true,
  "objectTypes": [ ...ObjectTypeCreate ],
  "addInstVars": [ ...AddInstVarsEntry ],
  "files": {
    "eventSheets/Path/SheetName.json": [ ...ops ],
    "eventSheets/Path/NewSheet.json":  { "create": true, "events": [...] },
    "Path/SheetName": [ ...ops ]
  },
  "layouts": {
    "layouts/Path/Layout.json": [ ...ops ],
    "Path/Layout": [ ...ops ]
  }
}
```

Processing order: `objectTypes` → `addInstVars` → `layouts` → `files`.

**Path normalization**: Both `files` and `layouts` keys accept bare paths (e.g., `"Goals/GoalsEvents"`, `"Login/LoginLayout"`) — they are automatically expanded to full paths (`"eventSheets/Goals/GoalsEvents.json"`, `"layouts/Login/LoginLayout.json"`). Full paths still work.

### `autoAdjust` (deprecated)

**Deprecated.** Setting `"autoAdjust": true` now only emits a warning and has no effect. Use [SID-based addressing](#sid-based-addressing) instead.

---

## objectTypes Section

Creates C3 data-plugin objectType files and updates TypeScript definitions in one step.

```json
{
  "objectTypes": [
    {
      "name": "FooJSON",
      "plugin": "Json",
      "folder": "Playfab",
      "instanceVariables": [
        { "name": "ParsingKey", "type": "string" }
      ]
    }
  ]
}
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `name` | yes | objectType name (must match C3 object name) |
| `plugin` | yes | `"Json"` \| `"Dictionary"` \| `"Arr"` |
| `folder` | no | Subfolder under `objectTypes/` (created if absent). Default: root |
| `instanceVariables` | no | `[{ name, type }]` — type is `"string"` \| `"number"` \| `"boolean"` |

**Effects per entry:**

- Creates `objectTypes/[folder/]Name.json` (SID = 0; C3 assigns real SIDs on next save)
- Appends class to `scripts/ts-defs/instanceTypes.d.ts`
- Appends property to `scripts/ts-defs/objects.d.ts`

**Idempotent**: if the objectType file already exists, prints `SKIP` and does NOT re-update ts-defs.

**After applying:** run `sync-project` to register new objectType files with C3.

---

## addInstVars Section

Adds instance variables to existing objectTypes and updates all references (objectType JSON, layout instances, TypeScript definitions) in one step.

```json
{
  "addInstVars": [
    {
      "type": "MyObjectJSON",
      "instanceVariables": [
        { "name": "episodeCount", "type": "number" },
        { "name": "language", "type": "string" }
      ]
    }
  ]
}
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | Existing objectType name |
| `instanceVariables` | yes | Non-empty `[{ name, type }]` — type is `"string"` \| `"number"` \| `"boolean"` |

**Effects per entry (3 locations):**

1. **ObjectType JSON** — finds `objectTypes/**/Type.json` recursively, appends new variables
2. **Layout instances** — scans all layout files for instances of the type, adds default values (`0` for number, `""` for string, `false` for boolean)
3. **TypeScript defs** — updates `scripts/ts-defs/instanceTypes.d.ts`: adds fields to existing `instVars` block, or creates one

**Idempotent**: skips variables that already exist (by name) in each location.

---

## File Creation

```json
{ "create": true, "events": [ ...BuilderEvent ] }
```

Creates a new event sheet from scratch using builder events. Sheet name is derived from the file path (basename without `.json`).

---

## SID-Based Addressing

**Preferred over position-based paths for all new recipes.** Position-based paths (`events[N]`, `index: N`) go stale when any preceding op inserts or removes events in the same array. SIDs are immutable identifiers assigned by C3 to every event node.

### `in` field

All ops that previously accepted `path` now also accept `in`. When `in` is present it takes precedence:

```json
{ "op": "insert-actions", "in": "sid:100234567890123", "after": 0, "actions": [...] }
{ "op": "remove-action",  "in": "sid:100234567890123", "index": 2 }
{ "op": "remove-event",   "in": "sid:100234567890456" }
{ "op": "patch-script",   "in": "sid:100234567890123", "matchScript": "oldCall", "find": "oldCall(", "replace": "newCall(" }
```

`path` remains supported for backward compatibility.

### SID ref format

```
"sid:XXXXXXXXXXXXXXX"   — 15-digit SID, no leading zeros in the number itself
```

Copy SIDs from the `§XXXXXXXXXXXXXXX` column in `.dsl.idx.txt` (via `read-dsl-index`). Strip the `§` prefix and write `"sid:XXXXXXXXXXXXXXX"`.

### `$symbol` references

Assign `id: "$name"` on `insert-event` to name the new event. Reference it in later ops with `in: "$name"`:

```json
{ "op": "insert-event", "id": "$loginBlock", "index": 0, "block": { "conditions": [], "actions": [] } }
{ "op": "insert-actions", "in": "$loginBlock", "after": 0, "actions": [{ "script": ["doLogin();"] }] }
```

Symbols are per-file, per-recipe-execution. No cross-file symbol refs. Symbols only work for events inserted by earlier ops in the same recipe — not for pre-existing events (use `"in": "sid:X"` for those).

### `after: "sid:X"` on `insert-event`

Insert a new event immediately after a specific existing event in the same container:

```json
{ "op": "insert-event", "after": "sid:100234567890456", "block": { "conditions": [], "actions": [] } }
```

The new event is spliced at `indexInParent + 1` of the referenced event.

### Authoring workflow with SIDs

1. Use `read-dsl` (or read `.dsl.txt`) to understand the event sheet structure
2. Use `read-dsl-index` (or read `.dsl.idx.txt`) to get SIDs for target events (§-prefixed column)
3. Write recipe using `in: "sid:X"` for existing events, `id: "$symbol"` + `in: "$symbol"` for new events
4. Validate with `--dry-run` or the `validate-recipe` MCP tool

---

## Event Sheet Operations

15 file-mutation operations for event sheets. All operations have `"op": "<name>"`. Most accept `"in"` (SID-based, preferred) or `"path"` (position-based, still supported). `"paths"` (array) is position-based only. `"in"` and `"path"`/`"paths"` are mutually exclusive.

### insert-event

Inserts a single event. Supports SID-based and position-based targeting.

**Position-based** (container at `path`, insert at `index`):

```json
{ "op": "insert-event", "path": "events[2].children", "index": 0, "block": { ... } }
```

**SID-based** — insert after a specific existing event:

```json
{ "op": "insert-event", "after": "sid:100234567890456", "block": { ... } }
```

**Assign symbol** — name the new event for use in later ops:

```json
{ "op": "insert-event", "id": "$myBlock", "index": 0, "block": { ... } }
```

Event key must be exactly one of: `block`, `function-block`, `custom-ace-block`, `variable`, `group`, `comment`.

### insert-variables

Inserts multiple variables starting after position `after` in the container at `path`.

```json
{
  "op": "insert-variables",
  "path": "",
  "after": 2,
  "variables": [
    { "name": "myVar", "type": "number", "value": "0" }
  ]
}
```

### insert-actions

Inserts multiple actions after position `after`. Supports `path`/`paths`.

```json
{
  "op": "insert-actions",
  "path": "events[5]",
  "after": 1,
  "actions": [ { "script": ["doSomething();"] } ]
}
```

Use `paths` to apply the same actions at multiple locations in one operation:

```json
{
  "op": "insert-actions",
  "paths": ["events[3].children[0]", "events[3].children[1]"],
  "after": -1,
  "actions": [
    { "call": "RefreshData" },
    { "id": "wait-for-previous-actions", "object": "System", "params": {} }
  ]
}
```

### insert-conditions

Inserts multiple conditions after position `after`. Supports `path`/`paths`.

```json
{
  "op": "insert-conditions",
  "path": "events[5]",
  "after": 0,
  "conditions": [ { "id": "compare-two-values", "object": "System", "params": { ... } } ]
}
```

### replace-action / replace-condition

Replaces the action or condition at 0-based `index`. Supports `path`/`paths` and `"in": "sid:X"` SID-based targeting.

```json
{ "op": "replace-action", "path": "events[3]", "index": 0, "action": { "script": ["newCode();"] } }
{ "op": "replace-condition", "in": "sid:197670977357660", "index": 1, "condition": { "else": true } }
```

The `action`/`condition` field uses builder shorthand. The replaced item gets a new SID (not preserved).

### replace-event

Replaces the event at `index` inside the container at `path`. Same inline event key rules as `insert-event`.

```json
{ "op": "replace-event", "path": "", "index": 4, "block": { "conditions": [...], "actions": [...] } }
```

### remove-event / remove-action / remove-condition

Removes the item at `index`. `remove-action` and `remove-condition` support `path`/`paths`.

```json
{ "op": "remove-event",     "path": "",         "index": 3 }
{ "op": "remove-action",    "path": "events[2]","index": 1 }
{ "op": "remove-condition", "path": "events[2]","index": 0 }
```

**Full-path syntax for `remove-event`**: Pass the full node path — the interpreter splits it automatically:

```json
{ "op": "remove-event", "path": "events[4].children[1]" }
```

**Consecutive position-based removes**: List in **descending index order** — the interpreter no longer auto-sorts. Or use `in: "sid:X"` to avoid ordering concerns (SID removes are order-independent).

### add-include

Adds an `include` directive. No `path` needed. By default inserts at index 0. Use `after` to insert after a named include.

```json
{ "op": "add-include", "include": "SomeOtherSheet" }
{ "op": "add-include", "include": "NewSheet", "after": "ExistingSheet" }
```

### patch-script

Finds and replaces text inside a script action. Supports `path`/`paths`.

**By index** (0-based `actionIndex`):

```json
{
  "op": "patch-script",
  "path": "events[0].children[17]",
  "actionIndex": 2,
  "find": "oldCall(x)",
  "replace": "newCall(x)"
}
```

**By content** (`matchScript` — scans for the first script action containing the string):

```json
{
  "op": "patch-script",
  "path": "events[0].children[17]",
  "matchScript": "oldCall",
  "find": "oldCall(x)",
  "replace": "newCall(x)"
}
```

- Use `actionIndex` OR `matchScript` — not both
- `replace` can be a string or array of strings (array is joined with `\n`)
- Default replaces first occurrence only; set `"replaceAll": true` to replace all
- Throws if `find` is not found in the script

### patch-action-param

Modifies individual parameters on a C3 action without replacing the entire action. Preserves the action's SID and untouched parameters.

**Single param** (by index):

```json
{
  "op": "patch-action-param",
  "path": "events[2].children[0]",
  "actionIndex": 3,
  "param": "template-name",
  "value": "\"default\""
}
```

**Multiple params** (by `matchAction`):

```json
{
  "op": "patch-action-param",
  "path": "events[2].children[0]",
  "matchAction": "create-object",
  "params": {
    "template-name": "\"default\"",
    "create-hierarchy": true
  }
}
```

- Use `actionIndex` OR `matchAction` — not both. `matchAction` matches on `id` (StandardAction), `callFunction` (FunctionCallAction), or `customAction` (CustomAction)
- Use `param` + `value` for one parameter, or `params` (object) for multiple
- For FunctionCallAction/CustomAction, parameter keys are numeric indices (as strings) into the positional parameters array

### set-or-block

Converts a block event to an OR-block. Target must be a `block`.

```json
{ "op": "set-or-block", "path": "events[7]" }
```

### set-disabled

Enables or disables a group. Target must be a `group`.

```json
{ "op": "set-disabled", "path": "events[2]", "disabled": true }
```

### rename-symbol

Replaces symbol strings in **all script actions** across the entire sheet. No `path` needed — walks the full event tree. Throws if no replacements match.

```json
{
  "op": "rename-symbol",
  "replacements": [
    { "from": "oldNamespace.longFuncName(", "to": "newNamespace.longFuncName(" },
    { "from": "oldNamespace.func(",         "to": "newNamespace.func(" }
  ]
}
```

Replacements are automatically sorted longest-first to prevent substring corruption.

### patch-function-block

Adds or removes parameters on a function-block or custom-ace-block. Use one of `addParam` or `removeParam` per op.

```json
{ "op": "patch-function-block", "in": "sid:123456", "addParam": { "name": "p1", "type": "string" } }
{ "op": "patch-function-block", "in": "sid:123456", "addParam": { "name": "count", "type": "number", "initialValue": "42" } }
{ "op": "patch-function-block", "in": "sid:123456", "removeParam": "obsoleteParam" }
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `path` / `in` | one of | Target function-block (path or SID ref) |
| `addParam` | no* | `{ name, type, initialValue? }` — appends a new parameter with generated SID |
| `removeParam` | no* | Parameter name to remove |

\* Exactly one of `addParam` or `removeParam` is required.

**`addParam` defaults**: If `initialValue` is omitted, defaults to `""` (string), `"0"` (number), or `"false"` (boolean).

### wrap-in-group

Wraps a set of existing events into a new group. Events are addressed by SID and must share the same parent container.

```json
{
  "op": "wrap-in-group",
  "events": ["sid:100234567890123", "sid:100234567890456"],
  "title": "Level Progression"
}
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `events` | yes | Array of SID refs (`"sid:X"` or `"$symbol"`) to wrap |
| `title` | yes | Group title |
| `in` | no | Parent container SID ref (default: root `events` array) |
| `id` | no | `$symbol` name for the new group |
| `activeOnStart` | no | Default: `true` |
| `disabled` | no | Default: `false` |

Non-contiguous events are supported. The group is inserted at the position where the first event was.

### move-variable

Moves a variable between **global** and **local** scope within one event sheet. Scope is positional: a `variable` event at the sheet root is global (referenced in scripts as `runtime.globalVars.X`); nested inside a group/block it is local (`localVars.X`).

```json
{ "op": "move-variable", "variable": "sid:100234567890123", "to": "root" }            // promote → global
{ "op": "move-variable", "variable": "sid:100234567890123", "to": "sid:100234567890456" } // demote → local, into that container
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `variable` | yes | SID ref (`"sid:X"` or `"$symbol"`) of the variable to move |
| `to` | yes | Destination: `"root"` (global) or a container SID ref (local) |
| `index` | no | Position within the destination's children (default: `0` — top) |
| `id` | no | `$symbol` name to register for the moved variable |

Behavior:

- **SID is preserved** across the move.
- **Script references are rewritten** within the variable's scope subtree: `localVars.X` ⇄ `runtime.globalVars.X`. C3 expression parameters reference variables by bare name regardless of scope, so they are left unchanged.
- **`isStatic` is normalized to `true`** in both directions. Globals are effectively always static; a demoted global must stay static to keep its persist-across-ticks semantics.
- **Demotion is refused** when the global is referenced in *other* event sheets — a project-wide global cannot be confined to one local scope. The check is conservative (whole-word name match across other sheets' JSON) and reports the offending sheets. To proceed, replace the external usages (e.g. via shared getter/setter functions) or relocate the global first.
- Only the two canonical directions are supported (root ⇄ nested). Re-parenting between two local scopes is not.

> **Scope ordering caveat:** a local variable must be declared *before* the events that read it to be in scope (group-level, sibling before the block). The default `index: 0` places it first; override `index` only if you know the destination's ordering.

---

## Layout Operations

11 primitive operations for adding/removing/moving instances and layers, plus 4 composite **workflow operations** (see [Workflow Operations](#workflow-operations) below) that bundle common multi-step template patterns. All are specified under the `layouts` key.

```json
{
  "layouts": {
    "layouts/Path/Layout.json": [
      { "op": "..." }
    ]
  }
}
```

UIDs are assigned globally unique (scanned across all layouts). When the `layouts` section is present, `generate` also runs `generate-layout-summaries` after applying.

### add-nonworld-instance

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | objectType name to instantiate |
| `instanceVariables` | no | `{ name: value }` |
| `properties` | no | Plugin-specific. Default: `{}` for Json/Dictionary, `{ width: 1, height: 1, depth: 1 }` for Arr |
| `tags` | no | Default `""` |

### add-layer

Adds a top-level layer to the layout.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `name` | yes | New layer name |
| `after` | no | Insert after this named layer. Default: append at end |

### add-sublayer

Adds a sublayer under an existing layer.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `parent` | yes | Parent layer name (searched recursively) |
| `name` | yes | New sublayer name |
| `after` | no | Insert after this named sibling sublayer. Default: append at end |

### copy-instance

Copies a world instance (and optionally its scene graph children) from a source layout into the target layout.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `from` | yes | Source layout path (e.g., `"layouts/Watch/WatchLayout.json"`) |
| `type` | yes | Instance type name to copy from source |
| `targetLayer` | yes | Layer name in the target layout to place the root instance |
| `includeChildren` | no | Copy scene graph children too. Default: `false`. Note: the higher-level `extract-template` workflow defaults this to `true` — the asymmetry is intentional (extract-template's typical use is preserving a whole sub-hierarchy) but worth knowing |
| `childrenLayer` | no | Layer for children (default: same as `targetLayer`) |
| `overrides` | no | Override properties on the root instance: `x`, `y`, `width`, `height`, `opacity`, `tags`, `"initially-visible"`, `instanceVariables` |
| `childOverrides` | no | `{ "TypeName": overrides }` — per-type overrides for children |

UIDs are remapped to globally unique values. Parent-child relationships are updated.

### templatize

Converts an existing plain instance into a template definition.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | Instance type name to templatize |
| `templateName` | yes | Template name (globally unique across the project) |
| `inheritOverrides` | no | `{ key: boolean }` — override default property inheritance (x/y not inherited by default) |

### add-replica

Copies a template instance from a source layout into the target layout as a replica.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `from` | yes | Source layout path containing the template definition |
| `sourceTemplateName` | yes | Template name to replicate |
| `targetLayer` | yes | Layer name in target layout for the root instance |
| `childrenLayer` | no | Layer for children (default: same as `targetLayer`) |
| `overrides` | no | Override properties on the replica root |
| `childOverrides` | no | `{ "TypeName": overrides }` — per-type overrides for children |
| `inheritOverrides` | no | `{ key: boolean }` — override inheritance flags |

### replicify

Converts an existing plain instance in place into a replica of a named template.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | Instance type name to convert |
| `sourceTemplateName` | yes | Template name this instance becomes a replica of |
| `inheritOverrides` | no | `{ key: boolean }` — override inheritance flags |

### remove-instance

Removes a world instance and its scene graph children from the layout.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | Instance type name to remove |
| `layer` | no | Only remove if instance is on this exact layer (throws if not) |

### remove-layer

Removes an empty layer from the layout. Fails if the layer has instances or sublayers.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `layer` | yes | Layer name to remove |

### move-instance

Moves an instance (and its children) to a different layer within the same layout.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | Instance type name to move |
| `targetLayer` | yes | Destination layer name |
| `childrenLayer` | no | Layer for children (default: same as `targetLayer`) |

### rename-layer

Renames a layer or sublayer in the layout. Searches recursively through sublayers.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `currentName` | yes | Current layer name |
| `newName` | yes | New layer name |

---

## Workflow Operations

Composite ops that bundle a common multi-step template pattern into a single declarative entry. The recipe pipeline expands each workflow into its primitive layout ops (`copy-instance`, `templatize`, `replicify`, `add-replica`, `remove-instance`) before the layout-file loop runs, fanning out across multiple layout keys when needed (e.g. `extract-template` emits a `replicify` on `sourceLayout` while filed under `templatesLayout`).

All workflows share the recipe's single safe `SidGenerator`, so every new SID falls in C3's safe `[1e14, 1e15)` range — using a workflow op eliminates the hand-editing SID-overflow trap that previously broke layout files with "invalid SID" errors.

Each workflow is also exposed as a standalone MCP tool with matching parameters, so an agent can invoke a workflow without composing a full recipe envelope.

### extract-template

"Make this reusable." Extract an instance + scene-graph children from a source layout into a master template on a dedicated templates layout, then convert the original on the source into a replica of the new template. Three primitives: `copy-instance` + `templatize` on the templates layout, `replicify` on the source layout. File under the **templates layout** in `recipe.layouts`.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `sourceLayout` | yes | Layout path containing the original instance (e.g. `"layouts/Shop/ShopLayout.json"`). Must differ from the layouts key — use `templatize-in-place` for same-layout master templates |
| `sourceType` | yes | C3 object type of the instance to extract |
| `templateName` | yes | Template name (globally unique across the project) |
| `templatesLayer` | yes | Layer on the templates layout for the new template root |
| `includeChildren` | no | Copy scene graph children too. Default: `true` (opposite of the lower-level `copy-instance` primitive, which defaults to `false` — `extract-template`'s typical use is preserving a whole sub-hierarchy) |
| `childrenLayer` | no | Layer on the templates layout for children. Default: same as `templatesLayer` |
| `inheritOverrides` | no | `{ key: boolean }` — override inheritance flags; forwarded to both `templatize` and `replicify` |

### templatize-in-place

"Make this the master so runtime can spawn replicas." Convert an existing instance on this layout into the master template — useful when C3 runtime code creates replicas dynamically via `create-object` with the template parameter. One-to-one expansion to a single `templatize` op.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | C3 object type of the instance to convert |
| `templateName` | yes | Template name (globally unique across the project) |
| `inheritOverrides` | no | `{ key: boolean }` — override inheritance flags |

### clone-replica-to-layouts

"Use this template on these N pages." Given an existing template defined on the layout this op is filed under, add a replica of it to one or more target layouts in one call. Fans out into one `add-replica` per target.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `templateName` | yes | Template name to replicate |
| `sourceType` | yes | C3 object type the template is built from (needed to locate the source instance on the templates layout) |
| `targets` | yes | Non-empty array of `{ layout, layer, childrenLayer?, overrides?, childOverrides?, inheritOverrides? }`. Target layout paths must be distinct |

### replace-instance-with-replica

"Swap this instance for a replica of the template." Remove an existing instance on this layout and add a replica of a named template in its spot (same layer, same world props captured from the removed instance). Expands to `remove-instance` + `add-replica`.

| Field | Required | Description |
| ----- | -------- | ----------- |
| `type` | yes | C3 object type of the instance to replace |
| `templatesLayout` | yes | Layout path containing the template definition |
| `templateName` | yes | Template name to replicate |
| `layer` | no | Restrict the replace to instances on this layer (throws if mismatched). When omitted, the instance's layer is auto-detected |
| `inheritOverrides` | no | `{ key: boolean }` — override inheritance flags |

> **Carry-over limitation:** `instanceVariables` and `tags` on the removed instance are **not** carried over to the new replica — a replica is treated as a fresh instance of the template. If the removed instance was holding per-instance state, that state is lost.

---

## Builder Shorthands

### Actions

```json
{ "script": ["line1;", "line2;"] }
{ "call": "FunctionName", "params": ["arg1", "arg2"] }
{ "id": "action-id", "object": "ObjectClass", "params": { "key": "value" }, "behavior": "BehaviorType" }
{ "custom-action": "ace-name", "object": "ObjectClass", "params": ["value1", "value2"] }
{ "comment": "Comment text" }
```

**`id` vs `custom-action`**: Plugin-defined actions (e.g., `parse`, `delete-key`) use `id` with **named params** (`{ "key": "value" }`). Custom ACEs defined in event sheets use `custom-action` with **positional array params** (`["value"]`).

**`object` / `objectClass`**: `object` names the target object class. `objectClass` (the field name used in the on-disk eventSheet JSON) is accepted as an alias. A genuinely-unknown key (e.g. a typo like `objclass`) is rejected at validate time.

**System actions**: well-known object-less System actions — `wait`, `wait-for-previous-actions`, `wait-for-signal`, `signal` — auto-default `objectClass: "System"`, so `{ "id": "wait-for-previous-actions" }` works with no `object`. Any other `id` action with no `object`/`objectClass` is **rejected at validate time** (previously it silently rendered `[unknown action]`).

### Conditions

```json
{ "else": true }
{ "trigger-once": true }
{ "id": "cond-id", "object": "ObjectClass", "params": { "key": "value" }, "inverted": true }
{ "id": "compare-boolean-eventvar", "object": "System", "params": { "variable": "myBoolVar" } }
{ "id": "is-boolean-instance-variable-set", "object": "ObjectClass", "params": { "instance-variable": "varName" } }
```

**`object` / `objectClass`**: as with actions, `objectClass` is accepted as an alias for `object`, unknown keys are rejected, and an `id` condition with no `object`/`objectClass` is rejected at validate time. (`else` / `trigger-once` are System conditions and need no `object`.)

**Comparison operator values** for `compare-two-values`:

| Value | Operator |
| ----- | -------- |
| `0` | `=` Equal |
| `1` | `<>` Not equal |
| `2` | `<` Less than |
| `3` | `<=` Less or equal |
| `4` | `>` Greater than |
| `5` | `>=` Greater or equal |

### Events

```json
{ "variable": { "name": "X", "type": "number", "value": "0", "constant": false, "static": false } }
{ "block": { "conditions": [...], "actions": [...], "children": [...], "orBlock": false } }
{ "function-block": {
    "name": "FuncName",
    "params": [ { "name": "p1", "type": "string", "initialValue": "" } ],
    "returnType": "none",
    "async": false,
    "actions": [...],
    "children": [...]
  }
}
{ "custom-ace-block": {
    "name": "AceName",
    "object": "ObjectClass",
    "aceType": "action",
    "params": [ { "name": "p1", "type": "string" } ],
    "actions": [...],
    "children": [...]
  }
}
{ "group": { "title": "Group Name", "children": [...], "activeOnStart": true, "disabled": false } }
{ "comment": "Comment text" }
{ "include": "SheetName" }
```

The `function-block` shorthand accepts `"actions": [...]` directly at the top level — no nested child block needed.

---

## CLI Flags

```bash
npx construct3-chef apply-recipe <recipe.json>              # Apply (writes files)
npx construct3-chef apply-recipe <recipe.json> --dry-run    # Validate without writing
npx construct3-chef apply-recipe <recipe.json> --preview    # Show script diffs
npx construct3-chef apply-recipe <recipe.json> --no-regenerate  # Skip generate after applying
```

---

## Gotchas

| # | Gotcha | Detail |
| - | ------ | ------ |
| 1 | **`actionIndex` is 0-based** | DSL shows `Act1`, `Act2` — map to `actionIndex: 0`, `1`. |
| 2 | **Comment actions count toward `actionIndex`** | Use `matchScript` to avoid counting. |
| 3 | **JSON paths from `.dsl.idx.txt` only** | Never derive paths from event numbers or DSL line offsets. Variables, comments, and includes don't increment the counter. |
| 4 | **`path`/`paths` are mutually exclusive** | Specifying both throws immediately. |
| 5 | **`rename-symbol` throws on zero matches** | Check symbol names before running. |
| 6 | **`patch-script` replaces first occurrence only** | Use `"replaceAll": true` or multiple ops for repeated strings. |
| 7 | **`set-disabled` requires a group, `set-or-block` requires a block** | Both throw if the target has the wrong `eventType`. |
| 8 | **`add-include` inserts at index 0 by default** | Use `"after": "SheetName"` to insert after a specific include. |
| 9 | **`insert-event path` is the parent node, not `.children`** | `"path": "events[21]"` inserts into events[21]'s children array. `"path": "events[21].children"` is invalid. |
| 10 | **`insert-variables` items are bare opts, not wrapped** | Items in `variables` are `{ name, type, value?, static?, constant? }` — NOT wrapped in `"variable": { ... }`. |
| 11 | **Root-level inserts shift all subsequent position-based indices** | Use SID-based addressing (`in: "sid:X"`) to avoid this. |
| 12 | **`custom-action` vs `id` in builder shorthand** | Plugin-defined actions use `{ "id": "..." }` with named params. Custom ACEs use `{ "custom-action": "..." }` with positional array params. |
| 13 | **Consecutive position-based `remove-event` must be in descending index order** | Or switch to `in: "sid:X"` — SID removes are order-independent. |
| 14 | **Expression params need C3 expression syntax** | `"path": ""` is an empty expression (error). For an empty string value, use `"path": "\"\""`. |
| 15 | **Script + variable in same block requires a child block** | When adding both a variable and a script to the same block, the script must be in an unconditional child block. |
| 16 | **No action-level rows in `.dsl.idx.txt`** | The index lists one row per event node, not per action (per-action rows were removed). For an `actionIndex` (`patch-script`, `patch-action-param`), read the action ordering in the matching `.dsl.txt` — actions are 1-indexed within their block's `actions` array. Block rows carry a hidden `⟪search⟫` tail so `read-dsl-index grep=` matches condition/action content (parity with `read-event-sids`). |
| 17 | **Variable builder uses `static`/`constant`, not `isStatic`/`isConstant`** | Both forms are now accepted as aliases, but `"static": true` is canonical. |
| 18 | **`insert-actions` uses `"actions"`, `insert-variables` uses `"variables"`** | There is no generic `"items"` field. |
| 19 | **`add-include` uses `include` field, not `sheet`** | `{ "op": "add-include", "include": "SheetName" }`. Using `"sheet"` silently produces a broken include. |
| 20 | **Comment events have no SID** | `insert-event` with a `comment` key produces an event with no SID. `id: "$name"` on a comment fails. Chain subsequent ops from the first real event instead. |
| 21 | **`patch-script` uses `find`/`replace`, not `old`/`new`** | Check the dry-run preview: if `find:` shows `undefined`, the field name is wrong. |
| 22 | **`replace-action` uses `action` (singular), not `actions`** | Using `"actions": [...]` causes a cryptic TypeError at apply time. |
| 23 | **`comparison` must be an integer, not a string** | `compare-two-values` `comparison` parameter must be a JSON number (`0`), not a string (`"0"`). |
| 24 | **`callFunction` `parameters` must be a JSON array** | Object-keyed params (`{"0": "arg1"}`) cause `TypeError: expected array` at runtime. Use the `call` builder shorthand. |
| 25 | **Layer name params must be quoted expressions** | `"layer": "\"LayerName\""` not `"layer": "LayerName"`. Applies to `set-layer-visible`, `is-on-layer`, etc. |
| 26 | **`visibility` must be `"visible"` or `"invisible"`, not `"0"`/`"1"`** | The `set-layer-visible` `visibility` parameter is a string enum. |
| 27 | **`interactive` must be a boolean, not a string** | `set-layer-interactive` `interactive` parameter must be `true`/`false`, not `"true"`/`"false"`. |
| 28 | **Animation name params must be quoted expressions** | `"animation": "\"animName\""` not `"animation": "animName"`. |
| 29 | **`on-touched-object` `type` must be a string enum** | Use `"start"`, `"end"`, `"move"` — not `"0"`. |
| 30 | **`add-include` shifts all path-based `after` refs** | `add-include` inserts a root-level event, shifting all `events[N]` indices. Use SID-based `after` for subsequent `insert-event` ops. |
| 31 | **`$symbol` refs only work for same-recipe inserts** | Pre-existing events are not in the symbol table. Use `"in": "sid:X"` for pre-existing events. |
| 32 | **`matchAction` is a string, not an object** | `"matchAction": "myFunc"` — not `{ callFunction: "name" }`. |
| 33 | **`callFunction` parameters: booleans are native, strings need C3 quoting** | `"parameters": [true, "\"LayerName\""]` — boolean params must be native booleans, string params must use inner quotes. |
| 34 | **`insert-event` with SID-based `after` resolves the live position** | The `after: "sid:X"` insert looks up the target's *current* index, so it stays correct even when earlier ops in the same recipe batch shift siblings. (Previously used a stale `buildSidIndex` snapshot and could misplace/append; fixed.) |
| 35 | **`matchAction` only matches actions, not conditions** | `patch-action-param`'s `matchAction` searches `actions` array only. To modify condition parameters, use `replace-condition`. |

---

## Workflow Summary

1. Use `read-dsl` (or read `.dsl.txt`) to understand the event sheet structure
2. Use `read-dsl-index` (or read `.dsl.idx.txt`) to get SIDs and JSON paths for target events
3. Write ops using `in: "sid:X"` for existing events (preferred), or `path` for position-based (legacy)
4. Validate with `--dry-run` or `validate-recipe`
5. Preview script changes with `--preview`
6. Apply (runs `generate` automatically unless `--no-regenerate`)
7. Run typecheck to catch type-position renames missed by `rename-symbol`

## Renaming a Symbol Across Event Sheets

When renaming a function or namespace across multiple event sheets:

1. Enumerate all exports — read barrel indexes for the module
2. Search DSL files for every exported symbol with the old prefix
3. Build and apply a `rename-symbol` recipe with all patterns (one recipe can cover all affected files)
4. Run typecheck — catches `typeof`, generic args, and type assertions that the recipe missed
5. Fix type-position references manually with a text editor or the Edit tool
