import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __getHandler, __setRegistry, __resetTestState } from "../../src/mcp/server.js";
import { createProjectContext } from "../../src/mcp/projectContext.js";
import { ProjectRegistry } from "../../src/mcp/projectRegistry.js";

/**
 * R2 (#211) — the `navigation-graph` handler resolves its nav convention from
 * the config its ProjectContext loaded at construction (`ctx.config`), not from
 * a fresh per-call `loadChefConfig(ctx.root)`.
 *
 * Why this shape rather than the obvious "the handler uses ctx.config" guard:
 * that guard is green from birth. No test in this repo exercises a `navigation`
 * block through the MCP handler, and there is no `construct3-chef.config.json`
 * anywhere in the tree — so both code paths resolve to `defaultNavConvention()`
 * and agree. That agreement is exactly why the defect went unnoticed.
 *
 * What separates them is the `overrides` argument. `createProjectContext(id,
 * root, overrides)` merges overrides into the loaded config; the per-call
 * reload passes none and structurally cannot see them. So a context built with
 * a `navigation` override that DIVERGES from the on-disk file distinguishes the
 * two: the file's convention wins before the fix, the override's after.
 *
 * The DSL fixture below carries one line matching each convention, so the
 * assertion is two-sided — the expected target present AND the other absent.
 * A one-sided assertion would pass on an empty result set.
 *
 * Deliberately built through `createProjectContext` + `__setRegistry` rather
 * than `__setProjectRoot`: that seam hardcodes DEFAULT_CHEF_CONFIG, which can
 * never carry a `navigation` block, so it cannot express this case at all.
 * Same reasoning as server.wiring.test.ts's T-W1 — drive the real construction
 * path, don't hand the harness the answer.
 */
describe("navigation config lifetime (#211, R2)", () => {
  let root: string;

  const FILE_CONVENTION = { targetPatterns: ["FILE_NAV\\(([^)]+)\\)"] };
  const OVERRIDE_CONVENTION = { targetPatterns: ["OVERRIDE_NAV\\(([^)]+)\\)"] };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nav-lifetime-"));

    // The on-disk config: what a per-call reload would pick up.
    fs.writeFileSync(
      path.join(root, "construct3-chef.config.json"),
      JSON.stringify({ navigation: FILE_CONVENTION }, null, 2),
    );

    // buildLayoutEventSheetMap walks this; empty is fine, missing may not be.
    fs.mkdirSync(path.join(root, "layouts"), { recursive: true });

    // One line per convention, so the assertion can be two-sided.
    const extracted = path.join(root, "extracted");
    fs.mkdirSync(extracted, { recursive: true });
    fs.writeFileSync(
      path.join(extracted, "nav.dsl.txt"),
      ["# Test Sheet", "FILE_NAV(FileTargetLayout)", "OVERRIDE_NAV(OverrideTargetLayout)", ""].join("\n"),
    );
  });

  afterEach(() => {
    __resetTestState();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("applies the context's navigation OVERRIDE, not the on-disk config file", async () => {
    const ctx = await createProjectContext("navcfg", root, { navigation: OVERRIDE_CONVENTION });

    // Precondition: the two conventions really do diverge in the context, so a
    // pass cannot come from them having collapsed to the same value.
    expect(ctx.config.navigation?.targetPatterns, "precondition: context carries the override").to.deep.equal(
      OVERRIDE_CONVENTION.targetPatterns,
    );

    const registry = new ProjectRegistry();
    registry.add(ctx);
    __setRegistry(registry);

    const handler = __getHandler("navigation-graph")!;
    expect(handler).to.exist;

    const result = (await handler({ project: "navcfg" }, { signal: new AbortController().signal })) as any;

    expect(result.isError, result.content?.[0]?.text).to.be.undefined;
    const text: string = result.content[0].text;

    expect(text, text).to.include("OverrideTargetLayout");
    expect(text, text).to.not.include("FileTargetLayout");
  });
});
