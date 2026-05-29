# C3 Layout Reference

> Part of the [C3 platform reference](README.md). Describes how Construct 3 layouts are structured on disk — the JSON that construct3-chef reads, mutates, and scaffolds.

## Layout Organization

Layouts define the visual screens of the project. When placing objects into a layout, verify the correct layer — layer ordering affects both rendering (visual depth) and event picking (which layer receives input events). Each layout JSON links to an event sheet:

```json
{
  "name": "SomeLayout",
  "layers": [ ... ],
  "eventSheet": "SomeLayoutEvents"
}
```

Projects typically group layouts into directories by purpose (gameplay levels, login/loading, menus, modals, template holders, etc.).

## Layer Rendering Order

Within a layout, layers render in array order -- **later layers render on top**:

```json
{
  "layers": [
    { "name": "Background" },     // renders first (bottom)
    { "name": "GameObjects" },    // renders second
    { "name": "HUD" },            // renders third
    { "name": "ModalOverlay" }    // renders last (top)
  ]
}
```

Layers support sub-layers for further nesting. Each layer has properties controlling visibility, interactivity, parallax, blend mode, and draw order. Instance `tags` are a comma-separated string (e.g., `"tags": "boss,flying"`) used in C3 conditions for filtering objects; layout summaries show them as `#tag1 #tag2`.

## Template System

A template master object is defined in one layout (often a dedicated "template holder" layout); template instances in other layouts reference that master. The `template` property on an instance controls which properties stay synchronized with the master:

```json
"template": {
  "mode": "template",
  "templateName": "default",
  "components": [
    { "id": "plugin", "component": [...] },
    { "id": "instance-variable", "component": [...] },
    { "id": "behavior", "component": [...] },
    { "id": "effect", "component": [...] }
  ]
}
```

The `"o"` boolean on child instances within templates enables per-instance property overrides. Set `"o": true` when game logic needs to change child properties (visibility, animation, text) at runtime on a per-instance basis.

Layout summaries (`.layout.txt`) show template definitions with full hierarchy; replicas (`mode: "replica"`) skip the hierarchy. Template definitions show all child instances; replicas show only the top-level instance.

## Global Layers and Overrides

### What global layers are

A layer marked `"global": true` in one layout (the **originating layout**) is inherited by all other layouts. The originating layout defines the layer and all its instances. Consuming layouts get those instances automatically — no per-layout duplication needed. Consuming layouts can optionally **override** the layer to change instance-level properties (position, visibility, effects, etc.) without affecting the original.

### Inheritance and override mechanics

When a global layer appears in multiple layouts, non-owning layouts set `"overriden": 1` to indicate they inherit the layer rather than defining it:

```json
{
  "name": "Header",
  "global": true,
  "overriden": 1,
  "instances": []    // MUST be empty when overriden
}
```

This constraint matters: if instances leak into an overridden layer (e.g., after C3 editor changes), the layer can render duplicated or stale content. A consuming layout can also override the layer **with** instances to change instance-level properties — position, visibility, effects, etc. — for that layout only. The override appears as a normal layer entry in the consuming layout's JSON with matching name and any changed properties on the instances. This does not affect the originating layout or other consumers.

**Recovery**: When a layer becomes global with `overriden: 1`, instances are cleared. Recover missing instances with `git show <commit>^:<path>`.

### Adding an effect to a global layer instance

Adding an effect (e.g., Grayscale) to an instance that lives on a global layer requires changes at three levels:

1. **`project.c3proj`** — add the effect as a dependency:

   ```json
   { "type": "effect", "id": "grayscale", "name": "Grayscale", "author": "Scirra", "bundled": false }
   ```

2. **`objectTypes/.../ObjectName.json`** — add an `effectTypes` entry on the object type:

   ```json
   { "effectId": "grayscale", "name": "Grayscale" }
   ```

3. **Originating global layout instance** — add an `effects` block on the specific instance in the originating layout (not in overriding layouts):

   ```json
   "effects": [{ "name": "Grayscale", "isEnabled": true, "parameters": { ... } }]
   ```

All consuming layouts that inherit the global layer pick up the effect automatically without any per-layout changes.

### Initialization trap

Global layers persist their visibility and interactivity state across layout transitions. Every layout that uses a global layer must explicitly reset it in `on-start-of-layout` — typically `set-layer-visible(invisible)` and/or `set-layer-interactive(false)` — then open it only when needed. Forgetting the reset causes the layer to appear with stale data when navigating back to a layout.

### Tooling gap

There is no extracted file that lists global layers, their originating layouts, and which layouts override them — unlike templates, which have `template-scope.txt`. When investigating a global layer, check the originating layout JSON directly (the one where `"global": true` appears without `"overriden": 1`). This gap is filed as a future item in the [mcp-tooling-followups initiative](../../initiatives/mcp-tooling-followups/initiative.md).

## Localization in Layouts

Text instances commonly use a `[[key]]` syntax for localized strings, resolved at runtime by a localization plugin (e.g. I18N) from a loc file:

```json
{
  "type": "Text",
  "instanceVariables": {
    "text": "[[some.loc.key]]"
  }
}
```

## Sublayers Casing Mismatch

**Casing mismatch**: JSON uses `subLayers` (camelCase) but the `Layer` interface has `sublayers` (lowercase). Access sublayers via the index signature or an explicit cast -- `layer.sublayers` silently returns `undefined`:

```typescript
// Correct
const sublayers = (layer as Record<string, unknown>).subLayers;

// Wrong -- silently returns undefined
const sublayers = layer.sublayers;
```

In the layout JSON, an instance's sublayer is determined by which `subLayers[].instances` array the instance object appears in — not by any explicit property on the instance itself.

## Instance Naming Doesn't Imply Scope

An instance whose name ends in `*Layout` reads as "lives in that one layout," but the name only records the *original* host — the same instance can be cloned into any number of layouts. The layout files that actually contain the instance are the ground truth; the name suffix is not a reliable host list. When a `LayoutName`-gated branch in an event sheet must cover every layout that hosts an instance, search the extracted layout summaries for the instance name rather than trusting the suffix — a missing branch is a common cause of "this UI never refreshes on layout X" bugs.

## Adding a New Layout

Creating a new layout requires several coordinated steps:

1. **Create the layout JSON** in `layouts/`. Layouts contain layer definitions, instance placements with unique UIDs and SIDs, and scene-graph parent-child relationships. The C3 editor is strongly recommended for this step — manual JSON editing is fragile due to UID/SID uniqueness requirements. (construct3-chef's `scaffold-layout` clones an existing layout with freshly remapped UIDs/SIDs to make this safe.)

2. **Create the event sheet** in `eventSheets/` — the JSON file that contains the layout's logic. Link it from the layout JSON via the `"eventSheet"` field (just the name, not the path).

3. **Sync `project.c3proj`** to register the new files (`construct3-chef sync-project`). Never edit `project.c3proj` by hand.

4. **Regenerate extracted files** (`construct3-chef generate`).

**Key constraints:**

- **UIDs** must be unique across the entire project (sequential integers). Check the max UID before assigning new ones.
- **SIDs** are large random integers, unique per object, used for C3 internal references.
- **Templates are layout-bound** — a template instance cannot be created from a layout other than where the master is defined. For cross-layout reuse, place the template master in a shared "components" layout.

## Navigation Between Layouts

C3 layouts navigate using the System `GoToLayout` action. Two common patterns:

- **Full-screen navigation** (separate layouts): the previous layout name is stored in a variable before navigating, and the back button calls `GoToLayout` with the stored name. `construct3-chef navigation-graph` extracts these `GoToLayout` calls into a navigation graph.
- **Embedded layer modals**: a popup lives on its own layer within the current layout and is toggled with `set-layer-visible` / `set-layer-interactive` rather than a layout change.

construct3-chef's `navigation-graph` subcommand surfaces the `GoToLayout` edges between event sheets, which is the tool-visible view of a project's navigation structure.
