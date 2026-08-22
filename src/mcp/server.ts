import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReadWriteLock,
  ExpectedChanges,
  OptimisticWatcher,
  paginatedContent,
  mcpContent,
  mcpError,
  withMcpErrors,
  exposeDocs,
  bufferingLogger,
  resolveWithin,
  toPosixPath,
  READ_ONLY,
  REGENERATE,
  MUTATE,
  NON_IDEMPOTENT_READ,
  resolveRootFolder,
  isMcpError,
} from "@genvidtech/mcp-utils";
import type { Logger } from "@genvidtech/mcp-utils";
import { applyParsed } from "../c3/recipeApplier.js";
import { writeSourceJson } from "../c3/sourceJson.js";
import { validateRecipe, type Recipe } from "../c3/recipeInterpreter.js";
import { GENERATORS, findJsonFiles, SID_SOURCE_DIRS } from "../c3/generators.js";
import { runSync, reportImageDrift, reportStrayFiles } from "../c3/projectSync.js";
import { isEditorLocalPathUnder } from "../c3/editorLocal.js";
import { readRegistryFile, mintUniqueSid } from "../c3/sidUtils.js";
import { filterIndex, buildShallowSidMap, type SidMapEntry } from "../c3/dslFormatter.js";
import { find_all_eventsheets_path, find_all_layouts_path, openProject } from "@genvidtech/c3source";
import type { EventSheet, C3Project } from "@genvidtech/c3source";
import { resolveIncludeTree, formatIncludeTree, flattenIncludeTree } from "../c3/includeTree.js";
import { collectAllUids, cloneLayout } from "../c3/layoutScaffold.js";
import { search } from "../c3/search.js";
import { createSourceWatcher } from "./sourceWatcher.js";
import { resolveAnchor } from "../c3/anchorResolver.js";
import {
  collectAllObjectTypeSids,
  collectMaxImageSpriteId,
  discoverAndPlanImageCopies,
  cloneSprite,
} from "../c3/spriteScaffold.js";
import { loadChefConfig, type ChefConfig } from "../c3/chefConfig.js";
import {
  buildLayoutEventSheetMap,
  findGoToLayoutCalls,
  formatNavTable,
  generatePlantUML,
} from "../c3/navigationGraph.js";
import { resolveNavConvention } from "../c3/navConvention.js";
import { discoverAddons, resolveAddonTarget } from "../c3/addonDiscovery.js";
import { readAddon, readAddonEntry, formatAddonInfo, formatAddonList } from "../c3/addonReader.js";
import { validateAddons, formatAddonValidation } from "../c3/addonValidator.js";
import { listAddons, formatAddonInventory } from "../c3/addonInventory.js";
import { diffAddonAces, formatAceDiff, resolveAceSource } from "../c3/addonAceDiff.js";
import { scanAddonUsage, formatAddonUsage } from "../c3/addonAceUsage.js";
import { syncAddonMetadata, formatAddonMetadataSync } from "../c3/addonMetadataSync.js";
import { lookup, formatLookupResult } from "../c3/aceLookup.js";
import { OpsRegistry } from "./opsRegistry.js";

let PROJECT_ROOT = process.cwd();
let EXTRACTED_DIR = path.join(PROJECT_ROOT, "extracted");
let PROJECT: C3Project = openProject(PROJECT_ROOT);

const server = new McpServer(
  { name: "construct3-chef", version: "1.0.0" },
  { capabilities: { logging: {}, resources: {}, tools: { listChanged: true } } },
);
const __pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
exposeDocs(server, __pkgDir);
const rwlock = new ReadWriteLock();

// ── Server State ─────────────────────────────────────────────────────────────

let extractedDirty = false;
// The OptimisticWatcher owns txId, the suppress window, and the file watchers.
// Assigned in setupWatchers() (called from startServer) before any tool runs.
let watcher!: OptimisticWatcher;
const expectedChanges = new ExpectedChanges();

// Tool annotation presets (READ_ONLY / REGENERATE / MUTATE / NON_IDEMPOTENT_READ)
// are imported from @genvidtech/mcp-utils. NON_IDEMPOTENT_READ marks tools that read
// source only but return different output per call (e.g. random-SID minting) —
// clients must NOT treat them as idempotent for retry/cache purposes.

// ── Helpers ──────────────────────────────────────────────────────────────────

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Extract the error message text from a CallToolResult returned by resolveRootFolder. */
function mcpErrorText(r: CallToolResult): string {
  const block = r.content[0];
  return block && block.type === "text" ? (block as { type: "text"; text: string }).text : String(r);
}

// ── Handler registry (also enables direct handler invocation in tests) ─────────
const handlers = new Map<string, (args: any, extra: Extra) => Promise<unknown>>();
// Config objects (inputSchema/annotations/description) as passed to registerTool,
// keyed by tool name — lets tests introspect the declared schema/annotations
// without round-tripping through the SDK's own registration bookkeeping.
const toolConfigs = new Map<string, Record<string, unknown>>();
function reg<
  OutputArgs extends Record<string, import("zod").ZodTypeAny>,
  InputArgs extends undefined | Record<string, import("zod").ZodTypeAny> = undefined,
>(...args: Parameters<typeof server.registerTool<OutputArgs, InputArgs>>): void {
  handlers.set(args[0] as string, args[2] as (a: any, e: Extra) => Promise<unknown>);
  toolConfigs.set(args[0] as string, args[1] as Record<string, unknown>);
  server.registerTool(...args);
}

// Shared Zod schemas mirroring layoutMutator's InstanceOverrides contract.
// Used by workflow MCP tools whose inputs carry per-instance world overrides.
// Without typed schemas, z.record(z.unknown()) would let a string land in a
// numeric `world.x` field, which applyOverrides assigns blindly — C3 then
// rejects the layout file at load with "invalid x".
const INSTANCE_OVERRIDES_SCHEMA = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    opacity: z.number().optional(),
    tags: z.string().optional(),
    "initially-visible": z.boolean().optional(),
    instanceVariables: z.record(z.unknown()).optional(),
  })
  .strict();
const CHILD_OVERRIDES_SCHEMA = z.record(INSTANCE_OVERRIDES_SCHEMA);

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

// Derived from the shared GENERATORS inventory. The `fn` closures must read
// PROJECT_ROOT/EXTRACTED_DIR at call time (not capture them eagerly) — both
// are module-level mutable and reassigned by startServer and the
// __setProjectRoot/__resetTestState test seams.
const GENERATOR_STEPS = GENERATORS.map((g) => ({
  name: g.label,
  fn: (log: Logger) => g.run(PROJECT_ROOT, EXTRACTED_DIR, log),
}));

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

function checkCancelled(extra?: Extra): void {
  if (extra?.signal?.aborted) throw new CancelledError();
}

async function runGenerators(log: Logger, extra?: Extra, progressOffset = 0, progressTotal = 6): Promise<void> {
  for (let i = 0; i < GENERATOR_STEPS.length; i++) {
    checkCancelled(extra);
    if (extra) await sendProgress(extra, progressOffset + i, progressTotal, GENERATOR_STEPS[i].name);
    GENERATOR_STEPS[i].fn(log);
  }
  if (extra) await sendProgress(extra, progressOffset + GENERATOR_STEPS.length, progressTotal, "Done");
}

function readExtracted(relPath: string): string | null {
  const fullPath = resolveWithin(EXTRACTED_DIR, relPath);
  if (fullPath === null) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, "utf-8");
}

const txIdLine = () => `txId: ${watcher.txId}`;

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
      watcher.bump();
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
    // Exclude editor-local paths (e.g. `layouts/uistate/*.instancesBar.json`):
    // generateSidRegistry excludes them the same way when building the very
    // registry this scan checks freshness against, so including them here
    // would compare against files the registry never contained. See ADR
    // wiki/decisions/0018-editor-local-writes-are-not-source-changes.md.
    for (const file of files.filter((f) => !isEditorLocalPathUnder(PROJECT_ROOT, f))) {
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
    watcher.bump();
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
  opts?: { stale?: boolean },
): CallToolResult {
  const result = paginatedContent(text, { offset, limit });
  const pageText = (result.content[0] as { text: string }).text;
  const finalText = opts?.stale === false ? pageText : appendStaleWarning(pageText);
  return { content: [{ type: "text" as const, text: finalText }] };
}

const toSortedRelative = (absPaths: string[], dir: string) =>
  absPaths.map((p) => toPosixPath(path.relative(dir, p))).sort();

/**
 * Render the rows portion of a read-event-sids response (excluding the header).
 *
 * When `grep` is provided and an entry matched only via its hidden `searchText`
 * (i.e. the regex does NOT match `description` but DOES match a line in
 * `searchText`), a sub-line `  ↳ matched: <first matching searchText line>` is
 * appended immediately after the data row so callers can see WHICH condition or
 * action matched.
 *
 * Exported for unit testing — the handler calls this directly.
 */
export function renderEventSidRows(entries: SidMapEntry[], grep?: string): string {
  const re = grep ? new RegExp(grep, "i") : null;
  const maxPathLen = Math.max(12, ...entries.map((e) => e.jsonPath.length));
  const lines: string[] = [];
  for (const e of entries) {
    const sidStr = e.sid !== undefined ? `§${e.sid}` : "(no SID)";
    lines.push(`${e.jsonPath.padEnd(maxPathLen + 2)}${sidStr.padEnd(20)}${e.description}`);
    if (re && !re.test(e.description) && e.searchText) {
      const matchedLine = e.searchText.split("\n").find((line) => re.test(line));
      if (matchedLine !== undefined) {
        lines.push(`  ↳ matched: ${matchedLine.trim()}`);
      }
    }
  }
  return lines.join("\n");
}

// ── File Watchers ────────────────────────────────────────────────────────────

function setupWatchers(): void {
  watcher = createSourceWatcher({
    projectRoot: PROJECT_ROOT,
    expected: expectedChanges,
    // External source-dir edit → mark extracted/ stale (txId already bumped by
    // the watcher). project.c3proj edits bump txId only (handled inside
    // createSourceWatcher), so they don't reach here.
    onSourceChange: (filePath) => {
      extractedDirty = true;
      emitLog("warning", `External change detected: ${filePath} (txId → ${watcher.txId})`);
    },
  });
  watcher.start();

  // Periodically purge expired entries from expectedChanges
  setInterval(() => expectedChanges.purgeExpired(), 30_000).unref();
}

// ── Listing Tools ─────────────────────────────────────────────────────────────

reg(
  "list-event-sheets",
  {
    title: "List Event Sheets",
    description:
      "List all C3 event sheet JSON files in the project. Returns relative paths from the eventSheets/ root. Supports offset/limit pagination.",
    annotations: READ_ONLY,
    inputSchema: { ...PAGINATION_PARAMS },
  },
  async ({ offset, limit }) =>
    rwlock.read(async () => {
      const sheets = toSortedRelative(PROJECT.findAllEventSheets(), PROJECT.eventSheetsDir);
      return paginatedResponse(sheets.join("\n"), offset, limit, { stale: false });
    }),
);

reg(
  "list-layouts",
  {
    title: "List Layouts",
    description:
      "List all C3 layout JSON files in the project. Returns relative paths from the layouts/ root. Supports offset/limit pagination.",
    annotations: READ_ONLY,
    inputSchema: { ...PAGINATION_PARAMS },
  },
  async ({ offset, limit }) =>
    rwlock.read(async () => {
      const layouts = toSortedRelative(PROJECT.findAllLayouts(), PROJECT.layoutsDir);
      return paginatedResponse(layouts.join("\n"), offset, limit, { stale: false });
    }),
);

reg(
  "list-global-layers",
  {
    title: "List Global Layers",
    description:
      "List each global layer with its source layout, overriding layouts, and instance count. Global layers are shared across layouts; one layout defines the instances, others reference them via override. Generated from layouts/**/*.json.",
    annotations: READ_ONLY,
    inputSchema: { ...PAGINATION_PARAMS },
  },
  async ({ offset, limit }) =>
    rwlock.read(async () => {
      const text = readExtracted("global-layers.txt");
      if (text === null) {
        return mcpError("global-layers.txt not found. Run 'regenerate' to generate it.", {
          prefix: "list-global-layers:",
        });
      }
      return paginatedResponse(text, offset, limit);
    }),
);

reg(
  "navigation-graph",
  {
    title: "Navigation Graph",
    description:
      "Show the layout navigation graph: every System.go-to-layout / configured nav call found in the extracted DSL, as a 'from event sheet → target layout → line' table. Pass format:\"plantuml\" to get a PlantUML component diagram (layout → layout) as text instead. Reads the extracted/ surface; supports offset/limit pagination.",
    annotations: READ_ONLY,
    inputSchema: {
      format: z
        .enum(["table", "plantuml"])
        .optional()
        .describe("Output format: 'table' (default) for the from→to→line table, or 'plantuml' for diagram source"),
      ...PAGINATION_PARAMS,
    },
  },
  async ({ format, offset, limit }) =>
    rwlock.read(async () => {
      const config = await loadChefConfig(PROJECT_ROOT);
      const layoutEventSheetMap = buildLayoutEventSheetMap(PROJECT.layoutsDir);
      const sheetToLayout: Record<string, string> = {};
      for (const [layoutName, sheetName] of Object.entries(layoutEventSheetMap)) {
        sheetToLayout[sheetName] = layoutName;
      }
      const navEntries = findGoToLayoutCalls(EXTRACTED_DIR, resolveNavConvention(config));
      const text =
        format === "plantuml" ? generatePlantUML(navEntries, sheetToLayout) : formatNavTable(navEntries, sheetToLayout);
      return paginatedResponse(text, offset, limit);
    }),
);

// ── Read Tools ────────────────────────────────────────────────────────────────

reg(
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
        path.join(PROJECT.eventSheetsDir, `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.txt`),
      );
      const text = readExtracted(`eventSheets/${sheet}.dsl.txt`);
      if (text === null) {
        return mcpError(`No DSL file found for '${sheet}'. Use list-event-sheets to see available sheets.`, {
          prefix: "read-dsl:",
        });
      }
      return paginatedResponse(text, offset, limit);
    }),
);

reg(
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
        path.join(PROJECT.eventSheetsDir, `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.idx.txt`),
      );
      let text = readExtracted(`eventSheets/${sheet}.dsl.idx.txt`);
      if (text === null) {
        return mcpError(`No DSL index file found for '${sheet}'. Use list-event-sheets to see available sheets.`, {
          prefix: "read-dsl-index:",
        });
      }
      if (grep) {
        text = filterIndex(text, grep);
      }
      return paginatedResponse(text, offset, limit);
    }),
);

reg(
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
        .describe(
          "Regex pattern (case-insensitive). Matches against the description column AND a serialized summary of each event's own conditions and actions — including object classes, action/condition IDs, parameter values, [behaviorType] segments, [DISABLED] markers, and NOT prefixes — so queries like 'BattleLayout', 'GoToLayout', 'on-touched-object', or '[DISABLED]' find the relevant blocks. Search is shallow per-event: a match in a nested child returns the child's SID, not the enclosing block's.",
        ),
    },
  },
  async ({ sheet, grep }) =>
    rwlock.read(async () => {
      const sourcePath = path.join(PROJECT.eventSheetsDir, `${sheet}.json`);
      if (!fs.existsSync(sourcePath)) {
        return mcpError(`No event sheet found for '${sheet}'. Use list-event-sheets to see available sheets.`, {
          prefix: "read-event-sids:",
        });
      }
      const raw = fs.readFileSync(sourcePath, "utf-8");
      const parsed = JSON.parse(raw) as EventSheet;
      let entries = buildShallowSidMap(parsed);
      if (grep) {
        const re = new RegExp(grep, "i");
        entries = entries.filter((e) => re.test(e.description) || re.test(e.searchText));
      }
      if (entries.length === 0) {
        const hint = grep ? ` matching '${grep}'` : "";
        return { content: [{ type: "text", text: `No events found${hint} in '${sheet}'.` }] };
      }
      // Format as pipe-delimited table matching .dsl.idx.txt style
      const sheetName = sheet.includes("/") ? sheet.split("/").pop()! : sheet;
      const header = `# ${sheetName} — Event SID Map (from source)\n# JSON Path | SID | Description`;
      return { content: [{ type: "text", text: `${header}\n${renderEventSidRows(entries, grep)}` }] };
    }),
);

reg(
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
        path.join(PROJECT.eventSheetsDir, `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.ts`),
      );
      const text = readExtracted(`eventSheets/${sheet}.ts`);
      if (text === null) {
        return mcpError(
          `No extracted TypeScript found for '${sheet}'. Use list-event-sheets to see available sheets.`,
          {
            prefix: "read-scripts:",
          },
        );
      }
      return paginatedResponse(text, offset, limit);
    }),
);

reg(
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
        path.join(PROJECT.layoutsDir, `${layout}.json`),
        path.join(EXTRACTED_DIR, "layouts", `${layout}.layout.txt`),
      );
      const text = readExtracted(`layouts/${layout}.layout.txt`);
      if (text === null) {
        return mcpError(`No layout summary found for '${layout}'. Use list-layouts to see available layouts.`, {
          prefix: "read-layout:",
        });
      }
      return paginatedResponse(text, offset, limit);
    }),
);

// ── Reference Tools ───────────────────────────────────────────────────────────

reg(
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
        return mcpError("template-scope.txt not found. Run 'npm run generate-c3' to generate it.", {
          prefix: "read-template-scope:",
        });
      }
      return paginatedResponse(text, offset, limit);
    }),
);

reg(
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
        return mcpError("sid-registry.txt not found. Run 'npm run generate-c3' to generate it.", {
          prefix: "read-sid-registry:",
        });
      }
      return paginatedResponse(text, offset, limit);
    }),
);

reg(
  "generate-sids",
  {
    title: "Generate Unique SIDs",
    description:
      "Mint fresh unique C3 SIDs in the [1e14, 1e15) range, seeded from sid-registry.txt (which covers eventSheets/, layouts/, and objectTypes/). " +
      "Returns `count` SIDs that don't collide with each other within this call or with any SID in the registry. " +
      "Minted SIDs are NOT persisted to the registry — to avoid re-drawing them across calls, write them into source files and run 'regenerate', or pass them as `extraUsedSids` on the next call.",
    annotations: NON_IDEMPOTENT_READ,
    inputSchema: {
      count: z.number().int().min(1).max(100).optional().describe("Number of SIDs to mint (default: 1, max: 100)."),
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
    rwlock.write(
      withMcpErrors(
        async () => {
          const registryPath = path.join(EXTRACTED_DIR, "sid-registry.txt");
          if (!fs.existsSync(registryPath)) {
            return mcpError("sid-registry.txt not found. Run 'regenerate' first.", { prefix: "generate-sids:" });
          }
          checkRegistryFreshness(registryPath);
          const used = readRegistryFile(registryPath);
          if (extraUsedSids) for (const s of extraUsedSids) used.add(s);
          const sids = Array.from({ length: count }, () => mintUniqueSid(used));
          const header = `# Generated ${count} SID${count === 1 ? "" : "s"}:`;
          const text = appendStaleWarning(`${header}\n${sids.join("\n")}`);
          return { content: [{ type: "text", text }] };
        },
        { prefix: "generate-sids:" },
      ),
    ),
);

reg(
  "list-include-tree",
  {
    title: "List Include Tree",
    description:
      "Show the transitive include tree for an eventSheet — which sheets it includes, and what those sheets include (recursively). Useful for determining which C3 functions are callable from a given layout's eventSheet. Optionally lists functions defined at each level.",
    annotations: READ_ONLY,
    inputSchema: {
      path: z
        .string()
        .describe("EventSheet name (e.g. 'GoalsEvents') or path (e.g. 'eventSheets/Goals/GoalsEvents.json')"),
      functions: z.boolean().optional().describe("Include function names defined at each level (default: false)"),
      flat: z
        .boolean()
        .optional()
        .describe("Return a flat deduplicated list of all included sheet names instead of a tree (default: false)"),
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

reg(
  "search",
  {
    title: "Search Files",
    description:
      "Search extracted or project files for a regex pattern. Returns matching lines with file path and line number. Supports multiple file types (dsl, ts, layout, md, json, idx), single-file or directory targeting, and context lines around matches.",
    annotations: READ_ONLY,
    inputSchema: {
      pattern: z.string().describe("Regex pattern to search for"),
      type: z
        .enum(["dsl", "ts", "layout", "md", "json", "idx"])
        .optional()
        .describe("File category to search (default: dsl)"),
      path: z
        .string()
        .optional()
        .describe("Single file or directory prefix. For json type, must include 'eventSheets/' or 'layouts/' prefix"),
      context: z.number().int().min(0).optional().describe("Context lines around matches (like grep -C)"),
    },
  },
  async ({ pattern, type, path: searchPath, context }) =>
    rwlock.read(
      withMcpErrors(
        async () => {
          if (!pattern) {
            return mcpError("Pattern cannot be empty. Provide a regex pattern to search for.", { prefix: "search:" });
          }

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

          emitLog(
            "info",
            `search: type=${type ?? "dsl"}, path=${searchPath ?? "(all)"}, matches=${result.lines.length}${result.truncated ? " (truncated)" : ""}`,
          );

          return { content: [{ type: "text", text }] };
        },
        { prefix: "search:" },
      ),
    ),
);

// ── Anchor Resolution Tool ────────────────────────────────────────────────────

reg(
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
        path.join(PROJECT.eventSheetsDir, `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.idx.txt`),
      );
      const text = readExtracted(`eventSheets/${sheet}.dsl.idx.txt`);
      if (text === null) {
        return mcpError(`No DSL index file found for '${sheet}'. Use list-event-sheets to see available sheets.`, {
          prefix: "resolve-anchor:",
        });
      }

      let lookup: Parameters<typeof resolveAnchor>[1];
      if (by === "line") {
        const line = parseInt(value, 10);
        if (isNaN(line)) return mcpError(`Invalid line number: '${value}'`, { prefix: "resolve-anchor:" });
        lookup = { by: "line", line };
      } else if (by === "sid") {
        const sid = parseInt(value, 10);
        if (isNaN(sid)) return mcpError(`Invalid SID: '${value}'`, { prefix: "resolve-anchor:" });
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
          lines.push(
            `  Line ${alt.dslLine}: ${alt.description} (SID: ${alt.sid !== undefined ? "§" + alt.sid : "none"}, Path: ${alt.jsonPath})`,
          );
        }
      }

      return { content: [{ type: "text", text: appendStaleWarning(lines.join("\n")) }] };
    }),
);

// ── Recipe Tools ─────────────────────────────────────────────────────────────

reg(
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
    rwlock.read(
      withMcpErrors(
        async () => {
          // Refresh extractedDirty so the returned txId reflects any external edits
          // the file watcher may have missed (atomic-rename, git checkout, network mounts).
          // This matters: apply-recipe's optimistic-concurrency check uses our returned txId.
          checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
          const { log, text } = bufferingLogger();
          const recipe: Recipe = JSON.parse(recipeJson);
          const errors = validateRecipe(recipe);
          if (errors.length > 0) {
            return mcpError(`Validation errors:\n${errors.join("\n")}`, { extraLines: [txIdLine()] });
          }
          applyParsed(PROJECT_ROOT, recipe, { dryRun: true, log });
          return mcpContent(text(), txIdLine());
        },
        { prefix: "Error:", extraLines: () => [txIdLine()] },
      ),
    ),
);

/**
 * Core apply orchestration: parse-already-done recipe → write lock → apply →
 * optionally regenerate. Encapsulates concurrency boilerplate so op-<name>
 * tools can reuse the exact same flow without duplicating rwlock/watcher logic.
 *
 * Module-internal — NOT exported on the public barrel.
 */
async function applyRecipeWithConcurrency(
  recipe: Recipe,
  opts: { expectedTxId?: number; regenerate?: boolean; label?: string },
  extra: Extra,
): Promise<CallToolResult> {
  return rwlock.write(
    withMcpErrors(
      async () => {
        // Refresh extractedDirty before the txId check — catches external edits the
        // file watcher may have missed, so a stale registry doesn't seed `mintUniqueSid`
        // with SIDs that already exist on disk.
        checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
        const shouldRegenerate = opts.regenerate !== false;
        const totalSteps = shouldRegenerate ? 7 : 1; // apply + 6 generators
        const { log, text } = bufferingLogger();
        if (opts.expectedTxId !== undefined && opts.expectedTxId !== watcher.txId) {
          return mcpError(
            `State changed (expected ${opts.expectedTxId}, got ${watcher.txId}) — re-validate before applying`,
            { extraLines: [txIdLine()] },
          );
        }
        const label = opts.label ?? "Applying recipe";
        // Suppress watcher during writes — we manage txId/extractedDirty ourselves
        await watcher.suppress(async () => {
          await sendProgress(extra, 0, totalSteps, label);
          applyParsed(PROJECT_ROOT, recipe, { regenerate: false, log });
          if (shouldRegenerate) {
            await runGenerators(log, extra, 1, totalSteps);
          }
        });
        watcher.bump();
        if (shouldRegenerate) {
          extractedDirty = false;
        }
        return mcpContent(text(), txIdLine());
      },
      {
        prefix: "Error:",
        onError: (e) => {
          if (e instanceof CancelledError) {
            // Recipe already applied (source files modified) but regeneration interrupted
            watcher.bump();
            extractedDirty = true;
          }
        },
        extraLines: () => [txIdLine()],
      },
    ),
  );
}

reg(
  "apply-recipe",
  {
    title: "Apply Recipe",
    description:
      "Apply a C3 eventSheet mutation recipe. Modifies source files (eventSheets/, objectTypes/, layouts/, scripts/) and optionally regenerates extracted/ files. Pass txId from validate-recipe for optimistic concurrency.",
    annotations: MUTATE,
    inputSchema: {
      recipe: z.string().describe("Recipe JSON string"),
      txId: z.number().optional().describe("Expected txId from validate-recipe — if stale, apply is rejected"),
      regenerate: z.boolean().optional().describe("Regenerate extracted/ files after applying (default: true)"),
    },
  },
  async ({ recipe: recipeJson, txId: expectedTxId, regenerate }, extra: Extra) => {
    let recipe: Recipe;
    try {
      recipe = JSON.parse(recipeJson);
    } catch (e) {
      return mcpError(e, { prefix: "Error:", extraLines: [txIdLine()] });
    }
    return applyRecipeWithConcurrency(recipe, { expectedTxId, regenerate }, extra);
  },
);

// ── Regenerate Tool ─────────────────────────────────────────────────────────

reg(
  "regenerate",
  {
    title: "Regenerate Extracted Files",
    description:
      "Run all 6 C3 generators (extract scripts, DSL, layout summaries, template scope, SID registry, global layers) and update extracted/. Clears the extractedDirty flag. Use after external edits to source files, or when extractedDirty is true.",
    annotations: REGENERATE,
    inputSchema: {},
  },
  async (_args: Record<string, never>, extra: Extra) =>
    rwlock.write(
      withMcpErrors(
        async () => {
          const { log, text } = bufferingLogger();
          // Suppress watcher — regenerate writes only to extracted/ (derived output)
          await watcher.suppress(async () => {
            await runGenerators(log, extra);
          });
          extractedDirty = false;
          return mcpContent(text());
        },
        {
          prefix: "Error:",
          onError: (e) => {
            if (e instanceof CancelledError) {
              // Partially regenerated — stale. No watcher.bump() (regenerate doesn't modify source files)
              extractedDirty = true;
            }
          },
        },
      ),
    ),
);

// ── Project Tools ────────────────────────────────────────────────────────────

reg(
  "validate-project",
  {
    title: "Validate project.c3proj",
    description:
      "Dry-run sync of project.c3proj against disk. Reports any drift (missing or extra file entries) without modifying the file. Also reports stray files — files under a section root that are neither .json section items nor editor-local (e.g. layouts/notes.txt) — as a detection-only note that never affects the result. Returns output and current txId.",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(
      withMcpErrors(
        async () => {
          const { log, text } = bufferingLogger();
          // #184: reportImageDrift and reportStrayFiles are both manifest-INDEPENDENT
          // (they classify basenames under the section roots and never read the
          // manifest), so a project.c3proj that will not parse is exactly where they
          // help most. Caught at the CALL SITE — runSync's own fail-fast contract, and
          // the three rows in syncC3Proj.test.ts that pin it, stay untouched.
          let failure: unknown;
          try {
            runSync(PROJECT_ROOT, true, log);
          } catch (err) {
            failure = err;
          }
          reportImageDrift(PROJECT_ROOT, log);
          reportStrayFiles(PROJECT_ROOT, log);
          if (failure !== undefined) {
            // The response stays isError — the tool DID fail. The diagnostics ride
            // along rather than converting a real failure into a success response.
            return mcpError(failure, { prefix: "Error:", extraLines: [text(), txIdLine()] });
          }
          return mcpContent(text(), txIdLine());
        },
        { prefix: "Error:", extraLines: () => [txIdLine()] },
      ),
    ),
);

reg(
  "sync-project",
  {
    title: "Sync project.c3proj",
    description:
      "Sync project.c3proj to match files on disk. Adds missing entries and removes stale ones. Stray files — files under a section root that are neither .json section items nor editor-local (e.g. layouts/notes.txt) — are reported detection-only; sync never acts on them. Pass txId for optimistic concurrency. Returns output and new txId.",
    annotations: MUTATE,
    inputSchema: {
      txId: z.number().optional().describe("Expected txId — if stale, sync is rejected"),
    },
  },
  async ({ txId: expectedTxId }) =>
    rwlock.write(
      withMcpErrors(
        async () => {
          const { log, text } = bufferingLogger();
          if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
            return mcpError(
              `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before syncing`,
              { extraLines: [txIdLine()] },
            );
          }
          // Suppress watcher — we manage txId ourselves
          await watcher.suppress(async () => {
            runSync(PROJECT_ROOT, false, log);
          });
          watcher.bump();
          // Detection-only: images aren't a manifest section so sync can't act on
          // image drift, but surface it (read-only) so a direct sync still shows it,
          // mirroring validate-project (#52).
          reportImageDrift(PROJECT_ROOT, log);
          reportStrayFiles(PROJECT_ROOT, log);
          return mcpContent(text(), txIdLine());
        },
        { prefix: "Error:", extraLines: () => [txIdLine()] },
      ),
    ),
);

// ── Addon Tool ──────────────────────────────────────────────────────────────

reg(
  "read-addon",
  {
    title: "Read Addon",
    description:
      "Read a C3 addon. Without a name, lists all available addons from addons/plugin/ and addons/effect/ with their extraction status. With a name and no file, returns the addon's metadata (id/version/author/sdk-version) plus its ACE summary. With a name and file, reads a single raw entry (e.g. 'addon.json') from within the addon — works whether the addon is extracted or archive-only.",
    annotations: READ_ONLY,
    inputSchema: {
      name: z.string().optional().describe("Addon name (e.g. 'CV_Clock'). Omit to list all available addons."),
      file: z.string().optional().describe("Raw file entry to read within the addon (e.g. 'addon.json')"),
    },
  },
  async ({ name, file }) =>
    rwlock.read(
      withMcpErrors(
        async () => {
          if (!name) {
            // formatAddonList owns the empty case ("No addons found."), so the
            // CLI and MCP list output stays byte-identical.
            return mcpContent(formatAddonList(discoverAddons(PROJECT_ROOT)));
          }

          if (!file) {
            const info = readAddon(PROJECT_ROOT, name);
            if (info === null) {
              return mcpError(`Addon '${name}' not found`, { prefix: "read-addon:" });
            }
            emitLog(
              "info",
              `read-addon: name=${name}, kind=${info.kind}, source=${info.source}, aces=${info.aces.length}`,
            );
            return mcpContent(formatAddonInfo(info));
          }

          // Path traversal guard — belt-and-suspenders on top of readAddonEntry's
          // internal resolveWithin (extracted branch); the zip branch matches by
          // exact entry name so it can't escape the archive.
          if (file.includes("..") || path.isAbsolute(file)) {
            return mcpError(`Invalid file path '${file}' — must stay within addon directory`, {
              prefix: "read-addon:",
            });
          }

          const addon = discoverAddons(PROJECT_ROOT).find((a) => a.name === name);
          if (addon === undefined) {
            return mcpError(`Addon '${name}' not found`, { prefix: "read-addon:" });
          }

          const content = readAddonEntry(addon, file);
          if (content === null) {
            return mcpError(`File '${file}' not found in addon '${name}'`, { prefix: "read-addon:" });
          }

          return mcpContent(content);
        },
        { prefix: "read-addon:" },
      ),
    ),
);

reg(
  "validate-addons",
  {
    title: "Validate Addons",
    description:
      "Validate every bundled .c3addon package under addons/ against the project.c3proj usedAddons manifest: reports metadata mismatches (author/version), package-integrity failures (malformed zip, missing addon.json/aces.json, un-materialized git-lfs pointer, addon-id vs filename), aces.json vs lang/ ACE-entry consistency, orphan packages (on disk but not in usedAddons), missing packages (usedAddons bundled:true with no package on disk), and duplicate packages (multiple archives resolving to the same addon id). With `addon`, scope validation to a single addon (by discovered id, or by path to an addon source tree) instead of the whole project. Read-only; no mutation.",
    annotations: READ_ONLY,
    inputSchema: {
      addon: z
        .string()
        .optional()
        .describe(
          "Validate a single addon by discovered id or by path to an addon source tree (aces.json + lang/). Omit to validate all bundled addons.",
        ),
    },
  },
  async ({ addon }) =>
    rwlock.read(
      withMcpErrors(
        async () => {
          let result;
          if (addon !== undefined) {
            if (addon.includes("..") || path.isAbsolute(addon)) {
              return mcpError(`Invalid addon path '${addon}' — must stay within the project directory`, {
                prefix: "validate-addons:",
              });
            }
            const target = resolveAddonTarget(PROJECT_ROOT, addon);
            if (target === null) {
              return mcpError(`Addon '${addon}' not found`, { prefix: "validate-addons:" });
            }
            result = validateAddons(PROJECT_ROOT, target);
          } else {
            result = validateAddons(PROJECT_ROOT);
          }
          return mcpContent(formatAddonValidation(result), txIdLine());
        },
        { prefix: "validate-addons:", extraLines: () => [txIdLine()] },
      ),
    ),
);

reg(
  "list-addons",
  {
    title: "List Addons",
    description:
      "List a unified addon inventory for the project: one row per addon reconciling bundled .c3addon packages under addons/ with project.c3proj usedAddons entries. Each row carries a status — bundled (declared and on disk), editor-only (usedAddons bundled:false), missing (declared bundled but no package on disk), or orphan (on disk but not in usedAddons) — plus the version and, for on-disk addons, the package path. Read-only; no mutation.",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(
      withMcpErrors(async () => mcpContent(formatAddonInventory(listAddons(PROJECT_ROOT)), txIdLine()), {
        prefix: "list-addons:",
        extraLines: () => [txIdLine()],
      }),
    ),
);

reg(
  "diff-addon-aces",
  {
    title: "Diff Addon ACEs",
    description:
      "Diff the ACE contract (added/removed/changed ACEs + changed param signatures) between two addon sources — a .c3addon file path, or a discovered addon id/dir. Read-only.",
    annotations: READ_ONLY,
    inputSchema: {
      from: z.string().describe("First ACE source: a .c3addon file path, or a discovered addon id/dir"),
      to: z.string().describe("Second ACE source (same forms as 'from')"),
    },
  },
  // No path-traversal guard here — a deliberate departure from the
  // read-addon/validate-addons sibling guards. diff-addon-aces exists
  // specifically to diff .c3addon files that live outside the project
  // (e.g. two downloaded release archives), and the tool is strictly
  // read-only; resolveAceSource containment-checks the addon-id/dir branch
  // internally. No txId footer either — addon packages aren't tx-tracked
  // (not in SOURCE_DIRS, not project.c3proj), same as read-addon.
  async ({ from, to }) =>
    rwlock.read(
      withMcpErrors(
        async () => {
          const a = resolveAceSource(PROJECT_ROOT, from);
          if ("error" in a) return mcpError(a.error, { prefix: "diff-addon-aces:" });
          const b = resolveAceSource(PROJECT_ROOT, to);
          if ("error" in b) return mcpError(b.error, { prefix: "diff-addon-aces:" });
          return mcpContent(formatAceDiff(diffAddonAces(a.aces, b.aces), a.label, b.label));
        },
        { prefix: "diff-addon-aces:" },
      ),
    ),
);

reg(
  "scan-addon-usage",
  {
    title: "Scan Addon Usage",
    description:
      "Scan the project for usage of a plugin, behavior, or effect addon. For plugin/behavior addons: which object types/families are instantiated from the addon (presence), which conditions/actions on them call one of its current ACEs (call sites), and which event-sheet parameter expressions reference one of its expressions (Object.expr / Object.Behavior.expr), grouped by event sheet. For effect addons (which have no ACEs): every site the effect is applied — object types, families, layers, and layouts — since presence is the whole story. With `from` (a .c3addon file path, or a discovered addon id/dir for a prior version), also reports blast radius — for plugins/behaviors, call sites and expression references whose ACE was changed or removed between `from` and the addon's current ACEs (surfacing dangling references a reimport may not have migrated); for effects, every application site (a version bump can change any effect parameter). Read-only.",
    annotations: READ_ONLY,
    inputSchema: {
      addon: z
        .string()
        .describe("The addon to scan usage for: a discovered addon id, or a path to an addon source tree"),
      from: z
        .string()
        .optional()
        .describe(
          "Optional prior-version ACE source for blast-radius mode: a .c3addon file path, or a discovered addon id/dir",
        ),
    },
  },
  async ({ addon, from }) =>
    rwlock.read(
      withMcpErrors(async () => mcpContent(formatAddonUsage(scanAddonUsage(PROJECT_ROOT, addon, from)), txIdLine()), {
        prefix: "scan-addon-usage:",
        extraLines: () => [txIdLine()],
      }),
    ),
);

// Shared by both addon-metadata-sync tools below — `direction` is deliberately
// NOT .optional(): the MCP analogue of the CLI's demandOption. The SDK rejects
// a call missing it before either handler body runs (see T2).
const ADDON_METADATA_SYNC_DIRECTION_SCHEMA = z
  .enum(["manifest-from-package", "package-from-manifest"])
  .describe(
    "Sync direction: 'manifest-from-package' treats each .c3addon package's addon.json as source of " +
      "truth and reports/writes into project.c3proj's usedAddons; 'package-from-manifest' is the reverse " +
      "read-only report (chef has no .c3addon writer, so this direction never writes).",
  );

reg(
  "preview-addon-metadata-sync",
  {
    title: "Preview Addon Metadata Sync",
    description:
      "Dry-run report of version/author drift between bundled .c3addon packages and project.c3proj's " +
      "usedAddons manifest entries — the read-only preview for sync-addon-metadata. Never writes. With " +
      "`addon`, scope to a single addon by discovered id.",
    annotations: READ_ONLY,
    inputSchema: {
      direction: ADDON_METADATA_SYNC_DIRECTION_SCHEMA,
      addon: z.string().optional().describe("Scope to a single addon by discovered id. Omit to preview all."),
    },
  },
  async ({ direction, addon }) =>
    rwlock.read(
      withMcpErrors(
        async () => {
          const result = syncAddonMetadata(PROJECT_ROOT, { direction, addon, dryRun: true });
          if ("error" in result) {
            return mcpError(result.error, { prefix: "preview-addon-metadata-sync:", extraLines: [txIdLine()] });
          }
          return mcpContent(formatAddonMetadataSync(result), txIdLine());
        },
        { prefix: "preview-addon-metadata-sync:", extraLines: () => [txIdLine()] },
      ),
    ),
);

reg(
  "sync-addon-metadata",
  {
    title: "Sync Addon Metadata",
    description:
      "Sync project.c3proj's usedAddons version/author fields against bundled .c3addon packages. Only " +
      "'manifest-from-package' writes anything (chef has no .c3addon writer, so 'package-from-manifest' is " +
      "a read-only report identical to preview-addon-metadata-sync). With `addon`, scope to a single addon. " +
      "Pass txId from preview-addon-metadata-sync (or a prior call) for optimistic concurrency. Returns the " +
      "sync report and the current txId — bumped only when the manifest was actually written.",
    annotations: MUTATE,
    inputSchema: {
      direction: ADDON_METADATA_SYNC_DIRECTION_SCHEMA,
      addon: z.string().optional().describe("Scope to a single addon by discovered id. Omit to sync all."),
      txId: z.number().optional().describe("Expected txId — if stale, sync is rejected"),
    },
  },
  async ({ direction, addon, txId: expectedTxId }) =>
    rwlock.write(
      withMcpErrors(
        async () => {
          if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
            return mcpError(
              `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before syncing`,
              { extraLines: [txIdLine()] },
            );
          }

          let result: ReturnType<typeof syncAddonMetadata> | undefined;
          // Suppress watcher — project.c3proj IS a watched target (sourceWatcher.ts
          // SOURCE_DIRS/PROJECT_MANIFEST_FILE), so an unsuppressed write would
          // self-trigger onSourceChange. No watcher.expect() needed: the sole write
          // is to an already-existing, already-watched path entirely inside this
          // synchronous suppress window — same rule sync-project (above) follows,
          // and the same reasoning recorded at the workflow-tools comment below.
          await watcher.suppress(async () => {
            result = syncAddonMetadata(PROJECT_ROOT, { direction, addon, dryRun: false });
          });

          if (result === undefined || "error" in result) {
            const message = result === undefined ? "sync-addon-metadata produced no result" : result.error;
            return mcpError(message, { prefix: "sync-addon-metadata:", extraLines: [txIdLine()] });
          }

          // Bump ONLY if a write actually happened — a deliberate departure from
          // sync-project (which bumps unconditionally because it's always in write
          // mode). This tool has genuine no-write paths (a preview-shaped
          // package-from-manifest report, or a manifest-from-package apply with no
          // would-change rows); bumping on those would falsely invalidate every
          // client's txId. extractedDirty is untouched either way — project.c3proj
          // isn't a generator input (generateSidRegistry reads project.containers
          // only) and the watcher itself excludes it from onSourceChange.
          if (result.wrote) watcher.bump();

          return mcpContent(formatAddonMetadataSync(result), txIdLine());
        },
        { prefix: "sync-addon-metadata:", extraLines: () => [txIdLine()] },
      ),
    ),
);

// ── Search Docs Tool ─────────────────────────────────────────────────────────

reg(
  "search-docs",
  {
    title: "Search C3 Docs",
    description:
      "Look up C3 ACE (action/condition/expression) reference — parameter names/types, expression syntax, and condition/action ids — for the project's custom addons and (when a c3-reference cache is present) built-in plugins, layouts, scripting, and the Expression language. Filter by object/plugin name, ace id, param name, or free-text query. Custom-addon coverage is always available; built-in/manual coverage requires the gvt-construct3 build-reference skill to populate <extractedDir>/c3-reference/.",
    annotations: READ_ONLY,
    inputSchema: {
      query: z.string().optional().describe("Free-text search query"),
      object: z.string().optional().describe("Filter by object/plugin name (case-insensitive exact match for ACEs)"),
      id: z.string().optional().describe("Filter by ACE id (exact, case-insensitive)"),
      param: z.string().optional().describe("Filter by ACE param name (substring, case-insensitive)"),
      offset: z.number().int().min(0).optional().describe("Start line (1-based). Omit to start from beginning."),
      limit: z.number().int().min(1).optional().describe("Max lines to return. Omit to return all."),
    },
  },
  async ({ query, object, id, param, offset, limit }) =>
    rwlock.read(
      withMcpErrors(
        async () => {
          // No-filter guard
          const hasQuery = query !== undefined && query !== "";
          const hasObject = object !== undefined && object !== "";
          const hasId = id !== undefined && id !== "";
          const hasParam = param !== undefined && param !== "";
          if (!hasQuery && !hasObject && !hasId && !hasParam) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Provide at least one filter: query, object, id, or param.",
                },
              ],
            };
          }

          const { aces, chunks, cachePresent } = lookup(PROJECT_ROOT, EXTRACTED_DIR, {
            query: hasQuery ? query : undefined,
            object: hasObject ? object : undefined,
            id: hasId ? id : undefined,
            param: hasParam ? param : undefined,
          });

          emitLog(
            "info",
            `search-docs: object=${object ?? "-"}, id=${id ?? "-"}, param=${param ?? "-"}, query=${query ?? "-"}, aces=${aces.length}, chunks=${chunks.length}, cache=${cachePresent}`,
          );

          const text = formatLookupResult({ aces, chunks, cachePresent });

          return paginatedResponse(text, offset, limit, { stale: false });
        },
        { prefix: "search-docs:" },
      ),
    ),
);

// ── Scaffold Tools ──────────────────────────────────────────────────────

reg(
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
      txId: z.number().optional().describe("Expected txId — if stale, scaffold is rejected"),
      regenerate: z.boolean().optional().describe("Regenerate extracted/ files after scaffolding (default: true)"),
    },
  },
  async ({ source, name, path: outRelPath, eventSheet, txId: expectedTxId, regenerate }, extra: Extra) =>
    rwlock.write(
      withMcpErrors(
        async () => {
          const shouldRegenerate = regenerate !== false;
          const totalSteps = shouldRegenerate ? 8 : 2; // clone + sync + 6 generators
          const { log, text } = bufferingLogger();
          if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
            return mcpError(
              `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before scaffolding`,
              { extraLines: [txIdLine()] },
            );
          }

          const layoutsDir = PROJECT.layoutsDir;

          // Path traversal check — output must stay within layouts/
          const outFullPath = resolveWithin(layoutsDir, outRelPath);
          if (outFullPath === null) {
            return mcpError(`Invalid output path '${outRelPath}' — must stay within layouts/`, {
              extraLines: [txIdLine()],
            });
          }

          // Path traversal check — source must stay within layouts/
          const sourceFullPath = resolveWithin(layoutsDir, source);
          if (sourceFullPath === null) {
            return mcpError(`Invalid source path '${source}' — must stay within layouts/`, {
              extraLines: [txIdLine()],
            });
          }
          if (!fs.existsSync(sourceFullPath)) {
            return mcpError(`Source layout not found: layouts/${source}`, { extraLines: [txIdLine()] });
          }

          const sourceContent = fs.readFileSync(sourceFullPath, "utf-8");
          const sourceLayout = JSON.parse(sourceContent) as Record<string, unknown>;

          // Collect all existing UIDs and SIDs, then clone. Seeding existingSids from the
          // project registry prevents cloned SIDs from colliding with anything in eventSheets/,
          // layouts/, or objectTypes/.
          const existingUids = collectAllUids(layoutsDir);
          const sidRegistryPath = path.join(EXTRACTED_DIR, "sid-registry.txt");
          const existingSids = fs.existsSync(sidRegistryPath) ? readRegistryFile(sidRegistryPath) : new Set<number>();
          const cloned = cloneLayout(sourceLayout, { name, eventSheet, existingUids, existingSids });

          // Write output
          await watcher.suppress(async () => {
            // Ensure output directory exists
            const outDir = path.dirname(outFullPath);
            fs.mkdirSync(outDir, { recursive: true });
            writeSourceJson(outFullPath, cloned);
            watcher.expect(outFullPath);
            await sendProgress(extra, 0, totalSteps, "Cloning layout");
            log(`Scaffolded ${name} → layouts/${outRelPath}`);

            // Sync project.c3proj
            await sendProgress(extra, 1, totalSteps, "Syncing project.c3proj");
            runSync(PROJECT_ROOT, false, log);

            // Regenerate extracted/ files
            if (shouldRegenerate) {
              await runGenerators(log, extra, 2, totalSteps);
            }
          });

          watcher.bump();
          if (shouldRegenerate) {
            extractedDirty = false;
          }
          return mcpContent(text(), txIdLine());
        },
        {
          prefix: "Error:",
          onError: (e) => {
            if (e instanceof CancelledError) {
              // Layout was already written — source files changed, extracted/ is stale
              watcher.bump();
              extractedDirty = true;
            }
          },
          extraLines: () => [txIdLine()],
        },
      ),
    ),
);

reg(
  "scaffold-sprite",
  {
    title: "Scaffold Sprite",
    description:
      "Clone an existing objectType (sprite) to create a new one. Remaps all SIDs and imageSpriteIds for uniqueness, copies associated image files, writes the new objectType JSON, and syncs project.c3proj.",
    annotations: MUTATE,
    inputSchema: {
      source: z.string().describe("Source objectType name (e.g. 'StoryBookIcon')"),
      name: z.string().describe("Target objectType name (e.g. 'VideosIcon')"),
      txId: z.number().optional().describe("Expected txId — if stale, scaffold is rejected"),
    },
  },
  async ({ source, name: targetName, txId: expectedTxId }) =>
    rwlock.write(
      withMcpErrors(
        async () => {
          const { log, text } = bufferingLogger();
          if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
            return mcpError(
              `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before scaffolding`,
              { extraLines: [txIdLine()] },
            );
          }

          const objectTypesDir = PROJECT.objectTypesDir;
          const imagesDir = PROJECT.imagesDir;

          // Validate names don't contain path separators
          for (const [label, val] of [
            ["source", source],
            ["name", targetName],
          ] as const) {
            if (val.includes("/") || val.includes("\\") || val.includes("..")) {
              return mcpError(`Invalid ${label} '${val}' — must be a plain objectType name without path separators`, {
                extraLines: [txIdLine()],
              });
            }
          }

          // Read source objectType
          const sourceFile = path.join(objectTypesDir, `${source}.json`);
          if (!fs.existsSync(sourceFile)) {
            return mcpError(`Source objectType not found: objectTypes/${source}.json`, { extraLines: [txIdLine()] });
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
          await watcher.suppress(async () => {
            // Write objectType JSON
            const outFile = path.join(objectTypesDir, `${targetName}.json`);
            writeSourceJson(outFile, cloned);
            watcher.expect(outFile);
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
          });

          watcher.bump();
          return mcpContent(text(), txIdLine());
        },
        {
          prefix: "Error:",
          onError: (e) => {
            if (e instanceof CancelledError) {
              // Sprite was already written — source files changed, extracted/ may be stale
              watcher.bump();
              extractedDirty = true;
            }
          },
          extraLines: () => [txIdLine()],
        },
      ),
    ),
);

// ── Template Workflow Tools ─────────────────────────────────────────────────
//
// Each tool wraps one composite workflow op in a single-op recipe envelope and
// hands it to applyParsed. The recipe pipeline (expandWorkflows → primitive
// dispatch → SidGenerator threading) handles fan-out, SID allocation, and
// scene-graphs-folder-root registration — the MCP layer just owns the
// concurrency boilerplate (rwlock, the OptimisticWatcher, registry freshness).
//
// Mirrors the apply-recipe pattern. No watcher.expect() — wrapping the writes
// in watcher.suppress() is sufficient for the watcher contract (apply-recipe
// does the same).

async function runWorkflowRecipe(
  recipe: Recipe,
  expectedTxId: number | undefined,
  regenerate: boolean | undefined,
  extra: Extra,
): Promise<CallToolResult> {
  return withMcpErrors(
    async () => {
      checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
      const shouldRegenerate = regenerate !== false;
      const totalSteps = shouldRegenerate ? 7 : 1; // apply + 6 generators
      const { log, text } = bufferingLogger();
      if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
        return mcpError(`State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before applying`, {
          extraLines: [txIdLine()],
        });
      }
      await watcher.suppress(async () => {
        await sendProgress(extra, 0, totalSteps, "Applying workflow");
        applyParsed(PROJECT_ROOT, recipe, { regenerate: false, log });
        if (shouldRegenerate) {
          await runGenerators(log, extra, 1, totalSteps);
        }
      });
      watcher.bump();
      if (shouldRegenerate) {
        extractedDirty = false;
      }
      return mcpContent(text(), txIdLine());
    },
    {
      prefix: "Error:",
      onError: (e) => {
        if (e instanceof CancelledError) {
          watcher.bump();
          extractedDirty = true;
        }
      },
      extraLines: () => [txIdLine()],
    },
  )();
}

reg(
  "extract-template",
  {
    title: "Extract Template",
    description:
      "Extract an instance + scene-graph children from a source layout into a reusable master template on a templates layout, then convert the original into a replica of the new template. Three-step workflow: copy-instance + templatize on templatesLayout, replicify on sourceLayout — all sharing the recipe's safe SID generator.",
    annotations: MUTATE,
    inputSchema: {
      sourceLayout: z.string().describe("Source layout path (e.g. 'layouts/Shop/ShopLayout.json')"),
      sourceType: z.string().describe("C3 object type of the instance to extract"),
      templatesLayout: z
        .string()
        .describe("Layout that will hold the new master template (e.g. 'layouts/UI_ComponentsLayout.json')"),
      templateName: z.string().describe("Template name (globally unique across the project)"),
      templatesLayer: z.string().describe("Layer on templatesLayout for the new template root"),
      includeChildren: z.boolean().optional().describe("Copy scene graph children too. Default: true"),
      childrenLayer: z
        .string()
        .optional()
        .describe("Layer for children on templatesLayout (default: same as templatesLayer)"),
      inheritOverrides: z
        .record(z.boolean())
        .optional()
        .describe("Override inheritance flags forwarded to both templatize and replicify"),
      txId: z.number().optional().describe("Expected txId — if stale, apply is rejected"),
      regenerate: z.boolean().optional().describe("Regenerate extracted/ after apply (default: true)"),
    },
  },
  async (
    {
      sourceLayout,
      sourceType,
      templatesLayout,
      templateName,
      templatesLayer,
      includeChildren,
      childrenLayer,
      inheritOverrides,
      txId: expectedTxId,
      regenerate,
    },
    extra: Extra,
  ) =>
    rwlock.write(async () => {
      const recipe: Recipe = {
        layouts: {
          [templatesLayout]: [
            {
              op: "extract-template",
              sourceLayout,
              sourceType,
              templateName,
              templatesLayer,
              includeChildren,
              childrenLayer,
              inheritOverrides,
            },
          ],
        },
      };
      return runWorkflowRecipe(recipe, expectedTxId, regenerate, extra);
    }),
);

reg(
  "templatize-in-place",
  {
    title: "Templatize In Place",
    description:
      "Convert an existing instance into the master template on its current layout. Use this when you want C3 runtime code to spawn replicas via `create-object` with the template parameter. One-step workflow: a single templatize.",
    annotations: MUTATE,
    inputSchema: {
      layout: z.string().describe("Layout path containing the instance (e.g. 'layouts/Game.json')"),
      type: z.string().describe("C3 object type of the instance to convert"),
      templateName: z.string().describe("Template name (globally unique across the project)"),
      inheritOverrides: z.record(z.boolean()).optional().describe("Override inheritance flags"),
      txId: z.number().optional().describe("Expected txId — if stale, apply is rejected"),
      regenerate: z.boolean().optional().describe("Regenerate extracted/ after apply (default: true)"),
    },
  },
  async ({ layout, type, templateName, inheritOverrides, txId: expectedTxId, regenerate }, extra: Extra) =>
    rwlock.write(async () => {
      const recipe: Recipe = {
        layouts: {
          [layout]: [{ op: "templatize-in-place", type, templateName, inheritOverrides }],
        },
      };
      return runWorkflowRecipe(recipe, expectedTxId, regenerate, extra);
    }),
);

reg(
  "clone-replica-to-layouts",
  {
    title: "Clone Replica To Layouts",
    description:
      "Given an existing template defined on templatesLayout, add a replica of it to one or more target layouts in one call. Fans out into one add-replica per target.",
    annotations: MUTATE,
    inputSchema: {
      templatesLayout: z.string().describe("Layout path containing the master template definition"),
      templateName: z.string().describe("Template name to replicate"),
      sourceType: z
        .string()
        .describe(
          "C3 object type the template is built from (needed to locate the source instance on templatesLayout)",
        ),
      targets: z
        .array(
          z.object({
            layout: z.string().describe("Target layout path"),
            layer: z.string().describe("Layer on the target layout for the replica root"),
            childrenLayer: z.string().optional(),
            overrides: INSTANCE_OVERRIDES_SCHEMA.optional(),
            childOverrides: CHILD_OVERRIDES_SCHEMA.optional(),
            inheritOverrides: z.record(z.boolean()).optional(),
          }),
        )
        .min(1)
        .describe("One or more target layouts to add replicas to (distinct layout paths required)"),
      txId: z.number().optional().describe("Expected txId — if stale, apply is rejected"),
      regenerate: z.boolean().optional().describe("Regenerate extracted/ after apply (default: true)"),
    },
  },
  async ({ templatesLayout, templateName, sourceType, targets, txId: expectedTxId, regenerate }, extra: Extra) =>
    rwlock.write(async () => {
      const recipe: Recipe = {
        layouts: {
          [templatesLayout]: [
            {
              op: "clone-replica-to-layouts",
              templateName,
              sourceType,
              targets,
            },
          ],
        },
      };
      return runWorkflowRecipe(recipe, expectedTxId, regenerate, extra);
    }),
);

reg(
  "replace-instance-with-replica",
  {
    title: "Replace Instance With Replica",
    description:
      "Remove an existing instance on a layout and place a replica of a named template in its spot (same layer, same world props). Composes remove-instance + add-replica. instanceVariables and tags on the removed instance are NOT carried over — a replica is treated as a fresh instance of the template.",
    annotations: MUTATE,
    inputSchema: {
      layout: z.string().describe("Layout path containing the instance to replace"),
      type: z.string().describe("C3 object type of the instance to replace"),
      templatesLayout: z.string().describe("Layout path containing the template definition"),
      templateName: z.string().describe("Template name to replicate"),
      layer: z
        .string()
        .optional()
        .describe(
          "Restrict the replace to instances on this layer (throws if mismatched). When omitted, the instance's layer is auto-detected.",
        ),
      inheritOverrides: z.record(z.boolean()).optional().describe("Override inheritance flags"),
      txId: z.number().optional().describe("Expected txId — if stale, apply is rejected"),
      regenerate: z.boolean().optional().describe("Regenerate extracted/ after apply (default: true)"),
    },
  },
  async (
    { layout, type, templatesLayout, templateName, layer, inheritOverrides, txId: expectedTxId, regenerate },
    extra: Extra,
  ) =>
    rwlock.write(async () => {
      const recipe: Recipe = {
        layouts: {
          [layout]: [
            {
              op: "replace-instance-with-replica",
              type,
              templatesLayout,
              templateName,
              layer,
              inheritOverrides,
            },
          ],
        },
      };
      return runWorkflowRecipe(recipe, expectedTxId, regenerate, extra);
    }),
);

// ── Layer Mutation Tools ─────────────────────────────────────────────────────

reg(
  "remove-layer",
  {
    title: "Remove Layer",
    description:
      "Remove a layer from a layout. Strict by default (fails if the layer has instances or sublayers); cascade removes the whole sublayer subtree, removeInstances forces removal of instances.",
    annotations: MUTATE,
    inputSchema: {
      layout: z.string().describe("Relative path to the layout JSON within layouts/ (e.g. 'Main Layout.json')"),
      layer: z.string().describe("Name of the layer to remove"),
      cascade: z.boolean().optional().describe("Remove the entire sublayer subtree recursively (default: false)"),
      removeInstances: z
        .boolean()
        .optional()
        .describe("Force removal even when the layer has instances (default: false)"),
      txId: z.number().optional().describe("Expected txId — if stale, remove is rejected"),
      regenerate: z.boolean().optional().describe("Regenerate extracted/ files after removing (default: true)"),
    },
  },
  async ({ layout, layer, cascade, removeInstances, txId: expectedTxId, regenerate }, extra: Extra) =>
    rwlock.write(async () => {
      // Path traversal check — layout must stay within layouts/
      const layoutsDir = PROJECT.layoutsDir;
      const layoutFullPath = resolveWithin(layoutsDir, layout);
      if (layoutFullPath === null) {
        return mcpError(`Invalid layout path '${layout}' — must stay within layouts/`, { extraLines: [txIdLine()] });
      }

      const recipe: Recipe = {
        layouts: {
          [layout]: [
            {
              op: "remove-layer",
              layer,
              ...(cascade !== undefined ? { cascade } : {}),
              ...(removeInstances !== undefined ? { removeInstances } : {}),
            },
          ],
        },
      };
      return runWorkflowRecipe(recipe, expectedTxId, regenerate, extra);
    }),
);

// ── State Tool ───────────────────────────────────────────────────────────────

reg(
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
        content: [{ type: "text", text: `txId: ${watcher.txId}\nextractedDirty: ${extractedDirty}` }],
      };
    }),
);

// ── Test-only seam ─────────────────────────────────────────────────────────────
// Exposed for handler-level tests (test/mcp/serverHandlers.test.ts). server.ts is
// not on the src/index.ts barrel, so these stay internal. Do NOT import from production code.
export function __getHandler(name: string): ((args: any, extra: Extra) => Promise<unknown>) | undefined {
  return handlers.get(name);
}
export function __getToolConfig(name: string): Record<string, unknown> | undefined {
  return toolConfigs.get(name);
}
export function __setTestWatcher(w: OptimisticWatcher): void {
  watcher = w;
}
export function __setExtractedDirty(value: boolean): void {
  extractedDirty = value;
}
export function __getExtractedDirty(): boolean {
  return extractedDirty;
}
export function __getProjectRoot(): string {
  return PROJECT_ROOT;
}
export function __setProjectRoot(dir: string): void {
  PROJECT_ROOT = dir;
  EXTRACTED_DIR = path.join(dir, "extracted");
  PROJECT = openProject(dir);
}
export function __setExtractedDir(dir: string): void {
  EXTRACTED_DIR = dir;
}
export function __resetTestState(): void {
  extractedDirty = false;
  PROJECT_ROOT = process.cwd();
  EXTRACTED_DIR = path.join(PROJECT_ROOT, "extracted");
  PROJECT = openProject(PROJECT_ROOT);
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startServer(projectDir?: string, overrides?: Partial<ChefConfig>): Promise<void> {
  const resolved = resolveRootFolder({
    explicit: projectDir,
    envVar: "C3_PROJECT_DIR",
    marker: "project.c3proj",
    searchDepth: 1,
  });
  if (isMcpError(resolved)) {
    console.error(`[construct3-chef] Root resolution: ${mcpErrorText(resolved)} — falling back to cwd`);
    PROJECT_ROOT = process.cwd();
  } else {
    PROJECT_ROOT = resolved.path;
    if (resolved.source === "cwd") {
      console.error(
        `[construct3-chef] Warning: no project.c3proj found via --project-dir, $C3_PROJECT_DIR, or discovery — using cwd ${PROJECT_ROOT}`,
      );
    }
  }
  PROJECT = openProject(PROJECT_ROOT);
  console.error(
    `[construct3-chef] Root: ${PROJECT_ROOT} (source: ${isMcpError(resolved) ? "cwd-fallback" : resolved.source})`,
  );
  const config = await loadChefConfig(PROJECT_ROOT, overrides);
  EXTRACTED_DIR = path.join(PROJECT_ROOT, config.extractedDir);

  // Startup validation — warn but don't hard-fail
  const c3projPath = path.join(PROJECT_ROOT, "project.c3proj");
  if (!fs.existsSync(c3projPath)) {
    console.error(
      `[construct3-chef] Warning: project.c3proj not found in ${PROJECT_ROOT} — not a Construct 3 project directory`,
    );
  }
  if (!fs.existsSync(EXTRACTED_DIR)) {
    console.error(`[construct3-chef] extracted/ not found — auto-generating...`);
    try {
      const log: Logger = (...args) => console.error(`[construct3-chef]   ${args.map(String).join(" ")}`);
      await runGenerators(log);
      console.error(`[construct3-chef] Auto-generation complete`);
    } catch (e) {
      console.error(
        `[construct3-chef] Warning: auto-generation failed — ${e instanceof Error ? e.message : String(e)}`,
      );
      console.error(`[construct3-chef] Run 'npm run generate-c3' manually to generate extracted files`);
    }
  }
  console.error(`[construct3-chef] Starting server in ${PROJECT_ROOT}`);

  // Resolve ops dir from already-loaded config (avoids a double loadChefConfig call).
  const opsDir = resolveWithin(PROJECT_ROOT, config.ops.dir) ?? path.join(PROJECT_ROOT, "ops");

  setupWatchers();

  // Start the OpsRegistry BEFORE server.connect() so initial op-* tools are
  // present from the first tools/list response (no spurious list_changed before connect).
  const opsRegistry = new OpsRegistry({
    server,
    opsDir,
    watch: config.ops.watch,
    applyRecipe: (recipe, opts, extra) => applyRecipeWithConcurrency(recipe, opts, extra),
    log: emitLog,
  });
  opsRegistry.start();

  // Graceful shutdown
  function shutdown() {
    console.error("[construct3-chef] Shutting down...");
    opsRegistry.stop();
    server.close().catch(() => {});
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
