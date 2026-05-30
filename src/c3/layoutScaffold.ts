import { readFileSync } from "node:fs";
import { find_all_layouts_path, remapInstanceIds, type Instance } from "c3source";
import { mintUniqueSid } from "./sidUtils.js";

// SID generation moved to ./sidUtils.js — use `mintUniqueSid(usedSids)` (strict range
// [1e14, 1e15) with a 100-attempt collision cap). The historical `generateUniqueSid`
// in this module had range [0, 1e15) (could return SID 0, documented as unsafe) and
// an unbounded retry loop; it was removed when the SID singleton was retired.

// ─── UID collection ───

function collectInstanceUids(instance: Record<string, unknown>, uids: Set<number>): void {
  if (typeof instance.uid === "number") {
    uids.add(instance.uid);
  }
  const sgd = instance.sceneGraphData as Record<string, unknown> | undefined;
  if (sgd) {
    if (typeof sgd.uid === "number") {
      uids.add(sgd.uid);
    }
    const children = sgd.children as Array<Record<string, unknown>> | undefined;
    if (children) {
      for (const child of children) {
        if (typeof child.uid === "number") {
          uids.add(child.uid);
        }
      }
    }
  }
}

function collectLayerUids(layer: Record<string, unknown>, uids: Set<number>): void {
  const instances = layer.instances as Array<Record<string, unknown>> | undefined;
  if (instances) {
    for (const inst of instances) {
      collectInstanceUids(inst, uids);
    }
  }
  const subLayers = layer.subLayers as Array<Record<string, unknown>> | undefined;
  if (subLayers) {
    for (const sub of subLayers) {
      collectLayerUids(sub, uids);
    }
  }
}

/** Collect all UIDs from a single layout JSON object (in-memory) */
export function collectLayoutUids(layout: Record<string, unknown>): Set<number> {
  const uids = new Set<number>();

  const layers = layout.layers as Array<Record<string, unknown>> | undefined;
  if (layers) {
    for (const layer of layers) {
      collectLayerUids(layer, uids);
    }
  }

  const nonworldInstances = layout["nonworld-instances"] as Array<Record<string, unknown>> | undefined;
  if (nonworldInstances) {
    for (const inst of nonworldInstances) {
      if (typeof inst.uid === "number") {
        uids.add(inst.uid);
      }
    }
  }

  return uids;
}

/** Collect all UIDs from all layout files in a directory */
export function collectAllUids(layoutsDir: string): Set<number> {
  const allPaths = find_all_layouts_path(layoutsDir);
  const uids = new Set<number>();

  for (const layoutPath of allPaths) {
    const content = readFileSync(layoutPath, "utf-8");
    const layout = JSON.parse(content) as Record<string, unknown>;
    for (const uid of collectLayoutUids(layout)) {
      uids.add(uid);
    }
  }

  return uids;
}

// ─── SID collection ───

function collectLayerSids(layer: Record<string, unknown>, sids: Set<number>): void {
  if (typeof layer.sid === "number") {
    sids.add(layer.sid);
  }
  const instances = layer.instances as Array<Record<string, unknown>> | undefined;
  if (instances) {
    for (const inst of instances) {
      if (typeof inst.sid === "number") {
        sids.add(inst.sid);
      }
    }
  }
  const subLayers = layer.subLayers as Array<Record<string, unknown>> | undefined;
  if (subLayers) {
    for (const sub of subLayers) {
      collectLayerSids(sub, sids);
    }
  }
}

/** Collect all SIDs from a single layout JSON object (layout sid, layer sids, instance sids) */
export function collectLayoutSids(layout: Record<string, unknown>): Set<number> {
  const sids = new Set<number>();

  if (typeof layout.sid === "number") {
    sids.add(layout.sid);
  }

  const layers = layout.layers as Array<Record<string, unknown>> | undefined;
  if (layers) {
    for (const layer of layers) {
      collectLayerSids(layer, sids);
    }
  }

  const nonworldInstances = layout["nonworld-instances"] as Array<Record<string, unknown>> | undefined;
  if (nonworldInstances) {
    for (const inst of nonworldInstances) {
      if (typeof inst.sid === "number") {
        sids.add(inst.sid);
      }
    }
  }

  return sids;
}

// ─── Remapping helpers ───

// Thin wrapper over c3source's remapInstanceIds, which owns the C3 id-remap
// rules (uid; sid + mirrored instanceFolderItem.sid; sceneGraphData uid /
// parent-uid (kept at -1 for roots) / children[].uid).
function remapInstanceInPlace(instance: Record<string, unknown>, uidMap: Map<number, number>, sidMap: Map<number, number>): void {
  remapInstanceIds(instance as unknown as Instance, uidMap, sidMap);
}

function remapLayerInPlace(layer: Record<string, unknown>, uidMap: Map<number, number>, sidMap: Map<number, number>): void {
  if (typeof layer.sid === "number") {
    layer.sid = sidMap.get(layer.sid) ?? layer.sid;
  }
  const instances = layer.instances as Array<Record<string, unknown>> | undefined;
  if (instances) {
    for (const inst of instances) {
      remapInstanceInPlace(inst, uidMap, sidMap);
    }
  }
  const subLayers = layer.subLayers as Array<Record<string, unknown>> | undefined;
  if (subLayers) {
    for (const sub of subLayers) {
      remapLayerInPlace(sub, uidMap, sidMap);
    }
  }
}

function remapSceneGraphFolder(folder: Record<string, unknown>, sidMap: Map<number, number>): void {
  const items = folder.items as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item.sid === "number") {
        item.sid = sidMap.get(item.sid) ?? item.sid;
      }
    }
  }
  const subfolders = folder.subfolders as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(subfolders)) {
    for (const sub of subfolders) {
      remapSceneGraphFolder(sub, sidMap);
    }
  }
}

// ─── cloneLayout ───

/**
 * Clone a source layout JSON, remapping all UIDs and SIDs for uniqueness.
 * Returns new layout JSON (does not write to disk).
 */
export function cloneLayout(
  source: Record<string, unknown>,
  opts: {
    name: string;
    eventSheet: string;
    /** All UIDs that already exist across ALL layouts (to avoid collision) */
    existingUids: Set<number>;
    /**
     * SIDs that already exist project-wide (eventSheets/, layouts/, objectTypes/) — typically
     * seeded via `readRegistryFile(extracted/sid-registry.txt)`. The new SIDs minted for the
     * clone will not collide with anything in this set. The Set is mutated as SIDs are minted.
     * Optional for backward compatibility; when omitted, falls back to the legacy clone-local
     * Set that only avoids collisions within the clone itself.
     */
    existingSids?: Set<number>;
  },
): Record<string, unknown> {
  // 1. Deep-copy source JSON
  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;

  // 2. Build UID remapping
  const sourceUids = collectLayoutUids(source);
  const allExistingUids = new Set<number>(opts.existingUids);
  // Also include source UIDs so we don't accidentally collide within the source set
  for (const uid of sourceUids) {
    allExistingUids.add(uid);
  }
  const maxUid = allExistingUids.size > 0 ? Math.max(...allExistingUids) : 100000;
  const uidMap = new Map<number, number>();
  let nextUid = maxUid + 1;
  for (const oldUid of sourceUids) {
    uidMap.set(oldUid, nextUid++);
  }

  // 3. Build SID remapping. Use the caller-provided existingSids when available so the
  // clone's new SIDs don't collide with anything project-wide; otherwise fall back to a
  // clone-local Set (legacy behaviour).
  const sourceSids = collectLayoutSids(source);
  const generatedSids = opts.existingSids ?? new Set<number>();
  // Seed with source SIDs too so cloned SIDs don't collide with their own ancestors.
  for (const sid of sourceSids) generatedSids.add(sid);
  const sidMap = new Map<number, number>();
  for (const oldSid of sourceSids) {
    sidMap.set(oldSid, mintUniqueSid(generatedSids));
  }

  // 4. Apply remapping to the deep-copied layout

  // Update name and eventSheet
  clone.name = opts.name;
  clone.eventSheet = opts.eventSheet;

  // Remap layout-level SID
  if (typeof clone.sid === "number") {
    clone.sid = sidMap.get(clone.sid) ?? clone.sid;
  }

  // Remap layers (recursively through subLayers)
  const layers = clone.layers as Array<Record<string, unknown>> | undefined;
  if (layers) {
    for (const layer of layers) {
      remapLayerInPlace(layer, uidMap, sidMap);
    }
  }

  // Remap nonworld-instances
  const nonworldInstances = clone["nonworld-instances"] as Array<Record<string, unknown>> | undefined;
  if (nonworldInstances) {
    for (const inst of nonworldInstances) {
      if (typeof inst.uid === "number") {
        inst.uid = uidMap.get(inst.uid) ?? inst.uid;
      }
      if (typeof inst.sid === "number") {
        inst.sid = sidMap.get(inst.sid) ?? inst.sid;
      }
    }
  }

  // Remap scene-graphs-folder-root item SIDs (recursively through subfolders)
  const sgfr = clone["scene-graphs-folder-root"] as Record<string, unknown> | undefined;
  if (sgfr) {
    remapSceneGraphFolder(sgfr, sidMap);
  }

  // 5. Return modified clone
  return clone;
}
