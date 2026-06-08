import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadChefConfig } from "../../src/c3/chefConfig.js";
import {
  generateSidRegistry,
  generateDSL,
  extractScripts,
  generateLayoutSummaries,
  generateTemplateScope,
  generateGlobalLayers,
} from "../../src/c3/generators.js";
import { regenerateExtracted, applyParsed } from "../../src/c3/recipeApplier.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
// Source dirs/files — same list the golden test uses, intentionally excludes extracted/
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj"];

const noop = () => {};

function copyFixture(): string {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c3chef-cfgint-"));
  for (const entry of SOURCE_ENTRIES) {
    const src = path.join(FIXTURE_ROOT, entry);
    if (existsSync(src)) cpSync(src, path.join(tmpRoot, entry), { recursive: true });
  }
  return tmpRoot;
}

/**
 * Recursively collect all files under `dir`, returning relative posix paths.
 * Returns [] if the directory does not exist.
 */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out.sort();
}

describe("chefConfig integration: extractedDir routing", () => {
  // ── Test A: config-driven routing via loadChefConfig ──────────────────────

  describe("Test A — loadChefConfig drives output routing", () => {
    let tmpRoot: string;

    before(function () {
      tmpRoot = copyFixture();
      // Write a config file requesting a custom output dir
      writeFileSync(path.join(tmpRoot, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "my-out" }));
    });

    after(function () {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("loadChefConfig reads extractedDir from config file", async () => {
      const cfg = await loadChefConfig(tmpRoot);
      expect(cfg.extractedDir).to.equal("my-out");
    });

    it("generateSidRegistry writes to the configured dir", async () => {
      const cfg = await loadChefConfig(tmpRoot);
      generateSidRegistry(tmpRoot, path.join(tmpRoot, cfg.extractedDir), noop);
      expect(existsSync(path.join(tmpRoot, "my-out", "sid-registry.txt"))).to.be.true;
    });

    it("generateDSL writes .dsl.txt files under the configured dir", async () => {
      const cfg = await loadChefConfig(tmpRoot);
      const outDir = path.join(tmpRoot, cfg.extractedDir);
      generateDSL(tmpRoot, outDir, noop);

      const dslFiles = collectFiles(outDir).filter((f) => f.endsWith(".dsl.txt"));
      expect(dslFiles.length, "at least one .dsl.txt written under my-out/").to.be.greaterThan(0);
    });

    it("nothing leaks into the default extracted/ dir", async () => {
      // After running the above generators, the default dir must still be absent
      expect(existsSync(path.join(tmpRoot, "extracted"))).to.be.false;
    });
  });

  // ── Test B: regenerateExtracted honors extractedDir ───────────────────────

  describe("Test B — regenerateExtracted routes all output to extractedDir", () => {
    let tmpRoot: string;

    before(function () {
      tmpRoot = copyFixture();
      // Run regenerate with a non-default dir — no config file needed.
      // regenerateExtracted runs extractScripts + generateDSL (+ layout summaries
      // when withLayouts=true). It does NOT call generateSidRegistry — that is the
      // caller's responsibility (CLI/server do it separately). So we assert on DSL
      // files and .ts script files, not on sid-registry.txt.
      regenerateExtracted(tmpRoot, false, "my-out2", noop);
    });

    after(function () {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("at least one .dsl.txt lands under the custom dir", () => {
      const dslFiles = collectFiles(path.join(tmpRoot, "my-out2")).filter((f) => f.endsWith(".dsl.txt"));
      expect(dslFiles.length, "at least one .dsl.txt written under my-out2/").to.be.greaterThan(0);
    });

    it("tsconfig.json is written under the custom dir (extractScripts output)", () => {
      // extractScripts always writes a tsconfig.json regardless of whether any
      // sheets have scripts, so this is a reliable presence check.
      expect(existsSync(path.join(tmpRoot, "my-out2", "tsconfig.json"))).to.be.true;
    });

    it("nothing leaks into the default extracted/ dir", () => {
      expect(existsSync(path.join(tmpRoot, "extracted"))).to.be.false;
    });
  });

  // ── Test C: applyParsed routes sid-registry via ApplyOptions.extractedDir ─

  describe("Test C — applyParsed routes sid-registry via ApplyOptions.extractedDir", () => {
    let tmpRoot: string;

    before(function () {
      tmpRoot = copyFixture();
      // applyParsed reads the sid-registry from opts.extractedDir to seed the
      // SID generator. We must pre-generate it in the custom dir before apply.
      generateSidRegistry(tmpRoot, path.join(tmpRoot, "my-out3"), noop);
    });

    after(function () {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("applyParsed reads registry from the custom dir and routes post-apply regeneration there", () => {
      // applyParsed reads the sid-registry from opts.extractedDir to seed the SID
      // generator (pre-generated in before()). After applying, it calls
      // regenerateExtracted(rootDir, withLayouts, opts.extractedDir) which routes
      // extractScripts + generateDSL output to my-out3/.
      //
      // We use a minimal file-create recipe (an empty new sheet) so the recipe
      // passes validation (a fully empty recipe {} is rejected). The recipe itself
      // only writes a new sheet file; the regeneration after apply is what exercises
      // the extractedDir routing.
      const recipe = {
        files: {
          "eventSheets/TestCSheet.json": { create: true as const, events: [] },
        },
      };
      // If applyParsed tried to read sid-registry from the default "extracted/" dir
      // (which doesn't exist here), readRegistryFile would throw. A clean run
      // proves it correctly used opts.extractedDir.
      applyParsed(tmpRoot, recipe, { extractedDir: "my-out3", regenerate: true, log: noop });

      // The pre-generated sid-registry.txt must still be in my-out3/ (not moved)
      expect(existsSync(path.join(tmpRoot, "my-out3", "sid-registry.txt"))).to.be.true;

      // The post-apply regeneration must have written DSL output to my-out3/
      const dslFiles = collectFiles(path.join(tmpRoot, "my-out3")).filter((f) => f.endsWith(".dsl.txt"));
      expect(dslFiles.length, "at least one .dsl.txt written under my-out3/ after apply").to.be.greaterThan(0);
    });

    it("nothing leaks into the default extracted/ dir after applyParsed", () => {
      expect(existsSync(path.join(tmpRoot, "extracted"))).to.be.false;
    });
  });
});
