import fs from "node:fs";
import type {
  CallToolResult,
  ServerRequest,
  ServerNotification,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { mcpError, MUTATE } from "@genvidtech/mcp-utils";
import type { Recipe } from "../c3/recipeInterpreter.js";
import { loadOpsFromDir, opToInputSchema, substituteOp, type LoadedOp, type OpLoadError } from "../c3/opTemplate.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Structural interface for a registered tool handle returned by registerTool.
 * The real SDK RegisteredTool satisfies this structurally (update is generic there
 * but a generic method is assignable to a stricter specific overload under TS's
 * method bivariance rules).
 */
export interface RegisterableTool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(updates: {
    name?: string | null;
    title?: string;
    description?: string;
    paramsSchema?: Record<string, z.ZodTypeAny>;
    annotations?: ToolAnnotations;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback?: (args: any, extra: any) => Promise<CallToolResult>;
    enabled?: boolean;
  }): void;
  remove(): void;
}

/**
 * Structural interface for what OpsRegistry needs from the MCP server.
 * The real McpServer satisfies this structurally — its registerTool signature is
 * a superset of this (extra generics, extra config keys), so assignment is sound.
 */
export interface RegisterableServer {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      annotations?: ToolAnnotations;
      inputSchema?: Record<string, z.ZodTypeAny>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, extra: any) => Promise<CallToolResult>,
  ): RegisterableTool;
}

export interface OpsRegistryDeps {
  server: RegisterableServer;
  /**
   * The owning project's id (`ProjectContext.id`, #95 F6). Every op tool this
   * registry registers is named `op-<projectId>_<opName>` — the `_` separator
   * (never `-`) is load-bearing: op names match `/^[a-z0-9][a-z0-9-]*$/i` and
   * project ids allow `-`, so `op-<id>-<name>` is genuinely ambiguous (project
   * `a` + op `b-c` and project `a-b` + op `c` both yield `op-a-b-c`). Neither
   * charset admits `_`, so it's collision-free. Verified against the real MCP
   * SDK (`tools/list`/`tools/call` both handle an underscore-bearing name) —
   * see ADR wiki/decisions/0034.
   */
  projectId: string;
  /** Absolute, containment-checked path to the ops directory. */
  opsDir: string;
  /** Whether to start an fs.watch on opsDir for hot-reload. */
  watch: boolean;
  applyRecipe: (
    recipe: Recipe,
    opts: { regenerate?: boolean; label?: string },
    extra: Extra,
  ) => Promise<CallToolResult>;
  log?: (level: "debug" | "info" | "warning" | "error", message: string) => void;
}

// ─── OpsRegistry ──────────────────────────────────────────────────────────────

/**
 * Manages dynamic MCP tools derived from user-defined op files in opsDir.
 *
 * SDK auto-notify finding: McpServer.registerTool(), RegisteredTool.update(), and
 * RegisteredTool.remove() all call sendToolListChanged() automatically, but only
 * when isConnected() returns true. Tool registrations before server.connect()
 * are silent (no spurious notifications before a client attaches).
 * After connect, all add/update/remove mutations auto-notify. OpsRegistry does NOT
 * call sendToolListChanged() manually — the SDK handles it.
 *
 * Call start() BEFORE server.connect() so initial op tools exist at connect time.
 */
export class OpsRegistry {
  private readonly server: RegisterableServer;
  private readonly projectId: string;
  private readonly opsDir: string;
  private readonly watch: boolean;
  private readonly applyRecipe: OpsRegistryDeps["applyRecipe"];
  private readonly log: NonNullable<OpsRegistryDeps["log"]>;

  private opTools = new Map<string, RegisterableTool>();
  private ops: LoadedOp[] = [];
  private errors: OpLoadError[] = [];
  private fsWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: OpsRegistryDeps) {
    this.server = deps.server;
    this.projectId = deps.projectId;
    this.opsDir = deps.opsDir;
    this.watch = deps.watch;
    this.applyRecipe = deps.applyRecipe;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Run the initial reconcile to register this project's op-* tools, then
   * start watching (if configured). `list-ops` is NOT registered here — it
   * moved to server.ts as a normal `regP` tool reading {@link getLoadedOps}
   * (#95 F6): a static per-context tool registration doesn't scale to N
   * registered projects (N contexts would each try to register the same
   * static "list-ops" name), so server.ts registers it once and resolves the
   * project via its usual `project` selector instead.
   *
   * Call BEFORE server.connect() so initial tools exist at connect time without
   * triggering spurious notifications (SDK only notifies when connected).
   */
  start(): void {
    this.reconcile();
    if (this.watch) {
      this.startWatching();
    }
  }

  /**
   * Current ops + load errors, for the `list-ops` tool (server.ts, #95 F6).
   * Returns the live arrays directly; callers must not mutate them —
   * `reconcile()` replaces both wholesale on the next call, never mutates in
   * place.
   */
  getLoadedOps(): { ops: LoadedOp[]; errors: OpLoadError[] } {
    return { ops: this.ops, errors: this.errors };
  }

  /**
   * Re-load ops from opsDir and sync registered tools accordingly.
   * Public so tests can drive reconciles deterministically without fs.watch timing.
   */
  reconcile(): void {
    try {
      const { ops, errors } = loadOpsFromDir(this.opsDir);
      this.ops = ops;
      this.errors = errors;

      const newNames = new Set(ops.map((op) => op.name));
      const oldNames = new Set(this.opTools.keys());

      // Remove tools for ops that are gone
      for (const name of oldNames) {
        if (!newNames.has(name)) {
          this.opTools.get(name)!.remove();
          this.opTools.delete(name);
          this.log("info", `[ops] removed tool op-${this.projectId}_${name}`);
        }
      }

      // Add or update tools
      for (const op of ops) {
        if (oldNames.has(op.name)) {
          // Update existing tool (description or params may have changed)
          this.opTools.get(op.name)!.update({
            description: op.def.description,
            paramsSchema: opToInputSchema(op.def),
            callback: this.makeOpHandler(op),
          });
          this.log("debug", `[ops] updated tool op-${this.projectId}_${op.name}`);
        } else {
          // New op — register and track
          const tool = this.registerOp(op);
          this.opTools.set(op.name, tool);
          this.log("info", `[ops] registered tool op-${this.projectId}_${op.name}`);
        }
      }

      if (errors.length > 0) {
        for (const err of errors) {
          this.log("warning", `[ops] load error in ${err.file}: ${err.message}`);
        }
      }
    } catch (e) {
      this.log("error", `[ops] reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Close the fs watcher and cancel any pending debounce timer.
   * Safe to call multiple times.
   */
  stop(): void {
    if (this.fsWatcher !== null) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignore close errors
      }
      this.fsWatcher = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private makeOpHandler(op: LoadedOp): (args: Record<string, unknown>, extra: Extra) => Promise<CallToolResult> {
    return async (args, extra) => {
      let recipe: Recipe;
      try {
        recipe = substituteOp(op.def, args);
      } catch (e) {
        return mcpError(e, { prefix: "Error:" });
      }
      return this.applyRecipe(recipe, { regenerate: true, label: `Applying op ${op.name}` }, extra);
    };
  }

  private registerOp(op: LoadedOp): RegisterableTool {
    return this.server.registerTool(
      `op-${this.projectId}_${op.name}`,
      {
        title: `Op: ${op.name}`,
        description: op.def.description,
        annotations: MUTATE,
        inputSchema: opToInputSchema(op.def),
      },
      this.makeOpHandler(op),
    );
  }

  /**
   * Start watching opsDir for file changes. Hot-reload requires opsDir to exist at startup.
   * If the directory doesn't exist yet, watching is skipped (create it to enable hot-reload).
   */
  private startWatching(): void {
    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(this.opsDir);
      } catch {
        this.log(
          "info",
          `[ops] opsDir "${this.opsDir}" does not exist at startup — hot-reload disabled (create the directory to enable it)`,
        );
        return;
      }
      if (!stat.isDirectory()) {
        this.log("info", `[ops] opsDir "${this.opsDir}" is not a directory — hot-reload disabled`);
        return;
      }
      this.fsWatcher = fs.watch(this.opsDir, { persistent: false }, () => {
        this.scheduleReconcile();
      });
      this.fsWatcher.unref();
      this.log("info", `[ops] watching "${this.opsDir}" for op file changes`);
    } catch (e) {
      this.log(
        "warning",
        `[ops] failed to start watcher on "${this.opsDir}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Debounced reconcile — coalesces rapid file-system events (e.g. editor save sequences). */
  private scheduleReconcile(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    const timer = setTimeout(() => {
      this.debounceTimer = null;
      this.reconcile();
    }, 150);
    // unref so the timer doesn't keep the process alive between tests
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
    this.debounceTimer = timer;
  }
}
