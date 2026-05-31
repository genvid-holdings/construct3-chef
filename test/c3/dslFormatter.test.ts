import { describe, it } from "mocha";
import { assert } from "chai";
import {
  formatAction,
  type ScriptAction,
  type EventSheetEvent,
  type BlockEvent,
  type FunctionBlockEvent,
  type CustomAceBlockEvent,
  type GroupEvent,
  type IncludeEvent,
  type CommentEvent,
  type EventSheetVariable,
  type EventSheet,
} from "@genvid/c3source";
import {
  formatEvent,
  formatEventSheet,
  formatIndex,
  filterIndex,
  describeAction,
  buildShallowSidMap,
  type EventCounter,
  type DslIndexEntry,
  type SidMapEntry,
} from "../../src/c3/dslFormatter.js";

describe("formatAction", () => {
  it("formats a standard action with parameters", () => {
    const action = {
      id: "set-text",
      objectClass: "UsernameHeaderText",
      sid: 420865440630047,
      parameters: { text: "Functions.GetPlayerName" },
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "UsernameHeaderText.set-text(text=Functions.GetPlayerName)");
  });

  it("formats a standard action without parameters", () => {
    const action = {
      id: "stop-animation",
      objectClass: "ProfileAvatar",
      sid: 973292168801044,
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "ProfileAvatar.stop-animation()");
  });

  it("formats a standard action with behaviorType", () => {
    const action = {
      id: "start-timer",
      objectClass: "BossHPBar",
      sid: 783047575603560,
      behaviorType: "Timer",
      parameters: { duration: "0.25", type: "Once" },
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "BossHPBar[Timer].start-timer(duration=0.25, type=Once)");
  });

  it("formats a single-line script action inline", () => {
    const action: ScriptAction = {
      type: "script",
      language: "typescript",
      script: ["runtime.setReturnValue(largeNumberToString(localVars.currency, 6));"],
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "script { runtime.setReturnValue(largeNumberToString(localVars.currency, 6)); }");
  });

  it("formats a multi-line script action with cross-reference", () => {
    const action: ScriptAction = {
      type: "script",
      language: "typescript",
      script: ["const x = 1;", "console.log(x);"],
    };
    const result = formatAction(action, "SheetName", 1, 1);
    const expected = ["script { // \u2192 SheetName_Event1_Act1", "  const x = 1;", "  console.log(x);", "}"].join(
      "\n",
    );
    assert.equal(result, expected);
  });

  it("formats a function call with parameters", () => {
    const action = {
      callFunction: "playSFX",
      sid: 282952132439521,
      parameters: ['"menuNavClick"'],
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, 'call playSFX("menuNavClick")');
  });

  it("formats a function call without parameters", () => {
    const action = {
      callFunction: "updateHeaderCurrencies",
      sid: 123,
      parameters: [],
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "call updateHeaderCurrencies()");
  });

  it("formats a function call with missing parameters field", () => {
    const action = {
      callFunction: "updateHeaderCurrencies",
      sid: 123,
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "call updateHeaderCurrencies()");
  });

  it("formats a custom action without parameters", () => {
    const action = {
      customAction: "RandomCreditLoop",
      objectClass: "ChestCreditText",
      sid: 337496313113720,
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "ace ChestCreditText.RandomCreditLoop()");
  });

  it("formats a custom action with parameters", () => {
    const action = {
      customAction: "Initialize",
      objectClass: "CardScroller",
      sid: 123,
      parameters: { speed: 5, direction: "left" },
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "ace CardScroller.Initialize(speed=5, direction=left)");
  });

  it("formats a comment action with same format as event comments", () => {
    const action = {
      type: "comment",
      text: "This sets up the UI",
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "// This sets up the UI");
  });

  it("formats a multi-line comment action", () => {
    const action = {
      type: "comment",
      text: "force the text to be on a certain layer\nkeep in mind this can be done within the layout as well",
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(
      result,
      "// force the text to be on a certain layer\n// keep in mind this can be done within the layout as well",
    );
  });

  it("prefixes disabled actions with [DISABLED]", () => {
    const action = {
      id: "set-text",
      objectClass: "UsernameHeaderText",
      sid: 420865440630047,
      parameters: { text: "Functions.GetPlayerName" },
      disabled: true,
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "[DISABLED] UsernameHeaderText.set-text(text=Functions.GetPlayerName)");
  });

  it("returns unknown action fallback for unrecognized shapes", () => {
    const action = {
      someWeirdKey: "value",
      anotherKey: 42,
    };
    const result = formatAction(action, "TestSheet", 1, 1);
    assert.equal(result, "[unknown action: someWeirdKey, anotherKey]");
  });
});

describe("formatEvent", () => {
  function makeCounter(value = 0): EventCounter {
    return { value };
  }

  function makeEntries(): DslIndexEntry[] {
    return [];
  }

  it("formats an include event", () => {
    const event: IncludeEvent = { eventType: "include", includeSheet: "SheetName" };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["include SheetName"]);
  });

  it("formats a comment event", () => {
    const event: CommentEvent = { eventType: "comment", text: "Load data to header" };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["// Load data to header"]);
  });

  it("formats a multi-line comment event with continuation lines", () => {
    const event: CommentEvent = {
      eventType: "comment",
      text: "Login support:\nA custom ID is saved in local storage.\nAfter login, it is linked to that account.",
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, [
      "// Login support:",
      "// A custom ID is saved in local storage.",
      "// After login, it is linked to that account.",
    ]);
  });

  it("formats a multi-line comment event with indentation", () => {
    const event: CommentEvent = {
      eventType: "comment",
      text: "First line\nSecond line",
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "    ", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["    // First line", "    // Second line"]);
  });

  it("formats a const variable", () => {
    const event: EventSheetVariable = {
      eventType: "variable",
      name: "MAX_ITEMS",
      type: "number",
      initialValue: "10",
      isStatic: false,
      isConstant: true,
      sid: 123,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["const MAX_ITEMS: number = 10"]);
  });

  it("formats a static variable", () => {
    const event: EventSheetVariable = {
      eventType: "variable",
      name: "counter",
      type: "number",
      initialValue: "0",
      isStatic: true,
      isConstant: false,
      sid: 456,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["static counter: number = 0"]);
  });

  it("formats a regular variable", () => {
    const event: EventSheetVariable = {
      eventType: "variable",
      name: "playerName",
      type: "string",
      initialValue: '""',
      isStatic: false,
      isConstant: false,
      sid: 789,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ['var playerName: string = ""']);
  });

  it("formats a group with children and correct nesting", () => {
    const child: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: '"hello"' } }],
      sid: 100,
    };
    const event: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "UI Setup",
      isActiveOnStart: true,
      children: [child],
      sid: 200,
    };
    const counter = makeCounter();
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", counter, "events[0]", 1, entries);
    assert.deepEqual(lines, [
      'group "UI Setup" (active)',
      "  block",
      "    when: System.on-start-of-layout()",
      '    do: Label.set-text(text="hello")',
    ]);
    // group increments counter (1), block increments counter (2)
    assert.equal(counter.value, 2);
  });

  it("formats a block with conditions and actions", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "ScoreText", sid: 2, parameters: { text: "0" } }],
      sid: 100,
    };
    const counter = makeCounter();
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", counter, "events[0]", 1, entries);
    assert.deepEqual(lines, ["block", "  when: System.on-start-of-layout()", "  do: ScoreText.set-text(text=0)"]);
    assert.equal(counter.value, 1);
  });

  it("formats a block with OR flag", () => {
    const event = {
      eventType: "block" as const,
      conditions: [{ id: "on-tap-object", objectClass: "Touch", sid: 1, parameters: { object: "Btn" } }],
      actions: [],
      sid: 100,
      isOrBlock: true,
    };
    const entries = makeEntries();
    const lines = formatEvent(event as BlockEvent, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["block [OR]", "  when: Touch.on-tap-object(object=Btn)"]);
  });

  it("formats a function-block with parameters and return type", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "getScore",
      functionReturnType: "number",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [
        { name: "level", type: "number", initialValue: "1", sid: 10 },
        { name: "name", type: "string", initialValue: '""', sid: 11 },
      ],
      conditions: [],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "0" } }],
      sid: 300,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, [
      'function getScore(level: number = 1, name: string = "") -> number',
      "  do: Label.set-text(text=0)",
    ]);
  });

  it("formats an async function-block", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "loadData",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: true,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 400,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["async function loadData() -> none"]);
  });

  it("formats a custom-ace-block", () => {
    const event: CustomAceBlockEvent = {
      eventType: "custom-ace-block",
      aceType: "condition",
      aceName: "IsReady",
      objectClass: "MyPlugin",
      functionReturnType: "boolean",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [{ name: "id", type: "number", initialValue: "0", sid: 20 }],
      conditions: [],
      actions: [],
      sid: 500,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["ace MyPlugin.IsReady(id: number = 0) -> boolean"]);
  });

  it("formats a block with nested children at correct indentation", () => {
    const innerChild: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "is-visible", objectClass: "Sprite", sid: 3 }],
      actions: [{ id: "destroy", objectClass: "Sprite", sid: 4 }],
      sid: 101,
    };
    const outerBlock: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "0" } }],
      sid: 100,
      children: [innerChild],
    };
    const counter = makeCounter();
    const entries = makeEntries();
    const lines = formatEvent(outerBlock, "", "Test", counter, "events[0]", 1, entries);
    assert.deepEqual(lines, [
      "block",
      "  when: System.on-start-of-layout()",
      "  do: Label.set-text(text=0)",
      "",
      "  block",
      "    when: Sprite.is-visible()",
      "    do: Sprite.destroy()",
    ]);
    assert.equal(counter.value, 2);
  });

  it("formats a function-block with copy-picked flag", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "processItems",
      functionReturnType: "none",
      functionCopyPicked: true,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 600,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["function processItems() -> none [copy-picked]"]);
  });

  it("formats a function-block with category only", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "doStuff",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      functionCategory: "MyCategory",
      conditions: [],
      actions: [],
      sid: 601,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["function doStuff() -> none [category: MyCategory]"]);
  });

  it("formats a function-block with description only", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "doStuff",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      functionDescription: "Some description",
      conditions: [],
      actions: [],
      sid: 602,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["function doStuff() -> none -- Some description"]);
  });

  it("formats a function-block with both category and description", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "doStuff",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      functionCategory: "MyCategory",
      functionDescription: "Some description",
      conditions: [],
      actions: [],
      sid: 603,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["function doStuff() -> none [category: MyCategory] -- Some description"]);
  });

  it("formats a function-block with copy-picked, category, and description", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "processItems",
      functionReturnType: "none",
      functionCopyPicked: true,
      functionIsAsync: false,
      functionParameters: [],
      functionCategory: "X",
      functionDescription: "desc",
      conditions: [],
      actions: [],
      sid: 604,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["function processItems() -> none [copy-picked] [category: X] -- desc"]);
  });

  it("formats a custom-ace-block with category and description", () => {
    const event: CustomAceBlockEvent = {
      eventType: "custom-ace-block",
      aceType: "action",
      aceName: "slashAttack",
      objectClass: "SlashAttackers",
      functionReturnType: "none",
      functionCopyPicked: true,
      functionIsAsync: false,
      functionParameters: [],
      functionCategory: "SlashAttackers",
      functionDescription: "Implementation of a single attack",
      conditions: [],
      actions: [],
      sid: 605,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, [
      "ace SlashAttackers.slashAttack() -> none [copy-picked] [category: SlashAttackers] -- Implementation of a single attack",
    ]);
  });

  it("does not increment counter for variable, comment, or include events", () => {
    const counter = makeCounter();
    const entries = makeEntries();
    formatEvent(
      { eventType: "include", includeSheet: "Other" } as IncludeEvent,
      "",
      "T",
      counter,
      "events[0]",
      1,
      entries,
    );
    assert.equal(counter.value, 0);
    formatEvent({ eventType: "comment", text: "hi" } as CommentEvent, "", "T", counter, "events[1]", 2, entries);
    assert.equal(counter.value, 0);
    formatEvent(
      {
        eventType: "variable",
        name: "x",
        type: "number",
        initialValue: "0",
        isStatic: false,
        isConstant: false,
        sid: 1,
      } as EventSheetVariable,
      "",
      "T",
      counter,
      "events[2]",
      3,
      entries,
    );
    assert.equal(counter.value, 0);
  });

  it("formats a disabled group", () => {
    const event: GroupEvent = {
      eventType: "group",
      disabled: true,
      title: "Debug",
      isActiveOnStart: false,
      children: [],
      sid: 700,
    };
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ['group "Debug" [DISABLED] (inactive)']);
  });

  it("formats a disabled block", () => {
    const event = {
      eventType: "block" as const,
      conditions: [],
      actions: [],
      sid: 100,
      disabled: true,
    };
    const entries = makeEntries();
    const lines = formatEvent(event as BlockEvent, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, ["block [DISABLED]"]);
  });

  it("prefixes disabled conditions with [DISABLED]", () => {
    // `disabled` is not declared on the c3source `Condition` type, but C3 stores it
    // at runtime — cast through `unknown` to model what source JSON actually carries.
    const event = {
      eventType: "block" as const,
      conditions: [
        {
          id: "compare-boolean-eventvar",
          objectClass: "GameState",
          sid: 969513000111828,
          parameters: { name: "hasCheckedTitleNewsPopup" },
          disabled: true,
        },
      ],
      actions: [],
      sid: 100,
    } as unknown as BlockEvent;
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, [
      "block",
      "  when: [DISABLED] GameState.compare-boolean-eventvar(name=hasCheckedTitleNewsPopup)",
    ]);
  });

  it("combines NOT and [DISABLED] on a single condition", () => {
    const event = {
      eventType: "block" as const,
      conditions: [
        {
          id: "compare-boolean-eventvar",
          objectClass: "GameState",
          sid: 414452253306203,
          parameters: { name: "hasCheckedTitleNewsPopup" },
          isInverted: true,
          disabled: true,
        },
      ],
      actions: [],
      sid: 100,
    } as unknown as BlockEvent;
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, [
      "block",
      "  when: [DISABLED] NOT GameState.compare-boolean-eventvar(name=hasCheckedTitleNewsPopup)",
    ]);
  });

  it("renders enabled conditions without the [DISABLED] marker", () => {
    // `disabled: false` and `disabled` omitted should both render bare — regression guard
    // so the disabled detection doesn't fire on truthy-but-non-true values.
    const event = {
      eventType: "block" as const,
      conditions: [
        { id: "on-start-of-layout", objectClass: "System", sid: 1 },
        {
          id: "is-visible",
          objectClass: "Sprite",
          sid: 2,
          disabled: false,
        },
      ],
      actions: [],
      sid: 100,
    } as unknown as BlockEvent;
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, [
      "block",
      "  when: System.on-start-of-layout()",
      "  when: Sprite.is-visible()",
    ]);
  });

  it("formats a block with comment action (no do: prefix)", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [
        { type: "comment", text: "First line\nSecond line" },
        { id: "destroy", objectClass: "Sprite", sid: 4 },
      ],
      sid: 100,
    };
    const counter = makeCounter();
    const entries = makeEntries();
    const lines = formatEvent(event, "", "Test", counter, "events[0]", 1, entries);
    // Multi-line comments produce one line per comment line
    assert.deepEqual(lines, [
      "block",
      "  when: System.on-start-of-layout()",
      "  // First line",
      "  // Second line",
      "  do: Sprite.destroy()",
    ]);
  });

  it("formats a block with empty actions and children without extra blank line", () => {
    const child: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "is-visible", objectClass: "Sprite", sid: 3 }],
      actions: [{ id: "destroy", objectClass: "Sprite", sid: 4 }],
      sid: 101,
    };
    const parentBlock: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-end-of-layout", objectClass: "System", sid: 1 }],
      actions: [],
      sid: 100,
      children: [child],
    };
    const entries = makeEntries();
    const lines = formatEvent(parentBlock, "", "Test", makeCounter(), "events[0]", 1, entries);
    assert.deepEqual(lines, [
      "block",
      "  when: System.on-end-of-layout()",
      "",
      "  block",
      "    when: Sprite.is-visible()",
      "    do: Sprite.destroy()",
    ]);
  });
});

describe("formatEventSheet", () => {
  it("produces correct header with sheet name and source path", () => {
    const sheet: EventSheet = {
      name: "TestSheet",
      events: [],
      sid: 999,
    };
    const { dsl } = formatEventSheet(sheet, "C:/repos/burbank/eventSheets/TestSheet.json");
    const lines = dsl.split("\n");
    assert.equal(lines[0], "# TestSheet");
    assert.equal(lines[1], "# Source: eventSheets/TestSheet.json");
  });

  it("produces header-only output for empty sheet", () => {
    const sheet: EventSheet = {
      name: "EmptySheet",
      events: [],
      sid: 888,
    };
    const { dsl } = formatEventSheet(sheet, "C:/repos/burbank/eventSheets/EmptySheet.json");
    assert.equal(dsl, "# EmptySheet\n# Source: eventSheets/EmptySheet.json\n\n");
  });

  it("formats a full sheet with events", () => {
    const sheet: EventSheet = {
      name: "MySheet",
      events: [
        { eventType: "comment", text: "Setup" } as CommentEvent,
        {
          eventType: "block",
          conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
          actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "hi" } }],
          sid: 100,
        } as BlockEvent,
      ],
      sid: 777,
    };
    const { dsl } = formatEventSheet(sheet, "/project/eventSheets/Sub/MySheet.json");
    const lines = dsl.split("\n");
    assert.equal(lines[0], "# MySheet");
    assert.equal(lines[1], "# Source: eventSheets/Sub/MySheet.json");
    assert.equal(lines[2], "");
    assert.equal(lines[3], "// Setup");
    assert.equal(lines[4], "");
    assert.equal(lines[5], "block");
    assert.equal(lines[6], "  when: System.on-start-of-layout()");
    assert.equal(lines[7], "  do: Label.set-text(text=hi)");
  });
});

describe("DslIndexEntry generation", () => {
  function makeCounter(value = 0): EventCounter {
    return { value };
  }

  function makeEntries(): DslIndexEntry[] {
    return [];
  }

  it("top-level block gets events[0] path, correct line number, and eventNumber 1", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [],
      sid: 100,
    };
    const entries = makeEntries();
    formatEvent(event, "", "Test", makeCounter(), "events[0]", 4, entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].jsonPath, "events[0]");
    assert.equal(entries[0].dslLineNumber, 4);
    assert.equal(entries[0].eventNumber, 1);
    assert.equal(entries[0].description, "block");
  });

  it("non-counting events (include, comment, variable) get entries with eventNumber null", () => {
    const entries = makeEntries();
    const counter = makeCounter();

    formatEvent(
      { eventType: "include", includeSheet: "Other" } as IncludeEvent,
      "",
      "T",
      counter,
      "events[0]",
      4,
      entries,
    );
    formatEvent({ eventType: "comment", text: "hi" } as CommentEvent, "", "T", counter, "events[1]", 6, entries);
    formatEvent(
      {
        eventType: "variable",
        name: "x",
        type: "number",
        initialValue: "0",
        isStatic: false,
        isConstant: false,
        sid: 1,
      } as EventSheetVariable,
      "",
      "T",
      counter,
      "events[2]",
      7,
      entries,
    );

    assert.equal(entries.length, 3);
    assert.equal(entries[0].eventNumber, null);
    assert.equal(entries[1].eventNumber, null);
    assert.equal(entries[2].eventNumber, null);
  });

  it("group with children gets correct nested paths", () => {
    const child1: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 101,
    };
    const child2: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 102,
    };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "MyGroup",
      isActiveOnStart: true,
      children: [child1, child2],
      sid: 200,
    };

    const entries = makeEntries();
    formatEvent(group, "", "Test", makeCounter(), "events[0]", 1, entries);

    assert.equal(entries.length, 3);
    assert.equal(entries[0].jsonPath, "events[0]");
    assert.equal(entries[0].description, 'group "MyGroup"');
    assert.equal(entries[1].jsonPath, "events[0].children[0]");
    assert.equal(entries[1].description, "block");
    assert.equal(entries[2].jsonPath, "events[0].children[1]");
    assert.equal(entries[2].description, "block");
  });

  it("deeply nested children (block inside group inside group)", () => {
    const innerBlock: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 103,
    };
    const innerGroup: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Inner",
      isActiveOnStart: true,
      children: [innerBlock],
      sid: 201,
    };
    const outerGroup: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Outer",
      isActiveOnStart: true,
      children: [innerGroup],
      sid: 200,
    };

    const entries = makeEntries();
    formatEvent(outerGroup, "", "Test", makeCounter(), "events[0]", 1, entries);

    assert.equal(entries.length, 3);
    assert.equal(entries[0].jsonPath, "events[0]");
    assert.equal(entries[1].jsonPath, "events[0].children[0]");
    assert.equal(entries[2].jsonPath, "events[0].children[0].children[0]");
  });

  it("mixed event types: variable + comment + block as siblings — all indexed with correct JSON array indices", () => {
    const variable: EventSheetVariable = {
      eventType: "variable",
      name: "count",
      type: "number",
      initialValue: "0",
      isStatic: false,
      isConstant: false,
      sid: 1,
    };
    const comment: CommentEvent = {
      eventType: "comment",
      text: "Setup",
    };
    const block: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 100,
    };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Mixed",
      isActiveOnStart: true,
      children: [variable, comment, block],
      sid: 200,
    };

    const entries = makeEntries();
    formatEvent(group, "", "Test", makeCounter(), "events[0]", 1, entries);

    assert.equal(entries.length, 4); // group + 3 children
    assert.equal(entries[0].jsonPath, "events[0]"); // group
    assert.equal(entries[1].jsonPath, "events[0].children[0]"); // variable
    assert.equal(entries[2].jsonPath, "events[0].children[1]"); // comment
    assert.equal(entries[3].jsonPath, "events[0].children[2]"); // block
  });

  it("event numbering matches counter across mixed event types (variables don't increment)", () => {
    const variable: EventSheetVariable = {
      eventType: "variable",
      name: "count",
      type: "number",
      initialValue: "0",
      isStatic: false,
      isConstant: false,
      sid: 1,
    };
    const block1: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 100,
    };
    const block2: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 101,
    };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Numbering",
      isActiveOnStart: true,
      children: [variable, block1, block2],
      sid: 200,
    };

    const entries = makeEntries();
    formatEvent(group, "", "Test", makeCounter(), "events[0]", 1, entries);

    // group=1, variable=null, block1=2, block2=3
    assert.equal(entries[0].eventNumber, 1); // group
    assert.equal(entries[1].eventNumber, null); // variable
    assert.equal(entries[2].eventNumber, 2); // block1
    assert.equal(entries[3].eventNumber, 3); // block2
  });

  it("description matches expected format for each event type", () => {
    const entries = makeEntries();
    const counter = makeCounter();

    // include
    formatEvent(
      { eventType: "include", includeSheet: "OtherSheet" } as IncludeEvent,
      "",
      "T",
      counter,
      "events[0]",
      1,
      entries,
    );
    assert.equal(entries[0].description, "include OtherSheet");

    // single-line comment
    formatEvent({ eventType: "comment", text: "A note" } as CommentEvent, "", "T", counter, "events[1]", 2, entries);
    assert.equal(entries[1].description, "// A note");

    // multi-line comment (truncated)
    formatEvent(
      { eventType: "comment", text: "Line one\nLine two" } as CommentEvent,
      "",
      "T",
      counter,
      "events[2]",
      3,
      entries,
    );
    assert.equal(entries[2].description, "// Line one...");

    // variable
    formatEvent(
      {
        eventType: "variable",
        name: "hp",
        type: "number",
        initialValue: "100",
        isStatic: false,
        isConstant: false,
        sid: 1,
      } as EventSheetVariable,
      "",
      "T",
      counter,
      "events[3]",
      4,
      entries,
    );
    assert.equal(entries[3].description, "var hp: number = 100");

    // block
    formatEvent(
      { eventType: "block", conditions: [], actions: [], sid: 10 } as BlockEvent,
      "",
      "T",
      counter,
      "events[4]",
      5,
      entries,
    );
    assert.equal(entries[4].description, "block");

    // block [OR]
    formatEvent(
      { eventType: "block", conditions: [], actions: [], sid: 11, isOrBlock: true } as BlockEvent,
      "",
      "T",
      counter,
      "events[5]",
      6,
      entries,
    );
    assert.equal(entries[5].description, "block [OR]");

    // group
    formatEvent(
      { eventType: "group", disabled: false, title: "Grp", isActiveOnStart: true, children: [], sid: 12 } as GroupEvent,
      "",
      "T",
      counter,
      "events[6]",
      7,
      entries,
    );
    assert.equal(entries[6].description, 'group "Grp"');

    // function-block
    formatEvent(
      {
        eventType: "function-block",
        functionName: "doStuff",
        functionReturnType: "none",
        functionCopyPicked: false,
        functionIsAsync: false,
        functionParameters: [],
        conditions: [],
        actions: [],
        sid: 13,
      } as FunctionBlockEvent,
      "",
      "T",
      counter,
      "events[7]",
      8,
      entries,
    );
    assert.equal(entries[7].description, "function doStuff()");

    // custom-ace-block
    formatEvent(
      {
        eventType: "custom-ace-block",
        aceType: "condition",
        aceName: "Check",
        objectClass: "Plug",
        functionReturnType: "boolean",
        functionCopyPicked: false,
        functionIsAsync: false,
        functionParameters: [],
        conditions: [],
        actions: [],
        sid: 14,
      } as CustomAceBlockEvent,
      "",
      "T",
      counter,
      "events[8]",
      9,
      entries,
    );
    assert.equal(entries[8].description, "ace Plug.Check()");
  });

  it("formatEventSheet returns index entries for all events", () => {
    const sheet: EventSheet = {
      name: "IndexSheet",
      events: [
        { eventType: "include", includeSheet: "Other" } as IncludeEvent,
        {
          eventType: "block",
          conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
          actions: [],
          sid: 100,
        } as BlockEvent,
      ],
      sid: 999,
    };
    const { dsl, index } = formatEventSheet(sheet, "C:/repos/burbank/eventSheets/IndexSheet.json");
    assert.equal(index.length, 2);
    assert.equal(index[0].jsonPath, "events[0]");
    assert.equal(index[0].eventNumber, null); // include
    assert.equal(index[0].dslLineNumber, 4); // line 4 (after header)
    assert.equal(index[1].jsonPath, "events[1]");
    assert.equal(index[1].eventNumber, 1); // block
    assert.equal(index[1].dslLineNumber, 6); // line 4 (include) + blank line + block at line 6
    // DSL output should still be correct
    assert.include(dsl, "# IndexSheet");
    assert.include(dsl, "include Other");
  });

  it("line numbers track correctly across multi-line events", () => {
    const sheet: EventSheet = {
      name: "LineSheet",
      events: [
        { eventType: "comment", text: "Line 1\nLine 2\nLine 3" } as CommentEvent,
        {
          eventType: "block",
          conditions: [{ id: "test", objectClass: "System", sid: 1 }],
          actions: [],
          sid: 100,
        } as BlockEvent,
      ],
      sid: 999,
    };
    const { index } = formatEventSheet(sheet, "C:/repos/burbank/eventSheets/LineSheet.json");
    assert.equal(index[0].dslLineNumber, 4); // comment starts at line 4
    // Comment is 3 lines (4,5,6) + blank line (7) → block at line 8
    assert.equal(index[1].dslLineNumber, 8);
  });
});

describe("formatIndex", () => {
  it("produces header-only output for empty entries", () => {
    const result = formatIndex("TestSheet", []);
    const lines = result.split("\n");
    assert.equal(lines[0], "# TestSheet \u2014 DSL Coordinate Index");
    assert.equal(lines[1], "# Regenerate: npm run generate-dsl");
    assert.equal(lines[2], "#");
    // Header and separator should still be present
    assert.include(lines[3], "Event");
    assert.include(lines[3], "JSON Path");
    assert.include(lines[3], "SID");
    assert.include(lines[3], "DSL Line");
    assert.include(lines[3], "Description");
    assert.include(lines[4], "---");
    // No data rows
    assert.equal(lines[5], "");
  });

  it("entries are formatted in table layout with correct alignment", () => {
    const entries: DslIndexEntry[] = [
      { eventNumber: 1, jsonPath: "events[0]", dslLineNumber: 4, description: "block" },
      { eventNumber: 2, jsonPath: "events[1]", dslLineNumber: 7, description: 'group "UI"' },
    ];
    const result = formatIndex("TestSheet", entries);
    const lines = result.split("\n");

    // Data rows should contain pipe separators
    assert.include(lines[5], "| events[0]");
    assert.include(lines[5], "| 4");
    assert.include(lines[5], "| block");
    assert.include(lines[6], "| events[1]");
    assert.include(lines[6], "| 7");
    assert.include(lines[6], '| group "UI"');
  });

  it("shows - for non-counting events, numbers for counting events", () => {
    const entries: DslIndexEntry[] = [
      { eventNumber: null, jsonPath: "events[0]", dslLineNumber: 4, description: "include Other" },
      { eventNumber: 1, jsonPath: "events[1]", dslLineNumber: 6, description: "block" },
      { eventNumber: null, jsonPath: "events[2]", dslLineNumber: 9, description: "var x: number = 0" },
    ];
    const result = formatIndex("TestSheet", entries);
    const lines = result.split("\n");

    // First data row (include) should show -
    const includeRow = lines[5];
    assert.match(includeRow, /^\s+-\s+\|/);

    // Second data row (block) should show 1
    const blockRow = lines[6];
    assert.match(blockRow, /^\s+1\s+\|/);

    // Third data row (variable) should show -
    const varRow = lines[7];
    assert.match(varRow, /^\s+-\s+\|/);
  });

  it("shows §-prefixed SID for events with sid, blank for events without", () => {
    const entries: DslIndexEntry[] = [
      {
        eventNumber: 1,
        jsonPath: "events[0]",
        dslLineNumber: 4,
        description: "block",
        sid: 100234567890123,
      },
      {
        eventNumber: null,
        jsonPath: "events[1]",
        dslLineNumber: 6,
        description: "include Other",
      },
      {
        eventNumber: 2,
        jsonPath: "events[2]",
        dslLineNumber: 8,
        description: "function myFunc()",
        sid: 200000000000001,
      },
    ];
    const result = formatIndex("TestSheet", entries);
    const lines = result.split("\n");

    // Block row (line 5) should show §100234567890123
    assert.include(lines[5], "\u00a7100234567890123");

    // Include row (line 6) should have blank SID column
    const includeParts = lines[6].split("|");
    assert.match(includeParts[2].trim(), /^$/);

    // Function row (line 7) should show §200000000000001
    assert.include(lines[7], "\u00a7200000000000001");
  });

  it("formats group and custom-ace-block events with SID", () => {
    const groupEvent: GroupEvent = {
      eventType: "group",
      title: "Main",
      disabled: false,
      isActiveOnStart: true,
      sid: 300000000000042,
      children: [],
    };
    const entries: DslIndexEntry[] = [];
    formatEvent(groupEvent, "", "TestSheet", { value: 0 }, "events[0]", 1, entries);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].sid, 300000000000042);
  });
});

describe("action-level index entries", () => {
  function makeCounter(value = 0): EventCounter {
    return { value };
  }

  function makeEntries(): DslIndexEntry[] {
    return [];
  }

  it("block with actions generates action-level index entries with correct actionIndex values", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [
        { id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "hi" } },
        { callFunction: "playSFX", sid: 3, parameters: ['"click"'] },
        { id: "destroy", objectClass: "Sprite", sid: 4 },
      ],
      sid: 100,
    };
    const entries = makeEntries();
    formatEvent(event, "", "TestSheet", makeCounter(), "events[0]", 1, entries);

    // 1 event-level entry + 3 action-level entries = 4 total
    assert.equal(entries.length, 4);

    // First entry is the block event itself
    assert.equal(entries[0].eventNumber, 1);
    assert.equal(entries[0].actionIndex, undefined);

    // Action entries have actionIndex 0, 1, 2
    assert.equal(entries[1].actionIndex, 0);
    assert.equal(entries[2].actionIndex, 1);
    assert.equal(entries[3].actionIndex, 2);

    // Action entries have eventNumber null
    assert.equal(entries[1].eventNumber, null);
    assert.equal(entries[2].eventNumber, null);
    assert.equal(entries[3].eventNumber, null);

    // Action entries share the parent event's jsonPath
    assert.equal(entries[1].jsonPath, "events[0]");
    assert.equal(entries[2].jsonPath, "events[0]");
    assert.equal(entries[3].jsonPath, "events[0]");
  });

  it("action descriptions are correct for different action types", () => {
    const scriptMultiLine: ScriptAction = {
      type: "script",
      language: "typescript",
      script: ["const x = 1;", "console.log(x);"],
    };
    const scriptSingleLine: ScriptAction = {
      type: "script",
      language: "typescript",
      script: ["runtime.setReturnValue(42);"],
    };
    const callAction = { callFunction: "playSFX", sid: 3, parameters: ['"click"'] };
    const commentAction = { type: "comment", text: "Set up UI elements" };
    const customAction = { customAction: "Initialize", objectClass: "CardScroller", sid: 5 };
    const standardAction = { id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "hi" } };

    // Multi-line script -> cross-ref
    const multiLineDesc = describeAction(scriptMultiLine, "SheetName", 3, 1);
    assert.equal(multiLineDesc, "script \u2192 SheetName_Event3_Act1");

    // Single-line script -> inline
    const singleLineDesc = describeAction(scriptSingleLine, "SheetName", 3, 2);
    assert.equal(singleLineDesc, "script { runtime.setReturnValue(42); }");

    // Call action
    const callDesc = describeAction(callAction, "SheetName", 3, 3);
    assert.equal(callDesc, "call playSFX()");

    // Comment action
    const commentDesc = describeAction(commentAction, "SheetName", 3, 4);
    assert.equal(commentDesc, "// Set up UI elements");

    // Custom ACE action
    const customDesc = describeAction(customAction, "SheetName", 3, 5);
    assert.equal(customDesc, "ace CardScroller.Initialize()");

    // Standard action
    const standardDesc = describeAction(standardAction, "SheetName", 3, 6);
    assert.equal(standardDesc, "Label.set-text()");
  });

  it("formatIndex renders action rows correctly (indented, no event number, no DSL line)", () => {
    const entries: DslIndexEntry[] = [
      { eventNumber: 1, jsonPath: "events[0]", dslLineNumber: 4, description: "block" },
      {
        eventNumber: null,
        jsonPath: "events[0]",
        dslLineNumber: 0,
        description: "script \u2192 Sheet_Event1_Act1",
        actionIndex: 0,
      },
      { eventNumber: null, jsonPath: "events[0]", dslLineNumber: 0, description: "call playSFX()", actionIndex: 1 },
      { eventNumber: null, jsonPath: "events[0]", dslLineNumber: 0, description: "// comment text", actionIndex: 2 },
    ];
    const result = formatIndex("TestSheet", entries);
    const lines = result.split("\n");

    // Line 5 = first data row (event-level, block)
    assert.include(lines[5], "1");
    assert.include(lines[5], "events[0]");
    assert.include(lines[5], "4");
    assert.include(lines[5], "block");

    // Line 6 = action[0] row — should have empty event, indented action path, empty DSL line
    assert.include(lines[6], "action[0]");
    assert.include(lines[6], "script \u2192 Sheet_Event1_Act1");
    // Event column should be spaces, not a number or dash
    assert.match(lines[6], /^\s+\s+\|/);
    // Should NOT contain a DSL line number (just spaces between the pipes)
    const actionParts = lines[6].split("|");
    // SID column (index 2) should be all spaces (no SID for action rows)
    assert.match(actionParts[2].trim(), /^$/);
    // Fourth column (DSL Line, index 3) should be all spaces
    assert.match(actionParts[3].trim(), /^$/);

    // Line 7 = action[1]
    assert.include(lines[7], "action[1]");
    assert.include(lines[7], "call playSFX()");

    // Line 8 = action[2]
    assert.include(lines[8], "action[2]");
    assert.include(lines[8], "// comment text");
  });

  it("block with mix of comment and script actions indexes all actions correctly", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [
        { type: "comment", text: "Initialize vars" },
        { type: "script", language: "typescript", script: ["const x = 1;", "console.log(x);"] } as ScriptAction,
        { type: "comment", text: "Call handler" },
        { callFunction: "handleInit", sid: 10, parameters: [] },
      ],
      sid: 100,
    };
    const entries = makeEntries();
    formatEvent(event, "", "MySheet", makeCounter(), "events[2]", 10, entries);

    // 1 event + 4 actions = 5 entries
    assert.equal(entries.length, 5);

    // Event entry
    assert.equal(entries[0].actionIndex, undefined);
    assert.equal(entries[0].description, "block");

    // Action 0: comment
    assert.equal(entries[1].actionIndex, 0);
    assert.equal(entries[1].description, "// Initialize vars");

    // Action 1: multi-line script (event counter was 1 after block increment)
    assert.equal(entries[2].actionIndex, 1);
    assert.equal(entries[2].description, "script \u2192 MySheet_Event1_Act2");

    // Action 2: comment
    assert.equal(entries[3].actionIndex, 2);
    assert.equal(entries[3].description, "// Call handler");

    // Action 3: function call
    assert.equal(entries[4].actionIndex, 3);
    assert.equal(entries[4].description, "call handleInit()");
  });

  it("describeAction returns [unknown action] for unrecognized action shape", () => {
    const action = { someWeirdKey: "value" };
    const desc = describeAction(action, "Sheet", 1, 1);
    assert.equal(desc, "[unknown action]");
  });

  it("describeAction truncates long single-line scripts", () => {
    const longLine = "a".repeat(100);
    const action: ScriptAction = {
      type: "script",
      language: "typescript",
      script: [longLine],
    };
    const desc = describeAction(action, "Sheet", 1, 1);
    assert.include(desc, "script {");
    assert.include(desc, "...");
    // Should be truncated, not the full 100 chars
    assert.isBelow(desc.length, 80);
  });

  it("describeAction truncates long comment text", () => {
    const longComment = "b".repeat(100);
    const action = { type: "comment", text: longComment };
    const desc = describeAction(action, "Sheet", 1, 1);
    assert.include(desc, "// ");
    assert.include(desc, "...");
    assert.isBelow(desc.length, 80);
  });
});

describe("filterIndex", () => {
  const sampleIndex = [
    "# TestSheet — DSL Coordinate Index",
    "# Regenerate: npm run generate-dsl",
    "#",
    "# Event | JSON Path        | SID              | DSL Line | Description",
    "#-------|-------------------|------------------|----------|------------",
    "  1     | events[0]         | §000000000000001 | 5        | function myFunc",
    "  2     | events[1]         | §000000000000002 | 10       | block on-start-of-layout",
    "  3     | events[2]         | §000000000000003 | 15       | group Settings",
    "",
  ].join("\n");

  it("filters data rows by pattern, preserving headers", () => {
    const result = filterIndex(sampleIndex, "function");
    const lines = result.split("\n");
    // All 5 header lines preserved
    assert.equal(lines.filter((l) => l.startsWith("#")).length, 5);
    // Only the function row matches
    assert.equal(lines.filter((l) => l.includes("myFunc")).length, 1);
    // Non-matching rows excluded
    assert.equal(lines.filter((l) => l.includes("on-start-of-layout")).length, 0);
    assert.equal(lines.filter((l) => l.includes("Settings")).length, 0);
  });

  it("returns headers + 'No matches' note when no data rows match", () => {
    const result = filterIndex(sampleIndex, "nonexistent_pattern_xyz");
    const lines = result.split("\n");
    // Headers preserved
    assert.equal(lines.filter((l) => l.startsWith("#")).length, 5);
    // No matches message present
    assert.include(result, "No matches for pattern: nonexistent_pattern_xyz");
    // No data rows
    assert.equal(lines.filter((l) => l.includes("events[")).length, 0);
  });

  it("supports regex patterns", () => {
    const result = filterIndex(sampleIndex, "function.*myFunc");
    const lines = result.split("\n");
    assert.equal(lines.filter((l) => l.includes("myFunc")).length, 1);
    assert.equal(lines.filter((l) => l.includes("on-start-of-layout")).length, 0);
  });

  it("is case-insensitive", () => {
    const result = filterIndex(sampleIndex, "FUNCTION");
    assert.include(result, "myFunc");
  });

  it("returns headers + error for invalid regex pattern", () => {
    const result = filterIndex(sampleIndex, "[invalid");
    const lines = result.split("\n");
    assert.equal(lines.filter((l) => l.startsWith("#")).length, 5);
    assert.include(result, "Invalid regex pattern: [invalid");
  });
});

describe("buildShallowSidMap", () => {
  function makeSheet(events: EventSheet["events"]): EventSheet {
    return { name: "TestSheet", sid: 999, events };
  }

  it("returns empty array for empty sheet", () => {
    const result = buildShallowSidMap(makeSheet([]));
    assert.deepEqual(result, []);
  });

  it("variable event — returns entry with sid and description matching formatVariableDescription format", () => {
    const variable: EventSheetVariable = {
      eventType: "variable",
      name: "hp",
      type: "number",
      initialValue: "100",
      isStatic: false,
      isConstant: false,
      sid: 101,
    };
    const result = buildShallowSidMap(makeSheet([variable]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.equal(entry.jsonPath, "events[0]");
    assert.equal(entry.sid, 101);
    assert.equal(entry.description, "var hp: number = 100");
  });

  it("include event — returns entry with sid: undefined and description as 'include SheetName'", () => {
    const event: IncludeEvent = { eventType: "include", includeSheet: "CommonEvents" };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    assert.equal(result[0].jsonPath, "events[0]");
    assert.equal(result[0].sid, undefined);
    assert.equal(result[0].description, "include CommonEvents");
  });

  it("comment event — returns entry with sid: undefined and description starting with '//'", () => {
    const event: CommentEvent = { eventType: "comment", text: "This is a note" };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    assert.equal(result[0].jsonPath, "events[0]");
    assert.equal(result[0].sid, undefined);
    assert.equal(result[0].description, "// This is a note");
  });

  it("multiline comment event — description uses first line with '...' suffix", () => {
    const event: CommentEvent = { eventType: "comment", text: "First line\nSecond line" };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result[0].description, "// First line...");
  });

  it("block event — returns entry with sid and description as 'block'", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [],
      sid: 200,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    assert.equal(result[0].jsonPath, "events[0]");
    assert.equal(result[0].sid, 200);
    assert.equal(result[0].description, "block");
  });

  it("function-block event — returns entry with sid and description as 'function \"name\"'", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "doSetup",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 300,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    assert.equal(result[0].jsonPath, "events[0]");
    assert.equal(result[0].sid, 300);
    assert.equal(result[0].description, 'function "doSetup"');
  });

  it("group with children — returns entry for group and entries for each child with correct paths", () => {
    const child1: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 401,
    };
    const child2: IncludeEvent = { eventType: "include", includeSheet: "Sub" };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Setup",
      isActiveOnStart: true,
      children: [child1, child2],
      sid: 400,
    };
    const result = buildShallowSidMap(makeSheet([group]));
    assert.equal(result.length, 3);
    assert.equal(result[0].jsonPath, "events[0]");
    assert.equal(result[0].sid, 400);
    assert.equal(result[0].description, 'group "Setup"');
    assert.equal(result[1].jsonPath, "events[0].children[0]");
    assert.equal(result[1].sid, 401);
    assert.equal(result[1].description, "block");
    assert.equal(result[2].jsonPath, "events[0].children[1]");
    assert.equal(result[2].sid, undefined);
    assert.equal(result[2].description, "include Sub");
  });

  it("nested group — verifies jsonPath is events[0].children[0].children[0] for doubly-nested event", () => {
    const innerBlock: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 503,
    };
    const innerGroup: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Inner",
      isActiveOnStart: true,
      children: [innerBlock],
      sid: 502,
    };
    const outerGroup: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Outer",
      isActiveOnStart: true,
      children: [innerGroup],
      sid: 501,
    };
    const result = buildShallowSidMap(makeSheet([outerGroup]));
    assert.equal(result.length, 3);
    assert.equal(result[0].jsonPath, "events[0]");
    assert.equal(result[1].jsonPath, "events[0].children[0]");
    assert.equal(result[2].jsonPath, "events[0].children[0].children[0]");
  });

  // searchText is grep-only (never displayed); it lets `read-event-sids grep=...`
  // match condition/action content, not just the description column.

  it("block searchText includes condition summary so grep can match condition id", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-touched-object", objectClass: "Touch", sid: 1 }],
      actions: [],
      sid: 200,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.equal(entry.description, "block");
    assert.include(entry.searchText, "Touch.on-touched-object");
  });

  it("block searchText includes callFunction action name", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [{ callFunction: "doSetup", sid: 2 }],
      sid: 201,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.include(entry.searchText, "call doSetup()");
  });

  it("block searchText includes standard action parameter values (the original grep=BattleLayout case)", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [
        {
          id: "go-to-layout",
          objectClass: "System",
          sid: 3,
          parameters: { layout: "BattleLayout" },
        },
      ],
      sid: 202,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.include(entry.searchText, "System.go-to-layout");
    // The motivating gap-report query — parameter value, not the action id —
    // must appear in searchText for `grep=BattleLayout` to find this block.
    assert.include(entry.searchText, "BattleLayout");
  });

  it("NOT condition is reflected in searchText (formatCondition NOT prefix)", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [
        { id: "compare-eventvar", objectClass: "System", sid: 4, isInverted: true },
      ],
      actions: [],
      sid: 203,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.include(entry.searchText, "NOT");
    assert.include(entry.searchText, "System.compare-eventvar");
  });

  it("disabled condition is reflected in searchText with [DISABLED] prefix", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [
        {
          id: "compare-eventvar",
          objectClass: "System",
          sid: 5,
          disabled: true,
        },
      ],
      actions: [],
      sid: 204,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.include(entry.searchText, "[DISABLED]");
  });

  it("disabled action is reflected in searchText with [DISABLED] prefix (via formatAction)", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [
        {
          id: "go-to-layout",
          objectClass: "System",
          sid: 6,
          disabled: true,
          parameters: { layout: "X" },
        },
      ],
      sid: 205,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.include(entry.searchText, "[DISABLED]");
  });

  it("behavior-scoped action is reflected in searchText with [behaviorType] segment", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [
        {
          id: "set-vector-x",
          objectClass: "Player",
          behaviorType: "Platform",
          sid: 7,
          parameters: { value: "100" },
        },
      ],
      sid: 206,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.include(entry.searchText, "Player[Platform].set-vector-x");
  });

  it("function-block searchText includes its inner action summaries", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "doSetup",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [{ callFunction: "innerCall", sid: 5 }],
      sid: 300,
    };
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    const entry = result[0] as SidMapEntry;
    assert.equal(entry.description, 'function "doSetup"');
    assert.include(entry.searchText, "call innerCall()");
  });

  it("variable / include / comment / group have empty searchText", () => {
    const variable: EventSheetVariable = {
      eventType: "variable",
      name: "hp",
      type: "number",
      initialValue: "100",
      isStatic: false,
      isConstant: false,
      sid: 101,
    };
    const include: IncludeEvent = { eventType: "include", includeSheet: "CommonEvents" };
    const comment: CommentEvent = { eventType: "comment", text: "note" };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Setup",
      isActiveOnStart: true,
      children: [],
      sid: 400,
    };
    const result = buildShallowSidMap(makeSheet([variable, include, comment, group]));
    for (const entry of result) {
      assert.equal(entry.searchText, "", `expected empty searchText for ${entry.description}`);
    }
  });

  it("block with missing conditions / actions arrays does not throw (defensive guard)", () => {
    // c3source's BlockEvent declares both as required, but the read-event-sids
    // handler parses raw JSON without runtime validation. A legacy or hand-edited
    // sheet that omits the array should degrade to empty searchText, not crash
    // the whole tool call.
    const event = {
      eventType: "block",
      sid: 210,
      // conditions: missing, actions: missing
    } as unknown as BlockEvent;
    const result = buildShallowSidMap(makeSheet([event]));
    assert.equal(result.length, 1);
    assert.equal(result[0].searchText, "");
  });

  it("eventCounter mirrors formatBlockLike — group before block bumps the index passed to formatAction", () => {
    // Sheet = [group, block-with-multiline-script]. formatBlockLike emits the
    // script function name as `<Sheet>_Event2_Act1` (group=1, block=2). The
    // counter shared between walk() and summarize() must produce the same name
    // so a user copying the function name out of extracted/scripts can grep it.
    const scriptAction: ScriptAction = {
      type: "script",
      language: "typescript",
      script: ["a()", "b()"],
    };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "G",
      isActiveOnStart: true,
      children: [],
      sid: 500,
    };
    const block: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [scriptAction],
      sid: 501,
    };
    const result = buildShallowSidMap(makeSheet([group, block]));
    assert.equal(result.length, 2);
    // The block entry (index 1) should embed the Event2_Act1 synthetic name.
    assert.include(result[1].searchText, "TestSheet_Event2_Act1");
  });
});
