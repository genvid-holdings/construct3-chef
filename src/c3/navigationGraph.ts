import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { find_all_layouts_path, type Layout } from "@genvid/c3source";

/** Map from layoutName -> primary eventSheet name (from layout JSON) */
export function buildLayoutEventSheetMap(layoutsDir: string): Record<string, string> {
  const layoutPaths = find_all_layouts_path(layoutsDir);
  const map: Record<string, string> = {};

  for (const layoutPath of layoutPaths) {
    const content = readFileSync(layoutPath, "utf-8");
    const layout: Layout & { eventSheet?: string } = JSON.parse(content);
    if (layout.name && layout.eventSheet) {
      map[layout.name] = layout.eventSheet;
    }
  }

  return map;
}

/** One navigation call found in a DSL file */
export interface NavEntry {
  fromSheet: string; // event sheet name (from DSL header)
  targetLayout: string; // layout name from GoToLayout call
  lineNumber: number; // 1-indexed line number in DSL file
}

function findDslFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...findDslFiles(fullPath));
    } else if (stats.isFile() && entry.endsWith(".dsl.txt")) {
      results.push(fullPath);
    }
  }
  return results;
}

// Matches a double-quoted layout name in a GoToLayout call:
// e.g., GoToLayout("SomeLayout" or GoToLayout("SomeLayout", ...)
const GOTO_LAYOUT_QUOTED_RE = /GoToLayout\("([^"]+)"/;

/** Scan all .dsl.txt files under extractedDir for GoToLayout calls */
export function findGoToLayoutCalls(extractedDir: string): NavEntry[] {
  const dslFiles = findDslFiles(extractedDir);
  const entries: NavEntry[] = [];

  for (const dslFile of dslFiles) {
    const content = readFileSync(dslFile, "utf-8");
    const lines = content.split("\n");

    // Parse the sheet name from the first line: "# SheetName"
    let fromSheet = "";
    if (lines.length > 0) {
      const headerMatch = /^#\s+(\S+)/.exec(lines[0]);
      if (headerMatch) {
        fromSheet = headerMatch[1];
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1; // 1-indexed

      if (!line.includes('GoToLayout("')) {
        continue;
      }

      // Skip function definitions
      if (line.includes("function GoToLayout") || line.includes("async function GoToLayout")) {
        continue;
      }

      const match = GOTO_LAYOUT_QUOTED_RE.exec(line);
      if (match && match[1].length > 0) {
        entries.push({
          fromSheet,
          targetLayout: match[1],
          lineNumber,
        });
      }
    }
  }

  return entries;
}

/**
 * Build a PlantUML component diagram from navigation entries.
 *
 * Each source event sheet is resolved to its owning layout via `sheetToLayout`.
 * If no owning layout is found the sheet name is used as the source node.
 * Duplicate source→target edges are collapsed to a single directed arrow.
 * Edges are sorted alphabetically (source then target) for stable output.
 */
export function generatePlantUML(
  navEntries: NavEntry[],
  sheetToLayout: Record<string, string>,
  name = "NavigationGraph",
): string {
  const seen = new Set<string>();
  const edges: Array<[string, string]> = [];

  for (const entry of navEntries) {
    const source = sheetToLayout[entry.fromSheet] ?? entry.fromSheet;
    const target = entry.targetLayout;
    const key = `${source}\x00${target}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([source, target]);
    }
  }

  edges.sort(([a1, b1], [a2, b2]) => {
    const cmp = a1.localeCompare(a2);
    return cmp !== 0 ? cmp : b1.localeCompare(b2);
  });

  const lines: string[] = [`@startuml ${name}`, ""];
  for (const [source, target] of edges) {
    lines.push(`[${source}] --> [${target}]`);
  }
  lines.push("", "@enduml");
  return lines.join("\n");
}
