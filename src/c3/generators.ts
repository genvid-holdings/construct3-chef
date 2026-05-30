import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { cleanOwnedFiles } from "./fsUtils.js";
import {
  type EventSheet,
  type ExtractedScript,
  type ScopeSegment,
  type Layer,
  type Layout,
  find_all_eventsheets_path,
  find_all_layouts_path,
  extractScriptsFromSheet,
  generateFunctionName,
  formatCondition,
} from "c3source";
import { formatEventSheet, formatIndex } from "./dslFormatter.js";
import { formatLayout, buildGlobalLayerMap, formatContainersFile } from "./layoutFormatter.js";
import { walkFiles, type Logger } from "genvid-mcp-utils";
export { type Logger } from "genvid-mcp-utils";

// ─── Script extraction ───

/**
 * Parse import statements from importsForEvents.ts, handling multi-line imports.
 */
function parseImportStatements(content: string): string[] {
  const imports: string[] = [];
  let currentImport: string[] | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (currentImport !== null) {
      currentImport.push(line);
      if (trimmed.endsWith(";")) {
        imports.push(currentImport.join("\n"));
        currentImport = null;
      }
    } else if (trimmed.startsWith("import ")) {
      if (trimmed.endsWith(";")) {
        imports.push(line);
      } else {
        currentImport = [line];
      }
    }
  }

  return imports;
}

/**
 * Generate the file header with imports from importsForEvents.ts and globalVars declaration.
 */
function generateFileHeader(rootDir: string, outPath: string, importStatements: string[]): string {
  const scriptsRelative = path.relative(path.dirname(outPath), path.join(rootDir, "scripts")).replace(/\\/g, "/");

  const lines: string[] = [];

  for (const stmt of importStatements) {
    lines.push(stmt.replace(/from "\.\//g, `from "${scriptsRelative}/`));
  }
  lines.push("");

  lines.push("declare const globalVars: IConstructProjectGlobalVariables;");

  return lines.join("\n");
}

// ─── Scope type helpers ───

/**
 * Convert a string to PascalCase by splitting on non-alphanumeric boundaries.
 */
export function toPascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

/**
 * Extract the name portion from a scope label (strips the prefix keyword).
 */
function extractNameFromLabel(label: string): string {
  const groupMatch = label.match(/^group "(.+)"$/);
  if (groupMatch) return groupMatch[1];
  const fnParamsMatch = label.match(/^fn (.+) params$/);
  if (fnParamsMatch) return fnParamsMatch[1];
  const fnMatch = label.match(/^fn (.+)$/);
  if (fnMatch) return fnMatch[1];
  // ACE patterns: "ObjectClass.AceName params" or "ObjectClass.AceName"
  const aceParamsMatch = label.match(/^(.+\..+) params$/);
  if (aceParamsMatch) return aceParamsMatch[1];
  return label;
}

/**
 * Derive a TypeScript type name from a scope segment label.
 *
 * - "root" → Root_Vars
 * - group "Foo Bar" → FooBar_Vars
 * - fn myFunc params → MyFunc_Params
 * - fn myFunc → MyFunc_Vars
 * - ObjectClass.AceName params → ObjectClassAceName_Params
 */
export function deriveTypeName(label: string): string {
  if (label === "root") return "Root_Vars";

  const isParams = label.endsWith(" params");
  const suffix = isParams ? "_Params" : "_Vars";
  const name = extractNameFromLabel(label);
  return `${toPascalCase(name)}${suffix}`;
}

/**
 * Collect unique scope segments across all scripts in a file, preserving first-encountered order.
 */
export function collectUniqueSegments(scripts: ExtractedScript[]): ScopeSegment[] {
  const seen = new Map<string, ScopeSegment>();
  for (const script of scripts) {
    for (const segment of script.scopeSegments) {
      if (!seen.has(segment.scopeKey)) {
        seen.set(segment.scopeKey, segment);
      }
    }
  }
  return Array.from(seen.values());
}

/**
 * Assign unique TypeScript type names to scope segments.
 * On collision, prepends parent context from scopeKey; falls back to counter suffix.
 */
export function assignTypeNames(segments: ScopeSegment[]): Map<string, string> {
  const nameMap = new Map<string, string>(); // scopeKey → typeName
  const usedNames = new Set<string>();

  for (const seg of segments) {
    let name = deriveTypeName(seg.label);

    if (usedNames.has(name)) {
      // Try prepending parent context from scopeKey
      const parts = seg.scopeKey.split(" > ");
      if (parts.length >= 2) {
        // Strip block event counter suffix (#N) used for sibling disambiguation
        const parentLabel = parts[parts.length - 2].replace(/#\d+$/, "");
        const parentName = toPascalCase(extractNameFromLabel(parentLabel));
        const suffix = name.endsWith("_Params") ? "_Params" : "_Vars";
        const base = name.slice(0, -suffix.length);
        name = `${parentName}_${base}${suffix}`;
      }

      // Still colliding? Append counter
      if (usedNames.has(name)) {
        let counter = 2;
        while (usedNames.has(`${name}${counter}`)) counter++;
        name = `${name}${counter}`;
      }
    }

    usedNames.add(name);
    nameMap.set(seg.scopeKey, name);
  }

  return nameMap;
}

function formatExtractedFile(
  rootDir: string,
  sheetPath: string,
  scripts: ExtractedScript[],
  outPath: string,
  importStatements: string[],
): string {
  const relPath = path.relative(rootDir, sheetPath).replace(/\\/g, "/");
  const lines: string[] = [
    "// " + "=".repeat(60),
    `// Source: ${relPath}`,
    "// " + "=".repeat(60),
    "",
    generateFileHeader(rootDir, outPath, importStatements),
    "",
  ];

  // Collect and emit named scope types
  const uniqueSegments = collectUniqueSegments(scripts);
  const typeNameMap = assignTypeNames(uniqueSegments);

  for (const seg of uniqueSegments) {
    const typeName = typeNameMap.get(seg.scopeKey)!;
    const sortedVars = [...seg.vars].sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`// ${seg.label}`);
    lines.push(`type ${typeName} = {`);
    for (const v of sortedVars) {
      lines.push(`  ${v.name}: ${v.type};`);
    }
    lines.push("};");
    lines.push("");
  }

  for (const script of scripts) {
    lines.push(`// --- ${script.humanPath} ---`);
    lines.push(
      `// C3: ${script.sheetName}, event ${script.eventIndex}, action ${script.actionIndex} (lines 1-${script.lines.length})`,
    );

    if (script.conditions.length > 0) {
      const condStr = script.conditions.map((c) => formatCondition(c)).join(", ");
      lines.push(`// Context: ${condStr}`);
    }

    const funcName = generateFunctionName(script.sheetName, script.eventIndex, script.actionIndex);

    if (script.scopeSegments.length > 0) {
      const typeRef = script.scopeSegments.map((s) => typeNameMap.get(s.scopeKey)!).join(" & ");
      lines.push(`async function ${funcName}(`);
      lines.push("  runtime: IRuntime,");
      lines.push(`  localVars: ${typeRef},`);
      lines.push(") {");
    } else {
      lines.push(`async function ${funcName}(runtime: IRuntime) {`);
    }

    for (const scriptLine of script.lines) {
      lines.push(scriptLine);
    }
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

export function extractScripts(rootDir: string, outDir: string, log: Logger = console.log) {
  const eventSheetsDir = path.join(rootDir, "eventSheets");
  const sheetPaths = find_all_eventsheets_path(eventSheetsDir);
  log(`Found ${sheetPaths.length} eventSheet files.`);

  // Clean only owned files (.ts and tsconfig.json), then prune empty dirs
  cleanOwnedFiles(outDir, ".ts");
  rmSync(path.join(outDir, "tsconfig.json"), { force: true });

  const importStatements = parseImportStatements(
    readFileSync(path.join(rootDir, "scripts", "importsForEvents.ts"), "utf-8"),
  );
  let totalScripts = 0;
  let filesWritten = 0;

  mkdirSync(outDir, { recursive: true });

  // Generate tsconfig.json so the editor resolves all C3 type definitions
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      esModuleInterop: false,
      forceConsistentCasingInFileNames: true,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["./**/*.ts", "../scripts/ts-defs/**/*.d.ts"],
  };
  writeFileSync(path.join(outDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");

  for (const sheetPath of sheetPaths) {
    const content = readFileSync(sheetPath, "utf-8");
    const sheet: EventSheet = JSON.parse(content);
    const scripts = extractScriptsFromSheet(sheet);

    if (scripts.length === 0) continue;

    totalScripts += scripts.length;

    // Mirror directory structure under eventSheets/
    const relPath = path.relative(eventSheetsDir, sheetPath);
    const outPath = path.join(outDir, "eventSheets", relPath.replace(/\.json$/, ".ts"));
    mkdirSync(path.dirname(outPath), { recursive: true });

    const fileContent = formatExtractedFile(rootDir, sheetPath, scripts, outPath, importStatements);
    writeFileSync(outPath, fileContent);
    filesWritten++;
  }

  log(`Extracted ${totalScripts} script blocks into ${filesWritten} files in ${outDir}`);
  log("Note: types in scripts/ts-defs/ may be stale — re-export from C3 editor to refresh.");
}

// ─── DSL generation ───

export function generateDSL(rootDir: string, outDir: string, log: Logger = console.log) {
  const eventSheetsDir = path.join(rootDir, "eventSheets");
  const sheetPaths = find_all_eventsheets_path(eventSheetsDir);
  log(`Found ${sheetPaths.length} eventSheet files.`);

  // Clean owned files (.dsl.txt and .dsl.idx.txt), then prune empty dirs
  cleanOwnedFiles(outDir, ".dsl.txt");
  cleanOwnedFiles(outDir, ".dsl.idx.txt");

  mkdirSync(outDir, { recursive: true });

  let filesWritten = 0;

  for (const sheetPath of sheetPaths) {
    const content = readFileSync(sheetPath, "utf-8");
    const sheet: EventSheet = JSON.parse(content);

    // Mirror directory structure under eventSheets/
    const relPath = path.relative(eventSheetsDir, sheetPath);
    const outPath = path.join(outDir, "eventSheets", relPath.replace(/\.json$/, ".dsl.txt"));
    mkdirSync(path.dirname(outPath), { recursive: true });

    const { dsl: dslContent, index } = formatEventSheet(sheet, sheetPath);
    writeFileSync(outPath, dslContent);

    const idxPath = outPath.replace(/\.dsl\.txt$/, ".dsl.idx.txt");
    writeFileSync(idxPath, formatIndex(sheet.name, index));

    filesWritten++;
  }

  log(`Generated ${filesWritten} DSL + index file pairs in ${outDir}`);
}

// ─── Layout summary generation ───

export function generateLayoutSummaries(rootDir: string, outDir: string, log: Logger = console.log) {
  const layoutsDir = path.join(rootDir, "layouts");
  const projectFilePath = path.join(rootDir, "project.c3proj");
  const layoutPaths = find_all_layouts_path(layoutsDir);
  log(`Found ${layoutPaths.length} layout files.`);

  // Clean only owned files (.layout.txt), then prune empty dirs
  cleanOwnedFiles(outDir, ".layout.txt");

  mkdirSync(outDir, { recursive: true });

  // Pass 1: Parse all layouts and build global layer map
  const parsedLayouts: Array<{ layout: Layout; filePath: string }> = [];
  for (const layoutPath of layoutPaths) {
    const content = readFileSync(layoutPath, "utf-8");
    const layout: Layout = JSON.parse(content);
    parsedLayouts.push({ layout, filePath: layoutPath });
  }

  const globalLayerMap = buildGlobalLayerMap(parsedLayouts);
  log(`Found ${globalLayerMap.size} global layer sources.`);

  // Read containers from project.c3proj
  const projectContent = readFileSync(projectFilePath, "utf-8");
  const project = JSON.parse(projectContent);
  const containerGroups: string[][] = (project.containers ?? []).map(
    (c: { members: string[] }) => c.members,
  );
  const containerMap = new Map<string, string[]>();
  for (const group of containerGroups) {
    for (const member of group) {
      containerMap.set(member, group);
    }
  }
  log(`Found ${containerGroups.length} containers (${containerMap.size} member types).`);

  // Write containers reference file
  const containersContent = formatContainersFile(containerGroups);
  writeFileSync(path.join(outDir, "containers.txt"), containersContent);

  // Pass 2: Generate summaries
  let filesWritten = 0;

  for (const { layout, filePath } of parsedLayouts) {
    // Mirror directory structure under layouts/
    const relPath = path.relative(layoutsDir, filePath);
    const outPath = path.join(outDir, "layouts", relPath.replace(/\.json$/, ".layout.txt"));
    mkdirSync(path.dirname(outPath), { recursive: true });

    const isTemplateHolder = filePath.replace(/\\/g, "/").includes("TemplateHolders/");
    const summaryContent = formatLayout(layout, filePath, globalLayerMap, isTemplateHolder, containerMap);
    writeFileSync(outPath, summaryContent);
    filesWritten++;
  }

  log(`Generated ${filesWritten} layout summary files in ${outDir}`);
}

// ─── Template scope ───

function collectTemplateTypesFromLayers(
  layers: Layer[],
  layoutName: string,
  results: Array<{ layout: string; type: string }>,
): void {
  for (const layer of layers) {
    for (const inst of layer.instances ?? []) {
      const tpl = (inst as Record<string, unknown>).template as { mode?: string } | undefined;
      if (tpl?.mode === "template") {
        results.push({ layout: layoutName, type: inst.type });
      }
    }
    const sub = (layer as Record<string, unknown>).subLayers;
    if (Array.isArray(sub)) {
      collectTemplateTypesFromLayers(sub as Layer[], layoutName, results);
    }
  }
}

export function generateTemplateScope(rootDir: string, outDir: string, log: Logger = console.log) {
  const layoutPaths = find_all_layouts_path(path.join(rootDir, "layouts"));
  const results: Array<{ layout: string; type: string }> = [];

  for (const layoutPath of layoutPaths) {
    const content = readFileSync(layoutPath, "utf-8");
    const layout: Layout = JSON.parse(content);
    collectTemplateTypesFromLayers(layout.layers, layout.name, results);
  }

  results.sort((a, b) => {
    const lc = a.layout.localeCompare(b.layout);
    return lc !== 0 ? lc : a.type.localeCompare(b.type);
  });

  const byLayout = new Map<string, string[]>();
  for (const { layout, type } of results) {
    const arr = byLayout.get(layout) ?? [];
    arr.push(type);
    byLayout.set(layout, arr);
  }

  const lines: string[] = [
    "# C3 Template Scope",
    "# Source: layouts/**/*.json",
    "# Templates are layout-bound — instances can only be created in the defining layout.",
    "# To use a template across layouts, define it in UI_ComponentsLayout.",
    "",
  ];

  for (const [layoutName, types] of byLayout) {
    lines.push(`${layoutName}:`);
    for (const type of types) {
      lines.push(`  ${type}`);
    }
    lines.push("");
  }

  const outPath = path.join(outDir, "template-scope.txt");
  writeFileSync(outPath, lines.join("\n"));
  log(`Generated template-scope.txt (${results.length} templates across ${byLayout.size} layouts)`);
}

// ─── SID registry generation ───

type SidEntry = { sid: number; sourceFile: string; location: string };

/**
 * Recursively walk a JSON value and emit (sid, location) pairs.
 * `location` is the human-readable path within the file.
 */
function collectSids(value: unknown, location: string, entries: Array<{ sid: number; location: string }>): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectSids(value[i], `${location}[${i}]`, entries);
    }
    return;
  }

  const obj = value as Record<string, unknown>;

  // If this object has a sid, record it at the current location
  if (typeof obj["sid"] === "number") {
    entries.push({ sid: obj["sid"] as number, location });
  }

  // Recurse into all properties (except sid itself, which is a leaf value)
  for (const [key, child] of Object.entries(obj)) {
    if (key === "sid") continue;
    collectSids(child, location === "" ? key : `${location}.${key}`, entries);
  }
}

/**
 * Determine the root location label for a file type.
 */
/**
 * The C3 source directories that contribute SIDs to the registry. Single source
 * of truth for both `generateSidRegistry` and `checkRegistryFreshness` — adding
 * a new SID-bearing dir (e.g. `families/`) here is a one-place change.
 */
export const SID_SOURCE_DIRS = ["eventSheets", "layouts", "objectTypes"] as const;

function rootLocationForFile(relativePath: string): string {
  if (relativePath.startsWith("eventSheets/")) return "sheet";
  if (relativePath.startsWith("objectTypes/")) return "objectType";
  if (relativePath.startsWith("layouts/")) return "layout";
  return "root";
}

/**
 * Recursively find all JSON files in a directory. Returns [] if the directory
 * does not exist. Exported so other tooling (e.g. staleness checks) can reuse it.
 */
export function findJsonFiles(dir: string): string[] {
  return walkFiles(dir, ".json");
}

export function generateSidRegistry(projectRoot: string, log: Logger = console.log): void {
  const outDir = path.join(projectRoot, "extracted");

  // Walk all SID-bearing source dirs (single source of truth: SID_SOURCE_DIRS).
  // findJsonFiles returns [] for missing dirs so partial projects work.
  const allFiles = SID_SOURCE_DIRS.flatMap((dir) => findJsonFiles(path.join(projectRoot, dir)));

  const allEntries: SidEntry[] = [];

  for (const filePath of allFiles) {
    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
    const rootLabel = rootLocationForFile(relativePath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      log(`  Skipping unparseable file: ${relativePath}`);
      continue;
    }

    const rawEntries: Array<{ sid: number; location: string }> = [];

    // Check if the top-level object itself has a sid (use rootLabel as location)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["sid"] === "number") {
        rawEntries.push({ sid: obj["sid"] as number, location: rootLabel });
      }
      // Recurse into properties (skip top-level sid — already handled)
      for (const [key, child] of Object.entries(obj)) {
        if (key === "sid") continue;
        collectSids(child, key, rawEntries);
      }
    } else {
      collectSids(parsed, rootLabel, rawEntries);
    }

    for (const { sid, location } of rawEntries) {
      allEntries.push({ sid, sourceFile: relativePath, location });
    }
  }

  // Sort by SID ascending
  allEntries.sort((a, b) => a.sid - b.sid);

  const lines: string[] = [
    "# SID Registry",
    "# Generated by generateSidRegistry — do not edit manually",
    "# Format: sid<TAB>source-file<TAB>location",
    "",
    ...allEntries.map((e) => `${e.sid}\t${e.sourceFile}\t${e.location}`),
  ];

  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "sid-registry.txt");
  writeFileSync(outPath, lines.join("\n") + "\n");

  log(`Generated sid-registry.txt (${allEntries.length} SID entries from ${allFiles.length} files)`);
}

