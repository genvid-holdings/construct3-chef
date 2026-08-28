import * as path from "node:path";
import { resolveRootFolder, isMcpError } from "@genvidtech/mcp-utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProjectRegistry, deriveProjectId, splitSpec } from "./projectRegistry.js";
import { createProjectContext, type ProjectContext } from "./projectContext.js";
import type { ChefConfig } from "../c3/chefConfig.js";

/**
 * Launch-time root resolution for the MCP server (#95): turns the
 * `--project-dir [<id>=]<path>` / `C3_PROJECT_DIRS` launch surface into the
 * ordered `{id, root}` pairs `startServer` registers. Split out of
 * `server.ts` so the precedence logic is unit-testable without booting the
 * MCP transport (`startServer` itself can't be called from a test — its
 * `StdioServerTransport.connect()` blocks the test process; see
 * `test/mcp/rootResolution.test.ts`'s own note on this).
 */

export type LaunchLogger = (message: string) => void;

/** Extract the error message text from a CallToolResult returned by
 *  `resolveRootFolder`. A separate copy from server.ts's own `mcpErrorText` —
 *  this module is deliberately import-light (no server.ts dependency) so it
 *  stays testable in isolation. */
function mcpErrorText(r: CallToolResult): string {
  const block = r.content[0];
  return block && block.type === "text" ? (block as { type: "text"; text: string }).text : String(r);
}

/**
 * Resolve the ordered list of `--project-dir` specs this launch should use,
 * per the precedence chain: repeated `--project-dir` CLI flags >
 * `C3_PROJECT_DIRS` (`path.delimiter`-separated list of the same
 * `[<id>=]<path>` spec form). An empty result is a deliberate signal, not an
 * omission — it tells {@link resolveLaunchRoots} to fall through to the
 * untouched `C3_PROJECT_DIR` / discovery / cwd path via `resolveRootFolder`,
 * exactly as `startServer` resolved a root before #95.
 */
export function resolveLaunchSpecs(
  cliProjectDirs: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (cliProjectDirs && cliProjectDirs.length > 0) return [...cliProjectDirs];
  const envList = env.C3_PROJECT_DIRS;
  if (!envList) return [];
  return envList
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ResolvedRoot {
  id: string;
  root: string;
}

/**
 * Resolve `specs` (the output of {@link resolveLaunchSpecs}) into one
 * `{id, root}` pair per project to register, logging the same startup lines
 * `startServer` always printed via `log` (defaults to `console.error`).
 *
 * - **0 or 1 spec** routes through the SAME `resolveRootFolder` call
 *   `startServer` made pre-#95 (`explicit`/`envVar: "C3_PROJECT_DIR"`/
 *   discovery/cwd), preserving today's single-root behaviour byte-for-byte —
 *   including the cwd-fallback stderr warning — because that's the only path
 *   an operator using the pre-#95 launch surface (a bare `--project-dir` or
 *   nothing at all) can reach. A single explicit spec still resolves via
 *   `explicit` (which always wins — see `rootResolution.test.ts`'s R2), so
 *   this is not merely "close to" the old behaviour, it IS the old call.
 * - **2+ specs** means every root is explicit, so there is nothing left to
 *   discover: each spec is resolved directly (id derivation/dedup exactly as
 *   {@link deriveProjectId} defines it — including its stderr dedup warning),
 *   with no `resolveRootFolder` call at all.
 */
export function resolveLaunchRoots(specs: readonly string[], log: LaunchLogger = console.error): ResolvedRoot[] {
  if (specs.length >= 2) {
    const usedIds = new Set<string>();
    return specs.map((spec) => {
      const id = deriveProjectId(spec, usedIds);
      usedIds.add(id);
      const root = path.resolve(splitSpec(spec).root);
      log(`[construct3-chef] Root: ${root} (source: --project-dir, id: ${id})`);
      return { id, root };
    });
  }

  const explicitSpec = specs[0];
  const explicitPath = explicitSpec !== undefined ? splitSpec(explicitSpec).root : undefined;
  const resolved = resolveRootFolder({
    explicit: explicitPath,
    envVar: "C3_PROJECT_DIR",
    marker: "project.c3proj",
    searchDepth: 1,
  });
  let root: string;
  if (isMcpError(resolved)) {
    log(`[construct3-chef] Root resolution: ${mcpErrorText(resolved)} — falling back to cwd`);
    root = process.cwd();
  } else {
    root = resolved.path;
    if (resolved.source === "cwd") {
      log(
        `[construct3-chef] Warning: no project.c3proj found via --project-dir, $C3_PROJECT_DIR, or discovery — using cwd ${root}`,
      );
    }
  }
  log(`[construct3-chef] Root: ${root} (source: ${isMcpError(resolved) ? "cwd-fallback" : resolved.source})`);
  const id = explicitSpec !== undefined ? deriveProjectId(explicitSpec) : deriveProjectId(root);
  return [{ id, root }];
}

/** Constructs a {@link ProjectContext} for one registered project. Matches
 *  {@link createProjectContext}'s signature — injectable so tests can build a
 *  registry without opening a real `C3Project`/loading real chef config for
 *  every root (see `launchConfig.test.ts`'s two-root/default-project cases,
 *  which use a lightweight duck-typed fake in the same spirit as
 *  `projectRegistry.test.ts`'s T-B4 `fakeCtx`). */
export type ProjectContextFactory = (
  id: string,
  root: string,
  overrides?: Partial<ChefConfig>,
) => Promise<ProjectContext>;

/**
 * Build the launch-fixed {@link ProjectRegistry} for one server run: resolve
 * the launch surface (`projectDirs` from the CLI, `C3_PROJECT_DIRS`/
 * `C3_PROJECT_DIR` from the environment) via {@link resolveLaunchSpecs} +
 * {@link resolveLaunchRoots}, construct one {@link ProjectContext} per
 * resolved root via `factory` (defaults to the real
 * {@link createProjectContext}), and apply an optional `--default-project`
 * override — which defaults to the FIRST spec, matching
 * {@link ProjectRegistry.add}'s "first-registered wins" default.
 */
export async function buildProjectRegistry(
  projectDirs: readonly string[] | undefined,
  overrides?: Partial<ChefConfig>,
  defaultProject?: string,
  opts?: { log?: LaunchLogger; env?: NodeJS.ProcessEnv; factory?: ProjectContextFactory },
): Promise<ProjectRegistry> {
  const specs = resolveLaunchSpecs(projectDirs, opts?.env);
  const roots = resolveLaunchRoots(specs, opts?.log);
  const factory = opts?.factory ?? createProjectContext;

  const registry = new ProjectRegistry();
  for (const { id, root } of roots) {
    registry.add(await factory(id, root, overrides));
  }
  if (defaultProject !== undefined) {
    registry.defaultId = defaultProject;
  }
  return registry;
}
