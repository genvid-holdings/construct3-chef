import { describe, it, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GENERATORS } from "../../src/c3/generators.js";

/**
 * #178 (RED step). Every entry in `GENERATORS` is supposed to create its own
 * `outDir` when handed one that does not exist yet — `regenerate` (and its
 * MCP/CLI callers) must not depend on generator run order to get a directory
 * to write into. `generateTemplateScope` currently breaks this: it writes
 * `path.join(outDir, "template-scope.txt")` with no `mkdirSync` first, so it
 * only "works" today because `extractScripts` happens to run before it and
 * creates `outDir` as a side effect.
 *
 * This test is committed RED, before that fix (landing later in the same
 * plan), so the red state is a structural artifact in git history rather
 * than a claim. At this commit the shape is exactly 1 failing (`templates`)
 * / 5 passing — the five passing siblings are the POSITIVE CONTROL: they
 * prove the harness genuinely exercises the "creates its own outDir"
 * property (a broken harness would pass all six vacuously), so the one
 * failure is a real signal from `generateTemplateScope`, not a fluke of the
 * test setup.
 *
 * CAVEAT — read before treating a green `scripts` case as health evidence:
 * `seedProject` below writes `scripts/importsForEvents.ts` purely so
 * `extractScripts` can run far enough to reach its own `mkdirSync(outDir)`
 * call at all (it reads that file, unguarded, five lines earlier). Without
 * it, the `scripts` case fails on a missing *input* file, not a missing
 * *output* dir, and proves nothing about this property. `extractScripts`
 * still cannot run on a real project that lacks `importsForEvents.ts`
 * (issue #181, out of scope here) — this test seeds around that gap, it
 * does not close it. Do not read the `scripts` case passing as evidence
 * that `extractScripts` is healthy in general.
 *
 * The loop below drives off `GENERATORS` itself rather than a hand-listed
 * set of the six generator functions, so a seventh generator added to the
 * inventory later is covered automatically with no edit to this file.
 *
 * Property under test: each generator creates its own `outDir`, so
 * correctness does not depend on some other generator (`extractScripts`)
 * happening to run first and create the directory as a side effect — which
 * is exactly what `--only templates` (or any generator reordering) breaks.
 */
describe("generator outDir self-sufficiency (#178)", () => {
  const noop = () => {};
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  /**
   * Seed a throwaway C3 project root with the minimum every generator in
   * `GENERATORS` needs to run: `project.c3proj`, one valid layout, one valid
   * objectType, an empty `eventSheets/` dir, and `scripts/importsForEvents.ts`
   * (required by `extractScripts`, see the caveat above). Deliberately does
   * NOT pre-create `extracted/` — that absence is the whole point of the test.
   */
  function seedProject(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "c3chef-outdir-"));

    writeFileSync(path.join(root, "project.c3proj"), JSON.stringify({}, null, "\t"));

    const layoutsDir = path.join(root, "layouts");
    mkdirSync(layoutsDir, { recursive: true });
    writeFileSync(
      path.join(layoutsDir, "MainLayout.json"),
      JSON.stringify({ name: "MainLayout", eventSheet: "MainEvents", layers: [] }),
    );

    const objectTypesDir = path.join(root, "objectTypes");
    mkdirSync(objectTypesDir, { recursive: true });
    writeFileSync(path.join(objectTypesDir, "Hero.json"), JSON.stringify({ name: "Hero", "plugin-id": "Sprite" }));

    mkdirSync(path.join(root, "eventSheets"), { recursive: true });

    const scriptsDir = path.join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(path.join(scriptsDir, "importsForEvents.ts"), "");

    return root;
  }

  for (const gen of GENERATORS) {
    it(`${gen.name} creates its own outDir when it does not exist`, () => {
      tmpDir = seedProject();
      const outDir = path.join(tmpDir, "extracted");
      gen.run(tmpDir, outDir, noop);
      assert.isTrue(existsSync(outDir), `${gen.name} did not create ${outDir}`);
    });
  }
});
