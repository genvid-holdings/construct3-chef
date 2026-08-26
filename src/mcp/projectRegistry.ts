import { mcpError } from "@genvidtech/mcp-utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectContext } from "./projectContext.js";

/**
 * Launch-fixed registry of {@link ProjectContext}s, keyed by project id (#95).
 *
 * Deliberately imports neither `node:path`, `node:fs`, nor `@genvidtech/c3source`
 * — {@link ProjectRegistry.resolve} is the entire security answer for
 * multi-project support: today's `--project-dir`/`C3_PROJECT_DIR` are NOT
 * path-contained because an OPERATOR sets the root at server launch (see ADR
 * `wiki/decisions/0007-mcp-server-root-resolution-and-c3project-adoption.md`),
 * but a tool `project` parameter is set by the MODEL. Selecting a project by
 * an arbitrary caller-supplied path at call time would invert that posture —
 * so `resolve()` is a pure `Map` lookup against the set of ids fixed at
 * launch, never a filesystem operation and never a call into
 * `openProject`/`C3Project`. The absence of those imports is a structural
 * guarantee of that, not just a style choice — see `projectRegistry.test.ts`'s
 * T-B4 for how this is asserted both behaviorally and on the import list.
 */
export class ProjectRegistry {
  readonly #contexts = new Map<string, ProjectContext>();
  #defaultId: string | undefined;

  /**
   * Register a context. Throws on a duplicate id, and throws if `ctx.id`
   * contains `:` — ids feed the composite `<projectId>:<counter>` txId wire
   * format, so a colon in an id would make that token ambiguous to parse.
   * The first context registered becomes the default (see {@link defaultId}).
   */
  add(ctx: ProjectContext): void {
    if (ctx.id.includes(":")) {
      throw new Error(
        `Invalid project id '${ctx.id}': project ids may not contain ':' (reserved for the '<projectId>:<counter>' txId wire format).`,
      );
    }
    if (this.#contexts.has(ctx.id)) {
      throw new Error(`Duplicate project id '${ctx.id}': a project with this id is already registered.`);
    }
    this.#contexts.set(ctx.id, ctx);
    if (this.#defaultId === undefined) this.#defaultId = ctx.id;
  }

  get(id: string): ProjectContext | undefined {
    return this.#contexts.get(id);
  }

  /** The id used when a tool call omits its `project` selector. Settable
   *  (e.g. by an explicit `--default-project` launch flag); defaults to the
   *  first id passed to {@link add}. Throws on read before any context is
   *  registered, and on write to an id that isn't registered. */
  get defaultId(): string {
    if (this.#defaultId === undefined) {
      throw new Error("ProjectRegistry has no registered projects.");
    }
    return this.#defaultId;
  }

  set defaultId(id: string) {
    if (!this.#contexts.has(id)) {
      throw new Error(`Cannot set defaultId to unregistered project id '${id}'.`);
    }
    this.#defaultId = id;
  }

  /**
   * Resolve a tool-supplied `project` selector to its {@link ProjectContext}.
   * `undefined` resolves to {@link defaultId}. A `sel` that names no
   * registered id — including anything that merely LOOKS like a path
   * (`"../other"`, `"C:/tmp"`, `"./x"`) — returns an {@link mcpError}
   * enumerating the known ids, rather than being treated as a root to open.
   *
   * Pure `Map` lookup: no filesystem access, no `path.resolve`, no
   * `openProject` call, regardless of what `sel` looks like.
   */
  resolve(sel?: string): ProjectContext | CallToolResult {
    const id = sel ?? this.#defaultId;
    const ctx = id === undefined ? undefined : this.#contexts.get(id);
    if (ctx) return ctx;
    const known = [...this.#contexts.keys()].sort();
    const knownText = known.length > 0 ? known.join(", ") : "(none registered)";
    return mcpError(`Unknown project '${id ?? "(none)"}'. Known project ids: ${knownText}.`);
  }

  list(): { id: string; root: string; extractedDir: string; isDefault: boolean }[] {
    return [...this.#contexts.values()].map((ctx) => ({
      id: ctx.id,
      root: ctx.root,
      extractedDir: ctx.extractedDir,
      isDefault: ctx.id === this.#defaultId,
    }));
  }
}

/** `<id>=` prefix on a `--project-dir` spec: an explicit id always wins over
 *  derivation. Anchored so the id portion can't itself contain a path
 *  separator — that's what tells `alpha=../x` apart from a bare path that
 *  happens to contain `=` somewhere past its first separator. */
const EXPLICIT_ID_RE = /^([^/\\=]+)=(.+)$/;

/** Collapse anything outside `[a-z0-9-]` to `-`, then collapse runs of `-` to
 *  one and trim leading/trailing `-`. Falls back to `"project"` if that
 *  leaves nothing. */
function sanitize(base: string): string {
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}

/**
 * `path.basename` reimplemented by string manipulation (never imports
 * `node:path` — see the class-level JSDoc on why that import's absence is
 * load-bearing here, not incidental). Normalizes `\` to `/`, trims trailing
 * slashes, then takes the last `/`-delimited segment.
 */
function basenameOf(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Derive a project id from a raw `--project-dir` spec: either a bare root
 * path, or an `<id>=<root>` spec whose explicit id always wins over
 * derivation (see {@link EXPLICIT_ID_RE}).
 *
 * For a bare path: basename it, lowercase, collapse anything outside
 * `[a-z0-9-]` to `-` (see {@link sanitize}). A collision against `usedIds`
 * (the caller's running set of already-derived ids — this is the dedup
 * primitive the launch-config parser accumulates across repeated
 * `--project-dir` flags) is resolved by appending `-2`, `-3`, … and a
 * warning written to **stderr** (never stdout — stdout is reserved for the
 * MCP protocol stream).
 */
export function deriveProjectId(root: string, usedIds: ReadonlySet<string> = new Set()): string {
  const explicit = EXPLICIT_ID_RE.exec(root);
  if (explicit) return explicit[1];

  const base = sanitize(basenameOf(root));
  if (!usedIds.has(base)) return base;

  let n = 2;
  while (usedIds.has(`${base}-${n}`)) n++;
  const deduped = `${base}-${n}`;
  process.stderr.write(
    `[construct3-chef] duplicate project id '${base}' derived from multiple --project-dir roots; using '${deduped}' instead.\n`,
  );
  return deduped;
}
