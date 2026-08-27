import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { walkFiles, toPosixPath, bufferingLogger, mcpContent } from "@genvidtech/mcp-utils";
import { OpsRegistry, type RegisterableServer, type RegisterableTool } from "../../src/mcp/opsRegistry.js";
import { applyParsed } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { __getHandler, __listToolNames, __setRegistry, __resetTestState } from "../../src/mcp/server.js";
import { createProjectContext } from "../../src/mcp/projectContext.js";
import { ProjectRegistry } from "../../src/mcp/projectRegistry.js";

/**
 * Cross-project ops-namespace tests for #95's F6 (per-project OpsRegistry +
 * op-<projectId>_<opName> naming). Covers T-O1 (namespace collision +
 * cross-project mutation isolation, at the OpsRegistry level) and T-O2
 * (list-ops registered once, project-scoped, at the server.ts level).
 *
 * Uses temp copies of test/fixtures/construct3-chef-sample throughout — never
 * the tracked fixture itself, which the golden test byte-diffs (see
 * CLAUDE.md's "No mutating smoke on golden fixtures").
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");

function copyFixture(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `c3chef-ops-${prefix}-`));
  fs.cpSync(FIXTURE_DIR, root, { recursive: true });
  return root;
}

/** Recursive sha256 over every file's relative posix path + content, so any
 * byte anywhere under `root` changes the digest (T-O1's byte-unchanged proof). */
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

function writeOpFile(dir: string, name: string, content: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(content, null, "\t") + "\n", "utf8");
}

// ── Minimal fake server (captures registerTool calls) ──────────────────────
// Same shape as opsRegistry.test.ts's own fake — duplicated rather than
// shared, matching this repo's existing per-file test-helper style.

interface CapturedTool {
  config: { title?: string; description?: string; inputSchema?: Record<string, unknown> };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
}

function makeFakeServer(): { server: RegisterableServer; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server: RegisterableServer = {
    registerTool(name, config, handler) {
      const captured: CapturedTool = { config: config as CapturedTool["config"], handler };
      tools.set(name, captured);
      const tool: RegisterableTool = {
        update(updates) {
          if (updates.callback) captured.handler = updates.callback as CapturedTool["handler"];
        },
        remove() {
          tools.delete(name);
        },
      };
      return tool;
    },
  };
  return { server, tools };
}

/** Real (file-mutating) applyRecipe, bound to one project's root — mirrors
 *  what server.ts's applyRecipeWithConcurrency does for the txId/watcher bits
 *  it owns, minus those bits: OpsRegistry-level tests don't need a watcher. */
function makeRealApplyRecipe(
  root: string,
): (recipe: Recipe, opts: { regenerate?: boolean; label?: string }, extra: unknown) => Promise<CallToolResult> {
  return async (recipe) => {
    const { log, text } = bufferingLogger();
    applyParsed(root, recipe, { regenerate: false, log });
    return mcpContent(text());
  };
}

const ALPHA_PROMOTE = {
  description: "Promote (alpha)",
  params: [{ name: "TARGET", type: "string", required: true, description: "target sid" }],
  recipe: {
    addInstVars: [{ type: "Text", instanceVariables: [{ name: "alphaPromoted", type: "string" }] }],
  },
};

const BETA_PROMOTE = {
  description: "Promote (beta)",
  params: [{ name: "LEVEL", type: "number", required: true, description: "level" }],
  recipe: {
    addInstVars: [{ type: "Text", instanceVariables: [{ name: "betaPromoted", type: "number" }] }],
  },
};

describe("OpsRegistry cross-project namespace (#95, F6)", () => {
  // ── T-O1 ─────────────────────────────────────────────────────────────────
  describe("T-O1: op tools are namespaced per project and cannot collide", () => {
    let alphaRoot: string;
    let betaRoot: string;
    let alphaOpsDir: string;
    let betaOpsDir: string;
    let fakeServer: ReturnType<typeof makeFakeServer>;
    let alphaRegistry: OpsRegistry;
    let betaRegistry: OpsRegistry;

    beforeEach(() => {
      alphaRoot = copyFixture("o1-alpha");
      betaRoot = copyFixture("o1-beta");
      alphaOpsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-o1-alpha-"));
      betaOpsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-o1-beta-"));
      writeOpFile(alphaOpsDir, "promote", ALPHA_PROMOTE);
      writeOpFile(betaOpsDir, "promote", BETA_PROMOTE);

      fakeServer = makeFakeServer();
      alphaRegistry = new OpsRegistry({
        server: fakeServer.server,
        projectId: "alpha",
        opsDir: alphaOpsDir,
        watch: false,
        applyRecipe: makeRealApplyRecipe(alphaRoot),
      });
      betaRegistry = new OpsRegistry({
        server: fakeServer.server,
        projectId: "beta",
        opsDir: betaOpsDir,
        watch: false,
        applyRecipe: makeRealApplyRecipe(betaRoot),
      });
      alphaRegistry.start();
      betaRegistry.start();
    });

    afterEach(() => {
      alphaRegistry.stop();
      betaRegistry.stop();
      fs.rmSync(alphaRoot, { recursive: true, force: true });
      fs.rmSync(betaRoot, { recursive: true, force: true });
      fs.rmSync(alphaOpsDir, { recursive: true, force: true });
      fs.rmSync(betaOpsDir, { recursive: true, force: true });
    });

    it("registers both op-alpha_promote and op-beta_promote, each with its own (different) param schema", () => {
      expect(fakeServer.tools.has("op-alpha_promote")).to.equal(true);
      expect(fakeServer.tools.has("op-beta_promote")).to.equal(true);

      const alphaSchema = fakeServer.tools.get("op-alpha_promote")!.config.inputSchema!;
      const betaSchema = fakeServer.tools.get("op-beta_promote")!.config.inputSchema!;
      expect(alphaSchema).to.have.property("TARGET");
      expect(alphaSchema).to.not.have.property("LEVEL");
      expect(betaSchema).to.have.property("LEVEL");
      expect(betaSchema).to.not.have.property("TARGET");
    });

    it("invoking op-beta_promote mutates only beta's tree — alpha's files are byte-unchanged", async () => {
      const alphaHashBefore = hashTree(alphaRoot);

      const handler = fakeServer.tools.get("op-beta_promote")!.handler;
      const result = await handler({ LEVEL: 5 }, {});
      expect(result.isError, JSON.stringify(result)).to.not.equal(true);

      // beta's tree was actually mutated by this call.
      const betaTextJson = fs.readFileSync(path.join(betaRoot, "objectTypes", "Text.json"), "utf-8");
      expect(betaTextJson).to.include("betaPromoted");

      // alpha's ENTIRE tree — not just the object type file — is byte-unchanged.
      // A real assertion, not implied by "we never called alpha's handler":
      // hash alpha's whole tree before and after and compare.
      expect(hashTree(alphaRoot)).to.equal(alphaHashBefore);
      const alphaTextJson = fs.readFileSync(path.join(alphaRoot, "objectTypes", "Text.json"), "utf-8");
      expect(alphaTextJson).to.not.include("betaPromoted");
      expect(alphaTextJson).to.not.include("alphaPromoted");
    });
  });

  // ── T-O2 ─────────────────────────────────────────────────────────────────
  // list-ops is registered once (in server.ts, not per-context) and is
  // project-scoped via the usual `project` selector (regP).
  describe("T-O2: list-ops is registered once and is project-scoped", () => {
    let alphaRoot: string;
    let betaRoot: string;

    beforeEach(async () => {
      alphaRoot = copyFixture("o2-alpha");
      betaRoot = copyFixture("o2-beta");

      const alphaOpsDir = path.join(alphaRoot, "ops");
      const betaOpsDir = path.join(betaRoot, "ops");
      writeOpFile(alphaOpsDir, "alpha-only-op", ALPHA_PROMOTE);
      writeOpFile(betaOpsDir, "beta-only-op", BETA_PROMOTE);

      const alphaCtx = await createProjectContext("alpha", alphaRoot);
      const betaCtx = await createProjectContext("beta", betaRoot);

      const alphaFake = makeFakeServer();
      const alphaOps = new OpsRegistry({
        server: alphaFake.server,
        projectId: "alpha",
        opsDir: alphaOpsDir,
        watch: false,
        applyRecipe: makeRealApplyRecipe(alphaRoot),
      });
      alphaOps.start();
      alphaCtx.ops = alphaOps;

      const betaFake = makeFakeServer();
      const betaOps = new OpsRegistry({
        server: betaFake.server,
        projectId: "beta",
        opsDir: betaOpsDir,
        watch: false,
        applyRecipe: makeRealApplyRecipe(betaRoot),
      });
      betaOps.start();
      betaCtx.ops = betaOps;

      const registry = new ProjectRegistry();
      registry.add(alphaCtx);
      registry.add(betaCtx);
      __setRegistry(registry);
    });

    afterEach(() => {
      __resetTestState();
      fs.rmSync(alphaRoot, { recursive: true, force: true });
      fs.rmSync(betaRoot, { recursive: true, force: true });
    });

    it("is registered exactly once in the handler registry, regardless of the number of registered projects", () => {
      expect(__listToolNames().filter((n) => n === "list-ops")).to.have.length(1);
    });

    it("list-ops {project:'beta'} lists only beta's ops", async () => {
      const handler = __getHandler("list-ops")!;
      const result = (await handler({ project: "beta" }, {} as never)) as CallToolResult;
      const text = (result.content[0] as { text: string }).text;
      expect(text).to.include("beta-only-op");
      expect(text).to.not.include("alpha-only-op");
    });

    it("list-ops {project:'alpha'} lists only alpha's ops", async () => {
      const handler = __getHandler("list-ops")!;
      const result = (await handler({ project: "alpha" }, {} as never)) as CallToolResult;
      const text = (result.content[0] as { text: string }).text;
      expect(text).to.include("alpha-only-op");
      expect(text).to.not.include("beta-only-op");
    });
  });
});
