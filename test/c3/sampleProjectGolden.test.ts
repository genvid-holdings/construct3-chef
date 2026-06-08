import { describe, it } from "mocha";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractScripts,
  generateDSL,
  generateLayoutSummaries,
  generateTemplateScope,
  generateSidRegistry,
  generateGlobalLayers,
} from "../../src/c3/generators.js";

/**
 * Golden-file integration test over a real C3 project export
 * (test/fixtures/construct3-chef-sample). The committed extracted/ directory is the
 * baseline; this test regenerates it in a temp copy and asserts byte-identical
 * output (line endings normalized).
 *
 * Purpose: guard the generate -> extracted/ pipeline — especially the layout
 * summaries' fullLayerName / global-qualifier composition, which the unit
 * tests do not cover. The fixture deliberately includes a global layer, an
 * `overriden` global layer, sublayers nested 3 deep, a global-flagged
 * sublayer, a scene-graph parent/child pair, and a template across layouts.
 *
 * To intentionally update the golden after a deliberate output change:
 *   pnpm exec tsx src/cli.ts generate --project-dir test/fixtures/construct3-chef-sample
 */

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const GOLDEN_DIR = path.join(FIXTURE_ROOT, "extracted");
// Source dirs/files the generators read (everything except the generated extracted/).
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj"];

const norm = (s: string): string => s.replace(/\r\n/g, "\n");

function listFilesRel(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

describe("construct3-chef-sample golden extracted/ output", () => {
  let tmpRoot: string;

  before(function () {
    if (!existsSync(GOLDEN_DIR)) {
      throw new Error(
        `Missing golden dir ${GOLDEN_DIR}. Generate it with: pnpm exec tsx src/cli.ts generate --project-dir test/fixtures/construct3-chef-sample`,
      );
    }
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c3chef-golden-"));
    for (const entry of SOURCE_ENTRIES) {
      const src = path.join(FIXTURE_ROOT, entry);
      if (existsSync(src)) cpSync(src, path.join(tmpRoot, entry), { recursive: true });
    }
    const outDir = path.join(tmpRoot, "extracted");
    const noop = () => {};
    extractScripts(tmpRoot, outDir, noop);
    generateDSL(tmpRoot, outDir, noop);
    generateLayoutSummaries(tmpRoot, outDir, noop);
    generateTemplateScope(tmpRoot, outDir, noop);
    generateSidRegistry(tmpRoot, outDir, noop);
    generateGlobalLayers(tmpRoot, outDir, noop);
  });

  after(function () {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("regenerates the same set of files", () => {
    const expected = listFilesRel(GOLDEN_DIR);
    const actual = listFilesRel(path.join(tmpRoot, "extracted"));
    assert.deepEqual(actual, expected);
  });

  it("regenerates byte-identical content for every file", () => {
    for (const rel of listFilesRel(GOLDEN_DIR)) {
      const expected = norm(readFileSync(path.join(GOLDEN_DIR, rel), "utf-8"));
      const actual = norm(readFileSync(path.join(tmpRoot, "extracted", rel), "utf-8"));
      assert.equal(actual, expected, `extracted/${rel} differs from the committed golden`);
    }
  });
});
