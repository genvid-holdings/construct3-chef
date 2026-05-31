import * as fs from "fs";
import * as path from "path";
import type { EventSheet } from "@genvid/c3source";
import { visitEvents } from "@genvid/c3source";

export interface IncludeTreeNode {
  /** Sheet name (e.g., "CommonEvents") */
  name: string;
  /** Relative path from project root (e.g., "eventSheets/Common/CommonEvents.json") */
  path: string;
  /** Direct includes from this sheet */
  includes: IncludeTreeNode[];
  /** Functions defined in this sheet (only populated when requested) */
  functions?: string[];
}

/**
 * Build a name → file path map by scanning the eventSheets directory.
 * Sheet names are filenames without extension (e.g., "CommonEvents").
 */
export function buildSheetNameMap(projectDir: string): Map<string, string> {
  const esDir = path.join(projectDir, "eventSheets");
  const map = new Map<string, string>();

  function scan(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scan(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".json")) {
        const sheetName = entry.name.replace(/\.json$/, "");
        const relPath = path.relative(projectDir, path.join(dir, entry.name)).replace(/\\/g, "/");
        map.set(sheetName, relPath);
      }
    }
  }

  scan(esDir);
  return map;
}

/**
 * Extract function names from an eventSheet's events array, via c3source's
 * canonical event walk: function-block → its name; custom-ace-block →
 * "ObjectClass.AceName". visitEvents descends every child-bearing event (not
 * only groups), so this is a strict superset of the old groups-only walk.
 */
export function extractFunctions(events: EventSheet["events"]): string[] {
  const functions: string[] = [];
  visitEvents(events, (event) => {
    if (event.eventType === "function-block") {
      functions.push(event.functionName);
    } else if (event.eventType === "custom-ace-block") {
      functions.push(`${event.objectClass}.${event.aceName}`);
    }
  });
  return functions;
}

/**
 * Resolve the transitive include tree for an eventSheet.
 *
 * @param sheetName - Sheet name (e.g., "GoalsEvents") or relative path (e.g., "eventSheets/Goals/GoalsEvents.json")
 * @param projectDir - Project root directory
 * @param options - Optional: includeFunctions (list functions at each level)
 * @returns Root IncludeTreeNode with resolved transitive includes
 */
export function resolveIncludeTree(
  sheetName: string,
  projectDir: string,
  options?: { includeFunctions?: boolean },
): IncludeTreeNode {
  const nameMap = buildSheetNameMap(projectDir);
  const visited = new Set<string>();

  // Normalize input: accept "eventSheets/Path/Sheet.json" or "Path/Sheet" or "Sheet"
  let rootName = sheetName;
  if (rootName.startsWith("eventSheets/")) {
    rootName = rootName.replace(/^eventSheets\//, "").replace(/\.json$/, "");
    // Extract just the filename part (last segment)
    const parts = rootName.split("/");
    rootName = parts[parts.length - 1];
  } else if (rootName.endsWith(".json")) {
    rootName = rootName.replace(/\.json$/, "");
    const parts = rootName.split("/");
    rootName = parts[parts.length - 1];
  }

  function resolve(name: string): IncludeTreeNode {
    const filePath = nameMap.get(name);
    const node: IncludeTreeNode = {
      name,
      path: filePath ?? `(not found: ${name})`,
      includes: [],
    };

    if (!filePath) return node;
    if (visited.has(name)) {
      // Already visited via another include path — not a real cycle,
      // just deduplication to prevent infinite traversal of diamond includes
      // (e.g., both B and C include Shared). Functions from this sheet are
      // still available; flattenIncludeTree() collects all unique names.
      node.path = `${filePath} (already included)`;
      return node;
    }

    visited.add(name);

    try {
      const fullPath = path.join(projectDir, filePath);
      const sheet: EventSheet = JSON.parse(fs.readFileSync(fullPath, "utf8"));

      if (options?.includeFunctions) {
        node.functions = extractFunctions(sheet.events);
      }

      for (const event of sheet.events) {
        if (event.eventType === "include") {
          node.includes.push(resolve(event.includeSheet));
        }
      }
    } catch {
      // File read/parse error — return partial node
    }

    return node;
  }

  return resolve(rootName);
}

/**
 * Format an include tree as a human-readable string.
 * Optionally includes function names at each level.
 */
export function formatIncludeTree(node: IncludeTreeNode, indent: number = 0): string {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];

  if (indent === 0) {
    lines.push(`# Include Tree: ${node.name}`);
    lines.push(`# Source: ${node.path}`);
    lines.push("");
  }

  const marker = indent === 0 ? "" : `${prefix}├─ `;
  const label = indent === 0 ? node.name : `${marker}${node.name}`;
  lines.push(label);

  if (node.functions && node.functions.length > 0) {
    for (const fn of node.functions) {
      lines.push(`${prefix}  │ fn ${fn}`);
    }
  }

  for (const child of node.includes) {
    lines.push(...formatIncludeTree(child, indent + 1).split("\n"));
  }

  return lines.join("\n");
}

/**
 * Collect all sheet names in the transitive include tree (flattened, deduplicated).
 * Useful for checking which functions are available from a given sheet.
 */
export function flattenIncludeTree(node: IncludeTreeNode): string[] {
  const names = new Set<string>();

  function walk(n: IncludeTreeNode): void {
    if (names.has(n.name)) return;
    names.add(n.name);
    for (const child of n.includes) {
      walk(child);
    }
  }

  walk(node);
  return [...names];
}
