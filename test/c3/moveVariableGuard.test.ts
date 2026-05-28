import { describe, it, after } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyRecipeInner } from "../../src/c3/recipeApplier.js";

// The demotion safety guard in recipeApplier runs before the dry-run branch, so
// applyRecipeInner({ dryRun: true }) exercises it without SID context or
// regeneration. These tests build a minimal temp project on disk.

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makeProject(sheets: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "c3-movevar-guard-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
  for (const [name, json] of Object.entries(sheets)) {
    writeFileSync(path.join(dir, "eventSheets", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
  }
  return dir;
}

const noop = () => {};

// "Globals" sheet: a global variable `score` at the root, plus a group to
// demote it into.
function globalsSheet() {
  return {
    name: "Globals",
    sid: 900000000000001,
    events: [
      { eventType: "variable", name: "score", type: "number", initialValue: "0", isStatic: true, isConstant: false, sid: 100000000000001 },
      {
        eventType: "group",
        title: "G",
        description: "",
        disabled: false,
        isActiveOnStart: true,
        sid: 100000000000002,
        children: [{ eventType: "block", conditions: [], actions: [], sid: 100000000000003 }],
      },
    ],
  };
}

function sheetWithScript(name: string, sid: number, line: string) {
  return {
    name,
    sid,
    events: [
      {
        eventType: "block",
        conditions: [],
        actions: [{ type: "script", language: "typescript", script: [line] }],
        sid: 100000000000010,
      },
    ],
  };
}

const demoteRecipe = {
  files: {
    Globals: [{ op: "move-variable", variable: "sid:100000000000001", to: "sid:100000000000002" }],
  },
};

describe("move-variable demotion guard (recipeApplier)", () => {
  it("refuses demotion when the global is referenced in another sheet", () => {
    const dir = makeProject({
      Globals: globalsSheet(),
      Other: sheetWithScript("Other", 900000000000002, "runtime.globalVars.score = 5;"),
    });
    assert.throws(
      () => applyRecipeInner(dir, demoteRecipe, { dryRun: true, regenerate: false, log: noop }),
      /cannot demote global variable "score".*referenced in 1 other event sheet\(s\): eventSheets[\\/]Other\.json/,
    );
  });

  it("allows demotion when the global is confined to the target sheet", () => {
    const dir = makeProject({
      Globals: globalsSheet(),
      Other: sheetWithScript("Other", 900000000000002, "runtime.globalVars.health = 5;"),
    });
    assert.doesNotThrow(() => applyRecipeInner(dir, demoteRecipe, { dryRun: true, regenerate: false, log: noop }));
  });

  it("does not run the cross-sheet scan for a promotion (to: root)", () => {
    // A promotion must not be blocked even when the same name appears elsewhere.
    const promoteRecipe = {
      files: {
        Globals: [{ op: "move-variable", variable: "sid:100000000000003", to: "root" }],
      },
    };
    // Make the variable local first (nested in the group) so promotion is valid.
    const local = {
      name: "Globals",
      sid: 900000000000001,
      events: [
        {
          eventType: "group",
          title: "G",
          description: "",
          disabled: false,
          isActiveOnStart: true,
          sid: 100000000000002,
          children: [
            { eventType: "variable", name: "score", type: "number", initialValue: "0", isStatic: false, isConstant: false, sid: 100000000000003 },
          ],
        },
      ],
    };
    const dir = makeProject({
      Globals: local,
      Other: sheetWithScript("Other", 900000000000002, "runtime.globalVars.score = 5;"),
    });
    assert.doesNotThrow(() => applyRecipeInner(dir, promoteRecipe, { dryRun: true, regenerate: false, log: noop }));
  });
});
