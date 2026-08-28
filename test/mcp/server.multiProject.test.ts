import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { walkFiles, toPosixPath } from "@genvidtech/mcp-utils";
import {
  __getHandler,
  __getToolConfig,
  __listToolNames,
  __setRegistry,
  __resetTestState,
} from "../../src/mcp/server.js";
import { createProjectContext } from "../../src/mcp/projectContext.js";
import { ProjectRegistry } from "../../src/mcp/projectRegistry.js";
import { OpsRegistry, type RegisterableServer } from "../../src/mcp/opsRegistry.js";

/**
 * Cross-project behavioural tests for #95's F5 (Seam C: `regP` selector
 * threading). Covers the five rows named in #95's Acceptance Criteria:
 * T-X4 (composite-token id isolation), T-X5 (no anti-global-counter
 * cross-project invalidation), T-X6 (get-state's composite token), T-C5 (no
 * MUTATE tool deadlocks under `regP`), T-C6 (default selection unchanged).
 *
 * Uses temp copies of test/fixtures/construct3-chef-sample throughout —
 * never the tracked fixture itself, which the golden test byte-diffs (see
 * CLAUDE.md's "No mutating smoke on golden fixtures").
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");

// A minimal valid recipe that applies cleanly against construct3-chef-sample
// (mirrors serverHandlers.test.ts's VALID_RECIPE) — adds a new instance
// variable to the Text objectType, which exists in objectTypes/Text.json and
// instanceTypes.d.ts.
const VALID_RECIPE = JSON.stringify({
  addInstVars: [
    {
      type: "Text",
      instanceVariables: [{ name: "multiProjectTest", type: "number" }],
    },
  ],
});

// ── Fake watcher ─────────────────────────────────────────────────────────────
// Same shape as serverHandlers.test.ts's FakeWatcher — handlers under test
// only touch watcher.txId, watcher.bump(), watcher.suppress(fn), and
// watcher.expect(path).

interface FakeWatcher {
  txId: number;
  bumped: number;
  bump(): void;
  suppress<T>(fn: () => Promise<T>): Promise<T>;
  expect(filePath: string): void;
}

function makeFakeWatcher(txId = 0): FakeWatcher {
  return {
    txId,
    bumped: 0,
    bump() {
      this.txId++;
      this.bumped++;
    },
    async suppress<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    expect() {
      // no-op — tests here don't assert on expectCalls
    },
  };
}

function makeExtra(): any {
  return { signal: new AbortController().signal };
}

/** Minimal fake RegisterableServer — T-C6's list-ops coverage only needs
 *  ctx.ops.getLoadedOps() to work; the ops dir it points at doesn't exist, so
 *  reconcile() never actually calls registerTool. */
function makeFakeOpsServer(): RegisterableServer {
  return {
    registerTool() {
      throw new Error("unexpected registerTool call — T-C6's ops dir should be empty");
    },
  };
}

// cpSync stamps every copied file with ~the same mtime, and the recursive
// copy order decides whether extracted/ ends up newer or older than the
// source dirs. checkSourceFreshness/checkRegistryFreshness compare mtimes
// with a strict `source > extracted`, so a freshly-copied fixture can read
// as spuriously stale. Force extracted/ deterministically newer than source
// (same helper as serverHandlers.test.ts) so staleness never fires as a side
// effect of the copy itself.
function makeExtractedNewerThanSource(root: string): void {
  const future = new Date(Date.now() + 3_600_000);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.utimesSync(full, future, future);
    }
  };
  const extractedDir = path.join(root, "extracted");
  if (fs.existsSync(extractedDir)) walk(extractedDir);
}

function copyFixture(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `c3chef-mcp-${prefix}-`));
  fs.cpSync(FIXTURE_DIR, root, { recursive: true });
  makeExtractedNewerThanSource(root);
  return root;
}

/** Recursive sha256 over every file's relative posix path + content, so any
 * byte anywhere under `root` changes the digest (T-X4's byte-unchanged proof). */
function hashTree(root: string): string {
  const files = walkFiles(root, () => true)
    .map((p) => toPosixPath(path.relative(root, p)))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update(fs.readFileSync(path.join(root, rel)));
  }
  return hash.digest("hex");
}

/** Extract the trailing `txId: <token>` line mcpContent's footer appends. */
function extractTxId(text: string): string {
  const m = /txId: (\S+)/.exec(text);
  if (!m) throw new Error(`No txId line found in:\n${text}`);
  return m[1];
}

/**
 * Replace every occurrence of `root` (a unique per-mkdtemp absolute path) in
 * a CallToolResult's text blocks with a constant placeholder. T-C6 compares
 * output from two PHYSICALLY DIFFERENT temp directories (by design — see the
 * describe block's docstring), and several tools legitimately embed
 * `ctx.root`/absolute file paths in their response text (e.g. `regenerate`'s
 * "Generated ... in <root>\extracted", or a Node ENOENT message). Those
 * embedded paths differ between the two roots for a reason that has nothing
 * to do with default-project-selection, so they're normalized away before
 * the byte-identical comparison — otherwise every such tool would fail this
 * row for the wrong reason.
 */
function normalizeRootPaths(result: any, root: string): unknown {
  return {
    ...result,
    content: result.content.map((block: any) =>
      block.type === "text" ? { ...block, text: (block.text as string).split(root).join("<ROOT>") } : block,
    ),
  };
}

function isMutateAnnotated(name: string): boolean {
  const cfg = __getToolConfig(name) as { annotations?: Record<string, boolean> } | undefined;
  const a = cfg?.annotations;
  return !!a && a.readOnlyHint === false && a.destructiveHint === true && a.idempotentHint === false;
}

describe("MCP server multi-project behavior (#95, Seam C)", () => {
  afterEach(() => {
    __resetTestState();
  });

  // ── T-X4 ─────────────────────────────────────────────────────────────────
  // A token issued for one project is rejected by another even when the
  // counters are equal.
  describe("T-X4: a project-scoped txId is rejected against a different project at an equal counter", () => {
    let alphaRoot: string;
    let betaRoot: string;

    beforeEach(async () => {
      alphaRoot = copyFixture("tx4-alpha");
      betaRoot = copyFixture("tx4-beta");
      const alphaCtx = await createProjectContext("alpha", alphaRoot);
      const betaCtx = await createProjectContext("beta", betaRoot);
      alphaCtx.watcher = makeFakeWatcher(12) as any;
      betaCtx.watcher = makeFakeWatcher(12) as any;
      const registry = new ProjectRegistry();
      registry.add(alphaCtx);
      registry.add(betaCtx);
      __setRegistry(registry);
    });

    afterEach(() => {
      fs.rmSync(alphaRoot, { recursive: true, force: true });
      fs.rmSync(betaRoot, { recursive: true, force: true });
    });

    it("apply-recipe {project:'beta', txId:'alpha:12'} is rejected naming both projects, beta's files byte-unchanged", async () => {
      const betaHashBefore = hashTree(betaRoot);

      const handler = __getHandler("apply-recipe")!;
      const result = (await handler(
        { project: "beta", recipe: VALID_RECIPE, txId: "alpha:12", regenerate: false },
        makeExtra(),
      )) as any;

      expect(result.isError, result.content?.[0]?.text).to.equal(true);
      const text = result.content[0].text as string;
      expect(text, text).to.include("alpha");
      expect(text, text).to.include("beta");

      // A real assertion, not implied by the rejection: hash beta's entire
      // tree before and after and compare.
      expect(hashTree(betaRoot)).to.equal(betaHashBefore);
    });
  });

  // ── T-X5 ─────────────────────────────────────────────────────────────────
  // Cross-project activity does not invalidate an outstanding plan.
  describe("T-X5: cross-project activity does not invalidate an outstanding plan", () => {
    let alphaRoot: string;
    let betaRoot: string;
    let betaWatcher: FakeWatcher;

    beforeEach(async () => {
      alphaRoot = copyFixture("tx5-alpha");
      betaRoot = copyFixture("tx5-beta");
      const alphaCtx = await createProjectContext("alpha", alphaRoot);
      const betaCtx = await createProjectContext("beta", betaRoot);
      alphaCtx.watcher = makeFakeWatcher(3) as any;
      betaWatcher = makeFakeWatcher(3);
      betaCtx.watcher = betaWatcher as any;
      const registry = new ProjectRegistry();
      registry.add(alphaCtx);
      registry.add(betaCtx);
      __setRegistry(registry);
    });

    afterEach(() => {
      fs.rmSync(alphaRoot, { recursive: true, force: true });
      fs.rmSync(betaRoot, { recursive: true, force: true });
    });

    it("a token minted for alpha still applies after beta's counter moves", async () => {
      const validate = __getHandler("validate-recipe")!;
      const validated = (await validate({ project: "alpha", recipe: VALID_RECIPE }, makeExtra())) as any;
      expect(validated.isError, validated.content?.[0]?.text).to.be.undefined;
      const token = extractTxId(validated.content[0].text as string);
      expect(token).to.match(/^alpha:\d+$/);

      // Mutate beta — simulate independent cross-project activity between the
      // validate call and the apply call.
      betaWatcher.bump();

      const apply = __getHandler("apply-recipe")!;
      const applied = (await apply(
        { project: "alpha", recipe: VALID_RECIPE, txId: token, regenerate: false },
        makeExtra(),
      )) as any;
      expect(applied.isError, applied.content?.[0]?.text).to.be.undefined;
    });
  });

  // ── T-X6 ─────────────────────────────────────────────────────────────────
  // get-state emits the composite token.
  describe("T-X6: get-state emits the composite <projectId>:<counter> token", () => {
    let betaRoot: string;

    beforeEach(async () => {
      betaRoot = copyFixture("tx6-beta");
      const betaCtx = await createProjectContext("beta", betaRoot);
      betaCtx.watcher = makeFakeWatcher(42) as any;
      const registry = new ProjectRegistry();
      registry.add(betaCtx);
      __setRegistry(registry);
    });

    afterEach(() => {
      fs.rmSync(betaRoot, { recursive: true, force: true });
    });

    it("get-state {project:'beta'} returns a 'txId: beta:<N>' line", async () => {
      const handler = __getHandler("get-state")!;
      const result = (await handler({ project: "beta" }, makeExtra())) as any;
      expect(result.isError).to.be.undefined;
      expect(result.content[0].text as string).to.match(/^txId: beta:\d+$/m);
    });
  });

  // ── T-C5 ─────────────────────────────────────────────────────────────────
  // No MUTATE tool deadlocks. `regP` owns exactly the schema param + context
  // resolution; a lock taken INSIDE regP would nest inside a handler's own
  // ctx.rwlock.write (and, for apply-recipe, inside applyRecipeWithConcurrency's
  // write lock too) and hang forever, since ReadWriteLock has no owner
  // tracking. This describe block is green from birth (the real regP never
  // does that) — see the mutation-proof note in this file's accompanying
  // report; the proof itself is performed by editing src/mcp/server.ts by
  // hand, not by a test file change.
  describe("T-C5: no MUTATE-annotated tool deadlocks under regP", () => {
    // Deliberately reference paths/names that do NOT exist in the fixture:
    // every one of these tools has an early, graceful not-found/validation
    // return that still passes through the full regP → handler →
    // ctx.rwlock.write path — proving the lock acquires and releases
    // (no deadlock) without needing real domain data. A hang here is
    // structural (nested lock acquisition), not data-dependent, so this is
    // just as strong a proof as using valid data, and far cheaper.
    const MUTATE_ARGS: Record<string, Record<string, unknown>> = {
      "apply-recipe": { recipe: "{}", regenerate: false },
      "sync-project": {},
      "sync-addon-metadata": { direction: "package-from-manifest" },
      "scaffold-layout": {
        source: "NoSuchLayout.json",
        name: "TC5Layout",
        path: "TC5Layout.json",
        eventSheet: "NoSuchSheet",
        regenerate: false,
      },
      "scaffold-sprite": { source: "NoSuchSprite", name: "TC5Sprite" },
      "extract-template": {
        sourceLayout: "layouts/NoSuch.json",
        sourceType: "NoSuchType",
        templatesLayout: "layouts/NoSuch2.json",
        templateName: "TC5Template",
        templatesLayer: "Layer 0",
        regenerate: false,
      },
      "templatize-in-place": {
        layout: "layouts/NoSuch.json",
        type: "NoSuchType",
        templateName: "TC5Template",
        regenerate: false,
      },
      "clone-replica-to-layouts": {
        templatesLayout: "layouts/NoSuch.json",
        templateName: "TC5Template",
        sourceType: "NoSuchType",
        targets: [{ layout: "layouts/NoSuch2.json", layer: "Layer 0" }],
        regenerate: false,
      },
      "replace-instance-with-replica": {
        layout: "layouts/NoSuch.json",
        type: "NoSuchType",
        templatesLayout: "layouts/NoSuch2.json",
        templateName: "TC5Template",
        regenerate: false,
      },
      "remove-layer": { layout: "layouts/NoSuch.json", layer: "Layer 0", regenerate: false },
    };

    // Derived from the LIVE registry, not a hardcoded list, so a future
    // MUTATE tool automatically gets its own deadlock-guard test — and, if
    // nobody added a MUTATE_ARGS entry for it, that test fails loudly naming
    // the missing tool instead of silently not existing.
    const mutateTools = __listToolNames().filter(isMutateAnnotated);

    let root: string;

    beforeEach(async () => {
      root = copyFixture("tc5");
      const ctx = await createProjectContext("tc5", root);
      ctx.watcher = makeFakeWatcher(0) as any;
      const registry = new ProjectRegistry();
      registry.add(ctx);
      __setRegistry(registry);
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("MUTATE_ARGS covers every currently-registered MUTATE tool", () => {
      expect(mutateTools.sort()).to.deep.equal(Object.keys(MUTATE_ARGS).sort());
    });

    for (const name of mutateTools) {
      it(`${name} settles (success or graceful error) without deadlocking`, async function () {
        this.timeout(5000);
        const args = MUTATE_ARGS[name];
        expect(args, `no MUTATE_ARGS entry for '${name}'`).to.exist;
        const handler = __getHandler(name)!;
        expect(handler, `${name} not registered`).to.exist;
        const result = await handler(args, makeExtra());
        // No assertion on isError: a graceful early-return error is just as
        // valid proof of no-deadlock as a success. What matters is that the
        // promise SETTLED at all within the timeout.
        expect(result).to.exist;
      });
    }
  });

  // ── T-C6 ─────────────────────────────────────────────────────────────────
  // Default selection is unchanged: every regP tool invoked with `project`
  // omitted returns byte-identical output to the same invocation with
  // `project: '<defaultId>'`.
  //
  // Strategy: two PHYSICALLY SEPARATE but byte-identical temp copies of the
  // fixture, each registered under the SAME project id ("solo") in its own
  // single-project ProjectRegistry. For each covered tool: call once against
  // the "omit" registry with no `project` key, then once against the
  // "explicit" registry with `project: 'solo'`, and deep-equal the two
  // results. Because every covered tool's args are applied to BOTH roots, in
  // the SAME order, both roots (and their watcher counters) stay mirrored
  // across the whole sweep — so this holds even for the few covered tools
  // that do perform a real (deterministic, no-op-shaped) write.
  describe("T-C6: default project selection is unchanged", () => {
    const DEFAULT_ID = "solo";

    // Covered: every regP-registered tool except the one explicit skip below.
    // Args are deliberately the same "doesn't exist" placeholder shape T-C5
    // uses where a tool takes a domain-specific string — deterministic,
    // side-effect-free (or side-effect-symmetric — see "regenerate" and
    // "apply-recipe"/"sync-project" below) output is what makes the
    // byte-identical comparison meaningful rather than accidental.
    const COVERED: Record<string, Record<string, unknown>> = {
      "get-state": {},
      "list-event-sheets": {},
      "list-layouts": {},
      "list-global-layers": {},
      "list-ops": {},
      "navigation-graph": {},
      "read-dsl": { sheet: "NoSuchSheet" },
      "read-dsl-index": { sheet: "NoSuchSheet" },
      "read-event-sids": { sheet: "NoSuchSheet" },
      "read-scripts": { sheet: "NoSuchSheet" },
      "read-layout": { layout: "NoSuchLayout" },
      "read-template-scope": {},
      "read-sid-registry": {},
      "list-include-tree": { path: "NoSuchSheet" },
      search: { pattern: "NoMatchWhatsoeverXyz123" },
      "resolve-anchor": { sheet: "NoSuchSheet", by: "name", value: "x" },
      "validate-recipe": { recipe: "{}" },
      // regenerate: real write to extracted/, but generation is deterministic
      // (same source, same generators, no randomness) so both mirrored roots
      // produce byte-identical extracted/ output and byte-identical response
      // text (which carries no txId footer at all — see server.ts).
      regenerate: {},
      "validate-project": {},
      "read-addon": { name: "NoSuchAddonXYZ" },
      "validate-addons": {},
      "list-addons": {},
      "diff-addon-aces": { from: "NoSuchAddonA", to: "NoSuchAddonB" },
      "scan-addon-usage": { addon: "NoSuchAddonXYZ" },
      "preview-addon-metadata-sync": { direction: "package-from-manifest" },
      "search-docs": { query: "NoMatchWhatsoeverXyz123" },
      // MUTATE tools: same not-found placeholders as T-C5 EXCEPT apply-recipe
      // and sync-project, which have no way to force a deterministic no-op —
      // apply-recipe's "{}" recipe and sync-project's unconditional sync both
      // genuinely do nothing (an empty recipe touches no files; a project
      // already in sync writes nothing new) and both unconditionally bump
      // the watcher once — symmetric on both mirrored roots, so still
      // byte-identical.
      "apply-recipe": { recipe: "{}", regenerate: false },
      "sync-project": {},
      "sync-addon-metadata": { direction: "package-from-manifest" },
      "scaffold-layout": {
        source: "NoSuchLayout.json",
        name: "TC6Layout",
        path: "TC6Layout.json",
        eventSheet: "NoSuchSheet",
        regenerate: false,
      },
      "scaffold-sprite": { source: "NoSuchSprite", name: "TC6Sprite" },
      "extract-template": {
        sourceLayout: "layouts/NoSuch.json",
        sourceType: "NoSuchType",
        templatesLayout: "layouts/NoSuch2.json",
        templateName: "TC6Template",
        templatesLayer: "Layer 0",
        regenerate: false,
      },
      "templatize-in-place": {
        layout: "layouts/NoSuch.json",
        type: "NoSuchType",
        templateName: "TC6Template",
        regenerate: false,
      },
      "clone-replica-to-layouts": {
        templatesLayout: "layouts/NoSuch.json",
        templateName: "TC6Template",
        sourceType: "NoSuchType",
        targets: [{ layout: "layouts/NoSuch2.json", layer: "Layer 0" }],
        regenerate: false,
      },
      "replace-instance-with-replica": {
        layout: "layouts/NoSuch.json",
        type: "NoSuchType",
        templatesLayout: "layouts/NoSuch2.json",
        templateName: "TC6Template",
        regenerate: false,
      },
      "remove-layer": { layout: "layouts/NoSuch.json", layer: "Layer 0", regenerate: false },
    };

    // Skipped, with reasons — kept visible rather than silently absent from
    // COVERED:
    const SKIPPED: Record<string, string> = {
      "generate-sids":
        "NON_IDEMPOTENT_READ — mints random SIDs, so two calls with identical input " +
        "deliberately return DIFFERENT output; a byte-identical assertion would be testing " +
        "randomness, not default-project-selection.",
    };
    // list-projects is out of the corpus definition entirely, not "skipped":
    // it is the sole tool registered via plain `reg` rather than `regP` (see
    // server.ts's own comment on the tool) and accepts no `project` selector
    // at all, so "omitted vs explicit default" doesn't apply to it.

    it("COVERED + SKIPPED account for every regP-registered tool (list-projects excluded by design)", () => {
      const regPTools = __listToolNames().filter((n) => n !== "list-projects");
      const accounted = new Set([...Object.keys(COVERED), ...Object.keys(SKIPPED)]);
      const missing = regPTools.filter((n) => !accounted.has(n));
      expect(missing, `regP tool(s) with neither COVERED nor SKIPPED entry: ${missing.join(", ")}`).to.deep.equal([]);
    });

    let rootOmit: string;
    let rootExplicit: string;
    let registryOmit: ProjectRegistry;
    let registryExplicit: ProjectRegistry;

    before(async function () {
      this.timeout(30_000);
      rootOmit = copyFixture("tc6-omit");
      rootExplicit = copyFixture("tc6-explicit");
      const ctxOmit = await createProjectContext(DEFAULT_ID, rootOmit);
      const ctxExplicit = await createProjectContext(DEFAULT_ID, rootExplicit);
      ctxOmit.watcher = makeFakeWatcher(0) as any;
      ctxExplicit.watcher = makeFakeWatcher(0) as any;
      // list-ops reads ctx.ops (#95) — wire a minimal one per root, pointed
      // at a nonexistent ops/ dir so both sides deterministically report "no
      // ops" (loadOpsFromDir treats an absent dir as empty, never an error).
      ctxOmit.ops = new OpsRegistry({
        server: makeFakeOpsServer(),
        projectId: DEFAULT_ID,
        opsDir: path.join(rootOmit, "ops"),
        watch: false,
        applyRecipe: async () => ({ content: [{ type: "text", text: "unused" }] }),
      });
      ctxOmit.ops.start();
      ctxExplicit.ops = new OpsRegistry({
        server: makeFakeOpsServer(),
        projectId: DEFAULT_ID,
        opsDir: path.join(rootExplicit, "ops"),
        watch: false,
        applyRecipe: async () => ({ content: [{ type: "text", text: "unused" }] }),
      });
      ctxExplicit.ops.start();
      registryOmit = new ProjectRegistry();
      registryOmit.add(ctxOmit);
      registryExplicit = new ProjectRegistry();
      registryExplicit.add(ctxExplicit);
    });

    after(() => {
      fs.rmSync(rootOmit, { recursive: true, force: true });
      fs.rmSync(rootExplicit, { recursive: true, force: true });
    });

    for (const [name, args] of Object.entries(COVERED)) {
      it(`${name}: project omitted === project: '${DEFAULT_ID}'`, async function () {
        this.timeout(10_000);
        __setRegistry(registryOmit);
        const omitted = await __getHandler(name)!(args, makeExtra());
        __setRegistry(registryExplicit);
        const explicit = await __getHandler(name)!({ ...args, project: DEFAULT_ID }, makeExtra());
        expect(normalizeRootPaths(explicit, rootExplicit)).to.deep.equal(normalizeRootPaths(omitted, rootOmit));
      });
    }
  });
});
