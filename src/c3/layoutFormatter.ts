import { visitLayers, type Layout, type Layer, type Instance } from "@genvid/c3source";

/**
 * Build a map of global layer name → source layout name.
 *
 * A global layer's "source" is the layout where it has `global: true`,
 * `overriden: 0`, and actual instances. Other layouts reference it via
 * `overriden: 1` (empty instances).
 */
export function buildGlobalLayerMap(layouts: Array<{ layout: Layout }>): Map<string, string> {
  const map = new Map<string, string>();

  for (const { layout } of layouts) {
    visitLayers(layout.layers, (layer) => {
      if (layer.global && !isOverriden(layer) && hasInstances(layer)) {
        if (map.has(layer.name)) {
          console.warn(
            `Warning: global layer "${layer.name}" defined in multiple layouts: "${map.get(layer.name)}" and "${layout.name}"`,
          );
        } else {
          map.set(layer.name, layout.name);
        }
      }
      return 0;
    });
  }

  return map;
}

/**
 * Format a layout into a human-readable summary string.
 */
export function formatLayout(
  layout: Layout,
  sourcePath: string,
  globalLayerMap: Map<string, string>,
  isTemplateHolder: boolean,
  containerMap?: Map<string, string[]>,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${layout.name}`);

  const layoutsIndex = sourcePath.replace(/\\/g, "/").indexOf("layouts/");
  const relPath =
    layoutsIndex >= 0 ? sourcePath.replace(/\\/g, "/").slice(layoutsIndex) : sourcePath.replace(/\\/g, "/");
  lines.push(`# Source: ${relPath}`);

  const eventSheet = getLayoutEventSheet(layout);
  if (eventSheet) {
    lines.push(`# EventSheet: ${eventSheet}`);
  }

  const size = getLayoutSize(layout);
  if (size) {
    lines.push(`# Size: ${size.width} x ${size.height}`);
  }

  lines.push("");

  const sectionHeader = isTemplateHolder ? "## Templates" : "## Layers";
  lines.push(`${sectionHeader} (${layout.layers.length})`);
  lines.push("");

  // Build UID map across all layers for cross-layer hierarchy resolution
  const uidMap = buildUidMap(layout);

  // Collect all instance types present in this layout (for container presence marking)
  const layoutTypes = new Set<string>();
  for (const inst of uidMap.values()) {
    layoutTypes.add(inst.type);
  }

  const nonworldInstances = layout["nonworld-instances"] ?? [];

  const ctx: LayoutFormatContext = {
    globalLayerMap,
    isTemplateHolder,
    containerMap,
    uidMap,
    layoutTypes,
  };

  for (const layer of layout.layers) {
    const layerLines = formatLayer(layer, null, "", ctx);
    lines.push(...layerLines);
  }

  if (nonworldInstances.length > 0) {
    lines.push(`## Non-world Instances (${nonworldInstances.length})`);
    lines.push("");
    const groups = groupInstances(nonworldInstances, false);
    for (const group of groups) {
      lines.push(`  ${formatInstanceGroup(group, ctx.containerMap, ctx.layoutTypes)}`);
    }
    lines.push("");
  }

  // Ensure trailing newline
  lines.push("");

  return lines.join("\n");
}

// --- Internal helpers ---

/** Layout-wide context passed to formatLayer and its callees. */
interface LayoutFormatContext {
  globalLayerMap: Map<string, string>;
  isTemplateHolder: boolean;
  containerMap?: Map<string, string[]>;
  uidMap: Map<number, Instance>;
  layoutTypes: Set<string>;
}

// Scene graph data types
interface SceneGraphData {
  "parent-uid": number | null;
  uid: number;
  children?: Array<{ uid: number; flags?: Record<string, unknown> }>;
  flags?: Record<string, unknown>;
}

function getSceneGraphData(inst: Instance): SceneGraphData | undefined {
  return (inst as Record<string, unknown>).sceneGraphData as SceneGraphData | undefined;
}

function isChildInstance(inst: Instance): boolean {
  const sgd = getSceneGraphData(inst);
  return sgd != null && sgd["parent-uid"] != null;
}

function getTemplateMode(inst: Instance): string | undefined {
  const template = inst.template as { mode?: string } | undefined;
  return template?.mode;
}

/** True if any instance in the group is a replica (mode: "replica"). */
function isReplicaGroup(group: InstanceGroup): boolean {
  return group.instances.some((inst) => getTemplateMode(inst) === "replica");
}

/** Build UID → Instance map across all layers and nonworld-instances in a layout. */
function buildUidMap(layout: Layout): Map<number, Instance> {
  const map = new Map<number, Instance>();
  visitLayers(layout.layers, (layer) => {
    for (const inst of layer.instances ?? []) {
      map.set(inst.uid, inst);
    }
    return 0;
  });
  for (const inst of layout["nonworld-instances"] ?? []) {
    map.set(inst.uid, inst);
  }
  return map;
}

interface ChildTree {
  type: string;
  children: ChildTree[];
}

/** Recursively resolve child tree for a parent instance. */
function resolveChildTree(inst: Instance, uidMap: Map<number, Instance>): ChildTree[] {
  const sgd = getSceneGraphData(inst);
  if (!sgd?.children) return [];

  const result: ChildTree[] = [];
  for (const childRef of sgd.children) {
    const childInst = uidMap.get(childRef.uid);
    if (!childInst) continue;
    result.push({
      type: childInst.type,
      children: resolveChildTree(childInst, uidMap),
    });
  }
  return result;
}

/** Serialize a child tree to a canonical string for deduplication. */
function treeSignature(children: ChildTree[]): string {
  return children.map((c) => `${c.type}(${treeSignature(c.children)})`).join(",");
}

/** Format tree lines for children, recursively handling multi-level. */
function formatChildTreeLines(children: ChildTree[], indent: string): string[] {
  const lines: string[] = [];
  for (const child of children) {
    lines.push(`${indent}└─ ${child.type}`);
    if (child.children.length > 0) {
      lines.push(...formatChildTreeLines(child.children, indent + "  "));
    }
  }
  return lines;
}

function isOverriden(layer: Layer): boolean {
  return layer.overriden === 1;
}

function getSubLayers(layer: Layer): Layer[] {
  return layer.subLayers ?? [];
}

function getTags(inst: Instance): string | undefined {
  return (inst as Record<string, unknown>).tags as string | undefined;
}

function getLayoutEventSheet(layout: Layout): string | undefined {
  return layout.eventSheet;
}

function getLayoutSize(layout: Layout): { width: number; height: number } | undefined {
  const { width, height } = layout;
  if (width != null && height != null) return { width, height };
  return undefined;
}

function hasInstances(layer: Layer): boolean {
  const instances = layer.instances ?? [];
  // Also check sublayers recursively
  if (instances.length > 0) return true;
  return getSubLayers(layer).some((sub) => hasInstances(sub));
}

function layerAnnotations(layer: Layer, globalLayerMap: Map<string, string>): string {
  const parts: string[] = [];

  if (isOverriden(layer)) {
    parts.push("overriden");
    const source = globalLayerMap.get(layer.name);
    if (source) {
      return `(${parts.join(", ")}) [\u2192 ${source}]`;
    }
    return `(${parts.join(", ")}) [\u2192 ?]`;
  }

  if (layer.global) {
    parts.push("global");
  }

  const instanceCount = countInstances(layer);
  if (instanceCount > 0) {
    parts.push(`${instanceCount} ${instanceCount === 1 ? "instance" : "instances"}`);
  }

  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

function countInstances(layer: Layer): number {
  return (layer.instances ?? []).length;
}

function formatLayer(layer: Layer, parentName: string | null, indent: string, ctx: LayoutFormatContext): string[] {
  const lines: string[] = [];
  const displayName = parentName ? `${parentName} > ${layer.name}` : layer.name;
  const annotation = layerAnnotations(layer, ctx.globalLayerMap);
  const header = annotation ? `${indent}${displayName} ${annotation}` : `${indent}${displayName}`;
  lines.push(header);

  // Overriden layers: no content, no sublayers
  if (isOverriden(layer)) {
    lines.push("");
    return lines;
  }

  // Filter out child instances (they appear nested under their parents)
  const allInstances = layer.instances ?? [];
  const instances = allInstances.filter((inst) => !isChildInstance(inst));

  if (instances.length > 0) {
    const groups = groupInstances(instances, ctx.isTemplateHolder);
    for (const group of groups) {
      lines.push(`${indent}  ${formatInstanceGroup(group, ctx.containerMap, ctx.layoutTypes)}`);

      // Add hierarchy nesting for parent instances
      const hierarchyLines = formatGroupHierarchy(group, ctx.uidMap, indent + "    ");
      lines.push(...hierarchyLines);
    }
  }

  // Recurse into sublayers
  const subLayers = getSubLayers(layer);
  for (const sub of subLayers) {
    lines.push(...formatLayer(sub, displayName, indent + "  ", ctx));
  }

  lines.push("");
  return lines;
}

interface InstanceGroup {
  type: string;
  count: number;
  varKeys: string[];
  tags: string[];
  templateName: string | null;
  isTemplateHolder: boolean;
  instances: Instance[];
}

function groupInstances(instances: Instance[], isTemplateHolder: boolean): InstanceGroup[] {
  // Group by type + templateName (for TemplateHolders, templateName is the primary identifier)
  const groupMap = new Map<string, InstanceGroup>();

  for (const inst of instances) {
    const template = inst.template as { templateName?: string } | undefined;
    const templateName = template?.templateName ?? null;
    const groupKey = isTemplateHolder ? `${inst.type}::${templateName ?? ""}` : inst.type;

    const existing = groupMap.get(groupKey);
    if (existing) {
      existing.count++;
      existing.instances.push(inst);
      mergeVarKeys(existing.varKeys, inst);
      mergeTags(existing.tags, inst);
    } else {
      groupMap.set(groupKey, {
        type: inst.type,
        count: 1,
        varKeys: collectVarKeys(inst),
        tags: collectTags(inst),
        templateName,
        isTemplateHolder,
        instances: [inst],
      });
    }
  }

  return Array.from(groupMap.values());
}

/** Format hierarchy lines for a group of parent instances. */
function formatGroupHierarchy(group: InstanceGroup, uidMap: Map<number, Instance>, indent: string): string[] {
  // Skip hierarchy for template replicas (mode: "replica").
  // Template definitions (mode: "template") show full hierarchy regardless of layout folder.
  if (isReplicaGroup(group)) return [];

  // Collect child trees from all instances in the group
  const trees: ChildTree[][] = [];
  for (const inst of group.instances) {
    const sgd = getSceneGraphData(inst);
    if (!sgd?.children || sgd.children.length === 0) continue;
    const tree = resolveChildTree(inst, uidMap);
    if (tree.length > 0) trees.push(tree);
  }

  if (trees.length === 0) return [];

  // Deduplicate: if all trees have the same signature, show once
  const signatures = trees.map((t) => treeSignature(t));
  const allSame = signatures.every((s) => s === signatures[0]);

  if (allSame) {
    // Show tree once (parent count already reflects total)
    return formatChildTreeLines(trees[0], indent);
  }

  // Different trees — show each one (rare case)
  const lines: string[] = [];
  for (const tree of trees) {
    lines.push(...formatChildTreeLines(tree, indent));
  }
  return lines;
}

function collectVarKeys(inst: Instance): string[] {
  const vars = inst.instanceVariables;
  if (!vars || Object.keys(vars).length === 0) return [];
  return Object.keys(vars);
}

function mergeVarKeys(existing: string[], inst: Instance): void {
  const vars = inst.instanceVariables;
  if (!vars) return;
  for (const key of Object.keys(vars)) {
    if (!existing.includes(key)) {
      existing.push(key);
    }
  }
}

function collectTags(inst: Instance): string[] {
  const tags = getTags(inst);
  if (!tags || tags.trim() === "") return [];
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function mergeTags(existing: string[], inst: Instance): void {
  for (const tag of collectTags(inst)) {
    if (!existing.includes(tag)) {
      existing.push(tag);
    }
  }
}

function formatInstanceGroup(
  group: InstanceGroup,
  containerMap?: Map<string, string[]>,
  layoutTypes?: Set<string>,
): string {
  const parts: string[] = [];

  if (group.isTemplateHolder && group.templateName) {
    // TemplateHolder: TypeName "templateName" xN
    parts.push(`${group.type} "${group.templateName}" x${group.count}`);
  } else {
    // Regular: TypeName xN
    parts.push(`${group.type} x${group.count}`);
  }

  // Add instanceVariable keys
  if (group.varKeys.length > 0) {
    parts.push(`[${group.varKeys.join(", ")}]`);
  }

  // Add tags
  if (group.tags.length > 0) {
    parts.push(`#${group.tags.join(" #")}`);
  }

  // Add template annotation for non-TemplateHolder layouts
  if (!group.isTemplateHolder && group.templateName) {
    parts.push(`(template: ${group.templateName})`);
  }

  // Add container annotation with full group and presence markers
  const containerGroup = containerMap?.get(group.type);
  if (containerGroup) {
    const formatted = containerGroup.map((m) => (layoutTypes?.has(m) ? m : `~${m}`)).join(", ");
    parts.push(`(container: {${formatted}})`);
  }

  return parts.join(" ");
}

/**
 * Recursively sum instance counts across a layer and all descendant sublayers.
 */
export function countInstancesDeep(layer: Layer): number {
  let count = (layer.instances ?? []).length;
  for (const sub of getSubLayers(layer)) {
    count += countInstancesDeep(sub);
  }
  return count;
}

/**
 * Report entry for a single global layer, aggregated across all layouts.
 */
export interface GlobalLayerReport {
  /** Layer name (matches the C3 layer `name` field). */
  name: string;
  /** Name of the layout that defines (sources) this global layer. */
  sourceLayout: string;
  /** Names of layouts that override this global layer, sorted. */
  overridingLayouts: string[];
  /** Total instance count in the source layer, including all descendant sublayers. */
  instanceCount: number;
  /**
   * Set when the same layer name qualifies as a source in more than one layout.
   * Contains a human-readable warning string; do NOT emit a console.warn.
   */
  multiSourceWarning?: string;
}

/**
 * Build a report of all global layers found across the given layouts.
 *
 * A layer is a "source" when `layer.global && !isOverriden(layer) && hasInstances(layer)`.
 * A layer is "overriding" when `isOverriden(layer)` is true for the same layer name.
 *
 * Returns entries sorted by layer name.
 */
export function buildGlobalLayerReport(layouts: Array<{ layout: Layout }>): GlobalLayerReport[] {
  // Map from layer name → { sourceLayout, sourceLayer, extraSources }
  const sourceMap = new Map<string, { sourceLayout: string; sourceLayer: Layer; extraSources: string[] }>();
  // Map from layer name → overriding layout names
  const overrideMap = new Map<string, string[]>();

  for (const { layout } of layouts) {
    visitLayers(layout.layers, (layer) => {
      if (layer.global && !isOverriden(layer) && hasInstances(layer)) {
        const existing = sourceMap.get(layer.name);
        if (existing) {
          existing.extraSources.push(layout.name);
        } else {
          sourceMap.set(layer.name, {
            sourceLayout: layout.name,
            sourceLayer: layer,
            extraSources: [],
          });
        }
      }
      if (isOverriden(layer)) {
        const list = overrideMap.get(layer.name);
        if (list) {
          list.push(layout.name);
        } else {
          overrideMap.set(layer.name, [layout.name]);
        }
      }
      return 0;
    });
  }

  const reports: GlobalLayerReport[] = [];
  for (const [name, { sourceLayout, sourceLayer, extraSources }] of sourceMap) {
    const overridingLayouts = (overrideMap.get(name) ?? []).slice().sort();
    const instanceCount = countInstancesDeep(sourceLayer);
    const report: GlobalLayerReport = {
      name,
      sourceLayout,
      overridingLayouts,
      instanceCount,
    };
    if (extraSources.length > 0) {
      const allSources = [sourceLayout, ...extraSources].map((s) => `"${s}"`).join(", ");
      report.multiSourceWarning = `[WARNING: global layer "${name}" defined in multiple source layouts: ${allSources}]`;
    }
    reports.push(report);
  }

  reports.sort((a, b) => a.name.localeCompare(b.name));
  return reports;
}

/**
 * Format a global-layers report into a human-readable text file.
 *
 * Follows the same `#`-header convention as formatContainersFile / template-scope.txt.
 * Returns a string with a trailing newline.
 */
export function formatGlobalLayers(reports: GlobalLayerReport[]): string {
  const lines: string[] = [
    "# C3 Global Layers",
    "# Source: layouts/**/*.json",
    "# Global layers are shared across layouts; one layout defines instances, others override.",
    "",
  ];

  if (reports.length === 0) {
    lines.push("(no global layers found)");
  } else {
    for (const r of reports) {
      const overriders = r.overridingLayouts.length > 0 ? r.overridingLayouts.join(", ") : "(none)";
      lines.push(
        `${r.name}: source="${r.sourceLayout}", overridingLayouts=[${overriders}], instanceCount=${r.instanceCount}`,
      );
      if (r.multiSourceWarning) {
        lines.push(`  ${r.multiSourceWarning}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format a standalone containers reference file.
 */
export function formatContainersFile(containerGroups: string[][]): string {
  const lines: string[] = [
    "# C3 Containers",
    "# Source: project.c3proj",
    "# All members of a container are created together at runtime.",
    "",
  ];

  for (const members of containerGroups) {
    lines.push(`{${members.join(", ")}}`);
  }

  lines.push("");
  return lines.join("\n");
}

