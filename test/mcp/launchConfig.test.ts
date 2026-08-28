import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLaunchSpecs, resolveLaunchRoots, buildProjectRegistry } from "../../src/mcp/launchConfig.js";

/**
 * launchConfig.ts is the #95 launch surface: it turns repeated
 * `--project-dir [<id>=]<path>` flags / `C3_PROJECT_DIRS` into the
 * `ProjectRegistry` `startServer` builds at launch. These tests exercise the
 * precedence chain and registry-building logic directly, WITHOUT calling
 * `startServer` itself — its `StdioServerTransport.connect()` blocks the test
 * process (see `rootResolution.test.ts`'s own note on this, which this file
 * follows).
 */
describe("launchConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-launchConfig-"));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // ── resolveLaunchSpecs: precedence ─────────────────────────────────────────
  describe("resolveLaunchSpecs precedence", () => {
    it("CLI --project-dir specs win over C3_PROJECT_DIRS entirely", () => {
      const env = { C3_PROJECT_DIRS: ["/x", "/y"].join(path.delimiter) } as NodeJS.ProcessEnv;
      expect(resolveLaunchSpecs(["/a", "/b"], env)).to.deep.equal(["/a", "/b"]);
    });

    it("falls back to C3_PROJECT_DIRS, split on path.delimiter, when no CLI specs are given", () => {
      const env = { C3_PROJECT_DIRS: ["/a", "b=/b"].join(path.delimiter) } as NodeJS.ProcessEnv;
      expect(resolveLaunchSpecs(undefined, env)).to.deep.equal(["/a", "b=/b"]);
      expect(resolveLaunchSpecs([], env)).to.deep.equal(["/a", "b=/b"]);
    });

    it("trims whitespace and drops empty entries from C3_PROJECT_DIRS", () => {
      const env = { C3_PROJECT_DIRS: ` /a ${path.delimiter}${path.delimiter} /b ` } as NodeJS.ProcessEnv;
      expect(resolveLaunchSpecs(undefined, env)).to.deep.equal(["/a", "/b"]);
    });

    it("returns [] when neither CLI specs nor C3_PROJECT_DIRS are given", () => {
      expect(resolveLaunchSpecs(undefined, {} as NodeJS.ProcessEnv)).to.deep.equal([]);
    });
  });

  // ── resolveLaunchRoots: the declarative multi-root branch ──────────────────
  describe("resolveLaunchRoots (2+ specs, no discovery)", () => {
    it("resolves every spec's path and derives its id, in order", () => {
      const rootA = path.join(tmp, "game-a");
      const rootB = path.join(tmp, "game-b");
      const logs: string[] = [];
      const roots = resolveLaunchRoots([rootA, rootB], (m) => logs.push(m));

      expect(roots).to.deep.equal([
        { id: "game-a", root: rootA },
        { id: "game-b", root: rootB },
      ]);
      expect(logs).to.have.lengthOf(2);
      expect(logs[0]).to.match(/--project-dir, id: game-a/);
    });

    it("honors an explicit <id>= prefix over derivation", () => {
      const rootA = path.join(tmp, "game-a");
      const rootB = path.join(tmp, "game-b");
      const roots = resolveLaunchRoots([`custom=${rootA}`, rootB], () => {});
      expect(roots).to.deep.equal([
        { id: "custom", root: rootA },
        { id: "game-b", root: rootB },
      ]);
    });
  });

  // ── resolveLaunchRoots: the preserved single-root branch ────────────────────
  describe("resolveLaunchRoots (0 or 1 spec, resolveRootFolder-backed)", () => {
    it("a single explicit spec resolves via 'explicit', deriving the id from the raw spec", () => {
      const root = path.join(tmp, "my game");
      fs.mkdirSync(root);
      const logs: string[] = [];
      const roots = resolveLaunchRoots([root], (m) => logs.push(m));
      expect(roots).to.deep.equal([{ id: "my-game", root }]);
      expect(logs.some((l) => l.includes("(source: explicit)"))).to.equal(true);
    });

    it("a single '<id>=' spec resolves via 'explicit', keeping the explicit id", () => {
      const root = path.join(tmp, "game");
      fs.mkdirSync(root);
      const roots = resolveLaunchRoots([`alpha=${root}`], () => {});
      expect(roots).to.deep.equal([{ id: "alpha", root }]);
    });
  });

  // ── buildProjectRegistry: two-root launch ────────────────────────────────────
  describe("buildProjectRegistry", () => {
    it("a two-root launch produces a two-entry registry", async () => {
      const rootA = path.join(tmp, "game-a");
      const rootB = path.join(tmp, "game-b");
      const registry = await buildProjectRegistry([rootA, rootB], undefined, undefined, { log: () => {} });

      expect(registry.list()).to.deep.equal([
        { id: "game-a", root: rootA, extractedDir: path.join(rootA, "extracted"), isDefault: true },
        { id: "game-b", root: rootB, extractedDir: path.join(rootB, "extracted"), isDefault: false },
      ]);
    });

    it("an '<id>=' spec overrides derivation in the built registry", async () => {
      const rootA = path.join(tmp, "game-a");
      const rootB = path.join(tmp, "game-b");
      const registry = await buildProjectRegistry([`custom=${rootA}`, rootB], undefined, undefined, {
        log: () => {},
      });

      expect(registry.get("custom")?.root).to.equal(rootA);
      expect(registry.get("game-a")).to.equal(undefined);
    });

    it("--default-project selects a non-first root as the default", async () => {
      const rootA = path.join(tmp, "game-a");
      const rootB = path.join(tmp, "game-b");
      const registry = await buildProjectRegistry([rootA, rootB], undefined, "game-b", { log: () => {} });

      expect(registry.defaultId).to.equal("game-b");
      expect(registry.list().find((p) => p.id === "game-b")?.isDefault).to.equal(true);
      expect(registry.list().find((p) => p.id === "game-a")?.isDefault).to.equal(false);
    });

    // ── omitting everything resolves exactly as today ──────────────────────────
    //
    // No --project-dir, no C3_PROJECT_DIRS, no C3_PROJECT_DIR: the pre-#95
    // launch surface, which falls all the way through to cwd discovery —
    // including the existing stderr-style warning (captured here via the
    // injected `log`, matching how startServer itself routes it to
    // console.error). Uses process.chdir() (restored in `finally`) because
    // resolveLaunchRoots' 0/1-spec branch deliberately calls the SAME
    // resolveRootFolder({ explicit, envVar: "C3_PROJECT_DIR", ... }) shape
    // startServer always called, with no injectable cwd — that's the whole
    // point of the preservation guarantee (see launchConfig.ts's docstring).
    it("omitting --project-dir, C3_PROJECT_DIRS, and C3_PROJECT_DIR falls back to cwd with the existing warning", async () => {
      const originalCwd = process.cwd();
      const originalEnv = process.env.C3_PROJECT_DIR;
      delete process.env.C3_PROJECT_DIR;
      process.chdir(tmp);
      try {
        const logs: string[] = [];
        const registry = await buildProjectRegistry(undefined, undefined, undefined, {
          log: (m) => logs.push(m),
          env: { ...process.env },
        });

        expect(registry.list()).to.have.lengthOf(1);
        expect(registry.list()[0].root).to.equal(tmp);
        expect(logs.some((l) => l.includes("no project.c3proj found via --project-dir"))).to.equal(true);
        expect(logs.some((l) => l.includes("(source: cwd)"))).to.equal(true);
      } finally {
        process.chdir(originalCwd);
        if (originalEnv !== undefined) process.env.C3_PROJECT_DIR = originalEnv;
      }
    });
  });
});
