import * as path from "node:path";
import { ReadWriteLock, ExpectedChanges, type OptimisticWatcher, type Logger } from "@genvidtech/mcp-utils";
import { openProject, type C3Project } from "@genvidtech/c3source";
import { loadChefConfig, type ChefConfig } from "../c3/chefConfig.js";
import { GENERATORS } from "../c3/generators.js";
import type { OpsRegistry } from "./opsRegistry.js";

/**
 * Per-project MCP server state container (#95). Replaces the seven
 * module-level globals `server.ts` used to carry (`PROJECT_ROOT`,
 * `EXTRACTED_DIR`, `PROJECT`, `rwlock`, `extractedDirty`, `watcher`,
 * `expectedChanges`) with one object per registered project.
 *
 * `id`/`root`/`extractedDir`/`project`/`rwlock`/`expected`/`config` are
 * getter-only (no setters) — this is load-bearing, not stylistic. They are
 * derived together, once, from a single `root` argument, so there is no
 * "reassign root but forget project" hazard: an accidental assignment
 * throws `TypeError` at runtime (ESM modules are always strict), rather
 * than silently going stale the way the old module-level `let PROJECT_ROOT`
 * / `let PROJECT` pair could (see CLAUDE.md § "MCP server state model").
 *
 * `extractedDirty`, `watcher`, and `ops` are deliberately mutable:
 * `extractedDirty` flips as source/extracted drift in and out of sync, and
 * `watcher`/`ops` are wired up by the caller after construction (see below).
 */
export class ProjectContext {
  readonly #id: string;
  readonly #root: string;
  readonly #extractedDir: string;
  readonly #project: C3Project;
  readonly #rwlock: ReadWriteLock;
  readonly #expected: ExpectedChanges;
  readonly #config: ChefConfig;

  extractedDirty = false;
  // Assigned by the caller during startup wiring (setupWatchers-equivalent),
  // after the watcher's onSourceChange callback can close over this context.
  // Constructing the watcher inside createProjectContext would work too, but
  // its onSourceChange needs `this` (to flip extractedDirty) before `this`
  // exists — assigning it as a second step keeps that wiring in one place at
  // the call site instead of a self-referential trick inside the constructor.
  watcher!: OptimisticWatcher;
  // Assigned by the caller during startup wiring, for the same reason as
  // `watcher` — an OpsRegistry is built from this context's `id`/`config`.
  ops!: OpsRegistry;

  get id(): string {
    return this.#id;
  }

  get root(): string {
    return this.#root;
  }

  get extractedDir(): string {
    return this.#extractedDir;
  }

  get project(): C3Project {
    return this.#project;
  }

  get rwlock(): ReadWriteLock {
    return this.#rwlock;
  }

  get expected(): ExpectedChanges {
    return this.#expected;
  }

  get config(): ChefConfig {
    return this.#config;
  }

  /** Derived from the shared GENERATORS inventory, closing over `this` instead
   * of module-level mutable globals — replaces server.ts's `GENERATOR_STEPS`. */
  readonly generatorSteps: { name: string; fn: (log: Logger) => void }[] = GENERATORS.map((g) => ({
    name: g.label,
    fn: (log: Logger) => g.run(this.root, this.extractedDir, log),
  }));

  constructor(id: string, root: string, config: ChefConfig) {
    this.#id = id;
    this.#root = root;
    this.#extractedDir = path.join(root, config.extractedDir);
    this.#project = openProject(root);
    this.#rwlock = new ReadWriteLock();
    this.#expected = new ExpectedChanges();
    this.#config = config;
  }
}

/**
 * Compose a `ProjectContext` from a project id + root: loads chef config,
 * opens the C3 project handle, and constructs the read/write lock and
 * expected-changes registry. This is the ONLY place that composes a root
 * string with `openProject`, `loadChefConfig`, `ReadWriteLock`, and
 * `ExpectedChanges` — mirroring today's `startServer` wiring in
 * `src/mcp/server.ts`, minus the parts left for the caller (see below).
 *
 * Deliberately does NOT construct the `OptimisticWatcher` or `OpsRegistry` —
 * both need a reference to the finished `ProjectContext` (the watcher's
 * `onSourceChange` flips `ctx.extractedDirty`; `OpsRegistry` reads `ctx.id`/
 * `ctx.config`), so they're wired by the caller onto `ctx.watcher`/`ctx.ops`
 * after this returns, the same two-step shape `setupWatchers` uses today.
 */
export async function createProjectContext(
  id: string,
  root: string,
  overrides?: Partial<ChefConfig>,
): Promise<ProjectContext> {
  const config = await loadChefConfig(root, overrides);
  return new ProjectContext(id, root, config);
}
