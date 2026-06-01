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
  formatEventSheet,
  formatIndex,
  filterIndex,
  buildShallowSidMap,
  buildBlockSearchText,
  renderNodeSelf,
  renderSubtree,
  SEARCH_SENTINEL,
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
    const expected = ["script { // → SheetName_Event1_Act1", "  const x = 1;", "  console.log(x);", "}"].join(
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

// describe("formatEvent") and describe("DslIndexEntry generation") removed in F2.
// Coverage lives in describe("renderNodeSelf") and describe("renderSubtree") below.

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

describe("formatIndex", () => {
  it("produces header-only output for empty entries", () => {
    const result = formatIndex("TestSheet", []);
    const lines = result.split("\n");
    assert.equal(lines[0], "# TestSheet — DSL Coordinate Index");
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
    assert.include(lines[5], "§100234567890123");

    // Include row (line 6) should have blank SID column
    const includeParts = lines[6].split("|");
    assert.match(includeParts[2].trim(), /^$/);

    // Function row (line 7) should show §200000000000001
    assert.include(lines[7], "§200000000000001");
  });

  it("group and custom-ace-block events produce SID in index entry (via renderSubtree)", () => {
    // Migrated from DslIndexEntry generation — verifies group SID is captured in the index.
    const groupEvent: GroupEvent = {
      eventType: "group",
      title: "Main",
      disabled: false,
      isActiveOnStart: true,
      sid: 300000000000042,
      children: [],
    };
    const { index } = renderSubtree([groupEvent], "TestSheet", 1);
    assert.equal(index.length, 1);
    assert.equal(index[0].sid, 300000000000042);
  });
});

describe("block index entries (searchText contract)", () => {
  it("block with actions generates exactly ONE index entry (the block row) and NO actionIndex entries", () => {
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
    const { index } = renderSubtree([event], "TestSheet", 1);

    // Exactly 1 entry — the block row; no per-action rows
    assert.equal(index.length, 1);

    // The single entry is the block event itself
    assert.equal(index[0].eventNumber, 1);
    assert.equal(index[0].actionIndex, undefined);
    assert.equal(index[0].description, "block");
  });

  it("block with parameterized action has searchText containing the parameter value", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [
        {
          id: "go-to-layout",
          objectClass: "System",
          sid: 2,
          parameters: { layout: '"Main Layout"' },
        },
      ],
      sid: 100,
    };
    const { index } = renderSubtree([event], "TestSheet", 1);

    assert.equal(index.length, 1);
    assert.isDefined(index[0].searchText);
    // Parameter value must be present in the hidden search tail
    assert.include(index[0].searchText!, "Main Layout");
    // The visible description remains clean
    assert.equal(index[0].description, "block");
  });

  it("block with mix of actions has searchText populated with all action content", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [
        { type: "comment", text: "Initialize vars" },
        { type: "script", language: "typescript", script: ["const x = 1;", "console.log(x);"] } as ScriptAction,
        { callFunction: "handleInit", sid: 10, parameters: [] },
      ],
      sid: 100,
    };
    const { index } = renderSubtree([event], "MySheet", 1);

    // Still exactly 1 entry
    assert.equal(index.length, 1);
    assert.equal(index[0].actionIndex, undefined);
    assert.include(index[0].searchText!, "handleInit");
  });

  it("block with no conditions and no actions has empty searchText", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 200,
    };
    const { index } = renderSubtree([event], "TestSheet", 1);

    assert.equal(index.length, 1);
    assert.equal(index[0].searchText, "");
  });

  it("formatIndex renders block row with sentinel + flattened searchText in Description column", () => {
    const searchText = `System.on-start-of-layout()
System.go-to-layout(layout="Main Layout")`;
    const entries: DslIndexEntry[] = [
      {
        eventNumber: 1,
        jsonPath: "events[0]",
        dslLineNumber: 4,
        description: "block",
        sid: 100000000000001,
        searchText,
      },
    ];
    const result = formatIndex("TestSheet", entries);
    const lines = result.split("\n");

    // Line 5 = the single data row
    const dataRow = lines[5];
    // Sentinel must appear
    assert.include(dataRow, SEARCH_SENTINEL);
    // Newlines in searchText must be flattened to spaces
    assert.notInclude(dataRow, "\n");
    // Both action components present after the sentinel
    assert.include(dataRow, "System.go-to-layout");
    assert.include(dataRow, "Main Layout");
    // Visible description still at the start of the Description column
    assert.include(dataRow, "block");
    // No action[N] path should appear
    assert.notInclude(dataRow, "action[");
  });

  it("formatIndex omits sentinel when searchText is absent or empty", () => {
    const entries: DslIndexEntry[] = [
      {
        eventNumber: null,
        jsonPath: "events[0]",
        dslLineNumber: 4,
        description: "include CommonEvents",
      },
    ];
    const result = formatIndex("TestSheet", entries);
    assert.notInclude(result, SEARCH_SENTINEL);
  });

  it("filterIndex grep on a param value (only in searchText, not in visible description) returns the block row", () => {
    // Construct an index string that mimics formatIndex output with a block row
    // whose Description contains the sentinel + hidden tail.
    const blockRowDesc = `block${SEARCH_SENTINEL}System.go-to-layout(layout="Main Layout")`;
    const indexLines = [
      "# TestSheet — DSL Coordinate Index",
      "# Regenerate: npm run generate-dsl",
      "#",
      "# Event | JSON Path | SID              | DSL Line | Description",
      "#-------|-----------|------------------|----------|-----------",
      `  1     | events[0] | §910000000000001 | 4        | ${blockRowDesc}`,
      "",
    ];
    const indexText = indexLines.join("\n");

    // "Main Layout" only exists in the hidden tail — filterIndex should still find the row
    const result = filterIndex(indexText, "Main Layout");
    assert.notInclude(result, "No matches");
    assert.include(result, "events[0]");
    assert.include(result, "block");
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
      conditions: [{ id: "compare-eventvar", objectClass: "System", sid: 4, isInverted: true }],
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

describe("buildBlockSearchText", () => {
  function makeSheet(name: string = "TestSheet"): EventSheet {
    return { name, sid: 999, events: [] };
  }

  it("purity — same input twice produces identical string", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "GoToLayout", objectClass: "System", sid: 2, parameters: { layout: "BattleLayout" } }],
      sid: 100,
    };
    const sheet = makeSheet();
    const first = buildBlockSearchText(event, sheet, 1);
    const second = buildBlockSearchText(event, sheet, 1);
    assert.equal(first, second);
  });

  it("parity — block with parameterized action contains parameter value", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [{ id: "GoToLayout", objectClass: "System", sid: 2, parameters: { layout: "BattleLayout" } }],
      sid: 101,
    };
    const result = buildBlockSearchText(event, makeSheet(), 1);
    assert.include(result, "BattleLayout");
  });

  it("empty — block with no conditions and no actions returns empty string", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 102,
    };
    const result = buildBlockSearchText(event, makeSheet(), 1);
    assert.equal(result, "");
  });

  it("function-block variant — both conditions and actions appear in output", () => {
    const event: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "doSetup",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 10 }],
      actions: [{ id: "GoToLayout", objectClass: "System", sid: 11, parameters: { layout: "BattleLayout" } }],
      sid: 103,
    };
    const result = buildBlockSearchText(event, makeSheet(), 1);
    assert.include(result, "System.on-start-of-layout");
    assert.include(result, "BattleLayout");
  });
});

// ---------------------------------------------------------------------------
// renderNodeSelf — new seam added in P1
// ---------------------------------------------------------------------------

describe("renderNodeSelf", () => {
  it("include event — returns single include line", () => {
    const event: IncludeEvent = { eventType: "include", includeSheet: "CommonEvents" };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["include CommonEvents"]);
  });

  it("comment event (single-line) — returns single // line", () => {
    const event: CommentEvent = { eventType: "comment", text: "Load data to header" };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["// Load data to header"]);
  });

  it("comment event (multi-line) — returns one // line per source line", () => {
    const event: CommentEvent = {
      eventType: "comment",
      text: "Login support:\nA custom ID is saved in local storage.\nAfter login, it is linked to that account.",
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, [
      "// Login support:",
      "// A custom ID is saved in local storage.",
      "// After login, it is linked to that account.",
    ]);
  });

  it("variable event (const) — returns the formatted variable line", () => {
    const event: EventSheetVariable = {
      eventType: "variable",
      name: "MAX_ITEMS",
      type: "number",
      initialValue: "10",
      isStatic: false,
      isConstant: true,
      sid: 123,
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["const MAX_ITEMS: number = 10"]);
  });

  it("variable event (static) — returns 'static' keyword", () => {
    const event: EventSheetVariable = {
      eventType: "variable",
      name: "counter",
      type: "number",
      initialValue: "0",
      isStatic: true,
      isConstant: false,
      sid: 456,
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["static counter: number = 0"]);
  });

  it("variable event (regular var) — returns 'var' keyword", () => {
    const event: EventSheetVariable = {
      eventType: "variable",
      name: "playerName",
      type: "string",
      initialValue: '""',
      isStatic: false,
      isConstant: false,
      sid: 789,
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ['var playerName: string = ""']);
  });

  it("group event — returns single group header line with active state", () => {
    const event: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "UI Setup",
      isActiveOnStart: true,
      children: [],
      sid: 200,
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ['group "UI Setup" (active)']);
  });

  it("group event (disabled, inactive) — returns header with [DISABLED] and (inactive)", () => {
    const event: GroupEvent = {
      eventType: "group",
      disabled: true,
      title: "Debug",
      isActiveOnStart: false,
      children: [],
      sid: 700,
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ['group "Debug" [DISABLED] (inactive)']);
  });

  it("block event — returns header + when: condition + do: action lines", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "ScoreText", sid: 2, parameters: { text: "0" } }],
      sid: 100,
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["block", "  when: System.on-start-of-layout()", "  do: ScoreText.set-text(text=0)"]);
  });

  it("block event WITH children — returns ONLY own header/when:/do: lines, no child content", () => {
    const child: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "is-visible", objectClass: "Sprite", sid: 3 }],
      actions: [{ id: "destroy", objectClass: "Sprite", sid: 4 }],
      sid: 101,
    };
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "0" } }],
      sid: 100,
      children: [child],
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    // Own lines only: header + when: + do:
    assert.deepEqual(lines, ["block", "  when: System.on-start-of-layout()", "  do: Label.set-text(text=0)"]);
    // Must not contain child content
    assert.notInclude(lines.join("\n"), "Sprite");
    assert.notInclude(lines.join("\n"), "is-visible");
    assert.notInclude(lines.join("\n"), "destroy");
  });

  it("block event with [OR] flag — returns 'block [OR]' header", () => {
    const event = {
      eventType: "block" as const,
      conditions: [{ id: "on-tap-object", objectClass: "Touch", sid: 1, parameters: { object: "Btn" } }],
      actions: [],
      sid: 100,
      isOrBlock: true,
    };
    const lines = renderNodeSelf(event as BlockEvent, "", "Test", 1);
    assert.deepEqual(lines, ["block [OR]", "  when: Touch.on-tap-object(object=Btn)"]);
  });

  it("block event with [DISABLED] flag — returns 'block [DISABLED]' header", () => {
    const event = {
      eventType: "block" as const,
      conditions: [],
      actions: [],
      sid: 100,
      disabled: true,
    };
    const lines = renderNodeSelf(event as BlockEvent, "", "Test", 1);
    assert.deepEqual(lines, ["block [DISABLED]"]);
  });

  it("block event with disabled condition — condition gets [DISABLED] prefix", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, [
      "block",
      "  when: [DISABLED] GameState.compare-boolean-eventvar(name=hasCheckedTitleNewsPopup)",
    ]);
  });

  it("block event with NOT + disabled condition — both prefixes appear", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, [
      "block",
      "  when: [DISABLED] NOT GameState.compare-boolean-eventvar(name=hasCheckedTitleNewsPopup)",
    ]);
  });

  it("block event with enabled conditions — no [DISABLED] marker (regression guard)", () => {
    // disabled: false and disabled omitted should both render bare.
    const event = {
      eventType: "block" as const,
      conditions: [
        { id: "on-start-of-layout", objectClass: "System", sid: 1 },
        { id: "is-visible", objectClass: "Sprite", sid: 2, disabled: false },
      ],
      actions: [],
      sid: 100,
    } as unknown as BlockEvent;
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["block", "  when: System.on-start-of-layout()", "  when: Sprite.is-visible()"]);
  });

  it("block event with comment action — no 'do:' prefix, multi-line indented", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [
        { type: "comment", text: "First line\nSecond line" },
        { id: "destroy", objectClass: "Sprite", sid: 4 },
      ],
      sid: 100,
    };
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, [
      "block",
      "  when: System.on-start-of-layout()",
      "  // First line",
      "  // Second line",
      "  do: Sprite.destroy()",
    ]);
  });

  it("function-block event — returns header + do: action line", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, [
      'function getScore(level: number = 1, name: string = "") -> number',
      "  do: Label.set-text(text=0)",
    ]);
  });

  it("async function-block — header starts with 'async function'", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["async function loadData() -> none"]);
  });

  it("function-block with copy-picked flag — appends [copy-picked]", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["function processItems() -> none [copy-picked]"]);
  });

  it("function-block with category only — appends [category: X]", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["function doStuff() -> none [category: MyCategory]"]);
  });

  it("function-block with description only — appends '-- desc'", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["function doStuff() -> none -- Some description"]);
  });

  it("function-block with both category and description — appends both", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["function doStuff() -> none [category: MyCategory] -- Some description"]);
  });

  it("function-block with copy-picked, category, and description — all three flags", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["function processItems() -> none [copy-picked] [category: X] -- desc"]);
  });

  it("custom-ace-block event — returns header line", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, ["ace MyPlugin.IsReady(id: number = 0) -> boolean"]);
  });

  it("custom-ace-block with copy-picked, category, and description", () => {
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
    const lines = renderNodeSelf(event, "", "Test", 1);
    assert.deepEqual(lines, [
      "ace SlashAttackers.slashAttack() -> none [copy-picked] [category: SlashAttackers] -- Implementation of a single attack",
    ]);
  });

  it("indentation — all own lines are prefixed with the given indent", () => {
    const event: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "destroy", objectClass: "Sprite", sid: 2 }],
      sid: 100,
    };
    const lines = renderNodeSelf(event, "  ", "Test", 1);
    assert.deepEqual(lines, [
      "  block",
      "    when: System.on-start-of-layout()",
      "    do: Sprite.destroy()",
    ]);
  });

  it("indentation — include and comment lines also receive the prefix", () => {
    const include: IncludeEvent = { eventType: "include", includeSheet: "CommonEvents" };
    const comment: CommentEvent = { eventType: "comment", text: "First line\nSecond line" };
    assert.deepEqual(renderNodeSelf(include, "    ", "Test", 1), ["    include CommonEvents"]);
    assert.deepEqual(renderNodeSelf(comment, "    ", "Test", 1), ["    // First line", "    // Second line"]);
  });

  // eventNumber threading: renderNodeSelf passes `eventNumber` to formatAction,
  // which embeds it in the cross-reference comment for multi-line script actions.
  // A multi-line script action produces `// → Sheet_Event<N>_Act<I>` in the output,
  // so we can assert the exact eventNumber shows up.
  it("eventNumber threading — multi-line script action cross-ref embeds the eventNumber", () => {
    const scriptAction: ScriptAction = {
      type: "script",
      language: "typescript",
      script: ["const x = 1;", "console.log(x);"],
    };
    const event: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [scriptAction],
      sid: 100,
    };
    const lines7 = renderNodeSelf(event, "", "MySheet", 7);
    const joined7 = lines7.join("\n");
    assert.include(joined7, "MySheet_Event7_Act1");

    const lines42 = renderNodeSelf(event, "", "MySheet", 42);
    const joined42 = lines42.join("\n");
    assert.include(joined42, "MySheet_Event42_Act1");
  });
});

// ---------------------------------------------------------------------------
// renderSubtree — new seam added in P1
// ---------------------------------------------------------------------------

describe("renderSubtree", () => {
  it("two sibling top-level events — single blank line between them, none trailing", () => {
    const comment: CommentEvent = { eventType: "comment", text: "Setup" };
    const block: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "hi" } }],
      sid: 100,
    };
    const { lines } = renderSubtree([comment, block], "Test", 1);
    assert.deepEqual(lines, [
      "// Setup",
      "",
      "block",
      "  when: System.on-start-of-layout()",
      "  do: Label.set-text(text=hi)",
    ]);
  });

  it("block with actions AND children — blank line between actions and first child", () => {
    const child: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "is-visible", objectClass: "Sprite", sid: 3 }],
      actions: [{ id: "destroy", objectClass: "Sprite", sid: 4 }],
      sid: 101,
    };
    const parent: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "0" } }],
      sid: 100,
      children: [child],
    };
    const { lines } = renderSubtree([parent], "Test", 1);
    assert.deepEqual(lines, [
      "block",
      "  when: System.on-start-of-layout()",
      "  do: Label.set-text(text=0)",
      "",
      "  block",
      "    when: Sprite.is-visible()",
      "    do: Sprite.destroy()",
    ]);
  });

  it("block with conditions only (no actions) AND children — blank line before first child", () => {
    // Conditions count as content; a blank is still inserted before the first child.
    const child: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "is-visible", objectClass: "Sprite", sid: 3 }],
      actions: [{ id: "destroy", objectClass: "Sprite", sid: 4 }],
      sid: 101,
    };
    const parent: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-end-of-layout", objectClass: "System", sid: 1 }],
      actions: [],
      sid: 100,
      children: [child],
    };
    const { lines } = renderSubtree([parent], "Test", 1);
    assert.deepEqual(lines, [
      "block",
      "  when: System.on-end-of-layout()",
      "",
      "  block",
      "    when: Sprite.is-visible()",
      "    do: Sprite.destroy()",
    ]);
  });

  it("group with children — children follow with NO blank separator before the first child", () => {
    const child: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: '"hello"' } }],
      sid: 100,
    };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "UI Setup",
      isActiveOnStart: true,
      children: [child],
      sid: 200,
    };
    const { lines } = renderSubtree([group], "Test", 1);
    // Group header is immediately followed by indented child — no blank line in between
    assert.deepEqual(lines, [
      'group "UI Setup" (active)',
      "  block",
      "    when: System.on-start-of-layout()",
      '    do: Label.set-text(text="hello")',
    ]);
    // Confirm no blank line appears anywhere
    assert.notInclude(lines, "");
  });

  it("dslLineNumber — startLine=1: events' index dslLineNumber matches actual line positions", () => {
    // event 0: comment "Setup" → 1 line (line 1)
    // blank separator                    (line 2)
    // event 1: block with 1 cond + 1 act → starts at line 3
    const comment: CommentEvent = { eventType: "comment", text: "Setup" };
    const block: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "on-start-of-layout", objectClass: "System", sid: 1 }],
      actions: [{ id: "set-text", objectClass: "Label", sid: 2, parameters: { text: "0" } }],
      sid: 100,
    };
    const { lines, index } = renderSubtree([comment, block], "Test", 1);

    // Verify the actual positions in the lines array (0-indexed in array, 1-indexed in DSL)
    assert.equal(lines[0], "// Setup"); // line 1
    assert.equal(lines[1], ""); // blank
    assert.equal(lines[2], "block"); // line 3

    assert.equal(index.length, 2);
    assert.equal(index[0].dslLineNumber, 1); // comment at line 1
    assert.equal(index[1].dslLineNumber, 3); // block at line 3
  });

  it("dslLineNumber — non-1 startLine offsets all index entries", () => {
    // Simulate that the sheet header already consumed lines 1-3, so events start at line 4.
    const comment: CommentEvent = { eventType: "comment", text: "A note" };
    const block: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 100,
    };
    const { index } = renderSubtree([comment, block], "Test", 4);

    // comment at line 4; blank at 5; block at line 6
    assert.equal(index[0].dslLineNumber, 4);
    assert.equal(index[1].dslLineNumber, 6);
  });

  it("dslLineNumber — multi-line comment shifts subsequent event's line number correctly", () => {
    // comment with 3 lines (lines 1-3) + blank (4) → block at 5
    const comment: CommentEvent = {
      eventType: "comment",
      text: "Line 1\nLine 2\nLine 3",
    };
    const block: BlockEvent = {
      eventType: "block",
      conditions: [{ id: "test", objectClass: "System", sid: 1 }],
      actions: [],
      sid: 100,
    };
    const { index } = renderSubtree([comment, block], "Test", 1);
    assert.equal(index[0].dslLineNumber, 1);
    assert.equal(index[1].dslLineNumber, 5);
  });

  it("index entry fields — eventNumber, jsonPath, sid, description are populated correctly", () => {
    const variable: EventSheetVariable = {
      eventType: "variable",
      name: "count",
      type: "number",
      initialValue: "0",
      isStatic: false,
      isConstant: false,
      sid: 1,
    };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "MyGroup",
      isActiveOnStart: true,
      children: [],
      sid: 200,
    };
    const block: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 100,
    };
    const { index } = renderSubtree([variable, group, block], "Test", 1);

    assert.equal(index.length, 3);

    // variable: non-counting, no sid in description but has sid field
    assert.equal(index[0].jsonPath, "events[0]");
    assert.equal(index[0].eventNumber, null);
    assert.equal(index[0].sid, 1);
    assert.equal(index[0].description, "var count: number = 0");

    // group: counting (eventNumber 1)
    assert.equal(index[1].jsonPath, "events[1]");
    assert.equal(index[1].eventNumber, 1);
    assert.equal(index[1].sid, 200);
    assert.equal(index[1].description, 'group "MyGroup"');

    // block: counting (eventNumber 2, follows group which was 1)
    assert.equal(index[2].jsonPath, "events[2]");
    assert.equal(index[2].eventNumber, 2);
    assert.equal(index[2].sid, 100);
    assert.equal(index[2].description, "block");
  });

  it("index entry jsonPath — nested children get correct paths", () => {
    const child: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 101,
    };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "MyGroup",
      isActiveOnStart: true,
      children: [child],
      sid: 200,
    };
    const { index } = renderSubtree([group], "Test", 1);

    assert.equal(index.length, 2);
    assert.equal(index[0].jsonPath, "events[0]");
    assert.equal(index[1].jsonPath, "events[0].children[0]");
  });

  it("index entry jsonPath — deeply nested (group > group > block) yields correct chain", () => {
    // Ported from DslIndexEntry generation: block inside group inside group.
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
    const { index } = renderSubtree([outerGroup], "Test", 1);

    assert.equal(index.length, 3);
    assert.equal(index[0].jsonPath, "events[0]");
    assert.equal(index[1].jsonPath, "events[0].children[0]");
    assert.equal(index[2].jsonPath, "events[0].children[0].children[0]");
  });

  it("index entry description — correct format for each event type", () => {
    // Ported from DslIndexEntry generation — verifies description strings for all types.
    const include: IncludeEvent = { eventType: "include", includeSheet: "OtherSheet" };
    const comment1: CommentEvent = { eventType: "comment", text: "A note" };
    const comment2: CommentEvent = { eventType: "comment", text: "Line one\nLine two" };
    const variable: EventSheetVariable = {
      eventType: "variable",
      name: "hp",
      type: "number",
      initialValue: "100",
      isStatic: false,
      isConstant: false,
      sid: 1,
    };
    const block: BlockEvent = { eventType: "block", conditions: [], actions: [], sid: 10 };
    const orBlock: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [],
      sid: 11,
      isOrBlock: true,
    } as BlockEvent;
    const grp: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Grp",
      isActiveOnStart: true,
      children: [],
      sid: 12,
    };
    const fnBlock: FunctionBlockEvent = {
      eventType: "function-block",
      functionName: "doStuff",
      functionReturnType: "none",
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [],
      conditions: [],
      actions: [],
      sid: 13,
    };
    const aceBlock: CustomAceBlockEvent = {
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
    };

    const { index } = renderSubtree(
      [include, comment1, comment2, variable, block, orBlock, grp, fnBlock, aceBlock],
      "T",
      1,
    );

    assert.equal(index[0].description, "include OtherSheet");
    assert.equal(index[1].description, "// A note");
    assert.equal(index[2].description, "// Line one..."); // multi-line truncated
    assert.equal(index[3].description, "var hp: number = 100");
    assert.equal(index[4].description, "block");
    assert.equal(index[5].description, "block [OR]");
    assert.equal(index[6].description, 'group "Grp"');
    assert.equal(index[7].description, "function doStuff()");
    assert.equal(index[8].description, "ace Plug.Check()");
  });

  it("index entry eventNumber — non-counting events get null; counting events are sequential", () => {
    // Ported from DslIndexEntry generation: variable + block1 + block2 inside a group.
    const variable: EventSheetVariable = {
      eventType: "variable",
      name: "count",
      type: "number",
      initialValue: "0",
      isStatic: false,
      isConstant: false,
      sid: 1,
    };
    const block1: BlockEvent = { eventType: "block", conditions: [], actions: [], sid: 100 };
    const block2: BlockEvent = { eventType: "block", conditions: [], actions: [], sid: 101 };
    const group: GroupEvent = {
      eventType: "group",
      disabled: false,
      title: "Numbering",
      isActiveOnStart: true,
      children: [variable, block1, block2],
      sid: 200,
    };

    const { index } = renderSubtree([group], "Test", 1);

    // group=1, variable=null, block1=2, block2=3
    assert.equal(index[0].eventNumber, 1); // group
    assert.equal(index[1].eventNumber, null); // variable
    assert.equal(index[2].eventNumber, 2); // block1
    assert.equal(index[3].eventNumber, 3); // block2
  });

  it("single empty event list — returns empty lines and empty index", () => {
    const { lines, index } = renderSubtree([], "Test", 1);
    assert.deepEqual(lines, []);
    assert.deepEqual(index, []);
  });
});
