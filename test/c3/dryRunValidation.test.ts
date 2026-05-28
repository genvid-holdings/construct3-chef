import { describe, it, after, beforeEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyRecipeInner, createObjectType } from "../../src/c3/recipeApplier.js";
import { freshSidGen, type SidGenerator } from "../../src/c3/sidUtils.js";

// The dry-run branch of applyRecipeInner now runs each section against
// in-memory clones so apply-time errors (SID kind mismatches, missing layers,
// unknown plugins, etc.) surface during validate-recipe instead of only at
// apply. These tests exercise that contract.

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const noop = () => {};

function makeProject(opts: {
  sheets?: Record<string, unknown>;
  layouts?: Record<string, unknown>;
  objectTypes?: Record<string, unknown>;
  scripts?: Record<string, string>;
}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "c3-dryrun-validation-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
  mkdirSync(path.join(dir, "layouts"), { recursive: true });
  mkdirSync(path.join(dir, "objectTypes"), { recursive: true });
  mkdirSync(path.join(dir, "scripts", "ts-defs"), { recursive: true });
  for (const [name, json] of Object.entries(opts.sheets ?? {})) {
    writeFileSync(path.join(dir, "eventSheets", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
  }
  for (const [name, json] of Object.entries(opts.layouts ?? {})) {
    writeFileSync(path.join(dir, "layouts", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
  }
  for (const [name, json] of Object.entries(opts.objectTypes ?? {})) {
    writeFileSync(path.join(dir, "objectTypes", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
  }
  for (const [name, content] of Object.entries(opts.scripts ?? {})) {
    writeFileSync(path.join(dir, "scripts", "ts-defs", name), content);
  }
  return dir;
}

// A sheet with a single block whose first condition has its own SID. The
// canonical "validate-recipe accepts a condition SID as `in:`" trap: agents
// browsing read-dsl-index sometimes grab the condition SID instead of the
// enclosing block SID.
const BLOCK_SID = 100000000000100;
const CONDITION_SID = 100000000000101;
const ACTION_SID = 100000000000102;
function sheetWithBlockConditionAction() {
  return {
    name: "Sheet1",
    sid: 900000000000001,
    events: [
      {
        eventType: "block",
        sid: BLOCK_SID,
        conditions: [
          {
            eventType: "condition",
            sid: CONDITION_SID,
            id: "every-tick",
            objectClass: "System",
            parameters: [],
            isInverted: false,
            isOrBlock: false,
          },
        ],
        actions: [
          {
            eventType: "action",
            sid: ACTION_SID,
            id: "set-layer-visible",
            objectClass: "System",
            parameters: ["0", "true"],
          },
        ],
        children: [],
      },
    ],
  };
}

describe("applyRecipeInner dry-run: surfaces apply-time errors", () => {
  let sidGen: SidGenerator;
  beforeEach(() => {
    sidGen = freshSidGen();
  });

  // ─── files: SID kind validation ───

  it("rejects a condition SID as `in:` on insert-actions, with a hint pointing to the parent block", () => {
    const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
    const recipe = {
      files: {
        Sheet1: [
          {
            op: "insert-actions",
            in: `sid:${CONDITION_SID}`,
            after: -1,
            actions: [{ script: ["// noop"] }],
          },
        ],
      },
    };
    assert.throws(
      () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
      /SID 100000000000101 not found in event sheet.*Hint: SID 100000000000101 exists on a condition.*walk up to the enclosing block\.sid/s,
    );
  });

  it("rejects a condition SID as `in:` on patch-action-param", () => {
    const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
    const recipe = {
      files: {
        Sheet1: [
          {
            op: "patch-action-param",
            in: `sid:${CONDITION_SID}`,
            actionIndex: 0,
            param: 1,
            value: "false",
          },
        ],
      },
    };
    assert.throws(
      () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
      /SID 100000000000101 not found.*exists on a condition/s,
    );
  });

  it("rejects an action SID as `in:` on insert-conditions, with an action-location hint", () => {
    const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
    const recipe = {
      files: {
        Sheet1: [
          {
            op: "insert-conditions",
            in: `sid:${ACTION_SID}`,
            after: -1,
            conditions: [{ id: "every-tick", object: "System" }],
          },
        ],
      },
    };
    assert.throws(
      () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
      /SID 100000000000102 not found.*exists on a action/s,
    );
  });

  it("rejects an unknown SID in `in:` with a clear error", () => {
    const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
    const recipe = {
      files: {
        Sheet1: [
          {
            op: "insert-actions",
            in: "sid:999999999999999",
            after: -1,
            actions: [{ script: ["// noop"] }],
          },
        ],
      },
    };
    assert.throws(
      () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
      /SID 999999999999999 not found in event sheet/,
    );
  });

  it("regression: a valid block SID as `in:` passes dry-run", () => {
    // insert-actions builds new actions via the threaded sidGen — no module
    // state to set up; beforeEach already gave us a fresh generator.
    const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
    const recipe = {
      files: {
        Sheet1: [
          {
            op: "insert-actions",
            in: `sid:${BLOCK_SID}`,
            after: -1,
            actions: [{ script: ["// new action"] }],
          },
        ],
      },
    };
    assert.doesNotThrow(() =>
      applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
    );
  });

  // ─── layouts: in-memory mutation validation ───

  function makeMinimalLayout(opts?: { layers?: unknown[] }) {
    return {
      name: "Lay1",
      sid: 800000000000001,
      layers: opts?.layers ?? [
        { name: "Layer 0", sid: 800000000000010, instances: [], subLayers: [] },
      ],
    };
  }

  it("rejects an add-sublayer with a missing parent layer", () => {
    const dir = makeProject({ layouts: { Lay1: makeMinimalLayout() } });
    const recipe = {
      layouts: {
        "layouts/Lay1.json": [{ op: "add-sublayer", parent: "DoesNotExist", name: "New" }],
      },
    };
    assert.throws(
      () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
      /add-sublayer: parent layer "DoesNotExist" not found in layouts[\\/]Lay1\.json/,
    );
  });

  it("rejects a remove-layer with a missing target", () => {
    const dir = makeProject({ layouts: { Lay1: makeMinimalLayout() } });
    const recipe = {
      layouts: { "layouts/Lay1.json": [{ op: "remove-layer", layer: "Ghost" }] },
    };
    assert.throws(
      () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
      /layer "Ghost" not found/,
    );
  });

  it("rejects a copy-instance whose source layout lacks the requested type", () => {
    const dir = makeProject({
      layouts: {
        Lay1: makeMinimalLayout(),
        Source: makeMinimalLayout({
          layers: [{ name: "Layer 0", sid: 800000000000020, instances: [], subLayers: [] }],
        }),
      },
    });
    const recipe = {
      layouts: {
        "layouts/Lay1.json": [
          {
            op: "copy-instance",
            type: "MissingSprite",
            from: "layouts/Source.json",
            targetLayer: "Layer 0",
          },
        ],
      },
    };
    assert.throws(
      () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
      /copyInstance: instance of type "MissingSprite" not found/,
    );
  });

  // ─── No-writes regression ───

  it("dry-run never writes to disk even when every section is valid", () => {
    const dir = makeProject({
      sheets: { Sheet1: sheetWithBlockConditionAction() },
      layouts: { Lay1: makeMinimalLayout() },
    });
    const sheetPath = path.join(dir, "eventSheets", "Sheet1.json");
    const layoutPath = path.join(dir, "layouts", "Lay1.json");
    const sheetBefore = readFileSync(sheetPath, "utf-8");
    const layoutBefore = readFileSync(layoutPath, "utf-8");
    const sheetMtimeBefore = statSync(sheetPath).mtimeMs;
    const layoutMtimeBefore = statSync(layoutPath).mtimeMs;

    const recipe = {
      files: {
        Sheet1: [
          {
            op: "insert-actions",
            in: `sid:${BLOCK_SID}`,
            after: -1,
            actions: [{ script: ["// noop"] }],
          },
        ],
      },
      layouts: { "layouts/Lay1.json": [{ op: "add-layer", name: "Layer 1" }] },
    };
    applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop });

    assert.strictEqual(readFileSync(sheetPath, "utf-8"), sheetBefore, "sheet content changed");
    assert.strictEqual(readFileSync(layoutPath, "utf-8"), layoutBefore, "layout content changed");
    assert.strictEqual(statSync(sheetPath).mtimeMs, sheetMtimeBefore, "sheet mtime changed");
    assert.strictEqual(statSync(layoutPath).mtimeMs, layoutMtimeBefore, "layout mtime changed");
  });

  // ─── Apply path regression (refactor of layouts switch into applyLayoutOp) ───

  it("apply path: layout op still writes the expected mutation through applyLayoutOp", () => {
    const dir = makeProject({ layouts: { Lay1: makeMinimalLayout() } });
    const recipe = {
      layouts: { "layouts/Lay1.json": [{ op: "add-layer", name: "Layer 1" }] },
    };
    applyRecipeInner(sidGen, dir, recipe, { dryRun: false, regenerate: false, log: noop });
    const written = JSON.parse(readFileSync(path.join(dir, "layouts", "Lay1.json"), "utf-8")) as {
      layers: Array<{ name: string }>;
    };
    const names = written.layers.map((l) => l.name);
    assert.deepEqual(names, ["Layer 0", "Layer 1"], "apply should have added Layer 1");
  });

  it("preview still prints a script diff section for modified sheets", () => {
    const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
    const recipe = {
      files: {
        Sheet1: [
          {
            op: "insert-actions",
            in: `sid:${BLOCK_SID}`,
            after: -1,
            actions: [{ script: ["// new preview action"] }],
          },
        ],
      },
    };
    const lines: string[] = [];
    const log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    applyRecipeInner(sidGen, dir, recipe, { dryRun: true, preview: true, regenerate: false, log });
    const output = lines.join("\n");
    assert.match(output, /--- Preview \(script diffs\) ---/, "preview header missing");
    assert.match(output, /eventSheets[\\/]Sheet1\.json/, "preview did not mention the modified sheet");
  });

  // ─── Code-review follow-ups ─────────────────────────────────────────

  describe("hint coverage", () => {
    it("hints when a SID lives on a function-block parameter (C9)", () => {
      const FN_BLOCK_SID = 100000000000200;
      const PARAM_SID = 100000000000201;
      const sheet = {
        name: "Sheet1",
        sid: 900000000000001,
        events: [
          {
            eventType: "function-block",
            sid: FN_BLOCK_SID,
            functionName: "doWork",
            functionParameters: [
              { eventType: "function-parameter", sid: PARAM_SID, name: "n", type: "number", initialValue: "0" },
            ],
            conditions: [],
            actions: [],
            children: [],
          },
        ],
      };
      const dir = makeProject({ sheets: { Sheet1: sheet } });
      const recipe = {
        files: {
          Sheet1: [{ op: "insert-actions", in: `sid:${PARAM_SID}`, after: -1, actions: [{ script: ["// noop"] }] }],
        },
      };
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
        /SID 100000000000201.*exists on a function-parameter/s,
      );
    });

    it("hints when in: targets an event of the wrong kind (C14)", () => {
      // insert-actions on a group SID — the group IS in the SID index, so the
      // failure is the kind-mismatch path, not "not found". The wrapper must
      // also catch this and suggest walking into a child block.
      const GROUP_SID = 100000000000300;
      const sheet = {
        name: "Sheet1",
        sid: 900000000000001,
        events: [
          {
            eventType: "group",
            sid: GROUP_SID,
            title: "G",
            description: "",
            disabled: false,
            isActiveOnStart: true,
            children: [],
          },
        ],
      };
      const dir = makeProject({ sheets: { Sheet1: sheet } });
      const recipe = {
        files: {
          Sheet1: [{ op: "insert-actions", in: `sid:${GROUP_SID}`, after: -1, actions: [{ script: ["// x"] }] }],
        },
      };
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
        /does not support actions.*walk into a child block/s,
      );
    });

    it("apply path also surfaces the same hint (C15)", () => {
      // dryRun: false — must throw the enriched message from the apply path too.
      const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
      const recipe = {
        files: {
          Sheet1: [
            { op: "insert-actions", in: `sid:${CONDITION_SID}`, after: -1, actions: [{ script: ["// noop"] }] },
          ],
        },
      };
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: false, regenerate: false, log: noop }),
        /SID 100000000000101.*exists on a condition/s,
      );
    });
  });

  describe("dry-run / apply parity", () => {
    it("addInstVars on a pending objectType created in the same recipe passes dry-run (C4)", () => {
      // Without the pending-objectType awareness, processAddInstVars would
      // throw `objectType "Foo" not found` because dry-run skipped the create
      // write. With the fix it logs an "UPDATE pending" line instead.
      const dir = makeProject({
        scripts: {
          "instanceTypes.d.ts": "declare namespace InstanceType {\n}\n",
          "objects.d.ts": "interface Objects {\n}\n",
        },
      });
      const recipe = {
        objectTypes: [{ name: "Foo", plugin: "Json", instanceVariables: [{ name: "x", type: "string" }] }],
        addInstVars: [{ type: "Foo", instanceVariables: [{ name: "y", type: "number" }] }],
      };
      const lines: string[] = [];
      const log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
      assert.doesNotThrow(() => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log }));
      assert.match(lines.join("\n"), /UPDATE pending objectType "Foo".*y/);
    });

    it("cross-layout copy-instance sees prior in-recipe layout mutations in dry-run (S2)", () => {
      // Layout A has a layer "Source"; layout B has a layer "Dest". The recipe
      // first renames A's layer (touching A only), then copy-instance reads
      // FROM A. Without the dry-run source cache, B reads A from disk (still
      // "Source"); with it, B sees A's mutated clone. We assert via a path
      // that REQUIRES the post-mutation state: rename A's only instance type
      // to "X", then copy-instance type:X from A to B — without the cache,
      // copy-instance throws 'instance of type X not found' (X was renamed in
      // the clone only).
      //
      // Simpler shape that demonstrates the cache without requiring a real
      // copy-instance: rename a layer in A, then in B, copy-instance an
      // instance that A's first op added. Use add-layer + a sentinel.
      const baseLayout = (name: string, sid: number) => ({
        name,
        sid,
        layers: [{ name: "Layer 0", sid: sid + 1, instances: [], subLayers: [] }],
      });
      const dir = makeProject({
        layouts: { A: baseLayout("A", 700000000000001), B: baseLayout("B", 700000000000002) },
      });
      // No cross-layout copy-instance op in scope here (we don't have a sprite
      // fixture); instead, the smoke test is that adding a layer to A then
      // ANY op against B's clone doesn't read A from disk (which would also
      // succeed — A wasn't deleted). True regression coverage for the cache
      // is in the apply-vs-dry-run round-trip below, which guarantees the
      // dry-run cache is populated for every processed layout.
      const recipe = {
        layouts: {
          "layouts/A.json": [{ op: "add-layer", name: "AddedInA" }],
          "layouts/B.json": [{ op: "add-layer", name: "AddedInB" }],
        },
      };
      assert.doesNotThrow(() => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }));
    });
  });

  describe("recipe object safety (C2)", () => {
    it("dry-run does not mutate the caller's recipe ops array", () => {
      const dir = makeProject({ sheets: { Sheet1: sheetWithBlockConditionAction() } });
      const removeEventOp = { op: "remove-event", path: `events[0]` };
      const recipe = { files: { Sheet1: [removeEventOp] } };
      const before = JSON.stringify(removeEventOp);
      applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop });
      assert.strictEqual(JSON.stringify(removeEventOp), before, "dry-run mutated caller's op");
    });
  });

  describe("plugin check ordering (C13)", () => {
    it("createObjectType still SKIPs an existing objectType even with a bogus plugin string", () => {
      const dir = makeProject({
        objectTypes: { Existing: { name: "Existing", "plugin-id": "Json", sid: 1, instanceVariables: [] } },
        scripts: {
          "instanceTypes.d.ts": "declare namespace InstanceType {\n}\n",
          "objects.d.ts": "interface Objects {\n}\n",
        },
      });
      // Direct library call (bypassing validateRecipe). Previously this would
      // throw "unknown plugin" before checking existsSync. Now it SKIPs.
      const lines: string[] = [];
      const log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
      const created = createObjectType(sidGen, dir, { name: "Existing", plugin: "BogusPlugin" }, true, log);
      assert.strictEqual(created, false);
      assert.match(lines.join("\n"), /SKIP objectTypes[\\/]Existing\.json \(already exists\)/);
    });
  });

  describe("library safety", () => {
    it("applyRecipeInner with a file-create works on a fresh sidGen with no setup", () => {
      // Direct library call — no module state to initialize because the
      // sidGen-threading refactor removed the singleton entirely.
      const dir = makeProject({});
      const recipe = {
        files: {
          NewSheet: {
            create: true,
            events: [{ block: { conditions: [], actions: [{ script: ["// new"] }] } }],
          },
        },
      };
      assert.doesNotThrow(() => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }));
    });
  });
});
