import { describe, it, beforeEach } from "mocha";
import { assert } from "chai";
import type { EventSheet, BlockEvent, EventSheetVariable } from "c3source";
import { diffScripts } from "../../src/c3/previewDiff.js";
import { buildBlock, buildScriptAction } from "../../src/c3/eventSheetMutator.js";
import { freshSidGen, type SidGenerator } from "../../src/c3/sidUtils.js";

// Module-scope binding so the `makeBlockWithScript` helper below can close over it.
// The `beforeEach` that reassigns it lives inside the describe (so the hook is scoped).
let sidGen: SidGenerator;

function makeSheet(events: EventSheet["events"]): EventSheet {
  return { name: "Test", events, sid: 1 };
}

function makeVariable(name: string, sid: number): EventSheetVariable {
  return { eventType: "variable", name, type: "string", initialValue: "", isStatic: false, isConstant: false, sid };
}

function makeBlockWithScript(sid: number, scriptLines: string[]): BlockEvent {
  return { ...buildBlock(sidGen, { actions: [buildScriptAction({ script: scriptLines })] }), sid };
}

describe("previewDiff", () => {
  beforeEach(() => {
    sidGen = freshSidGen();
  });

  describe("diffScripts", () => {
    it("detects script changes in matching events", () => {
      const orig = makeSheet([makeBlockWithScript(100, ["const x = 1;"])]);
      const mod = makeSheet([makeBlockWithScript(100, ["const x = 2;"])]);

      const lines = diffScripts("test.json", orig, mod);
      assert.isNotEmpty(lines);
      assert.include(lines.join("\n"), "- const x = 1;");
      assert.include(lines.join("\n"), "+ const x = 2;");
    });

    it("reports no changes for identical scripts", () => {
      const orig = makeSheet([makeBlockWithScript(100, ["const x = 1;"])]);
      const mod = makeSheet([makeBlockWithScript(100, ["const x = 1;"])]);

      const lines = diffScripts("test.json", orig, mod);
      assert.isEmpty(lines);
    });

    it("pairs events by SID, not position, when variable insertion shifts indices", () => {
      // Original: [blockA(sid=100, script="aaa"), blockB(sid=200, script="bbb")]
      const blockA = makeBlockWithScript(100, ["aaa"]);
      const blockB = makeBlockWithScript(200, ["bbb"]);
      const orig = makeSheet([blockA, blockB]);

      // Modified: [newVar(sid=0), blockA(sid=100, script="aaa"), blockB(sid=200, script="bbb modified")]
      const newVar = makeVariable("overrideKeysJson", 0);
      const blockAUnchanged = makeBlockWithScript(100, ["aaa"]);
      const blockBModified = makeBlockWithScript(200, ["bbb modified"]);
      const mod = makeSheet([newVar, blockAUnchanged, blockBModified]);

      const lines = diffScripts("test.json", orig, mod);

      // Should only show the actual change to blockB, not position-based false diffs
      const output = lines.join("\n");
      assert.include(output, "- bbb");
      assert.include(output, "+ bbb modified");
      // Should NOT show blockA's script as removed (old bug: position 0 orig vs position 0 mod = variable)
      assert.notInclude(output, "- aaa");
    });

    it("skips inserted events with SID 0", () => {
      const orig = makeSheet([makeBlockWithScript(100, ["original"])]);
      const newVar = makeVariable("newVar", 0);
      const mod = makeSheet([newVar, makeBlockWithScript(100, ["original"])]);

      const lines = diffScripts("test.json", orig, mod);
      assert.isEmpty(lines); // No script changes, just a shifted position
    });

    it("uses modified indices in path output", () => {
      // Block at position 0 in original, position 1 in modified (shifted by inserted variable)
      const orig = makeSheet([makeBlockWithScript(100, ["old line"])]);
      const newVar = makeVariable("v", 0);
      const mod = makeSheet([newVar, makeBlockWithScript(100, ["new line"])]);

      const lines = diffScripts("test.json", orig, mod);
      // Path should reference the modified position (events[1]), not the original (events[0])
      assert.include(lines[0], "events[1]");
    });

    it("handles nested children with SID-based pairing", () => {
      const childBlock = makeBlockWithScript(300, ["child script"]);
      const parentOrig: BlockEvent = {
        ...buildBlock(sidGen),
        sid: 100,
        children: [childBlock],
      };
      const orig = makeSheet([parentOrig]);

      const childModified = makeBlockWithScript(300, ["child script modified"]);
      const parentMod: BlockEvent = {
        ...buildBlock(sidGen),
        sid: 100,
        children: [childModified],
      };
      const mod = makeSheet([parentMod]);

      const lines = diffScripts("test.json", orig, mod);
      const output = lines.join("\n");
      assert.include(output, "- child script");
      assert.include(output, "+ child script modified");
    });
  });
});
