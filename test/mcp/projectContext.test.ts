import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReadWriteLock, ExpectedChanges } from "@genvidtech/mcp-utils";
import { createProjectContext, ProjectContext } from "../../src/mcp/projectContext.js";
import { GENERATORS } from "../../src/c3/generators.js";

/**
 * ProjectContext is the per-project state container that replaces server.ts's
 * seven module-level globals (#95). These tests cover composition
 * (createProjectContext wires the right pieces from a root) and the
 * getter-only atomicity guarantee (T-A2) that keeps root/extractedDir/project
 * from ever going stale relative to one another.
 */
describe("ProjectContext / createProjectContext", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-projectContext-"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("derives extractedDir from the default chef config (extracted/)", async () => {
    const ctx = await createProjectContext("proj", root);
    expect(ctx.id).to.equal("proj");
    expect(ctx.root).to.equal(root);
    expect(ctx.extractedDir).to.equal(path.join(root, "extracted"));
  });

  it("honors a construct3-chef.config.json extractedDir override", async () => {
    fs.writeFileSync(path.join(root, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "out" }));
    const ctx = await createProjectContext("proj", root);
    expect(ctx.extractedDir).to.equal(path.join(root, "out"));
  });

  it("honors an explicit overrides argument over the config file", async () => {
    fs.writeFileSync(path.join(root, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "out" }));
    const ctx = await createProjectContext("proj", root, { extractedDir: "override-dir" });
    expect(ctx.extractedDir).to.equal(path.join(root, "override-dir"));
  });

  it("opens a C3Project handle rooted at the same path", async () => {
    const ctx = await createProjectContext("proj", root);
    expect(ctx.project.root).to.equal(root);
  });

  it("constructs its own ReadWriteLock and ExpectedChanges instances", async () => {
    const ctx = await createProjectContext("proj", root);
    expect(ctx.rwlock).to.be.instanceOf(ReadWriteLock);
    expect(ctx.expected).to.be.instanceOf(ExpectedChanges);
  });

  it("derives generatorSteps from the shared GENERATORS inventory, one per entry", async () => {
    const ctx = await createProjectContext("proj", root);
    expect(ctx.generatorSteps).to.have.lengthOf(GENERATORS.length);
    expect(ctx.generatorSteps.map((s) => s.name)).to.deep.equal(GENERATORS.map((g) => g.label));
  });

  it("starts extractedDirty false, with watcher/ops left unassigned for the caller to wire", async () => {
    const ctx = await createProjectContext("proj", root);
    expect(ctx.extractedDirty).to.equal(false);
  });

  it("extractedDirty, watcher, and ops are mutable", async () => {
    const ctx = await createProjectContext("proj", root);
    expect(() => {
      ctx.extractedDirty = true;
    }).not.to.throw();
    expect(ctx.extractedDirty).to.equal(true);
    expect(() => {
      // watcher/ops are declared `!:` (definite assignment) precisely so the
      // caller can wire them up after construction — assignment must succeed.
      (ctx as unknown as { watcher: unknown }).watcher = {};
      (ctx as unknown as { ops: unknown }).ops = {};
    }).not.to.throw();
  });

  // ── T-A2: getter-only atomicity guarantee ──────────────────────────────────
  //
  // root/extractedDir/project/id (and, for full measure, rwlock/expected/config)
  // must have NO setter on the prototype, and assigning to any of them must
  // throw TypeError at runtime (ESM modules are always strict, so this is a
  // real runtime guarantee, not just a compile-time readonly check).
  describe("getter-only atomicity (T-A2)", () => {
    let ctx: ProjectContext;

    beforeEach(async () => {
      ctx = await createProjectContext("proj", root);
    });

    const accessors = ["id", "root", "extractedDir", "project", "rwlock", "expected", "config"] as const;

    for (const key of accessors) {
      it(`${key} has no setter on the prototype`, () => {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), key);
        expect(descriptor, `expected a getter descriptor for ${key}`).to.exist;
        expect(descriptor!.set).to.equal(undefined);
      });

      it(`assigning to ${key} throws TypeError`, () => {
        expect(() => {
          (ctx as unknown as Record<string, unknown>)[key] = "mutated";
        }).to.throw(TypeError);
      });
    }
  });
});
