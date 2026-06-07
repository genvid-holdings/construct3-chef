import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReadWriteLock,
  ExpectedChanges,
  OptimisticWatcher,
  paginateText,
  exposeDocs,
  bufferingLogger,
  resolveWithin,
  walkFiles,
  toPosixPath,
  READ_ONLY,
  REGENERATE,
  MUTATE,
  NON_IDEMPOTENT_READ,
} from "@genvid/mcp-utils";
import type { Logger } from "@genvid/mcp-utils";
import { applyParsed } from "../c3/recipeApplier.js";
import { validateRecipe, type Recipe } from "../c3/recipeInterpreter.js";
import {
  extractScripts,
  generateDSL,
  generateLayoutSummaries,
  generateTemplateScope,
  generateSidRegistry,
  generateGlobalLayers,
  findJsonFiles,
  SID_SOURCE_DIRS,
} from "../c3/generators.js";
import { runSync, reportImageDrift } from "../c3/projectSync.js";
import { readRegistryFile, mintUniqueSid } from "../c3/sidUtils.js";
import { filterIndex, buildShallowSidMap, type SidMapEntry } from "../c3/dslFormatter.js";
import type { EventSheet } from "@genvid/c3source";
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

let extractedDirty = false;
// The OptimisticWatcher owns txId, the suppress window, and the file watchers.
// Assigned in setupWatchers() (called from startServer) before any tool runs.
let watcher!: OptimisticWatcher;
const expectedChanges = new ExpectedChanges();

// Tool annotation presets (READ_ONLY / REGENERATE / MUTATE / NON_IDEMPOTENT_READ)
// are imported from @genvid/mcp-utils. NON_IDEMPOTENT_READ marks tools that read
// source only but return different output per call (e.g. random-SID minting) —
// clients must NOT treat them as idempotent for retry/cache purposes.

// ── Helpers ──────────────────────────────────────────────────────────────────

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ── Handler registry (also enables direct handler invocation in tests) ─────────
const handlers = new Map<string, (args: any, extra: Extra) => Promise<unknown>>();
function reg<
  OutputArgs extends Record<string, import("zod").ZodTypeAny>,
  InputArgs extends undefined | Record<string, import("zod").ZodTypeAny> = undefined,
>(...args: Parameters<typeof server.registerTool<OutputArgs, InputArgs>>): void {
  handlers.set(args[0] as string, args[2] as (a: any, e: Extra) => Promise<unknown>);
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

const GENERATOR_STEPS = [
  { name: "Extracting scripts", fn: (log: Logger) => extractScripts(PROJECT_ROOT, EXTRACTED_DIR, log) },
  { name: "Generating DSL", fn: (log: Logger) => generateDSL(PROJECT_ROOT, EXTRACTED_DIR, log) },
  {
    name: "Generating layout summaries",
    fn: (log: Logger) => generateLayoutSummaries(PROJECT_ROOT, EXTRACTED_DIR, log),
  },
  { name: "Generating template scope", fn: (log: Logger) => generateTemplateScope(PROJECT_ROOT, EXTRACTED_DIR, log) },
  {
    name: "Generating SID registry",
    // generateSidRegistry re-joins projectRoot internally, so it needs the
    // *relative* dir (as cli.ts passes). Handing it the absolute EXTRACTED_DIR
    // doubles the path — silently wrong on POSIX, an ENOENT crash on Windows.
    fn: (log: Logger) => generateSidRegistry(PROJECT_ROOT, path.relative(PROJECT_ROOT, EXTRACTED_DIR), log),
  },
  { name: "Generating global layers", fn: (log: Logger) => generateGlobalLayers(PROJECT_ROOT, EXTRACTED_DIR, log) },
] as const;

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

function notFound(tool: string, hint: string): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text", text: `${tool}: ${hint}` }],
    isError: true,
  };
}

function errorWithTxId(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [
      { type: "text", text: message },
      { type: "text", text: `txId: ${watcher.txId}` },
    ],
    isError: true,
  };
}

function caughtError(e: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  return errorWithTxId(`Error: ${e instanceof Error ? e.message : String(e)}`);
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
): { content: { type: "text"; text: string }[] } {
  const paginated = paginateText(text, { offset, limit });
  const content: { type: "text"; text: string }[] = [{ type: "text", text: appendStaleWarning(paginated.text) }];
  if (offset !== undefined || limit !== undefined) {
    const returnedLines = paginated.text === "" ? 0 : paginated.text.split("\n").length;
    const endLine = paginated.offset + Math.max(0, returnedLines - 1);
    content.push({ type: "text", text: `lines: ${paginated.offset}-${endLine} / ${paginated.totalLines}` });
  }
  return { content };
}

function globRelative(dir: string, ext: string): string[] {
  return walkFiles(dir, ext)
    .map((full) => toPosixPath(path.relative(dir, full)))
    .sort();
}

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
      "List all C3 event sheet JSON files in the project. Returns relative paths from the eventSheets/ root.",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(async () => {
      const sheets = globRelative(path.join(PROJECT_ROOT, "eventSheets"), ".json");
      return { content: [{ type: "text", text: sheets.join("\n") }] };
    }),
);

reg(
  "list-layouts",
  {
    title: "List Layouts",
    description: "List all C3 layout JSON files in the project. Returns relative paths from the layouts/ root.",
    annotations: READ_ONLY,
    inputSchema: {},
  },
  async () =>
    rwlock.read(async () => {
      const layouts = globRelative(path.join(PROJECT_ROOT, "layouts"), ".json");
      return { content: [{ type: "text", text: layouts.join("\n") }] };
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
        return notFound("list-global-layers", "global-layers.txt not found. Run 'regenerate' to generate it.");
      }
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
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.txt`),
      );
      const text = readExtracted(`eventSheets/${sheet}.dsl.txt`);
      if (text === null) {
        return notFound("read-dsl", `No DSL file found for '${sheet}'. Use list-event-sheets to see available sheets.`);
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
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.idx.txt`),
      );
      let text = readExtracted(`eventSheets/${sheet}.dsl.idx.txt`);
      if (text === null) {
        return notFound(
          "read-dsl-index",
          `No DSL index file found for '${sheet}'. Use list-event-sheets to see available sheets.`,
        );
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
      const sourcePath = path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`);
      if (!fs.existsSync(sourcePath)) {
        return notFound(
          "read-event-sids",
          `No event sheet found for '${sheet}'. Use list-event-sheets to see available sheets.`,
        );
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
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.ts`),
      );
      const text = readExtracted(`eventSheets/${sheet}.ts`);
      if (text === null) {
        return notFound(
          "read-scripts",
          `No extracted TypeScript found for '${sheet}'. Use list-event-sheets to see available sheets.`,
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
        path.join(PROJECT_ROOT, "layouts", `${layout}.json`),
        path.join(EXTRACTED_DIR, "layouts", `${layout}.layout.txt`),
      );
      const text = readExtracted(`layouts/${layout}.layout.txt`);
      if (text === null) {
        return notFound(
          "read-layout",
          `No layout summary found for '${layout}'. Use list-layouts to see available layouts.`,
        );
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
        return notFound(
          "read-template-scope",
          "template-scope.txt not found. Run 'npm run generate-c3' to generate it.",
        );
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
        return notFound("read-sid-registry", "sid-registry.txt not found. Run 'npm run generate-c3' to generate it.");
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
    }),
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

        emitLog(
          "info",
          `search: type=${type ?? "dsl"}, path=${searchPath ?? "(all)"}, matches=${result.lines.length}${result.truncated ? " (truncated)" : ""}`,
        );

        return { content: [{ type: "text", text }] };
      } catch (e) {
        return notFound("search", e instanceof Error ? e.message : String(e));
      }
    }),
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
        path.join(PROJECT_ROOT, "eventSheets", `${sheet}.json`),
        path.join(EXTRACTED_DIR, "eventSheets", `${sheet}.dsl.idx.txt`),
      );
      const text = readExtracted(`eventSheets/${sheet}.dsl.idx.txt`);
      if (text === null) {
        return notFound(
          "resolve-anchor",
          `No DSL index file found for '${sheet}'. Use list-event-sheets to see available sheets.`,
        );
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
    rwlock.read(async () => {
      // Refresh extractedDirty so the returned txId reflects any external edits
      // the file watcher may have missed (atomic-rename, git checkout, network mounts).
      // This matters: apply-recipe's optimistic-concurrency check uses our returned txId.
      checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
      const { log, text } = bufferingLogger();
      try {
        const recipe: Recipe = JSON.parse(recipeJson);
        const errors = validateRecipe(recipe);
        if (errors.length > 0) {
          return errorWithTxId(`Validation errors:\n${errors.join("\n")}`);
        }
        applyParsed(PROJECT_ROOT, recipe, { dryRun: true, log });
        return {
          content: [
            { type: "text", text: text() },
            { type: "text", text: `txId: ${watcher.txId}` },
          ],
        };
      } catch (e) {
        return caughtError(e);
      }
    }),
);

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
  async ({ recipe: recipeJson, txId: expectedTxId, regenerate }, extra: Extra) =>
    rwlock.write(async () => {
      // Refresh extractedDirty before the txId check — catches external edits the
      // file watcher may have missed, so a stale registry doesn't seed `mintUniqueSid`
      // with SIDs that already exist on disk.
      checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
      const shouldRegenerate = regenerate !== false;
      const totalSteps = shouldRegenerate ? 7 : 1; // apply + 6 generators
      const { log, text } = bufferingLogger();
      try {
        if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
          return errorWithTxId(
            `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before applying`,
          );
        }
        const recipe: Recipe = JSON.parse(recipeJson);
        // Suppress watcher during writes — we manage txId/extractedDirty ourselves
        await watcher.suppress(async () => {
          await sendProgress(extra, 0, totalSteps, "Applying recipe");
          applyParsed(PROJECT_ROOT, recipe, { regenerate: false, log });
          if (shouldRegenerate) {
            await runGenerators(log, extra, 1, totalSteps);
          }
        });
        watcher.bump();
        if (shouldRegenerate) {
          extractedDirty = false;
        }
        return {
          content: [
            { type: "text", text: text() },
            { type: "text", text: `txId: ${watcher.txId}` },
          ],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Recipe already applied (source files modified) but regeneration interrupted
          watcher.bump();
          extractedDirty = true;
        }
        return caughtError(e);
      }
    }),
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
    rwlock.write(async () => {
      const { log, text } = bufferingLogger();
      try {
        // Suppress watcher — regenerate writes only to extracted/ (derived output)
        await watcher.suppress(async () => {
          await runGenerators(log, extra);
        });
        extractedDirty = false;
        return {
          content: [{ type: "text", text: text() }],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Partially regenerated — stale. No watcher.bump() (regenerate doesn't modify source files)
          extractedDirty = true;
        }
        return {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }),
);

// ── Project Tools ────────────────────────────────────────────────────────────

reg(
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
      const { log, text } = bufferingLogger();
      try {
        runSync(PROJECT_ROOT, true, log);
        reportImageDrift(PROJECT_ROOT, log);
        return {
          content: [
            { type: "text", text: text() },
            { type: "text", text: `txId: ${watcher.txId}` },
          ],
        };
      } catch (e) {
        return caughtError(e);
      }
    }),
);

reg(
  "sync-project",
  {
    title: "Sync project.c3proj",
    description:
      "Sync project.c3proj to match files on disk. Adds missing entries and removes stale ones. Pass txId for optimistic concurrency. Returns output and new txId.",
    annotations: MUTATE,
    inputSchema: {
      txId: z.number().optional().describe("Expected txId — if stale, sync is rejected"),
    },
  },
  async ({ txId: expectedTxId }) =>
    rwlock.write(async () => {
      const { log, text } = bufferingLogger();
      try {
        if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
          return errorWithTxId(
            `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before syncing`,
          );
        }
        // Suppress watcher — we manage txId ourselves
        await watcher.suppress(async () => {
          runSync(PROJECT_ROOT, false, log);
        });
        watcher.bump();
        return {
          content: [
            { type: "text", text: text() },
            { type: "text", text: `txId: ${watcher.txId}` },
          ],
        };
      } catch (e) {
        return caughtError(e);
      }
    }),
);

// ── Addon Tool ──────────────────────────────────────────────────────────────

const ADDON_DIRS = ["addons/plugin", "addons/effect"] as const;

reg(
  "read-addon",
  {
    title: "Read Addon",
    description:
      "Read a C3 addon's extracted files (default: aces.json). Without a name, lists all available addons from addons/plugin/ and addons/effect/ with their extraction status.",
    annotations: READ_ONLY,
    inputSchema: {
      name: z.string().optional().describe("Addon name (e.g. 'CV_Clock'). Omit to list all available addons."),
      file: z.string().optional().describe("File to read within the extracted addon folder (default: 'aces.json')"),
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
          `Addon '${name}' not installed locally — extract from addons/plugin/${name}.c3addon or addons/effect/${name}.c3addon first`,
        );
      }

      const targetFile = file ?? "aces.json";

      // Path traversal check — reject paths that escape the addon directory
      const filePath = resolveWithin(addonPath, targetFile);
      if (filePath === null) {
        return notFound("read-addon", `Invalid file path '${targetFile}' — must stay within addon directory`);
      }

      if (!fs.existsSync(filePath)) {
        return notFound("read-addon", `File '${targetFile}' not found in addon '${name}'`);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }),
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
    rwlock.write(async () => {
      const shouldRegenerate = regenerate !== false;
      const totalSteps = shouldRegenerate ? 8 : 2; // clone + sync + 6 generators
      const { log, text } = bufferingLogger();
      try {
        if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
          return errorWithTxId(
            `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before scaffolding`,
          );
        }

        const layoutsDir = path.join(PROJECT_ROOT, "layouts");

        // Path traversal check — output must stay within layouts/
        const outFullPath = resolveWithin(layoutsDir, outRelPath);
        if (outFullPath === null) {
          return errorWithTxId(`Invalid output path '${outRelPath}' — must stay within layouts/`);
        }

        // Path traversal check — source must stay within layouts/
        const sourceFullPath = resolveWithin(layoutsDir, source);
        if (sourceFullPath === null) {
          return errorWithTxId(`Invalid source path '${source}' — must stay within layouts/`);
        }
        if (!fs.existsSync(sourceFullPath)) {
          return errorWithTxId(`Source layout not found: layouts/${source}`);
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
          fs.writeFileSync(outFullPath, JSON.stringify(cloned, null, "\t") + "\n");
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
        return {
          content: [
            { type: "text", text: text() },
            { type: "text", text: `txId: ${watcher.txId}` },
          ],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Layout was already written — source files changed, extracted/ is stale
          watcher.bump();
          extractedDirty = true;
        }
        return caughtError(e);
      }
    }),
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
    rwlock.write(async () => {
      const { log, text } = bufferingLogger();
      try {
        if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
          return errorWithTxId(
            `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before scaffolding`,
          );
        }

        const objectTypesDir = path.join(PROJECT_ROOT, "objectTypes");
        const imagesDir = path.join(PROJECT_ROOT, "images");

        // Validate names don't contain path separators
        for (const [label, val] of [
          ["source", source],
          ["name", targetName],
        ] as const) {
          if (val.includes("/") || val.includes("\\") || val.includes("..")) {
            return errorWithTxId(`Invalid ${label} '${val}' — must be a plain objectType name without path separators`);
          }
        }

        // Read source objectType
        const sourceFile = path.join(objectTypesDir, `${source}.json`);
        if (!fs.existsSync(sourceFile)) {
          return errorWithTxId(`Source objectType not found: objectTypes/${source}.json`);
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
          fs.writeFileSync(outFile, JSON.stringify(cloned, null, "\t") + "\n");
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
        return {
          content: [
            { type: "text", text: text() },
            { type: "text", text: `txId: ${watcher.txId}` },
          ],
        };
      } catch (e) {
        if (e instanceof CancelledError) {
          // Sprite was already written — source files changed, extracted/ may be stale
          watcher.bump();
          extractedDirty = true;
        }
        return caughtError(e);
      }
    }),
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
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  checkRegistryFreshness(path.join(EXTRACTED_DIR, "sid-registry.txt"));
  const shouldRegenerate = regenerate !== false;
  const totalSteps = shouldRegenerate ? 7 : 1; // apply + 6 generators
  const { log, text } = bufferingLogger();
  try {
    if (expectedTxId !== undefined && expectedTxId !== watcher.txId) {
      return errorWithTxId(
        `State changed (expected ${expectedTxId}, got ${watcher.txId}) — re-validate before applying`,
      );
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
    return {
      content: [
        { type: "text", text: text() },
        { type: "text", text: `txId: ${watcher.txId}` },
      ],
    };
  } catch (e) {
    if (e instanceof CancelledError) {
      watcher.bump();
      extractedDirty = true;
    }
    return caughtError(e);
  }
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
      const layoutsDir = path.join(PROJECT_ROOT, "layouts");
      const layoutFullPath = resolveWithin(layoutsDir, layout);
      if (layoutFullPath === null) {
        return errorWithTxId(`Invalid layout path '${layout}' — must stay within layouts/`);
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
export function __setTestWatcher(w: OptimisticWatcher): void {
  watcher = w;
}
export function __setExtractedDirty(value: boolean): void {
  extractedDirty = value;
}
export function __getExtractedDirty(): boolean {
  return extractedDirty;
}
export function __setProjectRoot(dir: string): void {
  PROJECT_ROOT = dir;
  EXTRACTED_DIR = path.join(dir, "extracted");
}
export function __resetTestState(): void {
  extractedDirty = false;
  PROJECT_ROOT = process.cwd();
  EXTRACTED_DIR = path.join(PROJECT_ROOT, "extracted");
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startServer(projectDir?: string, overrides?: Partial<ChefConfig>): Promise<void> {
  if (projectDir) {
    PROJECT_ROOT = projectDir;
  }
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
