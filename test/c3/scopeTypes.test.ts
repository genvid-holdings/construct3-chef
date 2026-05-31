import { describe, it } from "mocha";
import { assert } from "chai";
import { type ScopeSegment } from "@genvid/c3source";
import { toPascalCase, deriveTypeName, collectUniqueSegments, assignTypeNames } from "../../src/c3/generators.js";

describe("toPascalCase", () => {
  it("capitalizes first letter of single word", () => {
    assert.equal(toPascalCase("hello"), "Hello");
  });

  it("capitalizes each word separated by spaces", () => {
    assert.equal(toPascalCase("Generic Functions Events"), "GenericFunctionsEvents");
  });

  it("handles camelCase input (capitalizes first letter)", () => {
    assert.equal(toPascalCase("spawnWorldInstance"), "SpawnWorldInstance");
  });

  it("splits on dots and other non-alphanumeric chars", () => {
    assert.equal(toPascalCase("MyObject.DoSomething"), "MyObjectDoSomething");
  });

  it("handles multiple separators", () => {
    assert.equal(toPascalCase("foo--bar__baz"), "FooBarBaz");
  });

  it("handles empty string", () => {
    assert.equal(toPascalCase(""), "");
  });
});

describe("deriveTypeName", () => {
  it('derives Root_Vars for "root"', () => {
    assert.equal(deriveTypeName("root"), "Root_Vars");
  });

  it("derives group type name", () => {
    assert.equal(deriveTypeName('group "Generic Functions Events"'), "GenericFunctionsEvents_Vars");
  });

  it("derives function params type name", () => {
    assert.equal(deriveTypeName("fn spawnWorldInstance params"), "SpawnWorldInstance_Params");
  });

  it("derives function body vars type name", () => {
    assert.equal(deriveTypeName("fn GenerateCredits"), "GenerateCredits_Vars");
  });

  it("derives ACE params type name", () => {
    assert.equal(deriveTypeName("MyObject.DoSomething params"), "MyObjectDoSomething_Params");
  });

  it("derives ACE body vars type name", () => {
    assert.equal(deriveTypeName("MyObject.DoSomething"), "MyObjectDoSomething_Vars");
  });

  it("handles group with special characters", () => {
    assert.equal(deriveTypeName('group "Not Enough Credits Modal"'), "NotEnoughCreditsModal_Vars");
  });
});

describe("collectUniqueSegments", () => {
  const rootSeg: ScopeSegment = {
    label: "root",
    scopeKey: "root",
    vars: [{ name: "x", type: "number" }],
  };
  const groupSeg: ScopeSegment = {
    label: 'group "A"',
    scopeKey: 'root > group "A"',
    vars: [{ name: "y", type: "string" }],
  };

  it("deduplicates segments by scopeKey", () => {
    const scripts = [{ scopeSegments: [rootSeg, groupSeg] }, { scopeSegments: [rootSeg, groupSeg] }] as any[];

    const result = collectUniqueSegments(scripts);
    assert.equal(result.length, 2);
    assert.equal(result[0].scopeKey, "root");
    assert.equal(result[1].scopeKey, 'root > group "A"');
  });

  it("preserves first-encountered order", () => {
    const groupB: ScopeSegment = {
      label: 'group "B"',
      scopeKey: 'root > group "B"',
      vars: [{ name: "z", type: "boolean" }],
    };

    const scripts = [{ scopeSegments: [rootSeg, groupSeg] }, { scopeSegments: [rootSeg, groupB] }] as any[];

    const result = collectUniqueSegments(scripts);
    assert.equal(result.length, 3);
    assert.equal(result[0].label, "root");
    assert.equal(result[1].label, 'group "A"');
    assert.equal(result[2].label, 'group "B"');
  });

  it("returns empty array for scripts with no segments", () => {
    const scripts = [{ scopeSegments: [] }, { scopeSegments: [] }] as any[];
    const result = collectUniqueSegments(scripts);
    assert.equal(result.length, 0);
  });
});

describe("assignTypeNames", () => {
  it("assigns type names from labels", () => {
    const segments: ScopeSegment[] = [
      { label: "root", scopeKey: "root", vars: [{ name: "x", type: "number" }] },
      { label: 'group "MyGroup"', scopeKey: 'root > group "MyGroup"', vars: [{ name: "y", type: "string" }] },
      {
        label: "fn foo params",
        scopeKey: 'root > group "MyGroup" > fn foo params',
        vars: [{ name: "p", type: "number" }],
      },
    ];

    const names = assignTypeNames(segments);
    assert.equal(names.get("root"), "Root_Vars");
    assert.equal(names.get('root > group "MyGroup"'), "MyGroup_Vars");
    assert.equal(names.get('root > group "MyGroup" > fn foo params'), "Foo_Params");
  });

  it("resolves collisions by prepending parent context", () => {
    const segments: ScopeSegment[] = [
      {
        label: 'group "Init"',
        scopeKey: 'root > group "Init"',
        vars: [{ name: "a", type: "number" }],
      },
      {
        label: 'group "Init"',
        scopeKey: 'root > group "Login" > group "Init"',
        vars: [{ name: "b", type: "string" }],
      },
    ];

    const names = assignTypeNames(segments);
    // First one gets the base name
    assert.equal(names.get('root > group "Init"'), "Init_Vars");
    // Second one gets parent prepended
    assert.equal(names.get('root > group "Login" > group "Init"'), "Login_Init_Vars");
  });

  it("falls back to counter suffix when parent prepend still collides", () => {
    // Contrived: two segments at different paths but same parent name
    const segments: ScopeSegment[] = [
      {
        label: 'group "X"',
        scopeKey: 'root > group "Parent" > group "X"',
        vars: [{ name: "a", type: "number" }],
      },
      {
        label: 'group "X"',
        scopeKey: 'root > group "Parent" > group "Other" > group "X"',
        vars: [{ name: "b", type: "string" }],
      },
    ];

    const names = assignTypeNames(segments);
    const name1 = names.get('root > group "Parent" > group "X"');
    const name2 = names.get('root > group "Parent" > group "Other" > group "X"');
    // Both resolve differently
    assert.notEqual(name1, name2);
    // Both contain "X" in the name
    assert.include(name1!, "X");
    assert.include(name2!, "X");
  });

  it("handles single segment", () => {
    const segments: ScopeSegment[] = [{ label: "root", scopeKey: "root", vars: [{ name: "x", type: "number" }] }];
    const names = assignTypeNames(segments);
    assert.equal(names.get("root"), "Root_Vars");
  });

  it("handles empty segments array", () => {
    const names = assignTypeNames([]);
    assert.equal(names.size, 0);
  });
});
