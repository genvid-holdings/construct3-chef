import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { mintUniqueSid } from "./sidUtils.js";

// SID generation lives in ./sidUtils.js — `mintUniqueSid(existingSids)` enforces the
// strict [1e14, 1e15) range with a 100-attempt collision cap. The historical local
// `generateUniqueSid` here had range [0, 1e15) (could return SID 0, documented as
// unsafe in the initiative) and an unbounded retry loop.

// ─── File utilities ───

/** Recursively collect all .json file paths under a directory */
function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findJsonFiles(full));
    } else if (entry.endsWith(".json")) {
      results.push(full);
    }
  }
  return results;
}

// ─── SID collection from objectTypes ───

/** Recursively collect all imageSpriteId values from a parsed objectType JSON */
function collectImageSpriteIds(obj: unknown, ids: Set<number>): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectImageSpriteIds(item, ids);
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "imageSpriteId" && typeof value === "number") {
      ids.add(value);
    } else {
      collectImageSpriteIds(value, ids);
    }
  }
}

/** Recursively collect all SID values from a parsed objectType JSON */
function collectObjectTypeSids(obj: unknown, sids: Set<number>): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectObjectTypeSids(item, sids);
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "sid" && typeof value === "number") {
      sids.add(value);
    } else if (key !== "imageSpriteId") {
      collectObjectTypeSids(value, sids);
    }
  }
}

/**
 * Collect all existing SIDs from all objectType JSON files.
 * Returns a Set of all SIDs found.
 */
export function collectAllObjectTypeSids(objectTypesDir: string): Set<number> {
  const files = findJsonFiles(objectTypesDir);
  const sids = new Set<number>();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    collectObjectTypeSids(parsed, sids);
  }
  return sids;
}

/**
 * Collect max imageSpriteId from all objectType JSON files.
 * Returns the maximum imageSpriteId found, or 0 if none exist.
 */
export function collectMaxImageSpriteId(objectTypesDir: string): number {
  const files = findJsonFiles(objectTypesDir);
  const ids = new Set<number>();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    collectImageSpriteIds(parsed, ids);
  }
  return ids.size > 0 ? Math.max(...ids) : 0;
}

// ─── Image discovery and renaming ───

/**
 * Discover all image files associated with a source objectType by naming convention.
 * Images follow the pattern: <sourcename-lowercase>-*.png (case-insensitive glob).
 * Returns an array of { sourcePath, targetPath } pairs.
 */
export function discoverAndPlanImageCopies(
  imagesDir: string,
  sourceName: string,
  targetName: string,
): Array<{ sourcePath: string; targetPath: string; sourceBasename: string; targetBasename: string }> {
  const sourcePrefix = sourceName.toLowerCase();
  const targetPrefix = targetName.toLowerCase();

  const matches = readdirSync(imagesDir).filter(
    (f) => f.toLowerCase().startsWith(sourcePrefix + "-") && f.toLowerCase().endsWith(".png"),
  );
  return matches.map((basename) => {
    const suffix = basename.slice(sourcePrefix.length); // e.g., "-animation 1-000.png"
    const targetBasename = targetPrefix + suffix;
    return {
      sourcePath: path.join(imagesDir, basename),
      targetPath: path.join(imagesDir, targetBasename),
      sourceBasename: basename,
      targetBasename,
    };
  });
}

// ─── cloneSprite ───

/** Remap all imageSpriteId values in the deep-copied JSON, assigning sequential IDs from nextId. */
function remapImageSpriteIds(obj: unknown, nextId: number): number {
  if (obj === null || typeof obj !== "object") return nextId;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      nextId = remapImageSpriteIds(item, nextId);
    }
    return nextId;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "imageSpriteId" && typeof record[key] === "number") {
      record[key] = nextId++;
    } else {
      nextId = remapImageSpriteIds(record[key], nextId);
    }
  }
  return nextId;
}

/** Remap all SID values in the deep-copied JSON using the provided sidMap. */
function remapSids(obj: unknown, sidMap: Map<number, number>): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      remapSids(item, sidMap);
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "sid" && typeof record[key] === "number") {
      record[key] = sidMap.get(record[key] as number) ?? record[key];
    } else if (key !== "imageSpriteId") {
      remapSids(record[key], sidMap);
    }
  }
}

/**
 * Clone a source objectType JSON, remapping all SIDs and imageSpriteIds for uniqueness.
 * Returns new objectType JSON (does not write to disk).
 */
export function cloneSprite(
  source: Record<string, unknown>,
  opts: {
    name: string;
    /** All SIDs that already exist across ALL objectTypes (to avoid collision) */
    existingSids: Set<number>;
    /** The next imageSpriteId to use (typically maxExistingImageSpriteId + 1) */
    nextImageSpriteId: number;
  },
): Record<string, unknown> {
  // 1. Deep-copy source JSON
  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;

  // 2. Build SID remapping — collect source SIDs and generate new ones
  const sourceSids = new Set<number>();
  collectObjectTypeSids(source, sourceSids);

  const allExistingSids = new Set<number>(opts.existingSids);
  // Include source SIDs so we don't accidentally collide within the source set
  for (const sid of sourceSids) {
    allExistingSids.add(sid);
  }

  const sidMap = new Map<number, number>();
  for (const oldSid of sourceSids) {
    sidMap.set(oldSid, mintUniqueSid(allExistingSids));
  }

  // 3. Update name
  clone.name = opts.name;

  // 4. Apply SID remapping
  remapSids(clone, sidMap);

  // 5. Apply imageSpriteId remapping
  remapImageSpriteIds(clone, opts.nextImageSpriteId);

  return clone;
}
