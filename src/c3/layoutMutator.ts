// Layout mutation library — pure functions, no file I/O.

import {
  makeDefaultLayer,
  addSceneGraphRoot,
  removeSceneGraphRoot,
  findLayerByName,
  findLayerEntry,
  type Layout,
  type Layer,
  type Instance,
} from "@genvid/c3source";

// These were once local `Record<string, unknown>` aliases (a cast barrier that
// forced `as unknown as Layout` at every c3source call site). They now alias
// c3source's typed domain shapes directly — all three carry an index signature,
// so existing `x as LayerJson[]` narrowing casts on loosely-typed fields still
// compile, while c3source functions typed `(layers: Layer[])` accept them
// without the double cast.
export type LayoutJson = Layout;
export type LayerJson = Layer;
export type InstanceJson = Instance;

export interface InstanceOverrides {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tags?: string;
  "initially-visible"?: boolean;
  opacity?: number;
  instanceVariables?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Layer Operations
// ---------------------------------------------------------------------------

/**
 * Recursively search through layout.layers and their subLayers to find a
 * layer by name. Returns null if not found.
 *
 * Delegates to c3source's early-exit `findLayerByName` (stops at the first
 * match rather than walking the whole tree).
 */
export function findLayer(
  layout: LayoutJson,
  layerName: string,
): LayerJson | null {
  const layers = layout.layers as Layer[] | undefined;
  if (!layers) return null;
  return findLayerByName(layers, layerName) ?? null;
}

/**
 * Remove an empty layer from the layout. Throws if the layer has instances or sublayers.
 *
 * Uses c3source's `findLayerEntry`, whose returned entry carries the sibling
 * array (`parent`) and `index` for an in-place splice — no second walk to
 * locate the layer's container.
 */
export function removeLayer(layout: LayoutJson, layerName: string): void {
  const layers = layout.layers as Layer[] | undefined;
  const entry = layers ? findLayerEntry(layers, (e) => e.name === layerName) : undefined;
  if (!entry) {
    throw new Error(`removeLayer: layer "${layerName}" not found in layout`);
  }
  const instances = entry.layer.instances;
  if (instances && instances.length > 0) {
    throw new Error(
      `removeLayer: layer "${layerName}" has ${instances.length} instance(s) — remove them first`,
    );
  }
  const subLayers = entry.layer.subLayers;
  if (subLayers && subLayers.length > 0) {
    throw new Error(
      `removeLayer: layer "${layerName}" has ${subLayers.length} sublayer(s) — remove them first`,
    );
  }
  entry.parent.splice(entry.index, 1);
}

/**
 * Build a full C3 layer structure with all required fields. Delegates to
 * c3source's makeDefaultLayer — the canonical default-layer schema, sourced
 * from a real C3 export. Note this defaults to a white, opaque layer with
 * `sampling: "auto"` (the older hand-rolled values were gray/transparent and
 * omitted sampling).
 */
export function buildLayer(name: string): LayerJson {
  return makeDefaultLayer(name);
}

/**
 * Build a new layer and insert it into parentLayer.subLayers.
 * If `after` is specified, insert after the named sibling. Throws if the
 * named sibling is not found. Otherwise append to the end.
 * Returns the new layer.
 */
export function addSublayer(
  parentLayer: LayerJson,
  name: string,
  opts?: { after?: string },
): LayerJson {
  const newLayer = buildLayer(name);
  const subLayers = parentLayer.subLayers as LayerJson[];

  if (opts?.after !== undefined) {
    const idx = subLayers.findIndex((l) => l.name === opts.after);
    if (idx === -1) {
      throw new Error(
        `addSublayer: sibling layer "${opts.after}" not found in subLayers`,
      );
    }
    subLayers.splice(idx + 1, 0, newLayer);
  } else {
    subLayers.push(newLayer);
  }

  return newLayer;
}

/**
 * Build a new layer and insert it into layout.layers (top-level array).
 * If `after` is specified, insert after the named layer. Throws if the
 * named layer is not found. Otherwise append to the end.
 * Returns the new layer.
 */
export function addLayer(
  layout: LayoutJson,
  name: string,
  opts?: { after?: string },
): LayerJson {
  const newLayer = buildLayer(name);
  const layers = layout.layers as LayerJson[];

  if (opts?.after !== undefined) {
    const idx = layers.findIndex((l) => l.name === opts.after);
    if (idx === -1) {
      throw new Error(
        `addLayer: sibling layer "${opts.after}" not found in layout.layers`,
      );
    }
    layers.splice(idx + 1, 0, newLayer);
  } else {
    layers.push(newLayer);
  }

  return newLayer;
}

// ---------------------------------------------------------------------------
// Instance Operations
// ---------------------------------------------------------------------------

/**
 * Recursively search ALL layers (including sublayers) for an instance whose
 * `type` field matches typeName. Returns the instance and the layer name
 * where it was found, or null if not found.
 */
export function findInstanceByType(
  layout: LayoutJson,
  typeName: string,
): { instance: InstanceJson; layerName: string } | null {
  const layers = layout.layers as LayerJson[] | undefined;
  if (!layers) return null;
  return findInstanceInLayers(layers, typeName);
}

function findInstanceInLayers(
  layers: LayerJson[],
  typeName: string,
): { instance: InstanceJson; layerName: string } | null {
  for (const layer of layers) {
    const instances = layer.instances as InstanceJson[] | undefined;
    if (instances) {
      for (const inst of instances) {
        if (inst.type === typeName) {
          return { instance: inst, layerName: layer.name as string };
        }
      }
    }
    const subLayers = layer.subLayers as LayerJson[] | undefined;
    if (subLayers) {
      const found = findInstanceInLayers(subLayers, typeName);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Scan ALL instances across ALL layers (recursively through sublayers).
 * Return instances where sceneGraphData["parent-uid"] matches parentUid.
 * Return empty array if none found.
 */
export function findChildInstances(
  layout: LayoutJson,
  parentUid: number,
): InstanceJson[] {
  const results: InstanceJson[] = [];
  const layers = layout.layers as LayerJson[] | undefined;
  if (!layers) return results;
  collectChildInstances(layers, parentUid, results);
  return results;
}

function collectChildInstances(
  layers: LayerJson[],
  parentUid: number,
  results: InstanceJson[],
): void {
  for (const layer of layers) {
    const instances = layer.instances as InstanceJson[] | undefined;
    if (instances) {
      for (const inst of instances) {
        const sgd = inst.sceneGraphData as
          | Record<string, unknown>
          | undefined;
        if (sgd && sgd["parent-uid"] === parentUid) {
          results.push(inst);
        }
      }
    }
    const subLayers = layer.subLayers as LayerJson[] | undefined;
    if (subLayers) {
      collectChildInstances(subLayers, parentUid, results);
    }
  }
}

/**
 * Find which layer contains the given instance reference (by identity, not
 * type). Walks all layers recursively and returns the layer name of the
 * first match. Returns null when the instance is not present in any layer.
 */
function findLayerOfInstance(layout: LayoutJson, instance: InstanceJson): string | null {
  const layers = layout.layers as LayerJson[] | undefined;
  if (!layers) return null;
  return findLayerOfInstanceInList(layers, instance);
}

function findLayerOfInstanceInList(layers: LayerJson[], instance: InstanceJson): string | null {
  for (const layer of layers) {
    const instances = layer.instances as InstanceJson[] | undefined;
    if (instances && instances.indexOf(instance) !== -1) {
      return layer.name as string;
    }
    const subLayers = layer.subLayers as LayerJson[] | undefined;
    if (subLayers) {
      const found = findLayerOfInstanceInList(subLayers, instance);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Snapshot an existing instance's layer and world-level properties without
 * mutating the source. Returns the deep-cloned `world` object plus the
 * containing `layerName`, optional `tags`, `instanceVariables`, and the
 * scene-graph children's shared layer (or undefined when there are no
 * children, or when children span multiple layers — addReplica's default
 * "children share root layer" semantics already covers the latter, but the
 * info isn't safe to assume otherwise). The snapshot is independent of the
 * source — callers can mutate it safely.
 *
 * Used by composite workflows (e.g. replace-instance-with-replica) that need
 * to capture an instance's position/size before deleting it so a successor
 * can land in the same spot, including children on their original layer.
 *
 * When `layerName` is provided, returns null if the matched instance is on a
 * different layer.
 */
export function readInstanceWorld(
  layout: LayoutJson,
  typeName: string,
  layerName?: string,
): {
  layerName: string;
  childrenLayerName: string | undefined;
  world: Record<string, unknown>;
  tags: string | undefined;
  instanceVariables: Record<string, unknown> | undefined;
} | null {
  const found = findInstanceByType(layout, typeName);
  if (!found) return null;
  if (layerName !== undefined && found.layerName !== layerName) return null;
  const instance = found.instance;
  const world = (instance.world as Record<string, unknown> | undefined) ?? {};
  const ivars = instance.instanceVariables as Record<string, unknown> | undefined;

  // Determine the children's shared layer (if any). If children span multiple
  // layers (rare; not expected in canonical C3 scene-graphs), leave undefined
  // so the caller falls back to addReplica's "children inherit root layer"
  // default rather than picking an arbitrary one.
  const uid = instance.uid as number;
  const children = findChildInstances(layout, uid);
  let childrenLayerName: string | undefined;
  if (children.length > 0) {
    const childLayers = new Set<string>();
    for (const child of children) {
      const childLayer = findLayerOfInstance(layout, child);
      if (childLayer) childLayers.add(childLayer);
    }
    if (childLayers.size === 1) {
      childrenLayerName = childLayers.values().next().value;
    }
  }

  return {
    layerName: found.layerName,
    childrenLayerName,
    world: JSON.parse(JSON.stringify(world)) as Record<string, unknown>,
    tags: typeof instance.tags === "string" ? (instance.tags as string) : undefined,
    instanceVariables: ivars ? (JSON.parse(JSON.stringify(ivars)) as Record<string, unknown>) : undefined,
  };
}

/**
 * Remap UIDs on a cloned instance using the provided uidMap.
 * Unmapped UIDs pass through unchanged.
 */
function remapInstanceUids(
  instance: InstanceJson,
  uidMap: Map<number, number>,
): void {
  const oldUid = instance.uid as number;
  instance.uid = uidMap.get(oldUid) ?? oldUid;

  const sgd = instance.sceneGraphData as Record<string, unknown> | undefined;
  if (sgd) {
    const sgdUid = sgd.uid as number;
    sgd.uid = uidMap.get(sgdUid) ?? sgdUid;

    const parentUid = sgd["parent-uid"] as number;
    if (parentUid !== -1) {
      sgd["parent-uid"] = uidMap.get(parentUid) ?? parentUid;
    }

    const children = sgd.children as Array<Record<string, unknown>> | undefined;
    if (children) {
      for (const child of children) {
        const childUid = child.uid as number;
        child.uid = uidMap.get(childUid) ?? childUid;
      }
    }
  }
}

/**
 * Apply property overrides to an instance.
 */
function applyOverrides(
  instance: InstanceJson,
  overrides: InstanceOverrides,
): void {
  const world = instance.world as Record<string, unknown> | undefined;
  if (world) {
    if (overrides.x !== undefined) world.x = overrides.x;
    if (overrides.y !== undefined) world.y = overrides.y;
    if (overrides.width !== undefined) world.width = overrides.width;
    if (overrides.height !== undefined) world.height = overrides.height;
    if (overrides.opacity !== undefined) world.opacity = overrides.opacity;
  }

  const props = instance.properties as Record<string, unknown> | undefined;
  if (props && overrides["initially-visible"] !== undefined) {
    props["initially-visible"] = overrides["initially-visible"];
  }

  if (overrides.tags !== undefined) instance.tags = overrides.tags;

  if (overrides.instanceVariables) {
    const ivars = (instance.instanceVariables ?? {}) as Record<
      string,
      unknown
    >;
    Object.assign(ivars, overrides.instanceVariables);
    instance.instanceVariables = ivars;
  }
}

/**
 * Copy an instance (and optionally its scene-graph children) from a source
 * layout to a target layout, assigning new UIDs and SIDs.
 */
export function copyInstance(opts: {
  sourceLayout: LayoutJson;
  targetLayout: LayoutJson;
  instanceType: string;
  includeChildren: boolean;
  targetLayer: string;
  childrenLayer?: string;
  uidCounter: { next: number };
  sidGenerator: () => number;
  overrides?: InstanceOverrides;
  childOverrides?: Record<string, InstanceOverrides>;
}): void {
  // 1. Find root instance in source layout
  const found = findInstanceByType(opts.sourceLayout, opts.instanceType);
  if (!found) {
    throw new Error(
      `copyInstance: instance of type "${opts.instanceType}" not found in source layout`,
    );
  }

  // 2. Deep-clone root
  const rootClone: InstanceJson = JSON.parse(JSON.stringify(found.instance));
  const rootOldUid = rootClone.uid as number;

  // 3. Find and deep-clone children if requested
  const childClones: InstanceJson[] = [];
  if (opts.includeChildren) {
    const children = findChildInstances(opts.sourceLayout, rootOldUid);
    for (const child of children) {
      childClones.push(JSON.parse(JSON.stringify(child)));
    }
  }

  // 4. Build oldUid → newUid map
  const uidMap = new Map<number, number>();
  uidMap.set(rootOldUid, opts.uidCounter.next++);
  for (const child of childClones) {
    const childOldUid = child.uid as number;
    uidMap.set(childOldUid, opts.uidCounter.next++);
  }

  // 5. Remap UIDs on all clones
  remapInstanceUids(rootClone, uidMap);
  for (const child of childClones) {
    remapInstanceUids(child, uidMap);
  }

  // 6. Assign new SIDs
  const assignSid = (instance: InstanceJson): void => {
    const newSid = opts.sidGenerator();
    instance.sid = newSid;
    const folderItem = (instance as Record<string, unknown>)
      .instanceFolderItem as Record<string, unknown> | undefined;
    if (folderItem) {
      folderItem.sid = newSid;
    }
  };

  assignSid(rootClone);
  for (const child of childClones) {
    assignSid(child);
  }

  // 7. Apply overrides to root clone
  if (opts.overrides) {
    applyOverrides(rootClone, opts.overrides);
  }

  // 8. Apply childOverrides by matching child's .type field
  if (opts.childOverrides) {
    for (const child of childClones) {
      const childType = child.type as string;
      if (opts.childOverrides[childType]) {
        applyOverrides(child, opts.childOverrides[childType]);
      }
    }
  }

  // 9. Place root on targetLayer
  const rootLayer = findLayer(opts.targetLayout, opts.targetLayer);
  if (!rootLayer) {
    throw new Error(
      `copyInstance: target layer "${opts.targetLayer}" not found in target layout`,
    );
  }
  (rootLayer.instances as InstanceJson[]).push(rootClone);

  // 10. Place children on childrenLayer (or targetLayer)
  const childLayerName = opts.childrenLayer ?? opts.targetLayer;
  const childLayer = findLayer(opts.targetLayout, childLayerName);
  if (!childLayer) {
    throw new Error(
      `copyInstance: children layer "${childLayerName}" not found in target layout`,
    );
  }
  const childInstances = childLayer.instances as InstanceJson[];
  for (const child of childClones) {
    childInstances.push(child);
  }

  // 11. Register root's new SID in scene-graphs-folder-root (addSceneGraphRoot
  // creates the folder if the layout lacks one — it owns that invariant).
  const newRootSid = rootClone.sid as number;
  addSceneGraphRoot(opts.targetLayout, newRootSid);
}

// ---------------------------------------------------------------------------
// Template Block Builder
// ---------------------------------------------------------------------------

/** Fixed key order for the world-instance component. */
const WORLD_INSTANCE_KEYS = [
  "x",
  "y",
  "z",
  "w",
  "h",
  "a",
  "o",
  "c",
  "sx",
  "sy",
  "bm",
  "twpx",
  "twpy",
  "twpz",
  "twpw",
  "twph",
  "twpa",
  "dwp",
  "ssm",
] as const;

/** Default inheritance for world-instance keys: x and y are false, rest true. */
const WORLD_INSTANCE_DEFAULTS: Record<string, boolean> = Object.fromEntries(
  WORLD_INSTANCE_KEYS.map((k) => [k, k !== "x" && k !== "y"]),
);

/**
 * Build a C3 template block from an instance's existing data.
 *
 * The template block is attached to the root instance of a template or replica
 * hierarchy. It contains 5 component entries (plugin, instance-variable,
 * behavior, effect, world-instance) that describe which properties are
 * inherited from the template.
 */
export function buildTemplateBlock(
  instance: InstanceJson,
  mode: "template" | "replica",
  opts: {
    templateName?: string;
    sourceTemplateName?: string;
    inheritOverrides?: Record<string, boolean>;
  } = {},
): Record<string, unknown> {
  const overrides = opts.inheritOverrides ?? {};

  // Helper: resolve inheritance for a key (override wins, then fallback).
  const inherit = (key: string, fallback: boolean): boolean =>
    key in overrides ? overrides[key] : fallback;

  // 1. Plugin component
  const properties = (instance.properties ?? {}) as Record<string, unknown>;
  const pluginState = Object.keys(properties).map((k) => [
    k,
    inherit(k, true),
  ]);
  const pluginComponent = {
    id: "plugin",
    component: [{ key: "plugin", state: pluginState }],
  };

  // 2. Instance-variable component
  const instanceVariables = (instance.instanceVariables ?? {}) as Record<
    string,
    unknown
  >;
  const ivState = Object.keys(instanceVariables).map((name) => ({
    iv: name,
    state: inherit(name, true),
  }));
  const ivComponent = {
    id: "instance-variable",
    component: [{ key: "instance-variable", state: ivState }],
  };

  // 3. Behavior component
  const behaviors = (instance.behaviors ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const behaviorEntries = Object.entries(behaviors).map(
    ([behaviorName, behaviorData]) => {
      const behaviorProps = (behaviorData.properties ?? {}) as Record<
        string,
        unknown
      >;
      const state = Object.keys(behaviorProps).map((k) => [
        k,
        inherit(k, true),
      ]);
      return { key: behaviorName, state };
    },
  );
  const behaviorComponent = {
    id: "behavior",
    component: behaviorEntries,
  };

  // 4. Effect component
  const effects = (instance.effects ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const effectEntries = Object.entries(effects).map(
    ([effectName, effectData]) => {
      const params = (effectData.parameters ?? {}) as Record<string, unknown>;
      const state: Array<[string, boolean]> = Object.keys(params).map((k) => [
        k,
        inherit(k, true),
      ]);
      state.push(["<<effect-template-enable>>", inherit("<<effect-template-enable>>", true)]);
      return { key: effectName, state };
    },
  );
  const effectComponent = {
    id: "effect",
    component: effectEntries,
  };

  // 5. World-instance component
  const worldState = WORLD_INSTANCE_KEYS.map((k) => [
    k,
    inherit(k, WORLD_INSTANCE_DEFAULTS[k]),
  ]);
  const worldComponent = {
    id: "world-instance",
    component: [{ key: "world-instance", state: worldState }],
  };

  return {
    mode,
    templateName: mode === "template" ? (opts.templateName ?? "") : "",
    sourceTemplateName:
      mode === "replica" ? (opts.sourceTemplateName ?? "") : "",
    replicaHierarchyInSyncWithTemplate: mode === "replica",
    templatePropagateHierarchyChanges: true,
    replicaIgnoreTemplateHierarchyChanges: false,
    components: [
      pluginComponent,
      ivComponent,
      behaviorComponent,
      effectComponent,
      worldComponent,
    ],
    replicasUIDs: null,
  };
}

// ---------------------------------------------------------------------------
// Templatize Instance
// ---------------------------------------------------------------------------

/**
 * Convert an existing plain instance into a template definition.
 * Finds the instance by type, then attaches a template block with mode="template".
 */
export function templatize(
  layout: LayoutJson,
  typeName: string,
  templateName: string,
  inheritOverrides?: Record<string, boolean>,
): void {
  const found = findInstanceByType(layout, typeName);
  if (!found) {
    throw new Error(
      `templatize: instance of type "${typeName}" not found in layout`,
    );
  }
  found.instance.template = buildTemplateBlock(found.instance, "template", {
    templateName,
    inheritOverrides,
  });
}

// ---------------------------------------------------------------------------
// Replicify Instance
// ---------------------------------------------------------------------------

/**
 * Convert an existing plain instance into a replica of a named template.
 * Finds the instance by type, then attaches a template block with mode="replica".
 * Unlike addReplica, this does NOT copy — it converts an existing instance in place.
 */
export function replicify(
  layout: LayoutJson,
  typeName: string,
  sourceTemplateName: string,
  inheritOverrides?: Record<string, boolean>,
): void {
  const found = findInstanceByType(layout, typeName);
  if (!found) {
    throw new Error(
      `replicify: instance of type "${typeName}" not found in layout`,
    );
  }
  found.instance.template = buildTemplateBlock(found.instance, "replica", {
    sourceTemplateName,
    inheritOverrides,
  });
}

// ---------------------------------------------------------------------------
// Remove Instance
// ---------------------------------------------------------------------------

/**
 * Remove an instance from a layer's instances array. Searches recursively
 * through sublayers. Returns true if removed, false if not found.
 */
function removeInstanceFromLayers(
  layers: LayerJson[],
  instance: InstanceJson,
): boolean {
  for (const layer of layers) {
    const instances = layer.instances as InstanceJson[] | undefined;
    if (instances) {
      const idx = instances.indexOf(instance);
      if (idx !== -1) {
        instances.splice(idx, 1);
        return true;
      }
    }
    const subLayers = layer.subLayers as LayerJson[] | undefined;
    if (subLayers && removeInstanceFromLayers(subLayers, instance)) {
      return true;
    }
  }
  return false;
}

/**
 * Remove an instance (and its scene-graph children) from a layout.
 * Removes the root's SID from scene-graphs-folder-root.items.
 * Throws if the instance type is not found.
 */
export function removeInstance(layout: LayoutJson, typeName: string, layer?: string): void {
  // 1. Find root instance
  const found = findInstanceByType(layout, typeName);
  if (!found) {
    throw new Error(
      `removeInstance: instance of type "${typeName}" not found in layout`,
    );
  }

  // 1b. If layer filter specified, verify the instance is on that layer
  if (layer) {
    if (!findLayer(layout, layer)) {
      throw new Error(`removeInstance: layer "${layer}" not found in layout`);
    }
    if (found.layerName !== layer) {
      throw new Error(
        `removeInstance: instance of type "${typeName}" is not on layer "${layer}"`,
      );
    }
  }

  const rootInstance = found.instance;
  const rootUid = rootInstance.uid as number;
  const rootSid = rootInstance.sid as number;

  // 2. Find all children
  const children = findChildInstances(layout, rootUid);

  // 3. Remove root instance from its layer
  const layers = layout.layers as LayerJson[];
  removeInstanceFromLayers(layers, rootInstance);

  // 4. Remove each child from its layer
  for (const child of children) {
    removeInstanceFromLayers(layers, child);
  }

  // 5. Remove root's SID from scene-graphs-folder-root.items
  removeSceneGraphRoot(layout, rootSid);
}

// ---------------------------------------------------------------------------
// Move Instance
// ---------------------------------------------------------------------------

/**
 * Move an instance (and its scene-graph children) to a different layer within
 * the same layout. Internally copies to the target then removes the original.
 *
 * Saves references to the original instances before copying so that removal
 * targets the originals even if the target layer precedes the source in the
 * layer array.
 */
export function moveInstance(opts: {
  layout: LayoutJson;
  typeName: string;
  targetLayer: string;
  childrenLayer?: string;
  uidCounter: { next: number };
  sidGenerator: () => number;
}): void {
  // 1. Find and save references to the original instance + children
  const found = findInstanceByType(opts.layout, opts.typeName);
  if (!found) {
    throw new Error(
      `moveInstance: instance of type "${opts.typeName}" not found in layout`,
    );
  }
  const originalRoot = found.instance;
  const originalUid = originalRoot.uid as number;
  const originalSid = originalRoot.sid as number;
  const originalChildren = findChildInstances(opts.layout, originalUid);

  // 2. Copy to new location (creates clones with new UIDs/SIDs)
  copyInstance({
    sourceLayout: opts.layout,
    targetLayout: opts.layout,
    instanceType: opts.typeName,
    includeChildren: originalChildren.length > 0,
    targetLayer: opts.targetLayer,
    childrenLayer: opts.childrenLayer,
    uidCounter: opts.uidCounter,
    sidGenerator: opts.sidGenerator,
  });

  // 3. Remove originals by reference (not by type lookup)
  const layers = opts.layout.layers as LayerJson[];
  removeInstanceFromLayers(layers, originalRoot);
  for (const child of originalChildren) {
    removeInstanceFromLayers(layers, child);
  }

  // 4. Remove original's SID from scene-graphs-folder-root.items
  removeSceneGraphRoot(opts.layout, originalSid);
}

// ---------------------------------------------------------------------------
// Add Replica
// ---------------------------------------------------------------------------

/**
 * Find an instance that has a template block with the given templateName.
 * Searches all layers recursively.
 */
function findTemplateInstance(
  layout: LayoutJson,
  templateName: string,
): InstanceJson | null {
  const layers = layout.layers as LayerJson[] | undefined;
  if (!layers) return null;
  return findTemplateInLayers(layers, templateName);
}

function findTemplateInLayers(
  layers: LayerJson[],
  templateName: string,
): InstanceJson | null {
  for (const layer of layers) {
    const instances = layer.instances as InstanceJson[] | undefined;
    if (instances) {
      for (const inst of instances) {
        const tmpl = inst.template as Record<string, unknown> | undefined;
        if (tmpl && tmpl.mode === "template" && tmpl.templateName === templateName) {
          return inst;
        }
      }
    }
    const subLayers = layer.subLayers as LayerJson[] | undefined;
    if (subLayers) {
      const found = findTemplateInLayers(subLayers, templateName);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Copy a template instance (and children) from a source layout to a target
 * layout as a replica. Uses copyInstance for the deep clone, then sets the
 * template block on the root clone to mode="replica".
 */
export function addReplica(opts: {
  sourceLayout: LayoutJson;
  sourceTemplateName: string;
  targetLayout: LayoutJson;
  targetLayer: string;
  childrenLayer?: string;
  uidCounter: { next: number };
  sidGenerator: () => number;
  overrides?: InstanceOverrides;
  childOverrides?: Record<string, InstanceOverrides>;
  inheritOverrides?: Record<string, boolean>;
}): void {
  // Find the template instance in the source layout by scanning for an instance
  // that has a template block with the matching templateName
  const templateInstance = findTemplateInstance(opts.sourceLayout, opts.sourceTemplateName);
  if (!templateInstance) {
    throw new Error(
      `addReplica: template "${opts.sourceTemplateName}" not found in source layout`,
    );
  }

  const instanceType = templateInstance.type as string;

  // Record position before copy so we can find the root clone afterward
  const targetLayerObj = findLayer(opts.targetLayout, opts.targetLayer);
  if (!targetLayerObj) {
    throw new Error(
      `addReplica: target layer "${opts.targetLayer}" not found in target layout`,
    );
  }
  const instances = targetLayerObj.instances as InstanceJson[];
  const rootIndex = instances.length;

  // Use copyInstance to deep-clone the hierarchy
  copyInstance({
    sourceLayout: opts.sourceLayout,
    targetLayout: opts.targetLayout,
    instanceType,
    includeChildren: true,
    targetLayer: opts.targetLayer,
    childrenLayer: opts.childrenLayer,
    uidCounter: opts.uidCounter,
    sidGenerator: opts.sidGenerator,
    overrides: opts.overrides,
    childOverrides: opts.childOverrides,
  });

  // The root clone is the first instance added to the target layer by copyInstance
  const copiedRoot = instances[rootIndex];

  // Set the template block to replica mode
  copiedRoot.template = buildTemplateBlock(copiedRoot, "replica", {
    sourceTemplateName: opts.sourceTemplateName,
    inheritOverrides: opts.inheritOverrides,
  });
}

// ---------------------------------------------------------------------------
// Rename Layer
// ---------------------------------------------------------------------------

/**
 * Rename a layer in a layout. Searches recursively through layers and sublayers.
 */
export function renameLayer(
  layout: LayoutJson,
  currentName: string,
  newName: string,
): void {
  const layer = findLayer(layout, currentName);
  if (!layer) {
    throw new Error(
      `renameLayer: layer "${currentName}" not found in layout`,
    );
  }
  layer.name = newName;
}
