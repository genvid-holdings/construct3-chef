import { describe, it, beforeEach } from "mocha";
import { assert } from "chai";
import type {
  EventSheet,
  EventSheetEvent,
  EventSheetVariable,
  BlockEvent,
  FunctionBlockEvent,
  CustomAceBlockEvent,
  GroupEvent,
  Condition,
  ScriptAction,
} from "@genvid/c3source";
import {
  buildBlock,
  buildFunctionBlock,
  buildCustomAceBlock,
  buildAction,
  buildScriptAction,
  buildCondition,
  buildGroup,
  buildCommentEvent,
  buildInclude,
  buildCallAction,
  walkScriptActions,
  type StandardAction,
  type FunctionCallAction,
  type CommentAction,
  type CustomAction,
  buildSidIndex,
} from "../../src/c3/eventSheetMutator.js";
import {
  expandAction,
  expandCondition,
  expandEvent,
  executeOp,
  executeFileOps,
  createSheet,
  executeRecipe,
  validateRecipe,
  isFileCreate,
  applyReplacements,
  normalizeFileKey,
  normalizeLayoutKey,
  normalizeRecipePaths,
  type BuilderAction,
  type BuilderCondition,
  type BuilderEvent,
  type FileOp,
  type Recipe,
  type FileCreate,
  VALID_OPS,
  OP_FIELD_SCHEMAS,
  SHORTHAND_FIELD_SCHEMAS,
  PARAM_TYPE_RULES,
  validateActionParams,
  validateConditionParams,
} from "../../src/c3/recipeInterpreter.js";
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

describe("recipeInterpreter", () => {
  let sidGen: SidGenerator;

  beforeEach(() => {
    sidGen = freshSidGen();
  });

  // ─── expandAction ───

  describe("expandAction", () => {
  it("expands script shorthand", () => {
    const result = expandAction(sidGen, { script: ["const x = 1;"] });
    const script = result as ScriptAction;
    assert.equal(script.type, "script");
    assert.equal(script.language, "typescript");
    assert.deepStrictEqual(script.script, ["const x = 1;"]);
  });

  it("expands call shorthand with params", () => {
    const result = expandAction(sidGen, { call: "playSFX", params: ['"click"'] });
    const call = result as FunctionCallAction;
    assert.equal(call.callFunction, "playSFX");
    assert.deepStrictEqual(call.parameters, ['"click"']);
    assert.notEqual(call.sid, 0);
  });

  it("auto-stringifies numeric params in call shorthand", () => {
    const result = expandAction(sidGen, { call: "setLevel", params: [0, "hello", true] });
    const call = result as FunctionCallAction;
    assert.deepStrictEqual(call.parameters, ["0", "hello", "true"]);
  });

  it("expands call shorthand without params", () => {
    const result = expandAction(sidGen, { call: "doStuff" });
    const call = result as FunctionCallAction;
    assert.equal(call.callFunction, "doStuff");
    assert.notProperty(call, "parameters");
  });

  it("expands custom-action shorthand", () => {
    const result = expandAction(sidGen, { "custom-action": "Initialize", object: "CardScroller" });
    const custom = result as CustomAction;
    assert.equal(custom.customAction, "Initialize");
    assert.equal(custom.objectClass, "CardScroller");
    assert.notEqual(custom.sid, 0);
  });

  it("expands comment shorthand", () => {
    const result = expandAction(sidGen, { comment: "setup values" });
    const comment = result as CommentAction;
    assert.equal(comment.type, "comment");
    assert.equal(comment.text, "setup values");
  });

  it("expands generic action with params", () => {
    const result = expandAction(sidGen, { id: "set-text", object: "Text", params: { text: "hi" } });
    const action = result as StandardAction;
    assert.equal(action.id, "set-text");
    assert.equal(action.objectClass, "Text");
    assert.deepStrictEqual(action.parameters, { text: "hi" });
    assert.notEqual(action.sid, 0);
  });

  it("expands generic action with behavior", () => {
    const result = expandAction(sidGen, {
      id: "start-timer",
      object: "Boss",
      behavior: "Timer",
      params: { duration: 5 },
    });
    const action = result as StandardAction;
    assert.equal(action.id, "start-timer");
    assert.equal(action.objectClass, "Boss");
    assert.equal(action.behaviorType, "Timer");
    assert.deepStrictEqual(action.parameters, { duration: "5" });
  });

  it("accepts objectClass as an alias for object", () => {
    const action = expandAction(sidGen, { id: "destroy", objectClass: "Foo" }) as StandardAction;
    assert.equal(action.id, "destroy");
    assert.equal(action.objectClass, "Foo");
  });

  it("prefers object over objectClass when both are present", () => {
    const action = expandAction(sidGen, { id: "destroy", object: "Foo", objectClass: "Bar" }) as StandardAction;
    assert.equal(action.objectClass, "Foo");
  });

  it("auto-defaults objectClass to System for well-known System action ids", () => {
    for (const id of ["wait", "wait-for-previous-actions", "signal"]) {
      const action = expandAction(sidGen, { id }) as StandardAction;
      assert.equal(action.objectClass, "System", `id=${id}`);
    }
  });

  it("throws when a non-System id action has no object/objectClass", () => {
    assert.throws(() => expandAction(sidGen, { id: "destroy" }), /missing its target object/);
  });

  it("accepts objectClass as an alias on custom-action", () => {
    const custom = expandAction(sidGen, { "custom-action": "Initialize", objectClass: "CardScroller" }) as CustomAction;
    assert.equal(custom.customAction, "Initialize");
    assert.equal(custom.objectClass, "CardScroller");
  });

  it("throws for unrecognized shorthand", () => {
    assert.throws(() => expandAction(sidGen, { foo: "bar" } as unknown as BuilderAction), /Unrecognized action shorthand/);
  });
});

// ─── action validation heuristic ───

describe("action validation heuristic", () => {
  it("warns when id looks like a custom ACE name (PascalCase, no hyphens)", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      expandAction(sidGen, { id: "LoadTitleData", object: "Obj" });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /looks like a custom ACE name/);
      assert.match(warnings[0], /custom-action/);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not warn for kebab-case plugin action id", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      expandAction(sidGen, { id: "set-text", object: "Obj" });
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });

  it("warns when custom-action looks like a plugin action id (lowercase with hyphens)", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      expandAction(sidGen, { "custom-action": "set-text", object: "Obj" });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /looks like a plugin action id/);
      assert.match(warnings[0], /"id"/);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not warn for PascalCase custom-action", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      expandAction(sidGen, { "custom-action": "LoadData", object: "Obj" });
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not warn for single-word lowercase plugin action id (no hyphens)", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      expandAction(sidGen, { id: "destroy", object: "Obj" });
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });
});

// ─── expandCondition ───

describe("expandCondition", () => {
  it("expands else shorthand", () => {
    const result = expandCondition(sidGen, { else: true });
    assert.equal(result.id, "else");
    assert.equal(result.objectClass, "System");
    assert.notEqual(result.sid, 0);
  });

  it("expands trigger-once shorthand", () => {
    const result = expandCondition(sidGen, { "trigger-once": true });
    assert.equal(result.id, "trigger-once-while-true");
    assert.equal(result.objectClass, "System");
  });

  it("expands generic condition", () => {
    const result = expandCondition(sidGen, {
      id: "compare-two-values",
      object: "System",
      params: { first: "1", second: "2", comparison: 0 },
    });
    assert.equal(result.id, "compare-two-values");
    assert.equal(result.objectClass, "System");
    assert.deepStrictEqual(result.parameters, { first: "1", second: "2", comparison: 0 });
  });

  it("expands inverted condition", () => {
    const result = expandCondition(sidGen, { id: "is-visible", object: "Sprite", inverted: true });
    assert.equal(result.isInverted, true);
  });

  it("accepts objectClass as an alias for object", () => {
    const condition = expandCondition(sidGen, { id: "is-visible", objectClass: "Sprite" });
    assert.equal(condition.objectClass, "Sprite");
  });

  it("throws when a condition id has no object/objectClass", () => {
    assert.throws(() => expandCondition(sidGen, { id: "is-visible" }), /missing its target object/);
  });

  it("throws for unrecognized shorthand", () => {
    assert.throws(
      () => expandCondition(sidGen, { foo: "bar" } as unknown as BuilderCondition),
      /Unrecognized condition shorthand/,
    );
  });
});

// ─── expandEvent ───

describe("expandEvent", () => {
  it("expands variable", () => {
    const result = expandEvent(sidGen, { variable: { name: "count", type: "number", value: "10" } });
    assert.equal(result.eventType, "variable");
    const v = result as EventSheetEvent & { name: string; type: string; initialValue: string };
    assert.equal(v.name, "count");
    assert.equal(v.type, "number");
    assert.equal(v.initialValue, "10");
  });

  it("expands block with conditions and actions", () => {
    const result = expandEvent(sidGen, {
      block: {
        conditions: [{ id: "on-start-of-layout", object: "System" }],
        actions: [{ id: "set-text", object: "Text", params: { text: "hello" } }],
      },
    });
    assert.equal(result.eventType, "block");
    const block = result as BlockEvent;
    assert.equal(block.conditions.length, 1);
    assert.equal(block.conditions[0].id, "on-start-of-layout");
    assert.equal(block.actions.length, 1);
    assert.equal((block.actions[0] as StandardAction).id, "set-text");
  });

  it("expands function-block", () => {
    const result = expandEvent(sidGen, {
      "function-block": {
        name: "doWork",
        params: [{ name: "x", type: "number" }],
        returnType: "number",
        async: true,
        copyPicked: true,
        description: "Does work",
        category: "Utils",
        actions: [{ script: ["return 1;"] }],
      },
    });
    assert.equal(result.eventType, "function-block");
    const fb = result as FunctionBlockEvent;
    assert.equal(fb.functionName, "doWork");
    assert.equal(fb.functionReturnType, "number");
    assert.equal(fb.functionIsAsync, true);
    assert.equal(fb.functionCopyPicked, true);
    assert.equal(fb.functionDescription, "Does work");
    assert.equal(fb.functionCategory, "Utils");
    assert.equal(fb.functionParameters.length, 1);
    assert.equal(fb.functionParameters[0].name, "x");
    assert.equal(fb.actions.length, 1);
  });

  it("expands custom-ace-block", () => {
    const result = expandEvent(sidGen, {
      "custom-ace-block": {
        name: "SetupThumbnail",
        object: "VODStateJSON",
        aceType: "action",
        params: [
          { name: "vodId", type: "string" },
          { name: "vodPath", type: "string" },
        ],
        returnType: "none",
        description: "Set up a thumbnail",
        actions: [{ script: ["const x = 1;"] }],
      },
    });
    assert.equal(result.eventType, "custom-ace-block");
    const cab = result as CustomAceBlockEvent;
    assert.equal(cab.aceName, "SetupThumbnail");
    assert.equal(cab.objectClass, "VODStateJSON");
    assert.equal(cab.aceType, "action");
    assert.equal(cab.functionReturnType, "none");
    assert.equal(cab.functionDescription, "Set up a thumbnail");
    assert.equal(cab.functionParameters.length, 2);
    assert.equal(cab.functionParameters[0].name, "vodId");
    assert.equal(cab.functionParameters[1].name, "vodPath");
    assert.equal(cab.actions.length, 1);
  });

  it("expands custom-ace-block with defaults", () => {
    const result = expandEvent(sidGen, {
      "custom-ace-block": {
        name: "DoSomething",
        object: "MyObject",
      },
    });
    assert.equal(result.eventType, "custom-ace-block");
    const cab = result as CustomAceBlockEvent;
    assert.equal(cab.aceName, "DoSomething");
    assert.equal(cab.objectClass, "MyObject");
    assert.equal(cab.aceType, "action");
    assert.equal(cab.functionReturnType, "none");
    assert.equal(cab.functionIsAsync, false);
    assert.equal(cab.functionCopyPicked, false);
    assert.equal(cab.functionParameters.length, 0);
    assert.equal(cab.actions.length, 0);
  });

  it("expands group with children", () => {
    const result = expandEvent(sidGen, {
      group: {
        title: "My Group",
        children: [{ comment: "inside group" }],
        activeOnStart: false,
      },
    });
    assert.equal(result.eventType, "group");
    const g = result as GroupEvent;
    assert.equal(g.title, "My Group");
    assert.equal(g.isActiveOnStart, false);
    assert.equal(g.children.length, 1);
    assert.equal(g.children[0].eventType, "comment");
  });

  it("expands comment event", () => {
    const result = expandEvent(sidGen, { comment: "A comment" });
    assert.equal(result.eventType, "comment");
    assert.equal((result as { text: string }).text, "A comment");
  });

  it("throws for unrecognized shorthand", () => {
    assert.throws(() => expandEvent(sidGen, { foo: "bar" } as unknown as BuilderEvent), /Unrecognized event shorthand/);
  });
});

// ─── executeOp: insert-event ───

describe("executeOp: insert-event", () => {
  it("inserts block at index", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, {
      op: "insert-event",
      path: "",
      index: 0,
      block: { actions: [{ comment: "new" }] },
    });
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].eventType, "block");
  });

  it("inserts function-block at end with -1", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, {
      op: "insert-event",
      index: -1,
      "function-block": { name: "myFunc" },
    });
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[1].eventType, "function-block");
    assert.equal((sheet.events[1] as FunctionBlockEvent).functionName, "myFunc");
  });

  it("inserts variable with inline shorthand", () => {
    const sheet = makeSheet();
    executeOp(sidGen, sheet, {
      op: "insert-event",
      index: 0,
      variable: { name: "x", type: "number" },
    });
    assert.equal(sheet.events.length, 1);
    assert.equal(sheet.events[0].eventType, "variable");
  });

  it("inserts custom-ace-block with inline shorthand", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, {
      op: "insert-event",
      index: -1,
      "custom-ace-block": {
        name: "SetupThumbnail",
        object: "VODStateJSON",
        aceType: "action",
        params: [{ name: "vodId", type: "string" }],
      },
    });
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[1].eventType, "custom-ace-block");
    const cab = sheet.events[1] as CustomAceBlockEvent;
    assert.equal(cab.aceName, "SetupThumbnail");
    assert.equal(cab.objectClass, "VODStateJSON");
    assert.equal(cab.functionParameters.length, 1);
  });
});

// ─── executeOp: insert-variables ───

describe("executeOp: insert-variables", () => {
  it("inserts batch variables after position", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, {
      op: "insert-variables",
      path: "",
      after: 0,
      variables: [
        { name: "a", type: "string" },
        { name: "b", type: "number" },
        { name: "c", type: "boolean" },
      ],
    });
    assert.equal(sheet.events.length, 4);
    assert.equal(sheet.events[1].eventType, "variable");
    assert.equal((sheet.events[1] as { name: string }).name, "a");
    assert.equal((sheet.events[2] as { name: string }).name, "b");
    assert.equal((sheet.events[3] as { name: string }).name, "c");
  });

  it("prepends variables with after: -1", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, {
      op: "insert-variables",
      after: -1,
      variables: [
        { name: "first", type: "string" },
        { name: "second", type: "number" },
      ],
    });
    assert.equal(sheet.events.length, 3);
    assert.equal(sheet.events[0].eventType, "variable");
    assert.equal((sheet.events[0] as { name: string }).name, "first");
    assert.equal((sheet.events[1] as { name: string }).name, "second");
  });

  it("accepts { variable: {...} } wrapper format (consistent with insert-event)", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, {
      op: "insert-variables",
      path: "",
      after: -1,
      variables: [{ variable: { name: "wrapped", type: "boolean", static: true } }],
    });
    assert.equal(sheet.events.length, 2);
    const v = sheet.events[0] as { name: string; isStatic: boolean; type: string };
    assert.equal(v.name, "wrapped");
    assert.equal(v.type, "boolean");
    assert.equal(v.isStatic, true);
  });
});

// ─── executeOp: insert-actions ───

describe("executeOp: insert-actions", () => {
  it("inserts batch actions after position", () => {
    const existingAction = buildAction(sidGen, { id: "existing", objectClass: "Obj" });
    const block = makeBlock({ actions: [existingAction] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "insert-actions",
      path: "events[0]",
      after: 0,
      actions: [
        { id: "new1", object: "A" },
        { id: "new2", object: "B" },
      ],
    });
    assert.equal(block.actions.length, 3);
    assert.equal((block.actions[0] as StandardAction).id, "existing");
    assert.equal((block.actions[1] as StandardAction).id, "new1");
    assert.equal((block.actions[2] as StandardAction).id, "new2");
  });

  it("inserts actions at multiple paths", () => {
    const block1 = makeBlock({ sid: 1 });
    const block2 = makeBlock({ sid: 2 });
    const sheet = makeSheet(block1, block2);
    executeOp(sidGen, sheet, {
      op: "insert-actions",
      paths: ["events[0]", "events[1]"],
      after: -1,
      actions: [{ comment: "added" }],
    });
    assert.equal(block1.actions.length, 1);
    assert.equal(block2.actions.length, 1);
  });
});

// ─── executeOp: insert-conditions ───

describe("executeOp: insert-conditions", () => {
  it("inserts batch conditions after position", () => {
    const block = makeBlock({ conditions: [makeCondition("existing")] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "insert-conditions",
      path: "events[0]",
      after: 0,
      conditions: [
        { id: "new1", object: "System" },
        { id: "new2", object: "System" },
      ],
    });
    assert.equal(block.conditions.length, 3);
    assert.equal(block.conditions[0].id, "existing");
    assert.equal(block.conditions[1].id, "new1");
    assert.equal(block.conditions[2].id, "new2");
  });

  it("inserts conditions at multiple paths", () => {
    const block1 = makeBlock({ sid: 1 });
    const block2 = makeBlock({ sid: 2 });
    const sheet = makeSheet(block1, block2);
    executeOp(sidGen, sheet, {
      op: "insert-conditions",
      paths: ["events[0]", "events[1]"],
      after: -1,
      conditions: [{ id: "trigger-once", object: "System" }],
    });
    assert.equal(block1.conditions.length, 1);
    assert.equal(block2.conditions.length, 1);
  });
});

// ─── executeOp: replace-action ───

describe("executeOp: replace-action", () => {
  it("replaces action at index", () => {
    const block = makeBlock({ actions: [buildAction(sidGen, { id: "old", objectClass: "X" })] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "replace-action",
      path: "events[0]",
      index: 0,
      action: { id: "new", object: "Y" },
    });
    assert.equal((block.actions[0] as StandardAction).id, "new");
    assert.equal((block.actions[0] as StandardAction).objectClass, "Y");
  });

  it("replaces action at multiple paths", () => {
    const block1 = makeBlock({ actions: [buildAction(sidGen, { id: "old", objectClass: "X" })] });
    const block2 = makeBlock({ actions: [buildAction(sidGen, { id: "old", objectClass: "X" })] });
    const sheet = makeSheet(block1, block2);
    executeOp(sidGen, sheet, {
      op: "replace-action",
      paths: ["events[0]", "events[1]"],
      index: 0,
      action: { id: "replaced", object: "Z" },
    });
    assert.equal((block1.actions[0] as StandardAction).id, "replaced");
    assert.equal((block2.actions[0] as StandardAction).id, "replaced");
  });
});

// ─── executeOp: replace-condition ───

describe("executeOp: replace-condition", () => {
  it("replaces condition at index", () => {
    const block = makeBlock({ conditions: [makeCondition("old")] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "replace-condition",
      path: "events[0]",
      index: 0,
      condition: { id: "new-cond", object: "System" },
    });
    assert.equal(block.conditions[0].id, "new-cond");
  });
});

// ─── executeOp: replace-event ───

describe("executeOp: replace-event", () => {
  it("replaces event at index", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }));
    executeOp(sidGen, sheet, {
      op: "replace-event",
      index: 0,
      comment: "replaced",
    });
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].eventType, "comment");
    assert.equal((sheet.events[0] as { text: string }).text, "replaced");
    assert.equal(sheet.events[1].sid, 2);
  });
});

// ─── executeOp: remove-* ───

describe("executeOp: remove-event", () => {
  it("removes event at index", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }));
    executeOp(sidGen, sheet, { op: "remove-event", index: 0 });
    assert.equal(sheet.events.length, 1);
    assert.equal(sheet.events[0].sid, 2);
  });

  it("removes event using full node path (no index)", () => {
    const child1 = makeBlock({ sid: 10 });
    const child2 = makeBlock({ sid: 20 });
    const parent = makeBlock({ sid: 1, children: [child1, child2] });
    const sheet = makeSheet(parent);
    executeFileOps(sidGen, sheet, [{ op: "remove-event", path: "events[0].children[0]" }]);
    assert.equal((sheet.events[0] as BlockEvent).children!.length, 1);
    assert.equal((sheet.events[0] as BlockEvent).children![0].sid, 20);
  });

  it("removes root event using full node path (no index)", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }), makeBlock({ sid: 3 }));
    executeFileOps(sidGen, sheet, [{ op: "remove-event", path: "events[1]" }]);
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].sid, 1);
    assert.equal(sheet.events[1].sid, 3);
  });
});

describe("executeOp: remove-action", () => {
  it("removes action at index", () => {
    const action1 = buildAction(sidGen, { id: "first", objectClass: "A" });
    const action2 = buildAction(sidGen, { id: "second", objectClass: "B" });
    const block = makeBlock({ actions: [action1, action2] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, { op: "remove-action", path: "events[0]", index: 0 });
    assert.equal(block.actions.length, 1);
    assert.equal((block.actions[0] as StandardAction).id, "second");
  });
});

describe("executeOp: remove-condition", () => {
  it("removes condition at index", () => {
    const block = makeBlock({ conditions: [makeCondition("first"), makeCondition("second")] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, { op: "remove-condition", path: "events[0]", index: 0 });
    assert.equal(block.conditions.length, 1);
    assert.equal(block.conditions[0].id, "second");
  });
});

// ─── executeOp: add-include ───

describe("executeOp: add-include", () => {
  it("adds include at top of events", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, { op: "add-include", include: "OtherSheet" });
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].eventType, "include");
    assert.equal((sheet.events[0] as { includeSheet: string }).includeSheet, "OtherSheet");
  });

  it("inserts after named include when 'after' is specified", () => {
    const sheet = makeSheet(buildInclude("CommonEvents"), buildInclude("NavbarEvents"), makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, { op: "add-include", include: "NewSheet", after: "CommonEvents" });
    assert.equal(sheet.events.length, 4);
    assert.equal((sheet.events[0] as { includeSheet: string }).includeSheet, "CommonEvents");
    assert.equal((sheet.events[1] as { includeSheet: string }).includeSheet, "NewSheet");
    assert.equal((sheet.events[2] as { includeSheet: string }).includeSheet, "NavbarEvents");
  });

  it("inserts after last include when 'after' targets the last one", () => {
    const sheet = makeSheet(buildInclude("CommonEvents"), buildInclude("NavbarEvents"), makeBlock({ sid: 1 }));
    executeOp(sidGen, sheet, { op: "add-include", include: "NewSheet", after: "NavbarEvents" });
    assert.equal(sheet.events.length, 4);
    assert.equal((sheet.events[2] as { includeSheet: string }).includeSheet, "NewSheet");
    assert.equal(sheet.events[3].eventType, "block");
  });

  it("throws when 'after' include is not found", () => {
    const sheet = makeSheet(buildInclude("CommonEvents"), makeBlock({ sid: 1 }));
    assert.throws(
      () => executeOp(sidGen, sheet, { op: "add-include", include: "NewSheet", after: "NonExistent" }),
      /could not find include "NonExistent"/,
    );
  });
});

// ─── executeOp: patch-script ───

describe("executeOp: patch-script", () => {
  it("replaces single line in script", () => {
    const scriptAction = buildScriptAction({ script: ["const x = 1;", "console.log(x);"] });
    const block = makeBlock({ actions: [scriptAction] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-script",
      path: "events[0]",
      actionIndex: 0,
      find: "const x = 1;",
      replace: "const x = 42;",
    });
    const patched = block.actions[0] as ScriptAction;
    assert.deepStrictEqual(patched.script, ["const x = 42;", "console.log(x);"]);
  });

  it("replaces line with multiple lines", () => {
    const scriptAction = buildScriptAction({ script: ["const x = getVal();", "use(x);"] });
    const block = makeBlock({ actions: [scriptAction] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-script",
      path: "events[0]",
      actionIndex: 0,
      find: "const x = getVal();",
      replace: ["const raw = getRaw();", "const x = transform(raw);"],
    });
    const patched = block.actions[0] as ScriptAction;
    assert.deepStrictEqual(patched.script, ["const raw = getRaw();", "const x = transform(raw);", "use(x);"]);
  });

  it("works at multiple paths", () => {
    const script1 = buildScriptAction({ script: ["const a = 1;"] });
    const script2 = buildScriptAction({ script: ["const a = 1;"] });
    const block1 = makeBlock({ actions: [script1] });
    const block2 = makeBlock({ actions: [script2] });
    const sheet = makeSheet(block1, block2);
    executeOp(sidGen, sheet, {
      op: "patch-script",
      paths: ["events[0]", "events[1]"],
      actionIndex: 0,
      find: "const a = 1;",
      replace: "const a = 2;",
    });
    assert.deepStrictEqual((block1.actions[0] as ScriptAction).script, ["const a = 2;"]);
    assert.deepStrictEqual((block2.actions[0] as ScriptAction).script, ["const a = 2;"]);
  });

  it("throws when find string not found", () => {
    const scriptAction = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [scriptAction] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-script",
          path: "events[0]",
          actionIndex: 0,
          find: "nonexistent",
          replace: "replacement",
        }),
      /find string not found/,
    );
  });

  it("replaces all occurrences with replaceAll", () => {
    const scriptAction = buildScriptAction({ script: ["const a = 1;", "const b = 1;", "const c = 1;"] });
    const block = makeBlock({ actions: [scriptAction] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-script",
      path: "events[0]",
      actionIndex: 0,
      find: "= 1",
      replace: "= 2",
      replaceAll: true,
    });
    const patched = block.actions[0] as ScriptAction;
    assert.deepStrictEqual(patched.script, ["const a = 2;", "const b = 2;", "const c = 2;"]);
  });

  it("throws when find string not found with replaceAll", () => {
    const scriptAction = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [scriptAction] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-script",
          path: "events[0]",
          actionIndex: 0,
          find: "nonexistent",
          replace: "replacement",
          replaceAll: true,
        }),
      /find string not found/,
    );
  });

  it("replaces only first occurrence by default", () => {
    const scriptAction = buildScriptAction({ script: ["log(1);", "log(1);"] });
    const block = makeBlock({ actions: [scriptAction] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-script",
      path: "events[0]",
      actionIndex: 0,
      find: "log(1)",
      replace: "log(2)",
    });
    const patched = block.actions[0] as ScriptAction;
    assert.deepStrictEqual(patched.script, ["log(2);", "log(1);"]);
  });

  it("matches script action by content with matchScript", () => {
    const commentAction = { type: "comment", text: "setup" } as unknown as ScriptAction;
    const script1 = buildScriptAction({ script: ["initModule();"] });
    const script2 = buildScriptAction({ script: ["processData();"] });
    const block = makeBlock({ actions: [commentAction, script1, script2] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-script",
      path: "events[0]",
      matchScript: "processData",
      find: "processData()",
      replace: "processData(true)",
    });
    // script2 (index 2) should be patched, script1 untouched
    assert.deepStrictEqual((block.actions[1] as ScriptAction).script, ["initModule();"]);
    assert.deepStrictEqual((block.actions[2] as ScriptAction).script, ["processData(true);"]);
  });

  it("throws when matchScript matches zero actions", () => {
    const script = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-script",
          path: "events[0]",
          matchScript: "nonexistent",
          find: "x",
          replace: "y",
        }),
      /matchScript string not found/,
    );
  });

  it("throws when matchScript matches multiple actions", () => {
    const script1 = buildScriptAction({ script: ["doWork();"] });
    const script2 = buildScriptAction({ script: ["doWork();"] });
    const block = makeBlock({ actions: [script1, script2] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-script",
          path: "events[0]",
          matchScript: "doWork",
          find: "doWork()",
          replace: "doWork(true)",
        }),
      /matched 2 script actions/,
    );
  });

  it("matchScript works with multi-path operations", () => {
    const script1 = buildScriptAction({ script: ["uniqueCall();"] });
    const script2 = buildScriptAction({ script: ["uniqueCall();"] });
    const block1 = makeBlock({ actions: [script1] });
    const block2 = makeBlock({ actions: [script2] });
    const sheet = makeSheet(block1, block2);
    executeOp(sidGen, sheet, {
      op: "patch-script",
      paths: ["events[0]", "events[1]"],
      matchScript: "uniqueCall",
      find: "uniqueCall()",
      replace: "uniqueCall(42)",
    });
    assert.deepStrictEqual((block1.actions[0] as ScriptAction).script, ["uniqueCall(42);"]);
    assert.deepStrictEqual((block2.actions[0] as ScriptAction).script, ["uniqueCall(42);"]);
  });
});

// ─── executeOp: set-or-block ───

describe("executeOp: set-or-block", () => {
  it("sets isOrBlock on block", () => {
    const block = makeBlock();
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, { op: "set-or-block", path: "events[0]" });
    assert.equal((block as BlockEvent & { isOrBlock: boolean }).isOrBlock, true);
  });
});

// ─── executeOp: set-disabled ───

describe("executeOp: set-disabled", () => {
  it("sets disabled on group", () => {
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [],
      sid: 1,
    };
    const sheet = makeSheet(group);
    executeOp(sidGen, sheet, { op: "set-disabled", path: "events[0]", disabled: true });
    assert.equal(group.disabled, true);
  });
});

// ─── executeFileOps ───

describe("executeFileOps", () => {
  it("executes multiple ops sequentially", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    executeFileOps(sidGen, sheet, [
      {
        op: "insert-event",
        index: 0,
        variable: { name: "x", type: "number" },
      },
      {
        op: "insert-actions",
        path: "events[1]",
        after: -1,
        actions: [{ id: "set-text", object: "Text", params: { text: "hi" } }],
      },
    ]);
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].eventType, "variable");
    const block = sheet.events[1] as BlockEvent;
    assert.equal(block.actions.length, 1);
  });

  it("removes events correctly when given in descending index order", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }), makeBlock({ sid: 3 }));
    // Remove indices 2 and 0 in descending order — no index shifting issues
    executeFileOps(sidGen, sheet, [
      { op: "remove-event", index: 2 },
      { op: "remove-event", index: 0 },
    ]);
    // After removing index 2 then index 0, only sid=2 remains
    assert.equal(sheet.events.length, 1);
    assert.equal(sheet.events[0].sid, 2);
  });

  it("warns when consecutive remove-event ops are in ascending index order", () => {
    // Use indices 0 and 1 (ascending) to avoid an out-of-bounds error while still triggering the warning
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }), makeBlock({ sid: 3 }));
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      // Ascending order — will emit a warning (index 0 < index 1)
      executeFileOps(sidGen, sheet, [
        { op: "remove-event", index: 0 },
        { op: "remove-event", index: 1 },
      ]);
    } finally {
      console.warn = origWarn;
    }
    assert.isAtLeast(warnings.length, 1);
    assert.include(warnings[0], "ascending index order");
  });

  it("removes events and patches script when given ops in safe order", () => {
    const script = buildScriptAction({ script: ["const x = 1;"] });
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }), makeBlock({ sid: 3, actions: [script] }));
    executeFileOps(sidGen, sheet, [
      { op: "remove-event", index: 1 },
      { op: "remove-event", index: 0 },
      {
        op: "patch-script",
        path: "events[0]",
        actionIndex: 0,
        find: "const x = 1;",
        replace: "const x = 2;",
      },
    ]);
    // After removing indices 1 then 0 (descending), only sid=3 remains at events[0]
    assert.equal(sheet.events.length, 1);
    assert.equal(sheet.events[0].sid, 3);
    assert.deepStrictEqual((sheet.events[0] as BlockEvent).actions[0] as ScriptAction, {
      ...script,
      script: ["const x = 2;"],
    });
  });

  it("does not sort remove-event ops across different container paths", () => {
    const inner1 = makeBlock({ sid: 10 });
    const inner2 = makeBlock({ sid: 20 });
    const outer = makeBlock({ sid: 1, children: [inner1, inner2] });
    const topBlock = makeBlock({ sid: 2 });
    const sheet = makeSheet(outer, topBlock);
    // Remove from nested path first (ascending), then from root — different containers, no sort
    executeFileOps(sidGen, sheet, [
      { op: "remove-event", path: "events[0]", index: 0 },
      { op: "remove-event", path: "", index: 1 },
    ]);
    // inner1 removed from outer.children, topBlock removed from root
    assert.equal(sheet.events.length, 1);
    assert.equal(sheet.events[0].sid, 1);
    assert.equal((sheet.events[0] as BlockEvent).children!.length, 1);
    assert.equal((sheet.events[0] as BlockEvent).children![0].sid, 20);
  });
});

// ─── createSheet ───

describe("createSheet", () => {
  it("creates sheet from builder events", () => {
    const sheet = createSheet(sidGen, "MySheet", [
      { variable: { name: "x", type: "number" } },
      { block: { actions: [{ comment: "hello" }] } },
    ]);
    assert.equal(sheet.name, "MySheet");
    assert.notEqual(sheet.sid, 0);
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].eventType, "variable");
    assert.equal(sheet.events[1].eventType, "block");
  });
});

// ─── executeRecipe ───

describe("executeRecipe", () => {
  it("modifies existing sheet", () => {
    const existingSheet = makeSheet(makeBlock({ sid: 1 }));
    const recipe: Recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "insert-event", index: -1, comment: "appended" }],
      },
    };
    const result = executeRecipe(sidGen, recipe, () => existingSheet);
    assert.equal(result.modified.size, 1);
    assert.equal(result.created.size, 0);
    const modified = result.modified.get("eventSheets/Test.json")!;
    assert.equal(modified.events.length, 2);
    assert.equal(modified.events[1].eventType, "comment");
  });

  it("creates new sheet", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/NewSheet.json": {
          create: true,
          events: [{ variable: { name: "x", type: "number" } }, { comment: "hello" }],
        },
      },
    };
    const result = executeRecipe(sidGen, recipe, () => {
      throw new Error("should not load");
    });
    assert.equal(result.created.size, 1);
    assert.equal(result.modified.size, 0);
    const created = result.created.get("eventSheets/NewSheet.json")!;
    assert.equal(created.name, "NewSheet");
    assert.equal(created.events.length, 2);
  });

  it("handles multi-file recipe", () => {
    const existingSheet = makeSheet(makeBlock({ sid: 1 }));
    const recipe: Recipe = {
      files: {
        "eventSheets/Existing.json": [{ op: "insert-event", index: -1, comment: "added" }],
        "eventSheets/Brand/New.json": {
          create: true,
          events: [{ variable: { name: "v", type: "string" } }],
        },
      },
    };
    const result = executeRecipe(sidGen, recipe, () => existingSheet);
    assert.equal(result.modified.size, 1);
    assert.equal(result.created.size, 1);
    assert.isTrue(result.modified.has("eventSheets/Existing.json"));
    const created = result.created.get("eventSheets/Brand/New.json")!;
    assert.equal(created.name, "New");
  });
});

// ─── validateRecipe ───

describe("validateRecipe", () => {
  it("returns empty for valid recipe", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test.json": [
          { op: "insert-event", index: 0, block: { actions: [] } },
          { op: "remove-event", index: 1 },
        ],
        "eventSheets/New.json": {
          create: true,
          events: [{ comment: "hi" }],
        },
      },
    };
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });

  it("returns errors for invalid op type", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "bogus-op", index: 0 }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "unknown op");
  });

  it("returns errors for missing op field", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [{ index: 0, block: {} }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "missing or invalid 'op' field");
  });

  it("normalizes bare file names without eventSheets/ prefix and .json extension", () => {
    const recipe = {
      files: {
        "Login/ConfigurationEvents": [{ op: "insert-event", index: 0, block: { actions: [] } }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(Object.keys(recipe.files!), ["eventSheets/Login/ConfigurationEvents.json"]);
  });

  it("normalizes file key with prefix but no .json extension", () => {
    const recipe = {
      files: {
        "eventSheets/Login/ConfigurationEvents": [{ op: "insert-event", index: 0, block: { actions: [] } }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(Object.keys(recipe.files!), ["eventSheets/Login/ConfigurationEvents.json"]);
  });

  it("accepts correctly formatted file keys", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Login/ConfigurationEvents.json": [{ op: "insert-event", index: 0, block: { actions: [] } }],
      },
    };
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });
});

// ─── validateRecipe: addInstVars ───

describe("validateRecipe: addInstVars", () => {
  it("validates valid addInstVars recipe", () => {
    const recipe: Recipe = {
      addInstVars: [
        {
          type: "VODStateJSON",
          instanceVariables: [{ name: "count", type: "number" }],
        },
      ],
    };
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });

  it("errors on missing type field", () => {
    const recipe = {
      addInstVars: [{ instanceVariables: [{ name: "x", type: "number" }] }],
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.isAbove(errors.length, 0);
    assert.include(errors[0], "type");
  });

  it("errors on empty instanceVariables", () => {
    const recipe = {
      addInstVars: [{ type: "Foo", instanceVariables: [] }],
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.isAbove(errors.length, 0);
    assert.include(errors[0], "non-empty");
  });

  it("errors on invalid variable type", () => {
    const recipe = {
      addInstVars: [{ type: "Foo", instanceVariables: [{ name: "x", type: "int" }] }],
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.isAbove(errors.length, 0);
    assert.include(errors[0], "type");
  });
});

// ─── walkScriptActions ───

describe("walkScriptActions", () => {
  it("finds script actions in top-level blocks", () => {
    const script = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    const result = walkScriptActions(sheet);
    assert.equal(result.length, 1);
    assert.deepStrictEqual(result[0].script, ["const x = 1;"]);
  });

  it("finds script actions nested in groups", () => {
    const script = buildScriptAction({ script: ["code();"] });
    const block = makeBlock({ actions: [script] });
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [block],
      sid: 1,
    };
    const sheet = makeSheet(group);
    const result = walkScriptActions(sheet);
    assert.equal(result.length, 1);
  });

  it("finds script actions in function-blocks", () => {
    const script = buildScriptAction({ script: ["return 1;"] });
    const fb = buildFunctionBlock(sidGen, {
      functionName: "myFunc",
      actions: [script],
    });
    const sheet = makeSheet(fb);
    const result = walkScriptActions(sheet);
    assert.equal(result.length, 1);
  });

  it("skips non-script actions", () => {
    const action = buildAction(sidGen, { id: "set-text", objectClass: "Text" });
    const script = buildScriptAction({ script: ["code();"] });
    const block = makeBlock({ actions: [action, script] });
    const sheet = makeSheet(block);
    const result = walkScriptActions(sheet);
    assert.equal(result.length, 1);
  });

  it("skips variables, comments, and includes", () => {
    const sheet = makeSheet(
      {
        eventType: "variable",
        name: "x",
        type: "number",
        initialValue: "0",
        isStatic: false,
        isConstant: false,
        sid: 1,
      } as EventSheetEvent,
      { eventType: "comment", text: "hello" } as EventSheetEvent,
      { eventType: "include", includeSheet: "Other" } as EventSheetEvent,
    );
    const result = walkScriptActions(sheet);
    assert.equal(result.length, 0);
  });

  it("returns mutable references", () => {
    const script = buildScriptAction({ script: ["original();"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    const results = walkScriptActions(sheet);
    results[0].script = ["modified();"];
    assert.deepStrictEqual((block.actions[0] as ScriptAction).script, ["modified();"]);
  });
});

// ─── executeOp: rename-symbol ───

describe("executeOp: rename-symbol", () => {
  it("replaces symbol in script actions", () => {
    const script = buildScriptAction({ script: ["OldModule.foo();", "const x = OldModule.bar;"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "rename-symbol",
      replacements: [
        { from: "OldModule.foo(", to: "newNs.foo(" },
        { from: "OldModule.bar", to: "newNs.bar" },
      ],
    });
    const patched = block.actions[0] as ScriptAction;
    assert.deepStrictEqual(patched.script, ["newNs.foo();", "const x = newNs.bar;"]);
  });

  it("handles substring ordering — longer replacements applied first", () => {
    const script = buildScriptAction({
      script: ["getLocalizedPriceWithoutNumOfDecimals();", "getLocalizedPrice();"],
    });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "rename-symbol",
      replacements: [
        // Intentionally put shorter one first — implementation should sort
        { from: "getLocalizedPrice(", to: "economy.getLocalizedPrice(" },
        { from: "getLocalizedPriceWithoutNumOfDecimals(", to: "economy.getLocalizedPriceWithoutNumOfDecimals(" },
      ],
    });
    const patched = block.actions[0] as ScriptAction;
    assert.deepStrictEqual(patched.script, [
      "economy.getLocalizedPriceWithoutNumOfDecimals();",
      "economy.getLocalizedPrice();",
    ]);
  });

  it("skips non-script actions (standard, call, comment)", () => {
    const stdAction = buildAction(sidGen, { id: "set-text", objectClass: "OldModule", parameters: { text: "OldModule.foo" } });
    const script = buildScriptAction({ script: ["OldModule.foo();"] });
    const block = makeBlock({ actions: [stdAction, script] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "rename-symbol",
      replacements: [{ from: "OldModule.foo(", to: "newNs.foo(" }],
    });
    // Standard action params should be untouched
    assert.equal((block.actions[0] as StandardAction).objectClass, "OldModule");
    assert.equal((block.actions[0] as StandardAction).parameters!.text, "OldModule.foo");
    // Script action should be renamed
    assert.deepStrictEqual((block.actions[1] as ScriptAction).script, ["newNs.foo();"]);
  });

  it("skips functionDescription metadata", () => {
    const script = buildScriptAction({ script: ["OldModule.foo();"] });
    const fb = buildFunctionBlock(sidGen, {
      functionName: "myFunc",
      description: "Uses OldModule.foo to do things",
      actions: [script],
    });
    const sheet = makeSheet(fb);
    executeOp(sidGen, sheet, {
      op: "rename-symbol",
      replacements: [{ from: "OldModule.foo(", to: "newNs.foo(" }],
    });
    // Script renamed
    assert.deepStrictEqual((fb.actions[0] as ScriptAction).script, ["newNs.foo();"]);
    // Description untouched
    assert.equal(fb.functionDescription, "Uses OldModule.foo to do things");
  });

  it("works across nested groups and blocks", () => {
    const script1 = buildScriptAction({ script: ["Mod.a();"] });
    const script2 = buildScriptAction({ script: ["Mod.b();"] });
    const innerBlock = makeBlock({ actions: [script2], children: [] });
    const outerBlock = makeBlock({ actions: [script1], children: [innerBlock] });
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [outerBlock],
      sid: 1,
    };
    const sheet = makeSheet(group);
    executeOp(sidGen, sheet, {
      op: "rename-symbol",
      replacements: [{ from: "Mod.", to: "ns." }],
    });
    const block1 = group.children[0] as BlockEvent;
    assert.deepStrictEqual((block1.actions[0] as ScriptAction).script, ["ns.a();"]);
    const block2 = block1.children![0] as BlockEvent;
    assert.deepStrictEqual((block2.actions[0] as ScriptAction).script, ["ns.b();"]);
  });

  it("throws when no replacements match any script", () => {
    const script = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "rename-symbol",
          replacements: [{ from: "nonexistent", to: "replacement" }],
        }),
      /no replacements matched/,
    );
  });

  it("works via executeRecipe", () => {
    const script = buildScriptAction({ script: ["Old.call();"] });
    const block = makeBlock({ actions: [script] });
    const existingSheet = makeSheet(block);
    const recipe: Recipe = {
      files: {
        "eventSheets/Test.json": [
          {
            op: "rename-symbol",
            replacements: [{ from: "Old.call(", to: "New.call(" }],
          },
        ],
      },
    };
    const result = executeRecipe(sidGen, recipe, () => existingSheet);
    const modified = result.modified.get("eventSheets/Test.json")!;
    const modBlock = modified.events[0] as BlockEvent;
    assert.deepStrictEqual((modBlock.actions[0] as ScriptAction).script, ["New.call();"]);
  });
});

// ─── validateRecipe: rename-symbol ───

describe("validateRecipe: rename-symbol", () => {
  it("passes for valid rename-symbol", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test.json": [
          {
            op: "rename-symbol",
            replacements: [{ from: "old", to: "new" }],
          },
        ],
      },
    };
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });

  it("fails for empty replacements", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "rename-symbol", replacements: [] }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "non-empty");
  });

  it("fails for missing replacements", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "rename-symbol" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    // Schema validation reports missing required "replacements" AND
    // the existing specific validation reports non-empty array requirement
    assert.ok(errors.length >= 1);
    assert.ok(errors.some((e) => e.includes("replacements")));
  });
});

// ─── validateRecipe: patch-script ───

describe("validateRecipe: patch-script", () => {
  it("passes for patch-script with actionIndex", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "patch-script", path: "events[0]", actionIndex: 0, find: "x", replace: "y" }],
      },
    };
    assert.deepStrictEqual(validateRecipe(recipe), []);
  });

  it("passes for patch-script with matchScript", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [
          { op: "patch-script", path: "events[0]", matchScript: "doWork", find: "x", replace: "y" },
        ],
      },
    } as unknown as Recipe;
    assert.deepStrictEqual(validateRecipe(recipe), []);
  });

  it("fails when neither actionIndex nor matchScript", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "patch-script", path: "events[0]", find: "x", replace: "y" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "requires either");
  });

  it("fails when both actionIndex and matchScript", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [
          { op: "patch-script", path: "events[0]", actionIndex: 0, matchScript: "doWork", find: "x", replace: "y" },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "cannot have both");
  });
});

// ─── applyReplacements ───

describe("applyReplacements", () => {
  it("returns count of modified script actions", () => {
    const script = buildScriptAction({ script: ["OldModule.foo();"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    const count = applyReplacements(sheet, [{ from: "OldModule.foo(", to: "newNs.foo(" }]);
    assert.equal(count, 1);
    assert.deepStrictEqual((block.actions[0] as ScriptAction).script, ["newNs.foo();"]);
  });

  it("returns 0 when no matches (does NOT throw)", () => {
    const script = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    const count = applyReplacements(sheet, [{ from: "nonexistent", to: "replacement" }]);
    assert.equal(count, 0);
  });

  it("handles substring ordering — longest-first", () => {
    const script = buildScriptAction({
      script: ["getLocalizedPriceWithoutNumOfDecimals();", "getLocalizedPrice();"],
    });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    const count = applyReplacements(sheet, [
      { from: "getLocalizedPrice(", to: "economy.getLocalizedPrice(" },
      { from: "getLocalizedPriceWithoutNumOfDecimals(", to: "economy.getLocalizedPriceWithoutNumOfDecimals(" },
    ]);
    assert.equal(count, 1);
    assert.deepStrictEqual((block.actions[0] as ScriptAction).script, [
      "economy.getLocalizedPriceWithoutNumOfDecimals();",
      "economy.getLocalizedPrice();",
    ]);
  });

  it("counts multiple modified actions independently", () => {
    const script1 = buildScriptAction({ script: ["Mod.a();"] });
    const script2 = buildScriptAction({ script: ["Mod.b();"] });
    const block1 = makeBlock({ actions: [script1] });
    const block2 = makeBlock({ actions: [script2] });
    const sheet = makeSheet(block1, block2);
    const count = applyReplacements(sheet, [{ from: "Mod.", to: "ns." }]);
    assert.equal(count, 2);
  });

  it("returns 0 for empty replacements array", () => {
    const script = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    const count = applyReplacements(sheet, []);
    assert.equal(count, 0);
  });
});

// ─── isFileCreate ───

describe("isFileCreate", () => {
  it("returns true for FileCreate", () => {
    assert.isTrue(isFileCreate({ create: true, events: [] }));
  });

  it("returns false for FileOp array", () => {
    assert.isFalse(isFileCreate([]));
  });
});

// ─── stale path warnings ───

describe("stale path warnings", () => {
  it("insert-event followed by patch-script at higher index emits warning", () => {
    const sheet = makeSheet(
      makeBlock({ sid: 10 }), // events[0]
      makeBlock({ sid: 20 }), // events[1]
      makeBlock({ sid: 30 }), // events[2]
      makeBlock({ sid: 40, actions: [buildScriptAction({ script: ["const x = 1;"] })] }), // events[3]
      makeBlock({ sid: 50, actions: [buildScriptAction({ script: ["const y = 2;"] })] }), // events[4]
    );
    const ops: FileOp[] = [
      { op: "insert-event", index: 1, block: { actions: [{ script: ["// new"] }] } },
      // After insert, events[4] is now at events[5], but patch-script still targets events[4]
      // which is now the original events[3] (shifted). Warning should fire even though execution may "succeed" on the wrong target
      { op: "patch-script", path: "events[4]", actionIndex: 0, find: "const x = 1;", replace: "const x = 2;" },
    ];
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      executeFileOps(sidGen, sheet, ops);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "insert-event");
    assert.include(warnings[0], "stale");
  });

  it("remove-event followed by patch-script at higher index emits warning", () => {
    const sheet = makeSheet(
      makeBlock({ sid: 10 }), // events[0]
      makeBlock({ sid: 20 }), // events[1]
      makeBlock({ sid: 30 }), // events[2]
      makeBlock({ sid: 40, actions: [buildScriptAction({ script: ["const x = 1;"] })] }), // events[3]
      makeBlock({ sid: 50, actions: [buildScriptAction({ script: ["const y = 2;"] })] }), // events[4]
    );
    const ops: FileOp[] = [
      { op: "remove-event", index: 1 },
      { op: "patch-script", path: "events[4]", actionIndex: 0, find: "const y = 2;", replace: "const y = 3;" },
    ];
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      // The patch will fail because events[4] no longer exists after remove, but warning should still fire
      assert.throws(() => executeFileOps(sidGen, sheet, ops));
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "remove-event");
    assert.include(warnings[0], "stale");
  });

  it("no warning when ops target different containers", () => {
    // Insert into events[0]'s children, then patch-script at top-level events[1]
    // These are different containers so no warning should fire
    const parentBlock = makeBlock({
      sid: 10,
      children: [
        makeBlock({ sid: 11 }), // events[0].children[0]
      ],
    });
    const sheet = makeSheet(
      parentBlock, // events[0]
      makeBlock({ sid: 20, actions: [buildScriptAction({ script: ["const x = 1;"] })] }), // events[1]
    );
    const ops: FileOp[] = [
      // Insert inside events[0]'s children — container is "events[0]"
      { op: "insert-event", path: "events[0]", index: 0, block: { actions: [{ script: ["// new child"] }] } },
      // Patch at top-level events[1] — container is "" (top-level)
      { op: "patch-script", path: "events[1]", actionIndex: 0, find: "const x = 1;", replace: "const x = 2;" },
    ];
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      executeFileOps(sidGen, sheet, ops);
    } finally {
      console.warn = origWarn;
    }
    // Insert was in "events[0].children", patch is at "events[1]" — different containers, no warning
    assert.equal(warnings.length, 0);
  });

  it("no warning when later op index is below shift point", () => {
    const sheet = makeSheet(
      makeBlock({ sid: 10, actions: [buildScriptAction({ script: ["const x = 1;"] })] }), // events[0]
      makeBlock({ sid: 20 }), // events[1]
      makeBlock({ sid: 30 }), // events[2]
    );
    const ops: FileOp[] = [
      { op: "insert-event", index: 2, block: { actions: [{ script: ["// new"] }] } },
      { op: "patch-script", path: "events[0]", actionIndex: 0, find: "const x = 1;", replace: "const x = 2;" },
    ];
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      executeFileOps(sidGen, sheet, ops);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 0);
  });

  it("insert-event at container index warns about later insert-event at same container", () => {
    const sheet = makeSheet(
      makeBlock({ sid: 10 }), // events[0]
      makeBlock({ sid: 20 }), // events[1]
      makeBlock({ sid: 30 }), // events[2]
      makeBlock({ sid: 40 }), // events[3]
    );
    const ops: FileOp[] = [
      { op: "insert-event", index: 1, block: { actions: [{ script: ["// first"] }] } },
      { op: "insert-event", index: 3, block: { actions: [{ script: ["// second"] }] } },
    ];
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      executeFileOps(sidGen, sheet, ops);
    } finally {
      console.warn = origWarn;
    }
    // The second insert-event has no path (defaults to ""), so getOpPaths returns [""]
    // But its index=3 is in the same container and >= shiftAt=1, so it should warn
    assert.isAtLeast(warnings.length, 1);
    assert.include(warnings[0], "stale");
  });
});

// ─── SID-based addressing ───

describe("SID-based addressing", () => {
  it("remove-event with in: 'sid:X' removes the correct event", () => {
    const sheet = makeSheet(makeBlock({ sid: 100 }), makeBlock({ sid: 200 }), makeBlock({ sid: 300 }));
    executeFileOps(sidGen, sheet, [{ op: "remove-event", in: "sid:200" }]);
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].sid, 100);
    assert.equal(sheet.events[1].sid, 300);
  });

  it("batch remove-event with in: 'sid:X' removes all targeted events", () => {
    const sheet = makeSheet(
      makeBlock({ sid: 100 }),
      makeBlock({ sid: 200 }),
      makeBlock({ sid: 300 }),
      makeBlock({ sid: 400 }),
      makeBlock({ sid: 500 }),
    );
    executeFileOps(sidGen, sheet, [
      { op: "remove-event", in: "sid:200" },
      { op: "remove-event", in: "sid:400" },
      { op: "remove-event", in: "sid:500" },
    ]);
    assert.equal(sheet.events.length, 2);
    assert.equal(sheet.events[0].sid, 100);
    assert.equal(sheet.events[1].sid, 300);
  });

  it("insert-actions with in: 'sid:X' inserts into the correct event", () => {
    const block = makeBlock({ sid: 500 });
    const sheet = makeSheet(block);
    executeFileOps(sidGen, sheet, [
      { op: "insert-actions", in: "sid:500", after: -1, actions: [{ script: ["const x = 1;"] }] },
    ]);
    assert.equal(block.actions.length, 1);
    assert.deepStrictEqual((block.actions[0] as ScriptAction).script, ["const x = 1;"]);
  });

  it("$symbol allows referencing a newly-inserted event", () => {
    const sheet = makeSheet();
    executeFileOps(sidGen, sheet, [
      { op: "insert-event", id: "$newBlock", index: 0, block: { conditions: [], actions: [] } },
      { op: "insert-actions", in: "$newBlock", after: -1, actions: [{ script: ["const y = 2;"] }] },
    ]);
    assert.equal(sheet.events.length, 1);
    const block = sheet.events[0] as BlockEvent;
    assert.equal(block.actions.length, 1);
    assert.deepStrictEqual((block.actions[0] as ScriptAction).script, ["const y = 2;"]);
  });

  it("after: 'sid:X' on insert-event inserts after the referenced event", () => {
    const sheet = makeSheet(makeBlock({ sid: 10 }), makeBlock({ sid: 20 }), makeBlock({ sid: 30 }));
    executeFileOps(sidGen, sheet, [
      { op: "insert-event", after: "sid:20", block: { conditions: [], actions: [{ script: ["// inserted"] }] } },
    ]);
    assert.equal(sheet.events.length, 4);
    assert.equal(sheet.events[0].sid, 10);
    assert.equal(sheet.events[1].sid, 20);
    assert.equal(sheet.events[3].sid, 30);
    assert.deepStrictEqual(((sheet.events[2] as BlockEvent).actions[0] as ScriptAction).script, ["// inserted"]);
  });

  it("insert-event with in + after:'sid:X' inserts after the referenced child", () => {
    const child1 = makeBlock({ sid: 100 });
    const child2 = makeBlock({ sid: 200 });
    const child3 = makeBlock({ sid: 300 });
    const container = makeBlock({ sid: 10, children: [child1, child2, child3] });
    const sheet = makeSheet(container);
    executeFileOps(sidGen, sheet, [
      {
        op: "insert-event",
        in: "sid:10",
        after: "sid:200",
        block: { conditions: [], actions: [{ script: ["// inserted"] }] },
      },
    ]);
    const children = (sheet.events[0] as BlockEvent).children as BlockEvent[];
    assert.equal(children.length, 4);
    assert.equal(children[0].sid, 100);
    assert.equal(children[1].sid, 200);
    // inserted block should be at index 2
    assert.deepStrictEqual((children[2].actions[0] as ScriptAction).script, ["// inserted"]);
    assert.equal(children[3].sid, 300);
  });

  it("insert-event with in + after:'sid:X' throws if after ref not in container", () => {
    const child1 = makeBlock({ sid: 100 });
    const container = makeBlock({ sid: 10, children: [child1] });
    const outsider = makeBlock({ sid: 999 });
    const sheet = makeSheet(container, outsider);
    assert.throws(
      () =>
        executeFileOps(sidGen, sheet, [
          { op: "insert-event", in: "sid:10", after: "sid:999", block: { conditions: [], actions: [] } },
        ]),
      /not found in container/,
    );
  });

  it("insert-event with in + numeric after inserts after that position", () => {
    const child1 = makeBlock({ sid: 100 });
    const child2 = makeBlock({ sid: 200 });
    const container = makeBlock({ sid: 10, children: [child1, child2] });
    const sheet = makeSheet(container);
    executeFileOps(sidGen, sheet, [
      { op: "insert-event", in: "sid:10", after: 0, block: { conditions: [], actions: [{ script: ["// after-0"] }] } },
    ]);
    const children = (sheet.events[0] as BlockEvent).children as BlockEvent[];
    assert.equal(children.length, 3);
    assert.equal(children[0].sid, 100);
    assert.deepStrictEqual((children[1].actions[0] as ScriptAction).script, ["// after-0"]);
    assert.equal(children[2].sid, 200);
  });

  it("autoAdjust deprecation warning is emitted", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }));
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      executeFileOps(sidGen, sheet, [], { autoAdjust: true });
    } finally {
      console.warn = origWarn;
    }
    assert.isAtLeast(warnings.length, 1);
    assert.include(warnings[0], "autoAdjust is deprecated");
  });

  it("consecutive position-based remove-events in ascending order emit a warning", () => {
    const sheet = makeSheet(makeBlock({ sid: 1 }), makeBlock({ sid: 2 }), makeBlock({ sid: 3 }));
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      // Use indices 0 and 1 (ascending) to trigger warning without an out-of-bounds error
      executeFileOps(sidGen, sheet, [
        { op: "remove-event", index: 0 },
        { op: "remove-event", index: 1 },
      ]);
    } finally {
      console.warn = origWarn;
    }
    assert.isAtLeast(warnings.length, 1);
    assert.include(warnings[0], "ascending index order");
  });
});

// ─── executeOp: patch-action-param ───

describe("executeOp: patch-action-param", () => {
  it("patches a single param on a StandardAction by actionIndex", () => {
    const action = buildAction(sidGen, {
      id: "create-object",
      objectClass: "System",
      parameters: { "object-to-create": "Hero", "template-name": "" },
    });
    const block = makeBlock({ actions: [action] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-action-param",
      path: "events[0]",
      actionIndex: 0,
      param: "template-name",
      value: '"default"',
    });
    const patched = block.actions[0] as StandardAction;
    assert.equal(patched.parameters!["template-name"], '"default"');
    assert.equal(patched.parameters!["object-to-create"], "Hero");
  });

  it("patches multiple params with params object", () => {
    const action = buildAction(sidGen, {
      id: "create-object",
      objectClass: "System",
      parameters: { "object-to-create": "Hero", "template-name": "", "create-hierarchy": "false" },
    });
    const block = makeBlock({ actions: [action] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-action-param",
      path: "events[0]",
      actionIndex: 0,
      params: { "template-name": '"default"', "create-hierarchy": "true" },
    });
    const patched = block.actions[0] as StandardAction;
    assert.equal(patched.parameters!["template-name"], '"default"');
    assert.equal(patched.parameters!["create-hierarchy"], "true");
    assert.equal(patched.parameters!["object-to-create"], "Hero");
  });

  it("finds action by matchAction on StandardAction id", () => {
    const commentAction = { type: "comment", text: "setup" } as unknown as StandardAction;
    const action = buildAction(sidGen, {
      id: "create-object",
      objectClass: "System",
      parameters: { "template-name": "" },
    });
    const block = makeBlock({ actions: [commentAction, action] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-action-param",
      path: "events[0]",
      matchAction: "create-object",
      param: "template-name",
      value: '"HeroTemplate"',
    });
    const patched = block.actions[1] as StandardAction;
    assert.equal(patched.parameters!["template-name"], '"HeroTemplate"');
  });

  it("finds FunctionCallAction by matchAction", () => {
    const callAction: FunctionCallAction = {
      callFunction: "DoSetup",
      sid: 123,
      parameters: ['"old"', "0"],
    };
    const block = makeBlock({ actions: [callAction as unknown as StandardAction] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-action-param",
      path: "events[0]",
      matchAction: "DoSetup",
      param: "0",
      value: '"new"',
    });
    const patched = block.actions[0] as unknown as FunctionCallAction;
    assert.equal(patched.parameters![0], '"new"');
  });

  it("works with multiple paths", () => {
    const action1 = buildAction(sidGen, {
      id: "set-text",
      objectClass: "Text",
      parameters: { text: '"old"' },
    });
    const action2 = buildAction(sidGen, {
      id: "set-text",
      objectClass: "Text",
      parameters: { text: '"old"' },
    });
    const block1 = makeBlock({ actions: [action1] });
    const block2 = makeBlock({ actions: [action2] });
    const sheet = makeSheet(block1, block2);
    executeOp(sidGen, sheet, {
      op: "patch-action-param",
      paths: ["events[0]", "events[1]"],
      actionIndex: 0,
      param: "text",
      value: '"new"',
    });
    assert.equal((block1.actions[0] as StandardAction).parameters!.text, '"new"');
    assert.equal((block2.actions[0] as StandardAction).parameters!.text, '"new"');
  });

  it("throws on script action", () => {
    const script = buildScriptAction({ script: ["const x = 1;"] });
    const block = makeBlock({ actions: [script] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-action-param",
          path: "events[0]",
          actionIndex: 0,
          param: "foo",
          value: "bar",
        }),
      /not a parameterized action/,
    );
  });

  it("throws on comment action", () => {
    const comment = { type: "comment", text: "note" } as unknown as StandardAction;
    const block = makeBlock({ actions: [comment] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-action-param",
          path: "events[0]",
          actionIndex: 0,
          param: "foo",
          value: "bar",
        }),
      /not a parameterized action/,
    );
  });

  it("throws when matchAction matches zero actions", () => {
    const action = buildAction(sidGen, { id: "set-text", objectClass: "Text" });
    const block = makeBlock({ actions: [action] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-action-param",
          path: "events[0]",
          matchAction: "nonexistent",
          param: "foo",
          value: "bar",
        }),
      /matchAction.*not found/,
    );
  });

  it("throws when matchAction matches multiple actions", () => {
    const action1 = buildAction(sidGen, { id: "set-text", objectClass: "Text" });
    const action2 = buildAction(sidGen, { id: "set-text", objectClass: "Text" });
    const block = makeBlock({ actions: [action1, action2] });
    const sheet = makeSheet(block);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-action-param",
          path: "events[0]",
          matchAction: "set-text",
          param: "text",
          value: '"new"',
        }),
      /matchAction matched.*actions/,
    );
  });

  it("preserves SID and other action fields", () => {
    const action: StandardAction = {
      id: "create-object",
      objectClass: "System",
      sid: 772167270391161,
      parameters: { "template-name": "", "object-to-create": "Hero" },
      behaviorType: undefined,
    };
    const block = makeBlock({ actions: [action] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-action-param",
      path: "events[0]",
      actionIndex: 0,
      param: "template-name",
      value: '"default"',
    });
    const patched = block.actions[0] as StandardAction;
    assert.equal(patched.sid, 772167270391161);
    assert.equal(patched.id, "create-object");
    assert.equal(patched.objectClass, "System");
  });

  it("creates parameters object if missing on StandardAction", () => {
    const action = buildAction(sidGen, { id: "do-something", objectClass: "System" });
    // buildAction doesn't set parameters when not provided
    const block = makeBlock({ actions: [action] });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "patch-action-param",
      path: "events[0]",
      actionIndex: 0,
      param: "new-param",
      value: '"value"',
    });
    const patched = block.actions[0] as StandardAction;
    assert.equal(patched.parameters!["new-param"], '"value"');
  });
});

// ─── validateRecipe: patch-action-param ───

describe("validateRecipe: patch-action-param", () => {
  it("passes for patch-action-param with actionIndex and single param", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test.json": [
          { op: "patch-action-param", path: "events[0]", actionIndex: 0, param: "template-name", value: '"default"' },
        ],
      },
    } as unknown as Recipe;
    assert.deepStrictEqual(validateRecipe(recipe), []);
  });

  it("passes for patch-action-param with matchAction and params", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [
          {
            op: "patch-action-param",
            path: "events[0]",
            matchAction: "create-object",
            params: { "template-name": '"default"' },
          },
        ],
      },
    } as unknown as Recipe;
    assert.deepStrictEqual(validateRecipe(recipe), []);
  });

  it("fails when neither actionIndex nor matchAction", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "patch-action-param", path: "events[0]", param: "foo", value: "bar" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "requires either");
  });

  it("fails when both actionIndex and matchAction", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [
          {
            op: "patch-action-param",
            path: "events[0]",
            actionIndex: 0,
            matchAction: "create-object",
            param: "foo",
            value: "bar",
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "cannot have both");
  });

  it("fails when neither param nor params", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [{ op: "patch-action-param", path: "events[0]", actionIndex: 0 }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], 'requires either "param"');
  });

  it("fails when both param and params", () => {
    const recipe = {
      files: {
        "eventSheets/Test.json": [
          {
            op: "patch-action-param",
            path: "events[0]",
            actionIndex: 0,
            param: "foo",
            value: "bar",
            params: { baz: "qux" },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.equal(errors.length, 1);
    assert.include(errors[0], "cannot have both");
  });
});

// ─── normalizeFileKey ───

describe("normalizeFileKey", () => {
  it("expands bare name to full path", () => {
    assert.equal(normalizeFileKey("Goals/GoalsEvents"), "eventSheets/Goals/GoalsEvents.json");
  });

  it("adds .json extension when missing", () => {
    assert.equal(normalizeFileKey("eventSheets/Goals/GoalsEvents"), "eventSheets/Goals/GoalsEvents.json");
  });

  it("leaves full path unchanged", () => {
    assert.equal(normalizeFileKey("eventSheets/Goals/GoalsEvents.json"), "eventSheets/Goals/GoalsEvents.json");
  });

  it("handles single-word bare name", () => {
    assert.equal(normalizeFileKey("Sheet"), "eventSheets/Sheet.json");
  });
});

// ─── normalizeLayoutKey ───

describe("normalizeLayoutKey", () => {
  it("expands bare name to full path", () => {
    assert.equal(normalizeLayoutKey("Login/LoginLayout"), "layouts/Login/LoginLayout.json");
  });

  it("adds .json extension when missing", () => {
    assert.equal(normalizeLayoutKey("layouts/Login/LoginLayout"), "layouts/Login/LoginLayout.json");
  });

  it("leaves full path unchanged", () => {
    assert.equal(normalizeLayoutKey("layouts/Login/LoginLayout.json"), "layouts/Login/LoginLayout.json");
  });

  it("handles single-word bare name", () => {
    assert.equal(normalizeLayoutKey("Layout"), "layouts/Layout.json");
  });
});

// ─── normalizeRecipePaths ───

describe("normalizeRecipePaths", () => {
  it("normalizes bare file keys", () => {
    const recipe: Recipe = {
      files: { "Goals/GoalsEvents": [{ op: "insert-event", index: 0, block: { actions: [] } }] },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    assert.deepStrictEqual(Object.keys(recipe.files!), ["eventSheets/Goals/GoalsEvents.json"]);
  });

  it("normalizes bare layout keys", () => {
    const recipe: Recipe = {
      layouts: { "Login/LoginLayout": [{ op: "add-layer", name: "Test" }] },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    assert.deepStrictEqual(Object.keys(recipe.layouts!), ["layouts/Login/LoginLayout.json"]);
  });

  it("normalizes copy-instance from field", () => {
    const recipe: Recipe = {
      layouts: {
        "layouts/Target.json": [{ op: "copy-instance", from: "Source/Layout", type: "Obj", targetLayer: "Layer" }],
      },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    const ops = recipe.layouts!["layouts/Target.json"];
    assert.equal((ops[0] as any).from, "layouts/Source/Layout.json");
  });

  it("normalizes add-replica from field", () => {
    const recipe: Recipe = {
      layouts: {
        "layouts/Target.json": [
          { op: "add-replica", from: "Source/Layout", sourceTemplateName: "T", targetLayer: "Layer" },
        ],
      },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    const ops = recipe.layouts!["layouts/Target.json"];
    assert.equal((ops[0] as any).from, "layouts/Source/Layout.json");
  });

  it("leaves already-full paths unchanged", () => {
    const recipe: Recipe = {
      files: { "eventSheets/Test.json": [{ op: "remove-event", index: 0 }] },
      layouts: { "layouts/Test.json": [{ op: "add-layer", name: "L" }] },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    assert.deepStrictEqual(Object.keys(recipe.files!), ["eventSheets/Test.json"]);
    assert.deepStrictEqual(Object.keys(recipe.layouts!), ["layouts/Test.json"]);
  });

  it("normalizes extract-template sourceLayout", () => {
    const recipe: Recipe = {
      layouts: {
        "layouts/Templates.json": [
          {
            op: "extract-template",
            sourceLayout: "Shop/ShopLayout",
            sourceType: "Icon",
            templateName: "Icon",
            templatesLayer: "Layer 0",
          },
        ],
      },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    const ops = recipe.layouts!["layouts/Templates.json"];
    assert.equal((ops[0] as any).sourceLayout, "layouts/Shop/ShopLayout.json");
  });

  it("normalizes replace-instance-with-replica templatesLayout", () => {
    const recipe: Recipe = {
      layouts: {
        "layouts/Game.json": [
          {
            op: "replace-instance-with-replica",
            type: "Hero",
            templatesLayout: "UI/Templates",
            templateName: "Hero",
          },
        ],
      },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    const ops = recipe.layouts!["layouts/Game.json"];
    assert.equal((ops[0] as any).templatesLayout, "layouts/UI/Templates.json");
  });

  it("normalizes each target.layout on clone-replica-to-layouts", () => {
    const recipe: Recipe = {
      layouts: {
        "layouts/Templates.json": [
          {
            op: "clone-replica-to-layouts",
            templateName: "Icon",
            sourceType: "Icon",
            targets: [
              { layout: "Shop/ShopLayout", layer: "L" },
              { layout: "layouts/Game.json", layer: "L" },
            ],
          },
        ],
      },
    } as unknown as Recipe;
    normalizeRecipePaths(recipe);
    const targets = (recipe.layouts!["layouts/Templates.json"][0] as any).targets;
    assert.equal(targets[0].layout, "layouts/Shop/ShopLayout.json");
    assert.equal(targets[1].layout, "layouts/Game.json");
  });
});

// ─── validateRecipe: workflow ops ───

describe("validateRecipe: workflow ops", () => {
  describe("extract-template", () => {
    it("rejects missing sourceLayout / sourceType / templateName / templatesLayer", () => {
      const recipe: Recipe = {
        layouts: { "layouts/Templates.json": [{ op: "extract-template" } as any] },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      const joined = errors.join("\n");
      assert.match(joined, /"sourceLayout" field is required/);
      assert.match(joined, /"sourceType" field is required/);
      assert.match(joined, /"templateName" field is required/);
      assert.match(joined, /"templatesLayer" field is required/);
    });

    it("rejects sourceLayout equal to the layouts key", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "extract-template",
              sourceLayout: "layouts/Templates.json",
              sourceType: "Icon",
              templateName: "Icon",
              templatesLayer: "Layer 0",
            },
          ],
        },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      const joined = errors.join("\n");
      assert.match(joined, /"sourceLayout" must differ from the layouts key/);
    });

    it("rejects same-layout via bare-key normalization", () => {
      // Bare keys collapse to the same normalized path; the check still fires.
      const recipe: Recipe = {
        layouts: {
          Templates: [
            {
              op: "extract-template",
              sourceLayout: "Templates",
              sourceType: "Icon",
              templateName: "Icon",
              templatesLayer: "Layer 0",
            },
          ],
        },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      assert.match(errors.join("\n"), /"sourceLayout" must differ from the layouts key/);
    });

    it("accepts a valid extract-template op", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "extract-template",
              sourceLayout: "layouts/Shop.json",
              sourceType: "Icon",
              templateName: "Icon",
              templatesLayer: "Layer 0",
            },
          ],
        },
      } as unknown as Recipe;
      assert.deepStrictEqual(validateRecipe(recipe), []);
    });
  });

  describe("templatize-in-place", () => {
    it("rejects missing type and templateName", () => {
      const recipe: Recipe = {
        layouts: { "layouts/Game.json": [{ op: "templatize-in-place" } as any] },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      const joined = errors.join("\n");
      assert.match(joined, /"type" field is required for templatize-in-place/);
      assert.match(joined, /"templateName" field is required for templatize-in-place/);
    });

    it("accepts a valid op", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [{ op: "templatize-in-place", type: "Hero", templateName: "Hero" }],
        },
      } as unknown as Recipe;
      assert.deepStrictEqual(validateRecipe(recipe), []);
    });
  });

  describe("clone-replica-to-layouts", () => {
    it("rejects missing templateName / sourceType / targets", () => {
      const recipe: Recipe = {
        layouts: { "layouts/Templates.json": [{ op: "clone-replica-to-layouts" } as any] },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      const joined = errors.join("\n");
      assert.match(joined, /"templateName" field is required for clone-replica-to-layouts/);
      assert.match(joined, /"sourceType" field is required for clone-replica-to-layouts/);
      assert.match(joined, /"targets" must be a non-empty array/);
    });

    it("rejects empty targets array", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            { op: "clone-replica-to-layouts", templateName: "T", sourceType: "X", targets: [] },
          ],
        },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      assert.match(errors.join("\n"), /"targets" must be a non-empty array/);
    });

    it("rejects duplicate target layouts", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "clone-replica-to-layouts",
              templateName: "T",
              sourceType: "X",
              targets: [
                { layout: "layouts/A.json", layer: "L" },
                { layout: "layouts/A.json", layer: "L" },
              ],
            },
          ],
        },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      assert.match(errors.join("\n"), /duplicate target layout "layouts\/A.json"/);
    });

    it("rejects per-target missing layout / layer", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "clone-replica-to-layouts",
              templateName: "T",
              sourceType: "X",
              targets: [{ layer: "L" } as any, { layout: "layouts/B.json" } as any],
            },
          ],
        },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      const joined = errors.join("\n");
      assert.match(joined, /targets\[0\]: "layout" field is required/);
      assert.match(joined, /targets\[1\]: "layer" field is required/);
    });

    it("accepts a valid op with multiple distinct targets", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "clone-replica-to-layouts",
              templateName: "T",
              sourceType: "X",
              targets: [
                { layout: "layouts/A.json", layer: "L" },
                { layout: "layouts/B.json", layer: "L" },
              ],
            },
          ],
        },
      } as unknown as Recipe;
      assert.deepStrictEqual(validateRecipe(recipe), []);
    });
  });

  describe("replace-instance-with-replica", () => {
    it("rejects missing type / templatesLayout / templateName", () => {
      const recipe: Recipe = {
        layouts: { "layouts/Game.json": [{ op: "replace-instance-with-replica" } as any] },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      const joined = errors.join("\n");
      assert.match(joined, /"type" field is required for replace-instance-with-replica/);
      assert.match(joined, /"templatesLayout" field is required for replace-instance-with-replica/);
      assert.match(joined, /"templateName" field is required for replace-instance-with-replica/);
    });

    it("rejects non-string layer", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "replace-instance-with-replica",
              type: "X",
              templatesLayout: "layouts/T.json",
              templateName: "T",
              layer: 5,
            } as any,
          ],
        },
      } as unknown as Recipe;
      const errors = validateRecipe(recipe);
      assert.match(errors.join("\n"), /"layer" must be a string for replace-instance-with-replica/);
    });

    it("accepts a valid op", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "replace-instance-with-replica",
              type: "Hero",
              templatesLayout: "layouts/Templates.json",
              templateName: "Hero",
              layer: "Gameplay",
            },
          ],
        },
      } as unknown as Recipe;
      assert.deepStrictEqual(validateRecipe(recipe), []);
    });
  });
});

// ─── validateRecipe: field validation ───

describe("validateRecipe: field validation", () => {
  // Meta-test: every op in VALID_OPS has a schema entry
  it("has schema for every valid op", () => {
    for (const op of VALID_OPS) {
      assert.ok(OP_FIELD_SCHEMAS[op], `Missing OP_FIELD_SCHEMAS entry for op "${op}"`);
    }
  });

  // Missing required fields
  it("errors on patch-script missing find", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "patch-script", actionIndex: 0, replace: "bar" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "find"')));
  });

  it("errors on patch-script missing replace", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "patch-script", actionIndex: 0, find: "foo" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "replace"')));
  });

  it("errors on replace-action missing action", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "replace-action", index: 0 }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "action"')));
  });

  it("errors on replace-action missing index", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "replace-action", action: { script: ["x"] } }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "index"')));
  });

  it("errors on add-include missing include", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "add-include" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "include"')));
  });

  it("errors on set-disabled missing disabled", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "set-disabled", path: "events[0]" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "disabled"')));
  });

  it("errors on insert-variables missing after", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "insert-variables", variables: [{ name: "X", type: "number" }] }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "after"')));
  });

  it("errors on insert-variables missing variables", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "insert-variables", after: 0 }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "variables"')));
  });

  it("errors on rename-symbol missing replacements", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "rename-symbol" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing required field "replacements"') || e.includes("replacements")));
  });

  // Known misspellings
  it("warns on patch-script with old/new instead of find/replace", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "patch-script", actionIndex: 0, old: "foo", new: "bar" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('"old"') && e.includes('did you mean "find"')));
    assert.ok(errors.some((e) => e.includes('"new"') && e.includes('did you mean "replace"')));
  });

  it("warns on replace-action with actions instead of action", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "replace-action", index: 0, actions: [{ script: ["x"] }] }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('"actions"') && e.includes('did you mean "action"')));
  });

  it("warns on add-include with sheet instead of include", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "add-include", sheet: "OtherSheet" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('"sheet"') && e.includes('did you mean "include"')));
  });

  it("warns on replace-condition with conditions instead of condition", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "replace-condition", index: 0, conditions: [{ else: true }] }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('"conditions"') && e.includes('did you mean "condition"')));
  });

  // Unknown fields
  it("warns on unknown fields", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "set-or-block", path: "events[0]", bogusField: true }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('unknown field "bogusField"')));
  });

  // Valid recipes should not trigger field warnings
  it("no warnings for valid patch-script", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "patch-script", actionIndex: 0, find: "foo", replace: "bar" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });

  it("no warnings for valid replace-action", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "replace-action", index: 0, action: { script: ["x"] } }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });

  it("no warnings for valid add-include", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "add-include", include: "OtherSheet" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });
});

// ─── validateRecipe: add-include + path warning ───

describe("validateRecipe: add-include + path warning", () => {
  it("warns when add-include and path-based ops in same file", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          { op: "add-include", include: "NewSheet" },
          { op: "insert-event", path: "events[5].children[2]", block: { actions: [] } },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("add-include") && e.includes("path-based")));
  });

  it("no warning when add-include and SID-based ops in same file", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          { op: "add-include", include: "NewSheet" },
          { op: "insert-event", in: "sid:123456", block: { actions: [] } },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });

  it("no warning when add-include is the only op", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "add-include", include: "NewSheet" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });
});

describe("executeOp: patch-function-block", () => {
  it("adds a parameter to a function-block by path", () => {
    const sheet = makeSheet({
      eventType: "function-block",
      functionName: "myFunc",
      functionDescription: "",
      functionCategory: "",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 111,
    } as FunctionBlockEvent);
    executeOp(sidGen, sheet, {
      op: "patch-function-block",
      path: "events[0]",
      addParam: { name: "p1", type: "string" },
    } as FileOp);
    const params = (sheet.events[0] as FunctionBlockEvent).functionParameters;
    assert.equal(params.length, 1);
    assert.equal(params[0].name, "p1");
    assert.equal(params[0].type, "string");
    assert.equal(params[0].initialValue, "");
    assert.equal(typeof params[0].sid, "number");
  });

  it("adds a parameter with explicit initialValue", () => {
    const sheet = makeSheet({
      eventType: "function-block",
      functionName: "myFunc",
      functionDescription: "",
      functionCategory: "",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 222,
    } as FunctionBlockEvent);
    executeOp(sidGen, sheet, {
      op: "patch-function-block",
      path: "events[0]",
      addParam: { name: "count", type: "number", initialValue: "42" },
    } as FileOp);
    const params = (sheet.events[0] as FunctionBlockEvent).functionParameters;
    assert.equal(params[0].initialValue, "42");
  });

  it("removes a parameter by name", () => {
    const sheet = makeSheet({
      eventType: "function-block",
      functionName: "myFunc",
      functionDescription: "",
      functionCategory: "",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [
        { name: "keep", type: "string", initialValue: "", sid: 10 },
        { name: "remove", type: "number", initialValue: "0", sid: 20 },
      ],
      conditions: [],
      actions: [],
      sid: 333,
    } as FunctionBlockEvent);
    executeOp(sidGen, sheet, {
      op: "patch-function-block",
      path: "events[0]",
      removeParam: "remove",
    } as FileOp);
    const params = (sheet.events[0] as FunctionBlockEvent).functionParameters;
    assert.equal(params.length, 1);
    assert.equal(params[0].name, "keep");
  });

  it("throws if target is not a function-block", () => {
    const sheet = makeSheet(makeBlock({ sid: 444 }));
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-function-block",
          path: "events[0]",
          addParam: { name: "p", type: "string" },
        } as FileOp),
      /expected function-block/,
    );
  });

  it("throws if removeParam name not found", () => {
    const sheet = makeSheet({
      eventType: "function-block",
      functionName: "myFunc",
      functionDescription: "",
      functionCategory: "",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 555,
    } as FunctionBlockEvent);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-function-block",
          path: "events[0]",
          removeParam: "missing",
        } as FileOp),
      /parameter "missing" not found/,
    );
  });

  it("throws if addParam name already exists", () => {
    const sheet = makeSheet({
      eventType: "function-block",
      functionName: "myFunc",
      functionDescription: "",
      functionCategory: "",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [{ name: "existing", type: "string", initialValue: "", sid: 10 }],
      conditions: [],
      actions: [],
      sid: 888,
    } as FunctionBlockEvent);
    assert.throws(
      () =>
        executeOp(sidGen, sheet, {
          op: "patch-function-block",
          path: "events[0]",
          addParam: { name: "existing", type: "number" },
        } as FileOp),
      /parameter "existing" already exists/,
    );
  });

  it("works with SID-based targeting", () => {
    const sheet = makeSheet({
      eventType: "function-block",
      functionName: "myFunc",
      functionDescription: "",
      functionCategory: "",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 666,
    } as FunctionBlockEvent);
    const sidIndex = buildSidIndex(sheet);
    executeOp(
      sidGen,
      sheet,
      {
        op: "patch-function-block",
        in: "sid:666",
        addParam: { name: "x", type: "number" },
      } as FileOp,
      sidIndex,
    );
    const params = (sheet.events[0] as FunctionBlockEvent).functionParameters;
    assert.equal(params.length, 1);
    assert.equal(params[0].name, "x");
    assert.equal(params[0].type, "number");
    assert.equal(params[0].initialValue, "0");
  });

  it("works on custom-ace-block", () => {
    const sheet = makeSheet({
      eventType: "custom-ace-block",
      aceType: "action",
      aceName: "MyAction",
      objectClass: "MyObj",
      functionDescription: "",
      functionCategory: "",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [{ name: "old", type: "string", initialValue: "", sid: 30 }],
      conditions: [],
      actions: [],
      sid: 777,
    } as CustomAceBlockEvent);
    executeOp(sidGen, sheet, {
      op: "patch-function-block",
      path: "events[0]",
      addParam: { name: "new", type: "boolean" },
    } as FileOp);
    const params = (sheet.events[0] as CustomAceBlockEvent).functionParameters;
    assert.equal(params.length, 2);
    assert.equal(params[1].name, "new");
    assert.equal(params[1].type, "boolean");
    assert.equal(params[1].initialValue, "false");
  });
});

describe("validateRecipe: patch-function-block", () => {
  it("errors when neither addParam nor removeParam", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "patch-function-block", path: "events[0]" }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('requires either "addParam" or "removeParam"')));
  });

  it("errors when both addParam and removeParam", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "patch-function-block",
            path: "events[0]",
            addParam: { name: "p", type: "string" },
            removeParam: "q",
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("cannot have both")));
  });

  it("errors when addParam.name missing", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "patch-function-block",
            path: "events[0]",
            addParam: { type: "string" },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("addParam.name is required")));
  });

  it("errors when addParam.type invalid", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "patch-function-block",
            path: "events[0]",
            addParam: { name: "p", type: "invalid" },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('addParam.type must be "string", "number", or "boolean"')));
  });

  it("passes with valid addParam", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "patch-function-block",
            path: "events[0]",
            addParam: { name: "p", type: "string" },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });

  it("passes with valid removeParam", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "patch-function-block",
            path: "events[0]",
            removeParam: "old",
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, []);
  });
});

// ─── validateRecipe: shorthand field validation ───

describe("validateRecipe: shorthand field validation", () => {
  it("warns on unknown field in variable shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            variable: { name: "x", type: "number", bogusField: true },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("variable shorthand") && e.includes('unknown field "bogusField"')));
  });

  it("warns on unknown field in block shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            block: { conditions: [], actions: [], extraField: true },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("block shorthand") && e.includes('unknown field "extraField"')));
  });

  it("warns on unknown field in function-block shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            "function-block": { name: "myFunc", badOption: 42 },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("function-block shorthand") && e.includes('unknown field "badOption"')));
  });

  it("warns on unknown field in custom-ace-block shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            "custom-ace-block": { name: "myAce", object: "Sprite", junk: true },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("custom-ace-block shorthand") && e.includes('unknown field "junk"')));
  });

  it("warns on unknown field in group shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            group: { title: "My Group", nonsense: true },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("group shorthand") && e.includes('unknown field "nonsense"')));
  });

  it("rejects unknown field on an insert-actions action shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "insert-actions", in: "sid:1", after: 0, actions: [{ id: "destroy", object: "Foo", objclass: "x" }] }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('unknown field "objclass"')), errors.join("; "));
  });

  it("accepts objectClass alias on an insert-actions action shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [{ op: "insert-actions", in: "sid:1", after: 0, actions: [{ id: "destroy", objectClass: "Foo" }] }],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, [], errors.join("; "));
  });

  it("rejects an insert-actions action with no object (non-System)", () => {
    const recipe = {
      files: { "Test/Sheet": [{ op: "insert-actions", in: "sid:1", after: 0, actions: [{ id: "destroy" }] }] },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing "object"')), errors.join("; "));
  });

  it("allows a System action id with no object in insert-actions", () => {
    const recipe = {
      files: { "Test/Sheet": [{ op: "insert-actions", in: "sid:1", after: 0, actions: [{ id: "wait-for-previous-actions" }] }] },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.deepStrictEqual(errors, [], errors.join("; "));
  });

  it("rejects an insert-actions custom-action with no object (no validate/apply mismatch)", () => {
    const recipe = {
      files: { "Test/Sheet": [{ op: "insert-actions", in: "sid:1", after: 0, actions: [{ "custom-action": "Foo" }] }] },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes('missing "object"')), errors.join("; "));
  });

  it("warns on missing required field in variable shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            variable: { name: "x" },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("variable shorthand") && e.includes('missing required field "type"')));
  });

  it("warns on unknown field in insert-variables variable shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-variables",
            after: 0,
            variables: [{ name: "x", type: "number", bogus: true }],
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("variable shorthand") && e.includes('unknown field "bogus"')));
  });

  it("no warnings for valid variable shorthand with aliases", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            variable: { name: "x", type: "string", initialValue: "hello", isStatic: true, isConstant: false },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(!errors.some((e) => e.includes("shorthand")));
  });

  it("no warnings for valid block shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            block: { conditions: [], actions: [] },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(!errors.some((e) => e.includes("shorthand")));
  });

  it("no warnings for valid function-block shorthand", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-event",
            after: 0,
            "function-block": { name: "myFunc", params: [], returnType: "none", async: false, actions: [] },
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(!errors.some((e) => e.includes("shorthand")));
  });

  it("warns on unknown field in insert-variables wrapper form", () => {
    const recipe = {
      files: {
        "Test/Sheet": [
          {
            op: "insert-variables",
            after: 0,
            variables: [{ variable: { name: "x", type: "number", bogus: true } }],
          },
        ],
      },
    } as unknown as Recipe;
    const errors = validateRecipe(recipe);
    assert.ok(errors.some((e) => e.includes("variable shorthand") && e.includes('unknown field "bogus"')));
  });

  it("SHORTHAND_FIELD_SCHEMAS covers all non-comment inline event keys", () => {
    const inlineKeys = ["block", "function-block", "custom-ace-block", "variable", "group"];
    for (const key of inlineKeys) {
      assert.ok(SHORTHAND_FIELD_SCHEMAS[key], `Missing SHORTHAND_FIELD_SCHEMAS entry for "${key}"`);
    }
  });
});

// ─── validateRecipe: C3 param type validation ───

describe("validateActionParams", () => {
  it("accepts correct comparison integer", () => {
    const warnings = validateActionParams(
      { id: "compare-two-values", object: "System", params: { comparison: 0 } },
      "test",
    );
    assert.deepStrictEqual(warnings, []);
  });

  it("rejects comparison as string", () => {
    const warnings = validateActionParams(
      { id: "compare-two-values", object: "System", params: { comparison: "0" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "comparison");
    assert.include(warnings[0], "integer");
  });

  it("accepts correct layer quoted expression", () => {
    const warnings = validateActionParams(
      { id: "set-layer-visible", object: "System", params: { layer: '"MyLayer"', visibility: "visible" } },
      "test",
    );
    assert.deepStrictEqual(warnings, []);
  });

  it("rejects bare layer string", () => {
    const warnings = validateActionParams(
      { id: "set-layer-visible", object: "System", params: { layer: "MyLayer", visibility: "visible" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "layer");
    assert.include(warnings[0], "quoted");
  });

  it("rejects invalid visibility value", () => {
    const warnings = validateActionParams(
      { id: "set-layer-visible", object: "System", params: { layer: '"L"', visibility: "0" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "visibility");
  });

  it("rejects interactive as string", () => {
    const warnings = validateActionParams(
      { id: "set-layer-interactive", object: "System", params: { layer: '"L"', interactive: "true" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "interactive");
    assert.include(warnings[0], "boolean");
  });

  it("accepts correct interactive boolean", () => {
    const warnings = validateActionParams(
      { id: "set-layer-interactive", object: "System", params: { layer: '"L"', interactive: true } },
      "test",
    );
    assert.deepStrictEqual(warnings, []);
  });

  it("rejects bare animation string", () => {
    const warnings = validateActionParams(
      { id: "set-animation", object: "Sprite", params: { animation: "default" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "animation");
  });

  it("skips unknown action ids (no false positives)", () => {
    const warnings = validateActionParams(
      { id: "unknown-action", object: "Foo", params: { anything: "goes" } },
      "test",
    );
    assert.deepStrictEqual(warnings, []);
  });

  it("skips actions without params", () => {
    const warnings = validateActionParams({ id: "compare-two-values", object: "System" }, "test");
    assert.deepStrictEqual(warnings, []);
  });

  it("skips call shorthands (no id field)", () => {
    const warnings = validateActionParams({ call: "myFunc", params: [0] }, "test");
    assert.deepStrictEqual(warnings, []);
  });

  it("accepts objectClass as an alias for object (no warning)", () => {
    const warnings = validateActionParams({ id: "destroy", objectClass: "Foo" }, "test");
    assert.deepStrictEqual(warnings, []);
  });

  it("rejects a genuinely-unknown field on an id action shorthand", () => {
    const warnings = validateActionParams({ id: "destroy", object: "Foo", objclass: "Foo" }, "test");
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], 'unknown field "objclass"');
  });

  it("rejects an id action with neither object nor objectClass (non-System)", () => {
    const warnings = validateActionParams({ id: "destroy" }, "test");
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], 'missing "object"');
  });

  it("allows a well-known System action id with no object", () => {
    const warnings = validateActionParams({ id: "wait-for-previous-actions" }, "test");
    assert.deepStrictEqual(warnings, []);
  });

  it("rejects a custom-action with no object/objectClass (matches expandAction throw)", () => {
    const warnings = validateActionParams({ "custom-action": "Foo" }, "test");
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], 'missing "object"');
  });

  it("accepts a custom-action with objectClass alias", () => {
    const warnings = validateActionParams({ "custom-action": "Foo", objectClass: "Bar" }, "test");
    assert.deepStrictEqual(warnings, []);
  });

  it("rejects an action shorthand that matches no discriminator", () => {
    const warnings = validateActionParams({ foo: "bar" }, "test");
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "unrecognized action shorthand");
  });
});

describe("validateConditionParams", () => {
  it("rejects bare layer on is-on-layer condition", () => {
    const warnings = validateConditionParams(
      { id: "is-on-layer", object: "Sprite", params: { layer: "MyLayer" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "layer");
  });

  it("accepts quoted layer on layer-is-visible condition", () => {
    const warnings = validateConditionParams(
      { id: "layer-is-visible", object: "System", params: { layer: '"HUD"' } },
      "test",
    );
    assert.deepStrictEqual(warnings, []);
  });

  it("accepts objectClass as an alias for object (no warning)", () => {
    const warnings = validateConditionParams({ id: "is-visible", objectClass: "Sprite" }, "test");
    assert.deepStrictEqual(warnings, []);
  });

  it("rejects a genuinely-unknown field on a condition shorthand", () => {
    const warnings = validateConditionParams({ id: "is-visible", object: "Sprite", typo: 1 }, "test");
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], 'unknown field "typo"');
  });

  it("rejects a condition id with neither object nor objectClass", () => {
    const warnings = validateConditionParams({ id: "is-visible" }, "test");
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], 'missing "object"');
  });

  it("rejects a condition shorthand that matches no discriminator", () => {
    const warnings = validateConditionParams({ foo: "bar" }, "test");
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], "unrecognized condition shorthand");
  });
});

describe("validateRecipe: C3 param type validation", () => {
  it("warns on bad comparison in insert-actions", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test/Test.json": [
          {
            op: "insert-actions",
            path: "events[0]",
            actions: [{ id: "compare-two-values", object: "System", params: { comparison: "0" } }],
          } as unknown as FileOp,
        ],
      },
    };
    const errors = validateRecipe(recipe);
    const paramError = errors.find((e) => e.includes("comparison") && e.includes("integer"));
    assert.ok(paramError, `Expected param type warning for comparison, got: ${errors.join("; ")}`);
  });

  it("warns on bare layer in replace-action", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test/Test.json": [
          {
            op: "replace-action",
            path: "events[0]",
            actionIndex: 0,
            action: { id: "set-layer-visible", object: "System", params: { layer: "BadLayer", visibility: "visible" } },
          } as unknown as FileOp,
        ],
      },
    };
    const errors = validateRecipe(recipe);
    const paramError = errors.find((e) => e.includes("layer") && e.includes("quoted"));
    assert.ok(paramError, `Expected param type warning for layer, got: ${errors.join("; ")}`);
  });

  it("warns on bad condition params in insert-conditions", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test/Test.json": [
          {
            op: "insert-conditions",
            path: "events[0]",
            conditions: [{ id: "is-on-layer", object: "Sprite", params: { layer: "BadLayer" } }],
          } as unknown as FileOp,
        ],
      },
    };
    const errors = validateRecipe(recipe);
    const paramError = errors.find((e) => e.includes("layer") && e.includes("quoted"));
    assert.ok(paramError, `Expected param type warning for layer, got: ${errors.join("; ")}`);
  });

  it("warns on bad params in inline event actions (insert-event)", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test/Test.json": [
          {
            op: "insert-event",
            after: "events[0]",
            block: {
              conditions: [{ id: "is-on-layer", object: "Sprite", params: { layer: "BadLayer" } }],
              actions: [{ id: "set-layer-visible", object: "System", params: { layer: "BadLayer", visibility: "0" } }],
            },
          } as unknown as FileOp,
        ],
      },
    };
    const errors = validateRecipe(recipe);
    const layerError = errors.find((e) => e.includes("layer") && e.includes("quoted"));
    const visError = errors.find((e) => e.includes("visibility"));
    assert.ok(layerError, `Expected layer warning, got: ${errors.join("; ")}`);
    assert.ok(visError, `Expected visibility warning, got: ${errors.join("; ")}`);
  });

  it("no warnings for correct params", () => {
    const recipe: Recipe = {
      files: {
        "eventSheets/Test/Test.json": [
          {
            op: "insert-actions",
            path: "events[0]",
            actions: [
              { id: "set-layer-visible", object: "System", params: { layer: '"MyLayer"', visibility: "visible" } },
            ],
          } as unknown as FileOp,
        ],
      },
    };
    const errors = validateRecipe(recipe);
    const paramErrors = errors.filter((e) => e.includes("param"));
    assert.deepStrictEqual(paramErrors, []);
  });

  it("PARAM_TYPE_RULES covers key gotcha actions", () => {
    const expectedIds = [
      "compare-two-values",
      "set-layer-visible",
      "layer-is-visible",
      "set-layer-interactive",
      "is-on-layer",
      "set-animation",
      "on-touched-object",
    ];
    for (const id of expectedIds) {
      assert.ok(PARAM_TYPE_RULES[id], `Missing PARAM_TYPE_RULES entry for "${id}"`);
    }
  });
});

// ─── replace-action regression tests (R1: gotchas #41, #46) ───

describe("executeOp: replace-action regression", () => {
  it("R1.1: path-based call-to-call replaces params completely", () => {
    const block = makeBlock({
      sid: 100,
      actions: [buildCallAction(sidGen, { callFunction: "oldFunc", parameters: ["oldArg1", "oldArg2"] })],
    });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "replace-action",
      path: "events[0]",
      index: 0,
      action: { call: "newFunc", params: ['"newArg"'] },
    });
    const result = block.actions[0] as FunctionCallAction;
    assert.equal(result.callFunction, "newFunc");
    assert.deepStrictEqual(result.parameters, ['"newArg"']);
  });

  it("R1.2: path-based call-to-script changes action type", () => {
    const block = makeBlock({
      sid: 100,
      actions: [buildCallAction(sidGen, { callFunction: "oldFunc", parameters: ["arg"] })],
    });
    const sheet = makeSheet(block);
    executeOp(sidGen, sheet, {
      op: "replace-action",
      path: "events[0]",
      index: 0,
      action: { script: ["console.log('replaced');"] },
    });
    const result = block.actions[0] as ScriptAction;
    assert.equal(result.type, "script");
    assert.deepStrictEqual(result.script, ["console.log('replaced');"]);
    assert.equal((result as unknown as FunctionCallAction).callFunction, undefined);
  });

  it("R1.3: SID-based call-to-call replaces params completely", () => {
    const block = makeBlock({
      sid: 200,
      actions: [buildCallAction(sidGen, { callFunction: "oldFunc", parameters: ["oldArg"] })],
    });
    const sheet = makeSheet(block);
    executeFileOps(sidGen, sheet, [{
      op: "replace-action",
      in: "sid:200",
      index: 0,
      action: { call: "newFunc", params: ['"x"', '"y"'] },
    }]);
    const result = block.actions[0] as FunctionCallAction;
    assert.equal(result.callFunction, "newFunc");
    assert.deepStrictEqual(result.parameters, ['"x"', '"y"']);
  });

  it("R1.4: SID-based call-to-script changes action type", () => {
    const block = makeBlock({
      sid: 300,
      actions: [buildCallAction(sidGen, { callFunction: "oldFunc", parameters: ["arg"] })],
    });
    const sheet = makeSheet(block);
    executeFileOps(sidGen, sheet, [{
      op: "replace-action",
      in: "sid:300",
      index: 0,
      action: { script: ["doStuff();"] },
    }]);
    const result = block.actions[0] as ScriptAction;
    assert.equal(result.type, "script");
    assert.deepStrictEqual(result.script, ["doStuff();"]);
  });
});

// ─── R3 validation tests: on-touched-object and callFunction ───

describe("validateConditionParams: on-touched-object", () => {
  it("R3.1: rejects numeric type '0'", () => {
    const warnings = validateConditionParams(
      { id: "on-touched-object", object: "Touch", params: { type: "0" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], '"start", "end", or "move"');
  });

  it("R3.2: accepts valid type 'start'", () => {
    const warnings = validateConditionParams(
      { id: "on-touched-object", object: "Touch", params: { type: "start" } },
      "test",
    );
    assert.deepStrictEqual(warnings, []);
  });
});

describe("validateActionParams: callFunction params check", () => {
  it("R3.3: warns when call params is an object", () => {
    const warnings = validateActionParams(
      { call: "myFunc", params: { "0": "arg1", "1": "arg2" } },
      "test",
    );
    assert.equal(warnings.length, 1);
    assert.include(warnings[0], '"params" must be an array');
  });

  it("R3.4: no warning when call params is an array", () => {
    const warnings = validateActionParams(
      { call: "myFunc", params: ["arg1", "arg2"] },
      "test",
    );
    assert.deepStrictEqual(warnings, []);
  });
});

// ─── executeOp: wrap-in-group (R2) ───

describe("executeOp: wrap-in-group", () => {
  it("R2.1: wraps listed events into new group", () => {
    const b1 = makeBlock({ sid: 10 });
    const b2 = makeBlock({ sid: 20 });
    const b3 = makeBlock({ sid: 30 });
    const sheet = makeSheet(b1, b2, b3);
    executeFileOps(sidGen, sheet, [{
      op: "wrap-in-group",
      events: ["sid:10", "sid:20"],
      title: "Wrapped Group",
    }]);
    assert.equal(sheet.events.length, 2); // group + b3
    const group = sheet.events[0] as GroupEvent;
    assert.equal(group.eventType, "group");
    assert.equal(group.title, "Wrapped Group");
    assert.equal(group.children!.length, 2);
    assert.equal(group.children![0].sid, 10);
    assert.equal(group.children![1].sid, 20);
    assert.equal(sheet.events[1].sid, 30);
  });

  it("R2.2: group inserted at position of first wrapped event", () => {
    const b1 = makeBlock({ sid: 10 });
    const b2 = makeBlock({ sid: 20 });
    const b3 = makeBlock({ sid: 30 });
    const sheet = makeSheet(b1, b2, b3);
    executeFileOps(sidGen, sheet, [{
      op: "wrap-in-group",
      events: ["sid:20", "sid:30"],
      title: "Later Group",
    }]);
    assert.equal(sheet.events.length, 2); // b1 + group
    assert.equal(sheet.events[0].sid, 10); // b1 stays at 0
    const group = sheet.events[1] as GroupEvent;
    assert.equal(group.eventType, "group");
    assert.equal(group.children!.length, 2);
  });

  it("R2.3: group gets unique non-zero SID", () => {
    const b1 = makeBlock({ sid: 10 });
    const b2 = makeBlock({ sid: 20 });
    const sheet = makeSheet(b1, b2);
    executeFileOps(sidGen, sheet, [{
      op: "wrap-in-group",
      events: ["sid:10", "sid:20"],
      title: "SID Group",
    }]);
    const group = sheet.events[0] as GroupEvent;
    assert.notEqual(group.sid, 0);
    assert.equal(typeof group.sid, "number");
  });

  it("R2.4: children preserve original order (non-contiguous)", () => {
    const b0 = makeBlock({ sid: 10 });
    const b1 = makeBlock({ sid: 20 });
    const b2 = makeBlock({ sid: 30 });
    const b3 = makeBlock({ sid: 40 });
    const b4 = makeBlock({ sid: 50 });
    const sheet = makeSheet(b0, b1, b2, b3, b4);
    executeFileOps(sidGen, sheet, [{
      op: "wrap-in-group",
      events: ["sid:10", "sid:30", "sid:50"],
      title: "Non-contiguous",
    }]);
    const group = sheet.events[0] as GroupEvent;
    assert.equal(group.children!.length, 3);
    assert.equal(group.children![0].sid, 10);
    assert.equal(group.children![1].sid, 30);
    assert.equal(group.children![2].sid, 50);
    // Remaining events shifted
    assert.equal(sheet.events.length, 3); // group + b1 + b3
    assert.equal(sheet.events[1].sid, 20);
    assert.equal(sheet.events[2].sid, 40);
  });

  it("R2.5: $symbol assignment enables subsequent op targeting", () => {
    const b1 = makeBlock({ sid: 10 });
    const b2 = makeBlock({ sid: 20 });
    const sheet = makeSheet(b1, b2);
    executeFileOps(sidGen, sheet, [
      {
        op: "wrap-in-group",
        events: ["sid:10", "sid:20"],
        title: "Symbol Group",
        id: "$grp",
      },
      {
        op: "insert-event",
        in: "$grp",
        comment: "added via symbol",
      },
    ]);
    const group = sheet.events[0] as GroupEvent;
    assert.equal(group.children!.length, 3); // b1, b2, + comment
    assert.equal(group.children![2].eventType, "comment");
  });

  it("R2.6: throws when events span different parents", () => {
    const child = makeBlock({ sid: 20 });
    const parent = buildGroup(sidGen, { title: "G", children: [child] });
    const root = makeBlock({ sid: 10 });
    const sheet = makeSheet(root, parent);
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{
        op: "wrap-in-group",
        events: ["sid:10", "sid:20"],
        title: "Bad",
      }]),
      /not in the specified parent container/,
    );
  });

  it("R2.7: throws when event SID not found", () => {
    const sheet = makeSheet(makeBlock({ sid: 10 }));
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{
        op: "wrap-in-group",
        events: ["sid:999"],
        title: "Missing",
      }]),
      /SID 999 not found/,
    );
  });

  it("R2.8: throws on empty events array", () => {
    const sheet = makeSheet(makeBlock({ sid: 10 }));
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{
        op: "wrap-in-group",
        events: [],
        title: "Empty",
      }]),
      /events array must not be empty/,
    );
  });

  it("R2.9: single-event wrap produces group with one child", () => {
    const b1 = makeBlock({ sid: 10 });
    const b2 = makeBlock({ sid: 20 });
    const sheet = makeSheet(b1, b2);
    executeFileOps(sidGen, sheet, [{
      op: "wrap-in-group",
      events: ["sid:10"],
      title: "Solo",
    }]);
    assert.equal(sheet.events.length, 2); // group + b2
    const group = sheet.events[0] as GroupEvent;
    assert.equal(group.children!.length, 1);
    assert.equal(group.children![0].sid, 10);
  });

  it("R2.10: 'in' field targets non-root container", () => {
    const child1 = makeBlock({ sid: 10 });
    const child2 = makeBlock({ sid: 20 });
    const parent = buildGroup(sidGen, { title: "Parent", children: [child1, child2] });
    const sheet = makeSheet(parent);
    executeFileOps(sidGen, sheet, [{
      op: "wrap-in-group",
      in: `sid:${parent.sid}`,
      events: ["sid:10", "sid:20"],
      title: "Subgroup",
    }]);
    const parentGroup = sheet.events[0] as GroupEvent;
    assert.equal(parentGroup.children!.length, 1); // one subgroup
    const subgroup = parentGroup.children![0] as GroupEvent;
    assert.equal(subgroup.title, "Subgroup");
    assert.equal(subgroup.children!.length, 2);
  });

  it("R2.11: registered in OP_FIELD_SCHEMAS", () => {
    const schema = OP_FIELD_SCHEMAS["wrap-in-group"];
    assert.ok(schema, "wrap-in-group must be in OP_FIELD_SCHEMAS");
    assert.deepStrictEqual(schema.required, ["events", "title"]);
    assert.include(schema.optional, "in");
    assert.include(schema.optional, "id");
  });

  it("R2.12: deduplicates repeated SID refs", () => {
    const b1 = makeBlock({ sid: 10 });
    const b2 = makeBlock({ sid: 20 });
    const sheet = makeSheet(b1, b2);
    executeFileOps(sidGen, sheet, [{
      op: "wrap-in-group",
      events: ["sid:10", "sid:10", "sid:10"],
      title: "Dedup",
    }]);
    const group = sheet.events[0] as GroupEvent;
    assert.equal(group.children!.length, 1); // deduplicated to 1
    assert.equal(group.children![0].sid, 10);
    assert.equal(sheet.events.length, 2); // group + b2
  });

  it("R2.13: wrap-in-group is registered in VALID_OPS", () => {
    // Regression: wrap-in-group shipped (S18) but was absent from VALID_OPS,
    // so validateRecipe rejected it as an unknown op.
    assert.isTrue(VALID_OPS.has("wrap-in-group"));
  });
});

function makeVariable(overrides?: Partial<EventSheetVariable>): EventSheetVariable {
  return {
    eventType: "variable",
    name: "myVar",
    type: "number",
    initialValue: "0",
    isStatic: false,
    isConstant: false,
    sid: 100,
    ...overrides,
  };
}

function makeGroup(overrides?: Partial<GroupEvent>): GroupEvent {
  return {
    eventType: "group",
    disabled: false,
    title: "G",
    description: "",
    isActiveOnStart: true,
    children: [],
    sid: 5,
    ...overrides,
  };
}

describe("executeOp: move-variable", () => {
  it("MV1: promotes a local variable to the sheet root", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const group = makeGroup({ sid: 5, children: [v, makeBlock({ sid: 20 })] });
    const sheet = makeSheet(group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "root" }]);
    assert.equal(sheet.events.length, 2); // variable + group
    assert.equal(sheet.events[0].sid, 100);
    assert.equal((sheet.events[0] as EventSheetVariable).name, "score");
    assert.equal(group.children!.length, 1); // only the block remains
    assert.equal(group.children![0].sid, 20);
  });

  it("MV2: promotion rewrites localVars.X → runtime.globalVars.X in the source scope", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const script = buildScriptAction({ script: ["localVars.score = localVars.score + 1;"] });
    const block = makeBlock({ sid: 20, actions: [script] });
    const group = makeGroup({ sid: 5, children: [v, block] });
    const sheet = makeSheet(group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "root" }]);
    assert.deepEqual(script.script, ["runtime.globalVars.score = runtime.globalVars.score + 1;"]);
  });

  it("MV3: promotion is word-boundary aware (does not touch localVars.scoreMultiplier)", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const script = buildScriptAction({ script: ["localVars.score = localVars.scoreMultiplier;"] });
    const block = makeBlock({ sid: 20, actions: [script] });
    const group = makeGroup({ sid: 5, children: [v, block] });
    const sheet = makeSheet(group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "root" }]);
    assert.deepEqual(script.script, ["runtime.globalVars.score = localVars.scoreMultiplier;"]);
  });

  it("MV4: promotion normalizes isStatic to true", () => {
    const v = makeVariable({ sid: 100, name: "score", isStatic: false });
    const group = makeGroup({ sid: 5, children: [v] });
    const sheet = makeSheet(group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "root" }]);
    assert.isTrue((sheet.events[0] as EventSheetVariable).isStatic);
  });

  it("MV5: demotes a global variable into a container", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const block = makeBlock({ sid: 20 });
    const group = makeGroup({ sid: 5, children: [block] });
    const sheet = makeSheet(v, group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "sid:5" }]);
    assert.equal(sheet.events.length, 1); // only the group remains at root
    assert.equal(group.children!.length, 2);
    assert.equal(group.children![0].sid, 100); // variable inserted at index 0
    assert.equal(group.children![1].sid, 20);
  });

  it("MV6: demotion rewrites runtime.globalVars.X → localVars.X in the destination scope", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const script = buildScriptAction({ script: ["runtime.globalVars.score += 1;"] });
    const block = makeBlock({ sid: 20, actions: [script] });
    const group = makeGroup({ sid: 5, children: [block] });
    const sheet = makeSheet(v, group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "sid:5" }]);
    assert.deepEqual(script.script, ["localVars.score += 1;"]);
  });

  it("MV7: demotion sets isStatic to true", () => {
    const v = makeVariable({ sid: 100, name: "score", isStatic: false });
    const group = makeGroup({ sid: 5, children: [makeBlock({ sid: 20 })] });
    const sheet = makeSheet(v, group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "sid:5" }]);
    assert.isTrue((group.children![0] as EventSheetVariable).isStatic);
  });

  it("MV8: preserves the variable SID across the move", () => {
    const v = makeVariable({ sid: 123456789, name: "score" });
    const group = makeGroup({ sid: 5, children: [v] });
    const sheet = makeSheet(group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:123456789", to: "root" }]);
    assert.equal(sheet.events[0].sid, 123456789);
  });

  it("MV9: index places the demoted variable at the given position", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const group = makeGroup({ sid: 5, children: [makeBlock({ sid: 20 }), makeBlock({ sid: 30 })] });
    const sheet = makeSheet(v, group);
    executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "sid:5", index: 1 }]);
    assert.equal(group.children!.length, 3);
    assert.equal(group.children![0].sid, 20);
    assert.equal(group.children![1].sid, 100);
    assert.equal(group.children![2].sid, 30);
  });

  it("MV10: $symbol registration enables targeting in a later op", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const group = makeGroup({ sid: 5, children: [makeBlock({ sid: 20 })] });
    const sheet = makeSheet(v, group);
    executeFileOps(sidGen, sheet, [
      { op: "move-variable", variable: "sid:100", to: "sid:5", id: "$v" }, // demote into group
      { op: "move-variable", variable: "$v", to: "root" }, // promote back via symbol
    ]);
    assert.equal(sheet.events[0].sid, 100); // back at root
    assert.equal(group.children!.length, 1); // only the block remains
  });

  it("MV11: throws when the ref is not a variable", () => {
    const block = makeBlock({ sid: 10 });
    const sheet = makeSheet(block);
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:10", to: "root" }]),
      /not a variable/,
    );
  });

  it("MV12: throws when promoting an already-global variable", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const sheet = makeSheet(v);
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "root" }]),
      /already global/,
    );
  });

  it("MV13: throws when demoting an already-local variable", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const group = makeGroup({ sid: 5, children: [v] });
    const sheet = makeSheet(group);
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "sid:5" }]),
      /already local/,
    );
  });

  it("MV14: throws when the destination is not a container", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const other = makeVariable({ sid: 200, name: "other" });
    const sheet = makeSheet(v, other);
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "sid:200" }]),
      /not a container/,
    );
  });

  it("MV15: throws on a name collision in the destination scope", () => {
    const v = makeVariable({ sid: 100, name: "score" });
    const dup = makeVariable({ sid: 200, name: "score" });
    const group = makeGroup({ sid: 5, children: [dup] });
    const sheet = makeSheet(v, group);
    assert.throws(
      () => executeFileOps(sidGen, sheet, [{ op: "move-variable", variable: "sid:100", to: "sid:5" }]),
      /already declares a variable named "score"/,
    );
  });

  it("MV16: registered in OP_FIELD_SCHEMAS and VALID_OPS", () => {
    assert.isTrue(VALID_OPS.has("move-variable"));
    const schema = OP_FIELD_SCHEMAS["move-variable"];
    assert.ok(schema, "move-variable must be in OP_FIELD_SCHEMAS");
    assert.deepStrictEqual(schema.required, ["variable", "to"]);
    assert.include(schema.optional, "index");
    assert.include(schema.optional, "id");
  });
});
});
