import { describe, it, beforeEach } from "mocha";
import { assert } from "chai";
import type {
  EventSheet,
  EventSheetEvent,
  BlockEvent,
  FunctionBlockEvent,
  GroupEvent,
  Condition,
} from "@genvid/c3source";
import {
  insertEvent,
  removeEvent,
  replaceEvent,
  insertAction,
  removeAction,
  replaceAction,
  insertCondition,
  removeCondition,
  replaceCondition,
  buildBlock,
  buildFunctionBlock,
  buildAction,
  buildCallAction,
  buildScriptAction,
  buildVariable,
  buildCondition,
  buildGroup,
  buildInclude,
  buildCommentEvent,
  buildCommentAction,
  buildCustomAction,
  buildSidIndex,
  type StandardAction,
  type FunctionCallAction,
  type CommentAction,
  type CustomAction,
  type VariableEvent,
} from "../../src/c3/eventSheetMutator.js";
import { freshSidGen, type SidGenerator } from "../../src/c3/sidUtils.js";

function makeSheet(...events: EventSheetEvent[]): EventSheet {
  return { name: "TestSheet", events, sid: 0 };
}

function makeBlock(overrides?: Partial<BlockEvent>): BlockEvent {
  return { eventType: "block", conditions: [], actions: [], sid: 1, ...overrides };
}

function makeCondition(id: string): Condition {
  return { id, objectClass: "System", sid: 1 };
}

describe("eventSheetMutator", () => {
  let sidGen: SidGenerator;

  beforeEach(() => {
    sidGen = freshSidGen();
  });

  describe("resolveNode and getEventsArray", () => {
  it("insertEvent with empty path targets sheet.events", () => {
    const sheet = makeSheet();
    insertEvent(sheet, "", 0, makeBlock());
    assert.equal(sheet.events.length, 1);
  });

  it("insertEvent with events[0] targets children", () => {
    const block = makeBlock();
    const sheet = makeSheet(block);
    const child = makeBlock({ sid: 10 });
    insertEvent(sheet, "events[0]", 0, child);
    assert.property(block, "children");
    assert.equal((block as BlockEvent & { children: EventSheetEvent[] }).children.length, 1);
    assert.equal((block as BlockEvent & { children: EventSheetEvent[] }).children[0].sid, 10);
  });

  it("insertEvent with events[1].children[0] resolves nested path", () => {
    const innerBlock = makeBlock({ sid: 20 });
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [innerBlock],
      sid: 2,
    };
    const sheet = makeSheet(makeBlock({ sid: 1 }), group);
    const newBlock = makeBlock({ sid: 30 });
    insertEvent(sheet, "events[1].children[0]", 0, newBlock);
    assert.property(innerBlock, "children");
    assert.equal((innerBlock as BlockEvent & { children: EventSheetEvent[] }).children.length, 1);
    assert.equal((innerBlock as BlockEvent & { children: EventSheetEvent[] }).children[0].sid, 30);
  });

  it("throws for invalid path segments", () => {
    const sheet = makeSheet(makeBlock());
    assert.throws(() => insertEvent(sheet, "invalid[0]", 0, makeBlock()), /malformed segment/);
  });

  it("throws for out-of-bounds path index", () => {
    const sheet = makeSheet(makeBlock());
    assert.throws(() => insertEvent(sheet, "events[5]", 0, makeBlock()), /out of bounds/);
  });

  it("throws when getting children of a non-container event (comment)", () => {
    const sheet = makeSheet({ eventType: "comment", text: "hi" });
    assert.throws(
      () => insertEvent(sheet, "events[0]", 0, makeBlock()),
      /comment.*parent container|parent container.*comment/i,
    );
  });

  it("error message for non-container path hints at using parent container or empty path", () => {
    const sheet = makeSheet({
      eventType: "variable",
      name: "x",
      type: "number",
      initialValue: "0",
      comment: "",
      isStatic: false,
      isConstant: false,
      sid: 1,
    });
    assert.throws(() => insertEvent(sheet, "events[0]", 0, makeBlock()), /parent container/i);
  });

  it("resolves deeply nested paths (3+ levels)", () => {
    const innerBlock = makeBlock({ sid: 99 });
    const midBlock = makeBlock({ children: [innerBlock] });
    const outerGroup: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Outer",
      isActiveOnStart: true,
      children: [midBlock],
      sid: 1,
    };
    const sheet = makeSheet(outerGroup);
    insertEvent(sheet, "events[0].children[0].children[0]", 0, makeBlock({ sid: 50 }));
    assert.equal((innerBlock as BlockEvent & { children: EventSheetEvent[] }).children[0].sid, 50);
  });
});

describe("buildBlock", () => {
  it("builds minimal block with defaults", () => {
    const block = buildBlock(sidGen);
    assert.deepStrictEqual(block.eventType, "block");
    assert.deepStrictEqual(block.conditions, []);
    assert.deepStrictEqual(block.actions, []);
    assert.notEqual(block.sid, 0);
    assert.notProperty(block, "children");
    assert.notProperty(block, "isOrBlock");
  });

  it("builds block with isOrBlock", () => {
    const block = buildBlock(sidGen, { isOrBlock: true });
    assert.equal((block as BlockEvent & { isOrBlock: boolean }).isOrBlock, true);
  });

  it("builds block with conditions and actions", () => {
    const conds = [makeCondition("test-cond")];
    const actions = [buildAction(sidGen, { id: "set-text", objectClass: "Text", parameters: { text: "hi" } })];
    const block = buildBlock(sidGen, { conditions: conds, actions });
    assert.equal(block.conditions.length, 1);
    assert.equal(block.conditions[0].id, "test-cond");
    assert.equal(block.actions.length, 1);
  });
});

describe("buildFunctionBlock", () => {
  it("builds with defaults", () => {
    const fb = buildFunctionBlock(sidGen, { functionName: "myFunc" });
    assert.equal(fb.eventType, "function-block");
    assert.equal(fb.functionName, "myFunc");
    assert.equal(fb.functionReturnType, "none");
    assert.equal(fb.functionIsAsync, false);
    assert.equal(fb.functionCopyPicked, false);
    assert.deepStrictEqual(fb.conditions, []);
    assert.deepStrictEqual(fb.actions, []);
    assert.notEqual(fb.sid, 0);
    assert.deepStrictEqual(fb.functionParameters, []);
  });

  it("builds with params", () => {
    const fb = buildFunctionBlock(sidGen, {
      functionName: "calc",
      params: [
        { name: "x", type: "number" },
        { name: "label", type: "string" },
      ],
    });
    assert.equal(fb.functionParameters.length, 2);
    assert.equal(fb.functionParameters[0].name, "x");
    assert.equal(fb.functionParameters[0].type, "number");
    assert.notEqual(fb.functionParameters[0].sid, 0);
    assert.equal(fb.functionParameters[0].initialValue, "0");
    assert.equal(fb.functionParameters[1].name, "label");
    assert.equal(fb.functionParameters[1].type, "string");
    assert.notEqual(fb.functionParameters[1].sid, 0);
    assert.notEqual(fb.functionParameters[0].sid, fb.functionParameters[1].sid);
    assert.equal(fb.functionParameters[1].initialValue, "");
  });

  it("builds with returnType and isAsync", () => {
    const fb = buildFunctionBlock(sidGen, { functionName: "f", returnType: "number", isAsync: true });
    assert.equal(fb.functionReturnType, "number");
    assert.equal(fb.functionIsAsync, true);
  });
});

describe("buildAction", () => {
  it("builds standard action", () => {
    const action = buildAction(sidGen, { id: "set-text", objectClass: "Text", parameters: { text: "hello" } });
    assert.notEqual(action.sid, 0);
    assert.equal(action.id, "set-text");
    assert.equal(action.objectClass, "Text");
    assert.deepStrictEqual(action.parameters, { text: "hello" });
  });

  it("builds action without optional fields", () => {
    const action = buildAction(sidGen, { id: "destroy", objectClass: "Enemy" });
    assert.equal(action.id, "destroy");
    assert.equal(action.objectClass, "Enemy");
    assert.notProperty(action, "parameters");
    assert.notProperty(action, "behaviorType");
  });

  it("builds action with behaviorType", () => {
    const action = buildAction(sidGen, { id: "start-timer", objectClass: "BossHPBar", behaviorType: "Timer" });
    assert.equal(action.behaviorType, "Timer");
    assert.notEqual(action.sid, 0);
  });
});

describe("buildCallAction", () => {
  it("builds with parameters", () => {
    const action = buildCallAction(sidGen, { callFunction: "playSFX", parameters: ['"click"'] });
    assert.notEqual(action.sid, 0);
    assert.equal(action.callFunction, "playSFX");
    assert.deepStrictEqual(action.parameters, ['"click"']);
  });

  it("builds without parameters", () => {
    const action = buildCallAction(sidGen, { callFunction: "doStuff" });
    assert.equal(action.callFunction, "doStuff");
    assert.notProperty(action, "parameters");
  });
});

describe("buildScriptAction", () => {
  it("wraps script lines", () => {
    const action = buildScriptAction({ script: ["const x = 1;", "console.log(x);"] });
    assert.deepStrictEqual(action, {
      type: "script",
      language: "typescript",
      script: ["const x = 1;", "console.log(x);"],
    });
  });
});

describe("insertEvent", () => {
  it("inserts at index 0 in empty sheet", () => {
    const sheet = makeSheet();
    insertEvent(sheet, "", 0, makeBlock());
    assert.equal(sheet.events.length, 1);
  });

  it("appends with index -1", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    insertEvent(sheet, "", -1, makeBlock({ sid: 2 }));
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[1].sid, 2);
  });

  it("inserts at specific index", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }));
    insertEvent(sheet, "", 1, makeBlock({ sid: 3 }));
    assert.equal(sheet.events[0].sid, 1);
    assert.equal(sheet.events[1].sid, 3);
    assert.equal(sheet.events[2].sid, 2);
  });

  it("inserts into children via nested path", () => {
    const innerBlock = makeBlock({ sid: 10 });
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [innerBlock],
      sid: 2,
    };
    const sheet = makeSheet(group);
    const newBlock = makeBlock({ sid: 20 });
    insertEvent(sheet, "events[0].children[0]", 0, newBlock);
    assert.property(innerBlock, "children");
    assert.equal((innerBlock as BlockEvent & { children: EventSheetEvent[] }).children.length, 1);
    assert.equal((innerBlock as BlockEvent & { children: EventSheetEvent[] }).children[0].sid, 20);
  });

  it("auto-creates children array for block", () => {
    const block = makeBlock({ sid: 5 });
    assert.notProperty(block, "children");
    const sheet = makeSheet(block);
    insertEvent(sheet, "events[0]", 0, makeBlock({ sid: 6 }));
    assert.property(block, "children");
    assert.equal((block as BlockEvent & { children: EventSheetEvent[] }).children.length, 1);
  });

  it("throws for out-of-bounds index", () => {
    const sheet = makeSheet();
    assert.throws(() => insertEvent(sheet, "", 5, makeBlock()), /out of bounds/);
  });

  it("throws for negative index other than -1", () => {
    const sheet = makeSheet();
    assert.throws(() => insertEvent(sheet, "", -2, makeBlock()), /negative indices other than -1/);
  });
});

describe("removeEvent", () => {
  it("removes and returns event", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }));
    const removed = removeEvent(sheet, "", 0);
    assert.equal(removed.sid, 1);
    assert.equal(sheet.events.length, 1);
    assert.equal(sheet.events[0].sid, 2);
  });

  it("removes from children", () => {
    const child1 = makeBlock({ sid: 10 });
    const child2 = makeBlock({ sid: 20 });
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [child1, child2],
      sid: 1,
    };
    const sheet = makeSheet(group);
    const removed = removeEvent(sheet, "events[0]", 0);
    assert.equal(removed.sid, 10);
    assert.equal(group.children.length, 1);
    assert.equal(group.children[0].sid, 20);
  });

  it("throws for empty array", () => {
    const sheet = makeSheet();
    assert.throws(() => removeEvent(sheet, "", 0), /empty/);
  });

  it("throws for out-of-bounds", () => {
    const sheet = makeSheet(makeBlock());
    assert.throws(() => removeEvent(sheet, "", 5), /out of bounds/);
  });
});

describe("replaceEvent", () => {
  it("replaces at index", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }));
    replaceEvent(sheet, "", 0, makeBlock({ sid: 99 }));
    assert.equal(sheet.events[0].sid, 99);
    assert.equal(sheet.events.length, 2);
  });

  it("throws for invalid index", () => {
    const sheet = makeSheet();
    assert.throws(() => replaceEvent(sheet, "", 0, makeBlock()), /out of bounds/);
  });
});

describe("insertAction", () => {
  it("inserts action at beginning", () => {
    const existingAction = buildAction(sidGen, { id: "existing", objectClass: "Obj" });
    const block = makeBlock({ actions: [existingAction] });
    const sheet = makeSheet(block);
    const newAction = buildAction(sidGen, { id: "new", objectClass: "Obj" });
    insertAction(sheet, "events[0]", 0, newAction);
    assert.equal(block.actions.length, 2);
    assert.equal((block.actions[0] as StandardAction).id, "new");
  });

  it("appends action with -1", () => {
    const existingAction = buildAction(sidGen, { id: "existing", objectClass: "Obj" });
    const block = makeBlock({ actions: [existingAction] });
    const sheet = makeSheet(block);
    const newAction = buildAction(sidGen, { id: "appended", objectClass: "Obj" });
    insertAction(sheet, "events[0]", -1, newAction);
    assert.equal(block.actions.length, 2);
    assert.equal((block.actions[1] as StandardAction).id, "appended");
  });

  it("throws for empty jsonPath", () => {
    const sheet = makeSheet(makeBlock());
    assert.throws(
      () => insertAction(sheet, "", 0, buildAction(sidGen, { id: "x", objectClass: "Y" })),
      /must not be empty/,
    );
  });

  it("throws for event without actions", () => {
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [],
      sid: 1,
    };
    const sheet = makeSheet(group);
    assert.throws(
      () => insertAction(sheet, "events[0]", 0, buildAction(sidGen, { id: "x", objectClass: "Y" })),
      /Cannot access actions/,
    );
  });
});

describe("removeAction", () => {
  it("removes and returns action", () => {
    const action1 = buildAction(sidGen, { id: "first", objectClass: "A" });
    const action2 = buildAction(sidGen, { id: "second", objectClass: "B" });
    const block = makeBlock({ actions: [action1, action2] });
    const sheet = makeSheet(block);
    const removed = removeAction(sheet, "events[0]", 0) as StandardAction;
    assert.equal(removed.id, "first");
    assert.equal(block.actions.length, 1);
  });

  it("throws for empty actions array", () => {
    const block = makeBlock();
    const sheet = makeSheet(block);
    assert.throws(() => removeAction(sheet, "events[0]", 0), /empty/);
  });
});

describe("replaceAction", () => {
  it("replaces action at index", () => {
    const action = buildAction(sidGen, { id: "original", objectClass: "X" });
    const block = makeBlock({ actions: [action] });
    const sheet = makeSheet(block);
    const replacement = buildAction(sidGen, { id: "replaced", objectClass: "X" });
    replaceAction(sheet, "events[0]", 0, replacement);
    assert.equal((block.actions[0] as StandardAction).id, "replaced");
  });

  it("throws for invalid index", () => {
    const block = makeBlock({ actions: [buildAction(sidGen, { id: "a", objectClass: "X" })] });
    const sheet = makeSheet(block);
    assert.throws(
      () => replaceAction(sheet, "events[0]", 5, buildAction(sidGen, { id: "b", objectClass: "Y" })),
      /out of bounds/,
    );
  });
});

describe("insertCondition", () => {
  it("inserts condition", () => {
    const block = makeBlock({ conditions: [makeCondition("existing")] });
    const sheet = makeSheet(block);
    insertCondition(sheet, "events[0]", 0, makeCondition("new-cond"));
    assert.equal(block.conditions.length, 2);
    assert.equal(block.conditions[0].id, "new-cond");
  });

  it("throws for empty jsonPath", () => {
    const sheet = makeSheet(makeBlock());
    assert.throws(() => insertCondition(sheet, "", 0, makeCondition("x")), /must not be empty/);
  });
});

describe("removeCondition", () => {
  it("removes and returns condition", () => {
    const block = makeBlock({ conditions: [makeCondition("first"), makeCondition("second")] });
    const sheet = makeSheet(block);
    const removed = removeCondition(sheet, "events[0]", 0);
    assert.equal(removed.id, "first");
    assert.equal(block.conditions.length, 1);
  });

  it("throws for empty array", () => {
    const block = makeBlock();
    const sheet = makeSheet(block);
    assert.throws(() => removeCondition(sheet, "events[0]", 0), /empty/);
  });
});

describe("replaceCondition", () => {
  it("replaces condition at index", () => {
    const block = makeBlock({ conditions: [makeCondition("original")] });
    const sheet = makeSheet(block);
    replaceCondition(sheet, "events[0]", 0, makeCondition("replaced"));
    assert.equal(block.conditions[0].id, "replaced");
  });

  it("throws for invalid index", () => {
    const block = makeBlock({ conditions: [makeCondition("only")] });
    const sheet = makeSheet(block);
    assert.throws(() => replaceCondition(sheet, "events[0]", 5, makeCondition("x")), /out of bounds/);
  });
});

describe("buildVariable", () => {
  it("builds string variable with defaults", () => {
    const v = buildVariable(sidGen, { name: "myStr", type: "string" });
    assert.equal(v.eventType, "variable");
    assert.equal(v.name, "myStr");
    assert.equal(v.type, "string");
    assert.equal(v.initialValue, "");
    assert.equal(v.comment, "");
    assert.equal(v.isStatic, false);
    assert.equal(v.isConstant, false);
    assert.notEqual(v.sid, 0);
  });

  it("builds number variable with defaults", () => {
    const v = buildVariable(sidGen, { name: "count", type: "number" });
    assert.equal(v.type, "number");
    assert.equal(v.initialValue, "0");
  });

  it("builds boolean variable with defaults", () => {
    const v = buildVariable(sidGen, { name: "flag", type: "boolean" });
    assert.equal(v.type, "boolean");
    assert.equal(v.initialValue, "false");
  });

  it("builds constant variable", () => {
    const v = buildVariable(sidGen, { name: "MAX", type: "number", constant: true });
    assert.equal(v.isConstant, true);
    assert.equal(v.isStatic, true);
  });

  it("builds static non-constant variable", () => {
    const v = buildVariable(sidGen, { name: "shared", type: "string", static: true });
    assert.equal(v.isStatic, true);
    assert.equal(v.isConstant, false);
  });

  it("builds variable with custom value", () => {
    const v = buildVariable(sidGen, { name: "greeting", type: "string", value: "hello" });
    assert.equal(v.initialValue, "hello");
  });

  it("accepts initialValue as alias for value", () => {
    const v = buildVariable(sidGen, { name: "greeting", type: "string", initialValue: "hello" });
    assert.equal(v.initialValue, "hello");
  });

  it("accepts isStatic as alias for static", () => {
    const v = buildVariable(sidGen, { name: "shared", type: "string", isStatic: true });
    assert.equal(v.isStatic, true);
    assert.equal(v.isConstant, false);
  });

  it("accepts isConstant as alias for constant", () => {
    const v = buildVariable(sidGen, { name: "MAX", type: "number", isConstant: true });
    assert.equal(v.isConstant, true);
    assert.equal(v.isStatic, true);
  });

  it("throws when both value and initialValue are provided", () => {
    assert.throws(
      () => buildVariable(sidGen, { name: "X", type: "string", value: "a", initialValue: "b" }),
      /cannot specify both "value" and "initialValue"/,
    );
  });

  it("throws when both constant and isConstant are provided", () => {
    assert.throws(
      () => buildVariable(sidGen, { name: "X", type: "number", constant: true, isConstant: false }),
      /cannot specify both "constant" and "isConstant"/,
    );
  });

  it("throws when both static and isStatic are provided", () => {
    assert.throws(
      () => buildVariable(sidGen, { name: "X", type: "number", static: true, isStatic: false }),
      /cannot specify both "static" and "isStatic"/,
    );
  });
});

describe("buildCondition", () => {
  it("builds minimal condition", () => {
    const c = buildCondition(sidGen, { id: "on-start", objectClass: "System" });
    assert.equal(c.id, "on-start");
    assert.equal(c.objectClass, "System");
    assert.notEqual(c.sid, 0);
  });

  it("builds condition with parameters", () => {
    const c = buildCondition(sidGen, {
      id: "compare-two-values",
      objectClass: "System",
      parameters: { first: "1", second: "2", comparison: 0 },
    });
    assert.deepStrictEqual(c.parameters, { first: "1", second: "2", comparison: 0 });
  });

  it("builds inverted condition", () => {
    const c = buildCondition(sidGen, { id: "is-visible", objectClass: "Sprite", isInverted: true });
    assert.equal(c.isInverted, true);
  });

  it("builds condition with behaviorType", () => {
    const c = buildCondition(sidGen, { id: "on-timer", objectClass: "Enemy", behaviorType: "Timer" });
    assert.equal(c.behaviorType, "Timer");
  });

  it("omits optional fields when not provided", () => {
    const c = buildCondition(sidGen, { id: "on-start", objectClass: "System" });
    assert.notProperty(c, "parameters");
    assert.notProperty(c, "isInverted");
    assert.notProperty(c, "behaviorType");
  });
});

describe("buildGroup", () => {
  it("builds group with defaults", () => {
    const g = buildGroup(sidGen, { title: "My Group" });
    assert.equal(g.eventType, "group");
    assert.equal(g.title, "My Group");
    assert.equal(g.disabled, false);
    assert.equal(g.isActiveOnStart, true);
    assert.deepStrictEqual(g.children, []);
    assert.equal(g.description, "");
    assert.notEqual(g.sid, 0);
  });

  it("builds group with children", () => {
    const child = buildBlock(sidGen);
    const g = buildGroup(sidGen, { title: "Parent", children: [child] });
    assert.equal(g.children.length, 1);
    assert.equal(g.children[0].eventType, "block");
  });

  it("builds inactive group", () => {
    const g = buildGroup(sidGen, { title: "Lazy", activeOnStart: false });
    assert.equal(g.isActiveOnStart, false);
  });
});

describe("buildInclude", () => {
  it("builds include event", () => {
    const inc = buildInclude("OtherSheet");
    assert.equal(inc.eventType, "include");
    assert.equal(inc.includeSheet, "OtherSheet");
  });
});

describe("buildCommentEvent", () => {
  it("builds comment event", () => {
    const c = buildCommentEvent("Setup player state");
    assert.equal(c.eventType, "comment");
    assert.equal(c.text, "Setup player state");
  });
});

describe("buildCommentAction", () => {
  it("builds comment action", () => {
    const c = buildCommentAction("Initialize values");
    assert.equal(c.type, "comment");
    assert.equal(c.text, "Initialize values");
  });
});

describe("buildCustomAction", () => {
  it("builds custom action with name and objectClass", () => {
    const a = buildCustomAction(sidGen, { name: "Initialize", objectClass: "CardScroller" });
    assert.equal(a.customAction, "Initialize");
    assert.equal(a.objectClass, "CardScroller");
    assert.notEqual(a.sid, 0);
  });

  it("builds custom action with parameters", () => {
    const a = buildCustomAction(sidGen, {
      name: "SetValue",
      objectClass: "MyPlugin",
      parameters: ["health", 100],
    });
    assert.deepStrictEqual(a.parameters, ["health", 100]);
  });

  it("omits parameters when not provided", () => {
    const a = buildCustomAction(sidGen, { name: "Reset", objectClass: "Timer" });
    assert.notProperty(a, "parameters");
  });
});

describe("buildFunctionBlock (extended)", () => {
  it("builds with description", () => {
    const fb = buildFunctionBlock(sidGen, { functionName: "doWork", description: "Does important work" });
    assert.equal(fb.functionDescription, "Does important work");
  });

  it("builds with category", () => {
    const fb = buildFunctionBlock(sidGen, { functionName: "doWork", category: "Utilities" });
    assert.equal(fb.functionCategory, "Utilities");
  });

  it("builds with copyPicked", () => {
    const fb = buildFunctionBlock(sidGen, { functionName: "onTap", copyPicked: true });
    assert.equal(fb.functionCopyPicked, true);
  });
});

describe("buildSidIndex", () => {
  it("builds index with correct entries for a flat sheet", () => {
    const block1 = makeBlock({ sid: 10 });
    const block2 = makeBlock({ sid: 20 });
    const sheet = makeSheet(block1, block2);
    const index = buildSidIndex(sheet);

    assert.equal(index.size, 2);

    const entry1 = index.get(10);
    assert.ok(entry1);
    assert.strictEqual(entry1.node, block1);
    assert.strictEqual(entry1.parentArray, sheet.events);
    assert.equal(entry1.indexInParent, 0);

    const entry2 = index.get(20);
    assert.ok(entry2);
    assert.strictEqual(entry2.node, block2);
    assert.strictEqual(entry2.parentArray, sheet.events);
    assert.equal(entry2.indexInParent, 1);
  });

  it("indexes nested children correctly", () => {
    const childBlock = makeBlock({ sid: 30 });
    const parentBlock = makeBlock({ sid: 10, children: [childBlock] });
    const sheet = makeSheet(parentBlock);
    const index = buildSidIndex(sheet);

    assert.equal(index.size, 2);

    const childEntry = index.get(30);
    assert.ok(childEntry);
    assert.strictEqual(childEntry.node, childBlock);
    assert.strictEqual(childEntry.parentArray, parentBlock.children);
    assert.equal(childEntry.indexInParent, 0);
  });

  it("skips events without SIDs (include, comment)", () => {
    const include = buildInclude("OtherSheet");
    const comment = buildCommentEvent("test comment");
    const sheet = makeSheet(include, comment);
    const index = buildSidIndex(sheet);

    assert.equal(index.size, 0);
  });

  it("throws on duplicate SIDs", () => {
    const block1 = makeBlock({ sid: 42 });
    const block2 = makeBlock({ sid: 42 });
    const sheet = makeSheet(block1, block2);

    assert.throws(() => buildSidIndex(sheet), /Duplicate SID 42/);
  });

  it("returns empty map for empty sheet", () => {
    const sheet = makeSheet();
    const index = buildSidIndex(sheet);

    assert.equal(index.size, 0);
  });
});
});
