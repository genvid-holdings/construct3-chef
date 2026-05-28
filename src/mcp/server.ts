import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReadWriteLock, ExpectedChanges, paginateText, exposeDocs } from "genvid-mcp-utils";
import type { Logger } from "genvid-mcp-utils";
import { applyParsed } from "../c3/recipeApplier.js";
import { validateRecipe, type Recipe } from "../c3/recipeInterpreter.js";
import {
  extractScripts,
  generateDSL,
  generateLayoutSummaries,
  generateTemplateScope,
  generateSidRegistry,
  findJsonFiles,
  SID_SOURCE_DIRS,
} from "../c3/generators.js";
import { runSync } from "../c3/projectSync.js";
import { readRegistryFile, mintUniqueSid } from "../c3/sidUtils.js";
import { filterIndex, buildShallowSidMap } from "../c3/dslFormatter.js";
import type { EventSheet } from "c3source";
import { resolveIncludeTree, formatIncludeTree, flattenIncludeTree } from "../c3/includeTree.js";
import { collectAllUids, cloneLayout } from "../c3/layoutScaffold.js";
import { search } from "../c3/search.js";
import { resolveAnchor } from "../c3/anchorResolver.js";
import {
  collectAllObjectTypeSids,
  collectMaxImageSpriteId,
  discoverAndPlanImageCopies,
  cloneSprite,
} from "../c3/spriteScaffold.js";

let PROJECT_ROOT = process.cwd();
let EXTRACTED_DIR = path.join(PROJECT_ROOT, "extracted");

const server = new McpServer(
  { name: "construct3-chef", version: "1.0.0" },
  { capabilities: { logging: {}, resources: {} } },
);
const __pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
exposeDocs(server, __pkgDir);
const rwlock = new ReadWriteLock();

// ── Server State ─────────────────────────────────────────────────────────────

let txId = 0;
let extractedDirty = false;
// >0 while a write tool is running — prevents double txId increment.
// Safe without atomics because rwlock.write() serializes all write tools.
let suppressWatcherDepth = 0;
const expectedChanges = new ExpectedChanges();

// ── Tool Annotations ─────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const REGENERATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const MUTATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;
// Reads source files only (no project mutation) but returns different output per call —
// e.g. random-SID minting. Clients must NOT treat as idempotent for retry/cache purposes.
const NON_IDEMPOTENT_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: false } as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Normalize Windows backslash paths to forward slashes. */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

function emitLog(level: "debug" | "info" | "warning" | "error", message: string): void {
  server.sendLoggingMessage({ level, logger: "construct3-chef", data: message }).catch(() => {});
}

async function sendProgress(extra: Extra, progress: number, total: number, message?: string): Promise<void> {
  const token = extra._meta?.progressToken;
  if (!token) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken: token, progress, total, ...(message ? { message } : {}) },
  });
}

const GENERATOR_STEPS = [
  { name: "Extracting scripts", fn: (log: Logger) => extractScripts(PROJECT_ROOT, EXTRACTED_DIR, log) },
  { name: "Generating DSL", fn: (log: Logger) => generateDSL(PROJECT_ROOT, EXTRACTED_DIR, log) },
  { name: "Generating layout summaries", fn: (log: Logger) => generateLayoutSummaries(PROJECT_ROOT, EXTRACTED_DIR, log) },
  { name: "Generating template scope", fn: (log: Logger) => generateTemplateScope(PROJECT_ROOT, EXTRACTED_DIR, log) },
  { name: "Generating SID registry", fn: (log: Logger) => generateSidRegistry(PROJECT_ROOT, log) },
] as const;

class CancelledError extends Error {
  constructor() { super("Cancelled"); this.name = "CancelledError"; }
}

function checkCancelled(extra?: Extra): void {
  if (extra?.signal?.aborted) throw new CancelledError();
}

async function runGenerators(log: Logger, extra?: Extra, progressOffset = 0, progressTotal = 5): Promise<void> {
  for (let i = 0; i < GENERATOR_STEPS.length; i++) {
    checkCancelled(extra);
    if (extra) await sendProgress(extra, progressOffset + i, progressTotal, GENERATOR_STEPS[i].name);
    GENERATOR_STEPS[i].fn(log);
  }
  if (extra) await sendProgress(extra, progressOffset + GENERATOR_STEPS.length, progressTotal, "Done");
}

function readExtracted(relPath: string): string | null {
  const fullPath = path.resolve(path.join(EXTRACTED_DIR, relPath));
  if (!fullPath.startsWith(EXTRACTED_DIR + path.sep) && fullPath !== EXTRACTED_DIR) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, "utf-8");
}

function notFound(tool: string, hint: string): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text", text: `${tool}: ${hint}` }],
    isError: true,
  };
}

const STALE_WARNING = "\n\n[Warning: extracted files may be stale — run regenerate to refresh]";

function appendStaleWarning(text: string): string {
  return extractedDirty ? text + STALE_WARNING : text;
}

/**
 * Compare source file mtime against extracted file mtime.
 * If source is newer and extractedDirty is not already set, mark state as dirty.
 * No-ops silently if either file is missing (tolerant of partial states).
 */
function checkSourceFreshness(sourcePath: string, extractedPath: string): void {
  try {
    const sourceMtime = fs.statSync(sourcePath).mtimeMs;
    const extractedMtime = fs.statSync(extractedPath).mtimeMs;
    if (sourceMtime > extractedMtime && !extractedDirty) {
      extractedDirty = true;
      txId++;
      emitLog("warning", `Stale detected: source newer than extracted (${path.basename(sourcePath)})`);
    }
  } catch {
    // Either file missing — skip check silently
  }
}

/**
 * Multi-source variant of checkSourceFreshness for `sid-registry.txt`, which is
 * derived from many source files (eventSheets/, layouts/, objectTypes/).
 * Walks each source dir, finds the newest JSON mtime, compares against the
 * registry mtime, and marks `extractedDirty` if any source is newer.
 *
 * This catches external edits (git checkout, atomic-rename saves, network mounts)
 * that the fs.watch watcher may have missed before the watcher event delivers.
 */
function checkRegistryFreshness(registryPath: string): void {
  if (extractedDirty) return; // Already known stale; skip the scan.
  let registryMtime: number;
  try {
    registryMtime = fs.statSync(registryPath).mtimeMs;
  } catch {
    return; // No registry → can't compare; callers handle the missing-file case separately.
  }
  let newestSourceMtime = 0;
  for (const dir of SID_SOURCE_DIRS) {
    let files: string[];
    try {
      files = findJsonFiles(path.join(PROJECT_ROOT, dir));
    } catch {
      continue; // Directory vanished mid-walk — try the next dir.
    }
    for (const file of files) {
      try {
        const m = fs.statSync(file).mtimeMs;
        if (m > newestSourceMtime) newestSourceMtime = m;
      } catch {
        // Per-file TOCTOU (atomic-rename save, antivirus quarantine, network mount glitch) —
        // skip this file and keep scanning. Aborting the whole loop would mask later staleness.
        continue;
      }
    }
  }
  if (newestSourceMtime > registryMtime) {
    extractedDirty = true;
    txId++;
    emitLog("warning", "Stale detected: source newer than sid-registry.txt");
  }
}

const PAGINATION_PARAMS = {
  offset: z.number().int().min(1).optional().describe("Start line (1-based). Omit to start from beginning."),
  limit: z.number().int().min(1).optional().describe("Max lines to return. Omit to return all."),
};

function paginatedResponse(
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): { content: { type: "text"; text: string }[] } {
  const paginated = paginateText(text, { offset, limit });
  const content: { type: "text"; text: string }[] = [
    { type: "text", text: appendStaleWarning(paginated.text) },
  ];
  if (offset !== undefined || limit !== undefined) {
    const returnedLines = paginated.text === "" ? 0 : paginated.text.split("\n").length;
    const endLine = paginated.offset + Math.max(0, returnedLines - 1);
    content.push({ type: "text", text: `lines: ${paginated.offset}-${endLine} / ${paginated.totalLines}` });
  }
  return { content };
}

function globRelative(dir: string, ext: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // directory missing or inaccessible
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(ext)) {
        results.push(toForwardSlash(path.relative(dir, full)));
      }
    }
  }
  walk(dir);
  return results.sort();
}

// ── File Watchers ────────────────────────────────────────────────────────────

function setupWatchers(): void {
  const sourceDirs = ["eventSheets", "layouts", "objectTypes", "families", "scripts"];

  for (const dir of sourceDirs) {
    const fullDir = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    fs.watch(fullDir, { recursive: true }, (_event, filename) => {
      if (!filename || suppressWatcherDepth > 0) return;
      const normalized = toForwardSlash(path.join(dir, filename));
      if (expectedChanges.consume(normalized)) return;
      txId++;
      extractedDirty = true;
      emitLog("warning", `External change detected: ${normalized} (txId → ${txId})`);
    });
  }

  // project.c3proj — increments txId but does NOT set extractedDirty
  const c3projPath = path.join(PROJECT_ROOT, "project.c3proj");
  if (fs.existsSync(c3projPath)) {
    fs.watch(c3projPath, () => {
      if (suppressWatcherDepth === 0) txId++;
    });
  }

  // Periodically purge expired entries from expectedChanges
  setInterval(() => expectedChanges.purgeExpired(), 30_000).unref();
}

// ── Listing Tools ─────────────────────────────────────────────────────────────

server.registerTool(
  "list-event-sheets",
  {
    title: "List Event Sheets",
    description: "List all C3 event sheet JSON files in the project. Returns relative paths from the eventSheets/ root.",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(async () => {
      const sheets = globRelative(
        path.join(PROJECT_ROOT, "eventSheets"),
        ".json"
      );
      return { content: [{ type: "text", text: sheets.join("\n") }] };
    })
);

server.registerTool(
  "list-layouts",
  {
    title: "List Layouts",
    description: "List all C3 layout JSON files in the project. Returns relative paths from the layouts/ root.",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(async () => {
      const layouts = globRelative(
        path.join(PROJECT_ROOT, "layouts"),
        ".json"
      );
      return { content: [{ type: "text", text: layouts.join("\n") }] };
    })
);

// ── Read Tools ────────────────────────────────────────────────────────────────

server.registerTool(
  "read-dsl",
  {
    title: "Read Event Sheet DSL",
    description:
      "Read the human-readable DSL for a C3 event sheet. Shows all conditions, actions, function calls, and variables. Input is a relative path without extension, e.g. 'Goals/GoalsEvents' or 'LoginEvents'.",
    annotations: READ_ONLY,
    inputSchema: {
      sheet: z.string().describe("Relative path to the event sheet, without extension (e.g. 'Goals/GoalsEvents')"),
      ...PAGINATION_PARAMS,
    },
  },
  async ({ sheet, offset, limit }) =>
    rwlock.read(async () => {
      checkSourceFreshness(
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.txt`),
      );
      const text = readExtracted(`eventSheets/${sheet}.dsl.txt`);
      if (text === null) {
        return notFound("read-dsl", `No DSL file found for '${sheet}'. Use list-event-sheets to see available sheets.`);
      }
      return paginatedResponse(text, offset, limit);
    })
);

server.registerTool(
  "read-dsl-index",
  {
    title: "Read Event Sheet DSL Index",
    description:
      "Read the DSL coordinate index for a C3 event sheet. Maps every event tree node to its JSON path and SID. Use SIDs ('in': 'sid:X') for recipe targeting. Input is a relative path without extension. Optional grep filter to show only matching rows.",
    annotations: READ_ONLY,
    inputSchema: {
      sheet: z.string().describe("Relative path to the event sheet, without extension (e.g. 'Goals/GoalsEvents')"),
      grep: z
        .string()
        .optional()
        .describe("Regex pattern to filter index rows (case-insensitive). Headers are always shown."),
      ...PAGINATION_PARAMS,
    },
  },
  async ({ sheet, grep, offset, limit }) =>
    rwlock.read(async () => {
      checkSourceFreshness(
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.idx.txt`),
      );
      let text = readExtracted(`eventSheets/${sheet}.dsl.idx.txt`);
      if (text === null) {
        return notFound("read-dsl-index", `No DSL index file found for '${sheet}'. Use list-event-sheets to see available sheets.`);
      }
      if (grep) {
        text = filterIndex(text, grep);
      }
      return paginatedResponse(text, offset, limit);
    })
);

server.registerTool(
  "read-event-sids",
  {
    title: "Read Event SIDs from Source",
    description:
      "Read SIDs directly from source eventSheet JSON (not extracted/). " +
      "Returns a JSON-path-to-SID map for all events in the sheet. " +
      "Useful after apply-recipe to get SIDs of newly inserted events without regenerating.",
    annotations: READ_ONLY,
    inputSchema: {
      sheet: z.string().describe("Relative path to the event sheet, without extension (e.g. 'Goals/GoalsEvents')"),
      grep: z
        .string()
        .optional()
        .describe("Regex pattern to filter entries by description (case-insensitive)."),
    },
  },
  async ({ sheet, grep }) =>
    rwlock.read(async () => {
      const sourcePath = path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`);
      if (!fs.existsSync(sourcePath)) {
        return notFound("read-event-sids", `No event sheet found for '${sheet}'. Use list-event-sheets to see available sheets.`);
      }
      const raw = fs.readFileSync(sourcePath, "utf-8");
      const parsed = JSON.parse(raw) as EventSheet;
      let entries = buildShallowSidMap(parsed);
      if (grep) {
        const re = new RegExp(grep, "i");
        entries = entries.filter((e) => re.test(e.description));
      }
      if (entries.length === 0) {
        const hint = grep ? ` matching '${grep}'` : "";
        return { content: [{ type: "text", text: `No events found${hint} in '${sheet}'.` }] };
      }
      // Format as pipe-delimited table matching .dsl.idx.txt style
      const sheetName = sheet.includes("/") ? sheet.split("/").pop()! : sheet;
      const header = `# ${sheetName} — Event SID Map (from source)\n# JSON Path | SID | Description`;
      const maxPathLen = Math.max(12, ...entries.map((e) => e.jsonPath.length));
      const rows = entries.map((e) => {
        const sidStr = e.sid !== undefined ? `§${e.sid}` : "(no SID)";
        return `${e.jsonPath.padEnd(maxPathLen + 2)}${sidStr.padEnd(20)}${e.description}`;
      });
      return { content: [{ type: "text", text: `${header}\n${rows.join("\n")}` }] };
    })
);

server.registerTool(
  "read-scripts",
  {
    title: "Read Extracted TypeScript",
    description:
      "Read the extracted TypeScript file for a C3 event sheet. Provides IDE-quality TypeScript with imports and named scope types. Input is a relative path without extension.",
    annotations: READ_ONLY,
    inputSchema: {
      sheet: z.string().describe("Relative path to the event sheet, without extension (e.g. 'Goals/GoalsEvents')"),
      ...PAGINATION_PARAMS,
    },
  },
  async ({ sheet, offset, limit }) =>
    rwlock.read(async () => {
      checkSourceFreshness(
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.ts`),
      );
      const text = readExtracted(`eventSheets/${sheet}.ts`);
      if (text === null) {
        return notFound("read-scripts", `No extracted TypeScript found for '${sheet}'. Use list-event-sheets to see available sheets.`);
      }
      return paginatedResponse(text, offset, limit);
    })
);

server.registerTool(
  "read-layout",
  {
    title: "Read Layout Summary",
    description:
      "Read the layout summary for a C3 layout. Shows layers, instances (grouped by type), instance variable keys, tags, template bindings, and scene-graph hierarchy. Input is a relative path without extension, e.g. 'Login/LoginLayout'.",
    annotations: READ_ONLY,
    inputSchema: {
      layout: z.string().describe("Relative path to the layout, without extension (e.g. 'Login/LoginLayout')"),
      ...PAGINATION_PARAMS,
    },
  },
  async ({ layout, offset, limit }) =>
    rwlock.read(async () => {
      checkSourceFreshness(
        path.join(PROJECT_ROOT, "layouts", `${layout}.json`),
        path.join(EXTRACTED_DIR, "layouts", `${layout}.layout.txt`),
      );
      const text = readExtracted(`layouts/${layout}.layout.txt`);
      if (text === null) {
        return notFound("read-layout", `No layout summary found for '${layout}'. Use list-layouts to see available layouts.`);
      }
      return paginatedResponse(text, offset, limit);
    })
);

// ── Reference Tools ───────────────────────────────────────────────────────────

server.registerTool(
  "read-template-scope",
  {
    title: "Read Template Scope",
    description:
      "Read the cross-layout template scope reference. Shows which templates (mode=template instances) are defined in each layout — use to check whether a template can be instantiated from a given layout.",
    annotations: READ_ONLY,
    inputSchema: { ...PAGINATION_PARAMS },
  },
  async ({ offset, limit }) =>
    rwlock.read(async () => {
      const text = readExtracted("template-scope.txt");
      if (text === null) {
        return notFound("read-template-scope", "template-scope.txt not found. Run 'npm run generate-c3' to generate it.");
      }
      return paginatedResponse(text, offset, limit);
    })
);

server.registerTool(
  "read-sid-registry",
  {
    title: "Read SID Registry",
    description:
      "Read the SID registry — a sorted list of all SIDs used across eventSheets, layouts, and objectTypes. Use to check SID uniqueness or find which file owns a specific SID.",
    annotations: READ_ONLY,
    inputSchema: { ...PAGINATION_PARAMS },
  },
  async ({ offset, limit }) =>
    rwlock.read(async () => {
      const text = readExtracted("sid-registry.txt");
      if (text === null) {
        return notFound("read-sid-registry", "sid-registry.txt not found. Run 'npm run generate-c3' to generate it.");
      }
      return paginatedResponse(text, offset, limit);
    })
);

server.registerTool(
  "generate-sids",
  {
    title: "Generate Unique SIDs",
    description:
      "Mint fresh unique C3 SIDs in the [1e14, 1e15) range, seeded from sid-registry.txt (which covers eventSheets/, layouts/, and objectTypes/). " +
      "Returns `count` SIDs that don't collide with each other within this call or with any SID in the registry. " +
      "Minted SIDs are NOT persisted to the registry — to avoid re-drawing them across calls, write them into source files and run 'regenerate', or pass them as `extraUsedSids` on the next call.",
    annotations: NON_IDEMPOTENT_READ,
    inputSchema: {
      count: z.number().int().min(1).max(100).optional()
        .describe("Number of SIDs to mint (default: 1, max: 100)."),
      extraUsedSids: z
        .array(z.number().int().gte(1e14).lt(1e15))
        .max(100000)
        .optional()
        .describe(
          "Additional SIDs to treat as already-used (e.g. SIDs from a prior generate-sids call " +
            "not yet written to source). Each value must be a valid C3 SID in [1e14, 1e15); max 100,000 entries.",
        ),
    },
  },
  // Takes the WRITE lock — not because source files change (they don't), but because
  // (a) `checkRegistryFreshness` mutates module-level `extractedDirty` and `txId`, and
  // (b) two concurrent generate-sids calls each building their own local `used` Set
  // could mint identical SIDs (negligible probability ~1/9e14 per pair, but the
  // architectural contract "SIDs don't collide with each other" should hold across
  // concurrent callers). Serializing with `rwlock.write()` makes both rigorous.
  // The NON_IDEMPOTENT_READ annotation describes the tool's effect on PROJECT state
  // (none — source files unchanged); the write lock is internal-state safety.
  async ({ count = 1, extraUsedSids }) =>
    rwlock.write(async () => {
      try {
        const registryPath = path.join(EXTRACTED_DIR, "sid-registry.txt");
        if (!fs.existsSync(registryPath)) {
          return notFound("generate-sids", "sid-registry.txt not found. Run 'regenerate' first.");
        }
        checkRegistryFreshness(registryPath);
        const used = readRegistryFile(registryPath);
        if (extraUsedSids) for (const s of extraUsedSids) used.add(s);
        const sids = Array.from({ length: count }, () => mintUniqueSid(used));
        const header = `# Generated ${count} SID${count === 1 ? "" : "s"}:`;
        const text = appendStaleWarning(`${header}\n${sids.join("\n")}`);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `generate-sids: ${msg}` }], isError: true };
      }
    })
);

server.registerTool(
  "list-include-tree",
  {
    title: "List Include Tree",
    description:
      "Show the transitive include tree for an eventSheet — which sheets it includes, and what those sheets include (recursively). Useful for determining which C3 functions are callable from a given layout's eventSheet. Optionally lists functions defined at each level.",
    annotations: READ_ONLY,
    inputSchema: {
      path: z.string().describe("EventSheet name (e.g. 'GoalsEvents') or path (e.g. 'eventSheets/Goals/GoalsEvents.json')"),
      functions: z.boolean().optional().describe("Include function names defined at each level (default: false)"),
      flat: z.boolean().optional().describe("Return a flat deduplicated list of all included sheet names instead of a tree (default: false)"),
    },
  },
  async ({ path: sheetPath, functions: includeFunctions, flat }) =>
    rwlock.read(async () => {
      const tree = resolveIncludeTree(sheetPath, PROJECT_ROOT, { includeFunctions: includeFunctions ?? false });

      if (flat) {
        const names = flattenIncludeTree(tree);
        return { content: [{ type: "text", text: names.join("\n") }] };
      }

      const text = formatIncludeTree(tree);
      return { content: [{ type: "text", text }] };
    }),
);

// ── Search Tool ───────────────────────────────────────────────────────────────

server.registerTool(
  "search",
  {
    title: "Search Files",
    description:
      "Search extracted or project files for a regex pattern. Returns matching lines with file path and line number. Supports multiple file types (dsl, ts, layout, md, json, idx), single-file or directory targeting, and context lines around matches.",
    annotations: READ_ONLY,
    inputSchema: {
      pattern: z.string().describe("Regex pattern to search for"),
      type: z.enum(["dsl", "ts", "layout", "md", "json", "idx"]).optional()
        .describe("File category to search (default: dsl)"),
      path: z.string().optional()
        .describe("Single file or directory prefix. For json type, must include 'eventSheets/' or 'layouts/' prefix"),
      context: z.number().int().min(0).optional()
        .describe("Context lines around matches (like grep -C)"),
    },
  },
  async ({ pattern, type, path: searchPath, context }) =>
    rwlock.read(async () => {
      if (!pattern) {
        return notFound("search", "Pattern cannot be empty. Provide a regex pattern to search for.");
      }

      try {
        const result = search(
          { projectRoot: PROJECT_ROOT, extractedDir: EXTRACTED_DIR },
          { pattern, type, path: searchPath, context },
        );

        if (result.lines.length === 0) {
          return { content: [{ type: "text", text: `No matches found for pattern: ${pattern}` }] };
        }

        let text = result.lines.join("\n");
        if (result.truncated) {
          text += `\n\n[Truncated: showing first 1000 matches. Narrow your pattern or path to see more.]`;
        }
        if (result.isExtracted) {
          text = appendStaleWarning(text);
        }

        emitLog("info", `search: type=${type ?? "dsl"}, path=${searchPath ?? "(all)"}, matches=${result.lines.length}${result.truncated ? " (truncated)" : ""}`);

        return { content: [{ type: "text", text }] };
      } catch (e) {
        return notFound("search", e instanceof Error ? e.message : String(e));
      }
    })
);

// ── Anchor Resolution Tool ────────────────────────────────────────────────────

server.registerTool(
  "resolve-anchor",
  {
    title: "Resolve DSL Anchor",
    description:
      "Look up a DSL coordinate by line number, SID, or name pattern. Returns the JSON path, SID, and description for recipe targeting. Use after a search hit to get the SID needed for 'in': 'sid:X' recipe operations.",
    annotations: READ_ONLY,
    inputSchema: {
      sheet: z.string().describe("Relative path to the event sheet, without extension"),
      by: z.enum(["line", "sid", "name"]).describe("Lookup key type"),
      value: z.string().describe("Line number, SID (digits only), or name/regex pattern"),
    },
  },
  async ({ sheet, by, value }) =>
    rwlock.read(async () => {
      checkSourceFreshness(
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.idx.txt`),
      );
      const text = readExtracted(`eventSheets/${sheet}.dsl.idx.txt`);
      if (text === null) {
        return notFound("resolve-anchor", `No DSL index file found for '${sheet}'. Use list-event-sheets to see available sheets.`);
      }

      let lookup: Parameters<typeof resolveAnchor>[1];
      if (by === "line") {
        const line = parseInt(value, 10);
        if (isNaN(line)) return notFound("resolve-anchor", `Invalid line number: '${value}'`);
        lookup = { by: "line", line };
      } else if (by === "sid") {
        const sid = parseInt(value, 10);
        if (isNaN(sid)) return notFound("resolve-anchor", `Invalid SID: '${value}'`);
        lookup = { by: "sid", sid };
      } else {
        lookup = { by: "name", name: value };
      }

      const result = resolveAnchor(text, lookup);
      if (result === null) {
        emitLog("warning", `resolve-anchor: no match for ${by}=${value} in ${sheet}`);
        return { content: [{ type: "text", text: `No anchor found for ${by}: ${value}` }] };
      }

      const a = result.anchor;
      const lines = [
        `DSL Line: ${a.dslLine}`,
        `JSON Path: ${a.jsonPath}`,
        a.sid !== undefined ? `SID: §${a.sid}` : `SID: (none)`,
        `Description: ${a.description}`,
        `Match: ${result.exact ? "exact" : "nearest enclosing"}`,
      ];

      if (result.alternatives && result.alternatives.length > 0) {
        lines.push("", "---", "Also matched:");
        for (const alt of result.alternatives) {
          lines.push(`  Line ${alt.dslLine}: ${alt.description} (SID: ${alt.sid !== undefined ? "§" + alt.sid : "none"}, Path: ${alt.jsonPath})`);
        }
      }

      return { content: [{ type: "text", text: appendStaleWarning(lines.join("\n")) }] };
    })
);

// ── Recipe Tools ─────────────────────────────────────────────────────────────

server.registerTool(
  "validate-recipe",
  {
    title: "Validate Recipe (Dry Run)",
    description:
      "Validate a C3 eventSheet mutation recipe without applying it. Parses the JSON, checks for structural errors, then runs a full dry-run. Returns validation output and current txId for optimistic concurrency with apply-recipe.",
    annotations: READ_ONLY,
    inputSchema: {
      recipe: z.string().describe("Recipe JSON string"),
    },
  },
  async ({ recipe: recipeJson }) =>
    rwlock.read(async () => {
      // Refresh extractedDirty so the returned txId reflects any external edits
      // the file watcher may have missed (atomic-rename, git checkout, network mounts).
      // This matters: apply-recipe's optimistic-concurrency check uses our returned txId.
      checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
      const lines: string[] = [];
      const log: Logger = (...args) => lines.push(args.map(String).join(" "));
      try {
        const recipe: Recipe = JSON.parse(recipeJson);
        const errors = validateRecipe(recipe);
        if (errors.length > 0) {
          return {
            content: [
              { type: "text", text: `Validation errors:\n${errors.join("\n")}` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }
        applyParsed(PROJECT_ROOT, recipe, { dryRun: true, log });
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: `txId: ${txId}` },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            { type: "text", text: `txId: ${txId}` },
          ],
          isError: true,
        };
      }
    })
);

server.registerTool(
  "apply-recipe",
  {
    title: "Apply Recipe",
    description:
      "Apply a C3 eventSheet mutation recipe. Modifies source files (eventSheets/, objectTypes/, layouts/, scripts/) and optionally regenerates extracted/ files. Pass txId from validate-recipe for optimistic concurrency.",
    annotations: MUTATE,
    inputSchema: {
      recipe: z.string().describe("Recipe JSON string"),
      txId: z
        .number()
        .optional()
        .describe("Expected txId from validate-recipe — if stale, apply is rejected"),
      regenerate: z
        .boolean()
        .optional()
        .describe("Regenerate extracted/ files after applying (default: true)"),
    },
  },
  async ({ recipe: recipeJson, txId: expectedTxId, regenerate }, extra: Extra) =>
    rwlock.write(async () => {
      // Refresh extractedDirty before the txId check — catches external edits the
      // file watcher may have missed, so a stale registry doesn't seed `mintUniqueSid`
      // with SIDs that already exist on disk.
      checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
      const shouldRegenerate = regenerate !== false;
      const totalSteps = shouldRegenerate ? 6 : 1; // apply + 5 generators
      const lines: string[] = [];
      const log: Logger = (...args) => lines.push(args.map(String).join(" "));
      try {
        if (expectedTxId !== undefined && expectedTxId !== txId) {
          return {
            content: [
              { type: "text", text: `State changed (expected ${expectedTxId}, got ${txId}) — re-validate before applying` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }
        const recipe: Recipe = JSON.parse(recipeJson);
        // Suppress watcher during writes — we manage txId/extractedDirty ourselves
        suppressWatcherDepth++;
        try {
          await sendProgress(extra, 0, totalSteps, "Applying recipe");
          applyParsed(PROJECT_ROOT, recipe, { regenerate: false, log });
          if (shouldRegenerate) {
            await runGenerators(log, extra, 1, totalSteps);
          }
        } finally {
          suppressWatcherDepth--;
        }
        txId++;
        if (shouldRegenerate) {
          extractedDirty = false;
        }
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: `txId: ${txId}` },
          ],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Recipe already applied (source files modified) but regeneration interrupted
          txId++;
          extractedDirty = true;
        }
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            { type: "text", text: `txId: ${txId}` },
          ],
          isError: true,
        };
      }
    })
);

// ── Regenerate Tool ─────────────────────────────────────────────────────────

server.registerTool(
  "regenerate",
  {
    title: "Regenerate Extracted Files",
    description:
      "Run all 5 C3 generators (extract scripts, DSL, layout summaries, template scope, SID registry) and update extracted/. Clears the extractedDirty flag. Use after external edits to source files, or when extractedDirty is true.",
    annotations: REGENERATE,
    inputSchema: {},
  },
  async (_args: Record<string, never>, extra: Extra) =>
    rwlock.write(async () => {
      const lines: string[] = [];
      const log: Logger = (...args) => lines.push(args.map(String).join(" "));
      try {
        // Suppress watcher — regenerate writes only to extracted/ (derived output)
        suppressWatcherDepth++;
        try {
          await runGenerators(log, extra);
        } finally {
          suppressWatcherDepth--;
        }
        extractedDirty = false;
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Partially regenerated — stale. No txId++ (regenerate doesn't modify source files)
          extractedDirty = true;
        }
        return {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    })
);

// ── Project Tools ────────────────────────────────────────────────────────────

server.registerTool(
  "validate-project",
  {
    title: "Validate project.c3proj",
    description:
      "Dry-run sync of project.c3proj against disk. Reports any drift (missing or extra file entries) without modifying the file. Returns output and current txId.",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(async () => {
      const lines: string[] = [];
      const log: Logger = (...args) => lines.push(args.map(String).join(" "));
      try {
        runSync(PROJECT_ROOT, true, log);
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: `txId: ${txId}` },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            { type: "text", text: `txId: ${txId}` },
          ],
          isError: true,
        };
      }
    })
);

server.registerTool(
  "sync-project",
  {
    title: "Sync project.c3proj",
    description:
      "Sync project.c3proj to match files on disk. Adds missing entries and removes stale ones. Pass txId for optimistic concurrency. Returns output and new txId.",
    annotations: MUTATE,
    inputSchema: {
      txId: z
        .number()
        .optional()
        .describe("Expected txId — if stale, sync is rejected"),
    },
  },
  async ({ txId: expectedTxId }) =>
    rwlock.write(async () => {
      const lines: string[] = [];
      const log: Logger = (...args) => lines.push(args.map(String).join(" "));
      try {
        if (expectedTxId !== undefined && expectedTxId !== txId) {
          return {
            content: [
              { type: "text", text: `State changed (expected ${expectedTxId}, got ${txId}) — re-validate before syncing` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }
        // Suppress watcher — we manage txId ourselves
        suppressWatcherDepth++;
        try {
          runSync(PROJECT_ROOT, false, log);
        } finally {
          suppressWatcherDepth--;
        }
        txId++;
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: `txId: ${txId}` },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            { type: "text", text: `txId: ${txId}` },
          ],
          isError: true,
        };
      }
    })
);

// ── Addon Tool ──────────────────────────────────────────────────────────────

const ADDON_DIRS = ["addons/plugin", "addons/effect"] as const;

server.registerTool(
  "read-addon",
  {
    title: "Read Addon",
    description:
      "Read a C3 addon's extracted files (default: aces.json). Without a name, lists all available addons from addons/plugin/ and addons/effect/ with their extraction status.",
    annotations: READ_ONLY,
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("Addon name (e.g. 'CV_Clock'). Omit to list all available addons."),
      file: z
        .string()
        .optional()
        .describe("File to read within the extracted addon folder (default: 'aces.json')"),
    },
  },
  async ({ name, file }) =>
    rwlock.read(async () => {
      if (!name) {
        // List all addons
        const entries: string[] = [];
        for (const addonDir of ADDON_DIRS) {
          const dirType = addonDir === "addons/plugin" ? "plugin" : "effect";
          const fullDir = path.join(PROJECT_ROOT, addonDir);
          if (!fs.existsSync(fullDir)) continue;
          for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
            if (entry.name.endsWith(".c3addon") && entry.isFile()) {
              const addonName = entry.name.replace(/\.c3addon$/, "");
              const extractedDir = path.join(fullDir, addonName);
              const extracted = fs.existsSync(extractedDir) && fs.statSync(extractedDir).isDirectory();
              entries.push(`${addonName}  (${dirType})  ${extracted ? "extracted" : "archive only"}`);
            }
          }
        }
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No addons found." }] };
        }
        return { content: [{ type: "text", text: entries.sort().join("\n") }] };
      }

      // Find extracted addon folder
      let addonPath: string | null = null;
      for (const addonDir of ADDON_DIRS) {
        const candidate = path.join(PROJECT_ROOT, addonDir, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          addonPath = candidate;
          break;
        }
      }

      if (!addonPath) {
        return notFound(
          "read-addon",
          `Addon '${name}' not installed locally — extract from addons/plugin/${name}.c3addon or addons/effect/${name}.c3addon first`
        );
      }

      const targetFile = file ?? "aces.json";
      const filePath = path.resolve(path.join(addonPath, targetFile));

      // Path traversal check — reject paths that escape the addon directory
      const relative = path.relative(addonPath, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return notFound("read-addon", `Invalid file path '${targetFile}' — must stay within addon directory`);
      }

      if (!fs.existsSync(filePath)) {
        return notFound("read-addon", `File '${targetFile}' not found in addon '${name}'`);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    })
);

// ── Scaffold Tools ──────────────────────────────────────────────────────

server.registerTool(
  "scaffold-layout",
  {
    title: "Scaffold Layout",
    description:
      "Clone an existing layout to create a new one. Remaps all UIDs and SIDs for uniqueness, sets the layout name and event sheet, writes the new layout JSON, and syncs project.c3proj. Optionally regenerates extracted/ files.",
    annotations: MUTATE,
    inputSchema: {
      source: z
        .string()
        .describe("Relative path to the source layout JSON within layouts/ (e.g. 'Heroes/HeroesLayout.json')"),
      name: z.string().describe("Name for the new layout"),
      path: z
        .string()
        .describe("Relative output path within layouts/ for the new layout JSON (e.g. 'NewFeature/NewLayout.json')"),
      eventSheet: z.string().describe("Event sheet name for the new layout"),
      txId: z
        .number()
        .optional()
        .describe("Expected txId — if stale, scaffold is rejected"),
      regenerate: z
        .boolean()
        .optional()
        .describe("Regenerate extracted/ files after scaffolding (default: true)"),
    },
  },
  async ({ source, name, path: outRelPath, eventSheet, txId: expectedTxId, regenerate }, extra: Extra) =>
    rwlock.write(async () => {
      const shouldRegenerate = regenerate !== false;
      const totalSteps = shouldRegenerate ? 7 : 2; // clone + sync + 5 generators
      const lines: string[] = [];
      const log: Logger = (...args) => lines.push(args.map(String).join(" "));
      try {
        if (expectedTxId !== undefined && expectedTxId !== txId) {
          return {
            content: [
              { type: "text", text: `State changed (expected ${expectedTxId}, got ${txId}) — re-validate before scaffolding` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }

        const layoutsDir = path.join(PROJECT_ROOT, "layouts");

        // Path traversal check — output must stay within layouts/
        const outFullPath = path.resolve(path.join(layoutsDir, outRelPath));
        const outRelative = path.relative(layoutsDir, outFullPath);
        if (outRelative.startsWith("..") || path.isAbsolute(outRelative)) {
          return {
            content: [
              { type: "text", text: `Invalid output path '${outRelPath}' — must stay within layouts/` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }

        // Path traversal check — source must stay within layouts/
        const sourceFullPath = path.resolve(path.join(layoutsDir, source));
        const sourceRelative = path.relative(layoutsDir, sourceFullPath);
        if (sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) {
          return {
            content: [
              { type: "text", text: `Invalid source path '${source}' — must stay within layouts/` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }
        if (!fs.existsSync(sourceFullPath)) {
          return {
            content: [
              { type: "text", text: `Source layout not found: layouts/${source}` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }

        const sourceContent = fs.readFileSync(sourceFullPath, "utf-8");
        const sourceLayout = JSON.parse(sourceContent) as Record<string, unknown>;

        // Collect all existing UIDs and SIDs, then clone. Seeding existingSids from the
        // project registry prevents cloned SIDs from colliding with anything in eventSheets/,
        // layouts/, or objectTypes/.
        const existingUids = collectAllUids(layoutsDir);
        const sidRegistryPath = path.join(EXTRACTED_DIR, "sid-registry.txt");
        const existingSids = fs.existsSync(sidRegistryPath)
          ? readRegistryFile(sidRegistryPath)
          : new Set<number>();
        const cloned = cloneLayout(sourceLayout, { name, eventSheet, existingUids, existingSids });

        // Write output
        suppressWatcherDepth++;
        try {
          // Ensure output directory exists
          const outDir = path.dirname(outFullPath);
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(outFullPath, JSON.stringify(cloned, null, "\t") + "\n");
          expectedChanges.add(toForwardSlash(path.relative(PROJECT_ROOT, outFullPath)));
          await sendProgress(extra, 0, totalSteps, "Cloning layout");
          log(`Scaffolded ${name} → layouts/${outRelPath}`);

          // Sync project.c3proj
          await sendProgress(extra, 1, totalSteps, "Syncing project.c3proj");
          runSync(PROJECT_ROOT, false, log);

          // Regenerate extracted/ files
          if (shouldRegenerate) {
            await runGenerators(log, extra, 2, totalSteps);
          }
        } finally {
          suppressWatcherDepth--;
        }

        txId++;
        if (shouldRegenerate) {
          extractedDirty = false;
        }
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: `txId: ${txId}` },
          ],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Layout was already written — source files changed, extracted/ is stale
          txId++;
          extractedDirty = true;
        }
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            { type: "text", text: `txId: ${txId}` },
          ],
          isError: true,
        };
      }
    })
);

server.registerTool(
  "scaffold-sprite",
  {
    title: "Scaffold Sprite",
    description:
      "Clone an existing objectType (sprite) to create a new one. Remaps all SIDs and imageSpriteIds for uniqueness, copies associated image files, writes the new objectType JSON, and syncs project.c3proj.",
    annotations: MUTATE,
    inputSchema: {
      source: z
        .string()
        .describe("Source objectType name (e.g. 'StoryBookIcon')"),
      name: z.string().describe("Target objectType name (e.g. 'VideosIcon')"),
      txId: z
        .number()
        .optional()
        .describe("Expected txId — if stale, scaffold is rejected"),
    },
  },
  async ({ source, name: targetName, txId: expectedTxId }) =>
    rwlock.write(async () => {
      const lines: string[] = [];
      const log: Logger = (...args) => lines.push(args.map(String).join(" "));
      try {
        if (expectedTxId !== undefined && expectedTxId !== txId) {
          return {
            content: [
              { type: "text", text: `State changed (expected ${expectedTxId}, got ${txId}) — re-validate before scaffolding` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }

        const objectTypesDir = path.join(PROJECT_ROOT, "objectTypes");
        const imagesDir = path.join(PROJECT_ROOT, "images");

        // Validate names don't contain path separators
        for (const [label, val] of [["source", source], ["name", targetName]] as const) {
          if (val.includes("/") || val.includes("\\") || val.includes("..")) {
            return {
              content: [
                { type: "text", text: `Invalid ${label} '${val}' — must be a plain objectType name without path separators` },
                { type: "text", text: `txId: ${txId}` },
              ],
              isError: true,
            };
          }
        }

        // Read source objectType
        const sourceFile = path.join(objectTypesDir, `${source}.json`);
        if (!fs.existsSync(sourceFile)) {
          return {
            content: [
              { type: "text", text: `Source objectType not found: objectTypes/${source}.json` },
              { type: "text", text: `txId: ${txId}` },
            ],
            isError: true,
          };
        }

        const sourceContent = fs.readFileSync(sourceFile, "utf-8");
        const sourceObj = JSON.parse(sourceContent) as Record<string, unknown>;

        // Collect all existing SIDs and max imageSpriteId
        const existingSids = collectAllObjectTypeSids(objectTypesDir);
        const maxImageSpriteId = collectMaxImageSpriteId(objectTypesDir);

        // Clone the sprite
        const cloned = cloneSprite(sourceObj, {
          name: targetName,
          existingSids,
          nextImageSpriteId: maxImageSpriteId + 1,
        });

        // Write output and copy images
        suppressWatcherDepth++;
        try {
          // Write objectType JSON
          const outFile = path.join(objectTypesDir, `${targetName}.json`);
          fs.writeFileSync(outFile, JSON.stringify(cloned, null, "\t") + "\n");
          expectedChanges.add(`objectTypes/${targetName}.json`);
          log(`Scaffolded ${targetName} → objectTypes/${targetName}.json`);

          // Discover and copy images (images/ is NOT watched — no expectedChanges needed)
          if (fs.existsSync(imagesDir)) {
            const imageCopies = discoverAndPlanImageCopies(imagesDir, source, targetName);
            for (const { sourcePath, targetPath, sourceBasename, targetBasename } of imageCopies) {
              fs.copyFileSync(sourcePath, targetPath);
              log(`Copied images/${sourceBasename} → images/${targetBasename}`);
            }
          }

          // Sync project.c3proj
          runSync(PROJECT_ROOT, false, log);
        } finally {
          suppressWatcherDepth--;
        }

        txId++;
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: `txId: ${txId}` },
          ],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Sprite was already written — source files changed, extracted/ may be stale
          txId++;
          extractedDirty = true;
        }
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            { type: "text", text: `txId: ${txId}` },
          ],
          isError: true,
        };
      }
    })
);

// ── State Tool ───────────────────────────────────────────────────────────────

server.registerTool(
  "get-state",
  {
    title: "Get Server State",
    description:
      "Returns the current server state: txId (incremented on source file changes) and extractedDirty (true if source files changed since last regeneration).",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(async () => {
      return {
        content: [{ type: "text", text: `txId: ${txId}\nextractedDirty: ${extractedDirty}` }],
      };
    })
);

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startServer(projectDir?: string): Promise<void> {
  if (projectDir) {
    PROJECT_ROOT = projectDir;
    EXTRACTED_DIR = path.join(PROJECT_ROOT, "extracted");
  }

  // Startup validation — warn but don't hard-fail
  const c3projPath = path.join(PROJECT_ROOT, "project.c3proj");
  if (!fs.existsSync(c3projPath)) {
    console.error(`[construct3-chef] Warning: project.c3proj not found in ${PROJECT_ROOT} — not a Construct 3 project directory`);
  }
  if (!fs.existsSync(EXTRACTED_DIR)) {
    console.error(`[construct3-chef] extracted/ not found — auto-generating...`);
    try {
      const log: Logger = (...args) => console.error(`[construct3-chef]   ${args.map(String).join(" ")}`);
      await runGenerators(log);
      console.error(`[construct3-chef] Auto-generation complete`);
    } catch (e) {
      console.error(`[construct3-chef] Warning: auto-generation failed — ${e instanceof Error ? e.message : String(e)}`);
      console.error(`[construct3-chef] Run 'npm run generate-c3' manually to generate extracted files`);
    }
  }
  console.error(`[construct3-chef] Starting server in ${PROJECT_ROOT}`);

  // Graceful shutdown
  function shutdown() {
    console.error("[construct3-chef] Shutting down...");
    server.close().catch(() => {});
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  setupWatchers();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
