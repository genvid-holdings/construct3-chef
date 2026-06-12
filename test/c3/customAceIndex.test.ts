import { describe, it } from "mocha";
import { assert } from "chai";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { EventSheet } from "@genvid/c3source";
import type { CustomAceIndex } from "../../src/c3/customAceIndex.js";
import { buildCustomAceIndex, validateInsertedCustomActions } from "../../src/c3/customAceIndex.js";

// ─── Test helpers ───

/** Build a minimal EventSheet with no events (used as original/modified base). */
function emptySheet(name = "TestSheet"): EventSheet {
  return { name, events: [], sid: 0 };
}

/**
 * Build an EventSheet that contains a single block event whose actions array
 * holds the given custom-action objects verbatim.
 */
function sheetWithCustomActions(
  actions: Array<{ customAction: string; objectClass: string; sid: number; customActionObjectClass?: string }>,
): EventSheet {
  return {
    name: "TestSheet",
    sid: 0,
    events: [
      {
        eventType: "block",
        sid: 9000,
        conditions: [],
        actions: actions as unknown as [],
      },
    ],
  };
}

/**
 * Build a hand-wired `CustomAceIndex` from plain data, without touching the disk.
 *
 * @param aces    `[objectClass, aceName]` pairs that ARE defined.
 * @param families  `{ familyName: memberNames[] }` membership map.
 */
function buildTestIndex(aces: Array<[string, string]>, families: Record<string, string[]> = {}): CustomAceIndex {
  const aceMap = new Map<string, Set<string>>();
  for (const [oc, name] of aces) {
    let s = aceMap.get(oc);
    if (!s) {
      s = new Set();
      aceMap.set(oc, s);
    }
    s.add(name);
  }

  const familyToMembers = new Map<string, Set<string>>();
  const memberToFamilies = new Map<string, Set<string>>();
  for (const [fam, members] of Object.entries(families)) {
    const ms = new Set(members);
    familyToMembers.set(fam, ms);
    for (const m of members) {
      let fs2 = memberToFamilies.get(m);
      if (!fs2) {
        fs2 = new Set();
        memberToFamilies.set(m, fs2);
      }
      fs2.add(fam);
    }
  }

  const emptySet: ReadonlySet<string> = new Set();
  return {
    hasAce: (oc, n) => aceMap.get(oc)?.has(n) ?? false,
    familiesOf: (oc) => memberToFamilies.get(oc) ?? emptySet,
    membersOf: (fam) => familyToMembers.get(fam) ?? emptySet,
  };
}

// ─── Pure validator tests ───

describe("validateInsertedCustomActions", () => {
  it("returns no errors when action is defined directly on objectClass (no family)", () => {
    const index = buildTestIndex([["CardScroller", "Initialize"]]);
    const original = emptySheet();
    const modified = sheetWithCustomActions([{ customAction: "Initialize", objectClass: "CardScroller", sid: 1001 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });

  it("returns error with family hint when action is on a family but no family key is set", () => {
    const index = buildTestIndex(
      [["Movables", "Move"]], // 'Move' is defined on family 'Movables', NOT on 'Sprite'
      { Movables: ["Sprite", "Enemy"] },
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([{ customAction: "Move", objectClass: "Sprite", sid: 1002 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /provided by family "Movables"/);
    assert.match(errors[0], /"Sprite"/);
    assert.match(errors[0], /set \{ "family": "Movables" \}/);
  });

  it("returns no errors when family key is correct (action on family + objectClass is member)", () => {
    const index = buildTestIndex([["Movables", "Move"]], { Movables: ["Sprite", "Enemy"] });
    const original = emptySheet();
    const modified = sheetWithCustomActions([
      { customAction: "Move", objectClass: "Sprite", sid: 1003, customActionObjectClass: "Movables" },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });

  it("returns error when specified family does not define the action", () => {
    const index = buildTestIndex(
      [["OtherFamily", "Fly"]], // 'Move' is NOT defined on 'Movables'
      { Movables: ["Sprite"] },
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([
      { customAction: "Move", objectClass: "Sprite", sid: 1004, customActionObjectClass: "Movables" },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"Move"/);
    assert.match(errors[0], /"Movables"/);
    assert.match(errors[0], /not defined on family/);
  });

  it("returns error when objectClass is not a member of the specified family", () => {
    const index = buildTestIndex(
      [["Movables", "Move"]],
      { Movables: ["Enemy"] }, // 'Sprite' is NOT in Movables
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([
      { customAction: "Move", objectClass: "Sprite", sid: 1005, customActionObjectClass: "Movables" },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"Sprite"/);
    assert.match(errors[0], /not a member of family "Movables"/);
  });

  it("returns error (no family hint) when action is not defined anywhere reachable", () => {
    const index = buildTestIndex(
      [], // nothing defined
      { Movables: ["Sprite"] }, // Sprite IS in a family, but Movables has no 'Teleport' ace
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([{ customAction: "Teleport", objectClass: "Sprite", sid: 1006 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"Teleport"/);
    assert.match(errors[0], /"Sprite"/);
    assert.match(errors[0], /not defined on "Sprite" or any family/);
  });

  it("skips actions already present in original (same sid)", () => {
    // Action sid 1007 already exists in original — should NOT be validated
    const index = buildTestIndex([]); // empty index — would fail if validated
    const original = sheetWithCustomActions([{ customAction: "OldAction", objectClass: "Sprite", sid: 1007 }]);
    const modified = sheetWithCustomActions([{ customAction: "OldAction", objectClass: "Sprite", sid: 1007 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });

  it("only validates the NEW action when original has one and modified has an additional new one", () => {
    // sid 1008 is pre-existing (OK to skip); sid 1009 is inserted (must validate)
    const index = buildTestIndex([["CardScroller", "Initialize"]]);
    const original = sheetWithCustomActions([{ customAction: "OldAction", objectClass: "SomeObj", sid: 1008 }]);
    const modified = sheetWithCustomActions([
      { customAction: "OldAction", objectClass: "SomeObj", sid: 1008 },
      { customAction: "Initialize", objectClass: "CardScroller", sid: 1009 },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });
});

// ─── buildCustomAceIndex integration tests ───

describe("buildCustomAceIndex", () => {
  const fixtureDir = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
    "..",
    "fixtures",
    "construct3-chef-sample",
  );

  it("builds without throwing on the real fixture project", () => {
    assert.doesNotThrow(() => buildCustomAceIndex(fixtureDir));
  });

  it("loads families from the fixture project", () => {
    const index = buildCustomAceIndex(fixtureDir);
    // TextFamily has members Text2 and Text
    const textFamilyMembers = index.membersOf("TextFamily");
    assert.isTrue(textFamilyMembers.has("Text"), "TextFamily should include 'Text'");
    assert.isTrue(textFamilyMembers.has("Text2"), "TextFamily should include 'Text2'");

    // Reverse: Text2 should belong to TextFamily
    const text2Families = index.familiesOf("Text2");
    assert.isTrue(text2Families.has("TextFamily"), "Text2 should belong to TextFamily");
  });

  it("returns empty family sets for an unknown object", () => {
    const index = buildCustomAceIndex(fixtureDir);
    const families = index.familiesOf("NoSuchObject");
    assert.equal(families.size, 0);
  });

  it("handles absent families dir gracefully via a temp project dir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      // Create a minimal event-sheets directory with one empty sheet
      const esDir = path.join(tmpDir, "eventSheets");
      fs.mkdirSync(esDir, { recursive: true });
      fs.writeFileSync(
        path.join(esDir, "EmptySheet.json"),
        JSON.stringify({ name: "EmptySheet", events: [], sid: 1 }, null, "\t") + "\n",
      );
      // No families/ directory — should not throw

      let index: CustomAceIndex | undefined;
      assert.doesNotThrow(() => {
        index = buildCustomAceIndex(tmpDir);
      });
      assert.equal(index!.familiesOf("AnyObject").size, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records custom-ace definitions from a hand-authored temp project", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      const esDir = path.join(tmpDir, "eventSheets");
      fs.mkdirSync(esDir, { recursive: true });

      // Craft an event sheet with a custom-ace-block for 'MyWidget.DoSomething'
      const sheet = {
        name: "WidgetSheet",
        sid: 1,
        events: [
          {
            eventType: "custom-ace-block",
            aceType: "action",
            aceName: "DoSomething",
            objectClass: "MyWidget",
            functionDescription: "",
            functionCategory: "",
            functionReturnType: "none",
            functionCopyPicked: false,
            functionIsAsync: false,
            functionParameters: [],
            conditions: [],
            actions: [],
            sid: 2,
          },
        ],
      };
      fs.writeFileSync(path.join(esDir, "WidgetSheet.json"), JSON.stringify(sheet, null, "\t") + "\n");

      // Also add a family
      const familiesDir = path.join(tmpDir, "families");
      fs.mkdirSync(familiesDir, { recursive: true });
      fs.writeFileSync(
        path.join(familiesDir, "Widgets.json"),
        JSON.stringify({ name: "Widgets", members: ["MyWidget", "OtherWidget"] }, null, "\t") + "\n",
      );

      const index = buildCustomAceIndex(tmpDir);

      assert.isTrue(index.hasAce("MyWidget", "DoSomething"), "should detect MyWidget.DoSomething");
      assert.isFalse(index.hasAce("MyWidget", "NoSuchAction"), "should not detect undefined action");
      assert.isTrue(index.membersOf("Widgets").has("MyWidget"), "Widgets family should include MyWidget");
      assert.isTrue(index.familiesOf("MyWidget").has("Widgets"), "MyWidget should belong to Widgets");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
