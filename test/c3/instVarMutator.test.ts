import { describe, it, beforeEach } from "mocha";
import { assert } from "chai";
import { addInstVarsToObjectType, addInstVarsToLayout, addInstVarsToTypesDts } from "../../src/c3/instVarMutator.js";
import { freshSidGen, type SidGenerator } from "../../src/c3/sidUtils.js";

// ─── addInstVarsToObjectType ───

describe("addInstVarsToObjectType", () => {
  let sidGen: SidGenerator;
  beforeEach(() => {
    sidGen = freshSidGen();
  });

  it("adds new instance variables to objectType", () => {
    const objectType = {
      name: "MyObject",
      instanceVariables: [],
    };
    const added = addInstVarsToObjectType(sidGen, objectType, [
      { name: "count", type: "number" as const },
      { name: "label", type: "string" as const },
    ]);
    assert.deepEqual(added, ["count", "label"]);
    assert.equal(objectType.instanceVariables.length, 2);
    assert.equal(objectType.instanceVariables[0].name, "count");
    assert.equal(objectType.instanceVariables[0].type, "number");
    assert.equal(objectType.instanceVariables[0].desc, "");
    assert.equal(objectType.instanceVariables[0].show, true);
    assert.notEqual(objectType.instanceVariables[0].sid, 0);
  });

  it("skips variables that already exist", () => {
    const objectType = {
      name: "MyObject",
      instanceVariables: [{ name: "existing", type: "string", desc: "", show: true, sid: 12345 }],
    };
    const added = addInstVarsToObjectType(sidGen, objectType, [
      { name: "existing", type: "string" as const },
      { name: "newVar", type: "number" as const },
    ]);
    assert.deepEqual(added, ["newVar"]);
    assert.equal(objectType.instanceVariables.length, 2);
    // Original SID preserved
    assert.equal(objectType.instanceVariables[0].sid, 12345);
  });

  it("returns empty array when all vars already exist", () => {
    const objectType = {
      name: "MyObject",
      instanceVariables: [{ name: "count", type: "number", desc: "", show: true, sid: 123 }],
    };
    const added = addInstVarsToObjectType(sidGen, objectType, [{ name: "count", type: "number" as const }]);
    assert.deepEqual(added, []);
    assert.equal(objectType.instanceVariables.length, 1);
  });
});

// ─── addInstVarsToLayout ───

describe("addInstVarsToLayout", () => {
  it("adds defaults to nonworld instances", () => {
    const layout = {
      layers: [],
      "nonworld-instances": [
        { type: "MyJSON", instanceVariables: {}, uid: 1, sid: 100 },
        { type: "OtherJSON", instanceVariables: {}, uid: 2, sid: 200 },
      ],
    };
    const count = addInstVarsToLayout(layout, "MyJSON", [
      { name: "count", type: "number" as const },
      { name: "label", type: "string" as const },
    ]);
    assert.equal(count, 1);
    assert.deepEqual(layout["nonworld-instances"][0].instanceVariables, {
      count: 0,
      label: "",
    });
    // Other type untouched
    assert.deepEqual(layout["nonworld-instances"][1].instanceVariables, {});
  });

  it("adds defaults to world instances in layers", () => {
    const layout = {
      layers: [
        {
          instances: [{ type: "MySprite", instanceVariables: { existing: "hello" }, uid: 1, sid: 100 }],
        },
      ],
    };
    const count = addInstVarsToLayout(layout, "MySprite", [{ name: "flag", type: "boolean" as const }]);
    assert.equal(count, 1);
    assert.deepEqual(layout.layers[0].instances![0].instanceVariables, {
      existing: "hello",
      flag: false,
    });
  });

  it("recurses into subLayers", () => {
    const layout = {
      layers: [
        {
          subLayers: [
            {
              instances: [{ type: "MyJSON", instanceVariables: {}, uid: 3, sid: 300 }],
            },
          ],
        },
      ],
    };
    const count = addInstVarsToLayout(layout, "MyJSON", [{ name: "value", type: "number" as const }]);
    assert.equal(count, 1);
    assert.deepEqual(layout.layers[0].subLayers![0].instances![0].instanceVariables, {
      value: 0,
    });
  });

  it("skips existing instanceVariables", () => {
    const layout = {
      layers: [],
      "nonworld-instances": [{ type: "MyJSON", instanceVariables: { count: 42 }, uid: 1, sid: 100 }],
    };
    const count = addInstVarsToLayout(layout, "MyJSON", [
      { name: "count", type: "number" as const },
      { name: "newVar", type: "string" as const },
    ]);
    assert.equal(count, 1);
    // Existing value preserved
    assert.equal(layout["nonworld-instances"][0].instanceVariables.count, 42);
    assert.equal(layout["nonworld-instances"][0].instanceVariables.newVar, "");
  });

  it("returns 0 when type not found", () => {
    const layout = {
      layers: [],
      "nonworld-instances": [{ type: "OtherJSON", instanceVariables: {}, uid: 1, sid: 100 }],
    };
    const count = addInstVarsToLayout(layout, "MyJSON", [{ name: "x", type: "number" as const }]);
    assert.equal(count, 0);
  });
});

// ─── addInstVarsToTypesDts ───

describe("addInstVarsToTypesDts", () => {
  const sampleDts = [
    "declare namespace InstanceType {",
    "\tclass EmptyClass extends IJSONInstance {",
    "\t}",
    "\tclass WithInstVars extends ISpriteInstance {",
    "\t\tinstVars: {",
    "\t\t\texisting: string,",
    "\t\t};",
    "\t}",
    "}",
  ].join("\n");

  it("creates instVars block for class without one", () => {
    const result = addInstVarsToTypesDts(sampleDts, "EmptyClass", [
      { name: "count", type: "number" as const },
      { name: "label", type: "string" as const },
    ]);
    assert.isNotNull(result);
    assert.include(result!, "instVars: {");
    assert.include(result!, "\t\t\tcount: number,");
    assert.include(result!, "\t\t\tlabel: string,");
  });

  it("appends to existing instVars block", () => {
    const result = addInstVarsToTypesDts(sampleDts, "WithInstVars", [{ name: "newField", type: "boolean" as const }]);
    assert.isNotNull(result);
    assert.include(result!, "existing: string,");
    assert.include(result!, "newField: boolean,");
  });

  it("skips duplicate fields in existing instVars", () => {
    const result = addInstVarsToTypesDts(sampleDts, "WithInstVars", [{ name: "existing", type: "string" as const }]);
    // No change needed — all vars already exist
    assert.equal(result, sampleDts);
  });

  it("returns null for unknown class", () => {
    const result = addInstVarsToTypesDts(sampleDts, "NoSuchClass", [{ name: "x", type: "number" as const }]);
    assert.isNull(result);
  });

  it("returns unchanged content for empty newVars", () => {
    const result = addInstVarsToTypesDts(sampleDts, "EmptyClass", []);
    assert.equal(result, sampleDts);
  });
});
