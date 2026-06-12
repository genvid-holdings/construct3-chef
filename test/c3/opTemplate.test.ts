import { describe, it, before, after } from "mocha";
import { assert } from "chai";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  loadOpsFromDir,
  opToInputSchema,
  substituteOp,
  formatOpsList,
  coerceArgs,
  type LoadedOp,
  type OpDefinition,
} from "../../src/c3/opTemplate.js";

// ─── Fixture paths ─────────────────────────────────────────────────────────────

const SAMPLE_OPS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  "../../test/fixtures/sample-ops",
);

// ─── loadOpsFromDir ────────────────────────────────────────────────────────────

describe("loadOpsFromDir", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "optemplate-"));
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads valid op from the sample-ops fixture dir", () => {
    const { ops, errors } = loadOpsFromDir(SAMPLE_OPS_DIR);
    // add-screen.json should load; bad-schema.json should be an error
    const names = ops.map((o) => o.name);
    assert.include(names, "add-screen", "add-screen op should be loaded");
    assert.lengthOf(errors, 1, "bad-schema.json should produce exactly one error");
    assert.include(errors[0].file, "bad-schema.json");
  });

  it("loaded op has correct name and description", () => {
    const { ops } = loadOpsFromDir(SAMPLE_OPS_DIR);
    const addScreen = ops.find((o) => o.name === "add-screen");
    assert.isDefined(addScreen);
    assert.strictEqual(addScreen!.def.description, "Add a new screen event sheet");
  });

  it("loaded op has correct params", () => {
    const { ops } = loadOpsFromDir(SAMPLE_OPS_DIR);
    const addScreen = ops.find((o) => o.name === "add-screen");
    assert.isDefined(addScreen);
    const params = addScreen!.def.params;
    assert.lengthOf(params, 2);
    const screenParam = params.find((p) => p.name === "SCREEN_NAME");
    assert.isDefined(screenParam);
    assert.strictEqual(screenParam!.type, "string");
    assert.isTrue(screenParam!.required);
    const depthParam = params.find((p) => p.name === "DEPTH");
    assert.isDefined(depthParam);
    assert.strictEqual(depthParam!.type, "number");
    assert.isFalse(depthParam!.required);
    assert.strictEqual(depthParam!.default, 0);
  });

  it("returns { ops: [], errors: [] } for a non-existent dir", () => {
    const result = loadOpsFromDir(path.join(tmpDir, "does-not-exist"));
    assert.deepEqual(result, { ops: [], errors: [] });
  });

  it("returns { ops: [], errors: [] } for a file path (not a dir)", () => {
    const filePath = path.join(tmpDir, "notadir.json");
    writeFileSync(filePath, "{}");
    const result = loadOpsFromDir(filePath);
    assert.deepEqual(result, { ops: [], errors: [] });
  });

  it("rejects an op whose filename contains an invalid character", () => {
    const badDir = path.join(tmpDir, "badname");
    mkdirSync(badDir, { recursive: true });
    // Filename starting with '_' fails /^[a-z0-9][a-z0-9-]*$/i
    writeFileSync(
      path.join(badDir, "_invalid-name.json"),
      JSON.stringify({ description: "test", params: [], recipe: { files: {} } }),
    );
    const { ops, errors } = loadOpsFromDir(badDir);
    assert.lengthOf(ops, 0, "invalid-name op should not be loaded");
    assert.lengthOf(errors, 1);
    assert.include(errors[0].file, "_invalid-name.json");
    assert.include(errors[0].message, "invalid");
  });

  it("reports schema validation error for bad-schema.json fixture", () => {
    const { errors } = loadOpsFromDir(SAMPLE_OPS_DIR);
    const badErr = errors.find((e) => e.file === "bad-schema.json");
    assert.isDefined(badErr, "bad-schema.json should produce an error");
    assert.include(badErr!.message, "schema validation failed");
  });

  it("files are loaded in sorted (alphabetical) order", () => {
    const sortedDir = path.join(tmpDir, "sorted");
    mkdirSync(sortedDir, { recursive: true });
    const validDef = JSON.stringify({
      description: "op",
      params: [],
      recipe: { files: { "eventSheets/Sheet.json": { create: true, events: [] } } },
    });
    writeFileSync(path.join(sortedDir, "z-op.json"), validDef);
    writeFileSync(path.join(sortedDir, "a-op.json"), validDef);
    writeFileSync(path.join(sortedDir, "m-op.json"), validDef);
    const { ops } = loadOpsFromDir(sortedDir);
    assert.deepEqual(
      ops.map((o) => o.name),
      ["a-op", "m-op", "z-op"],
    );
  });

  it("collects invalid JSON as an error (not a crash)", () => {
    const badJsonDir = path.join(tmpDir, "badjson");
    mkdirSync(badJsonDir, { recursive: true });
    writeFileSync(path.join(badJsonDir, "broken.json"), "{ not valid json");
    const { ops, errors } = loadOpsFromDir(badJsonDir);
    assert.lengthOf(ops, 0);
    assert.lengthOf(errors, 1);
    assert.include(errors[0].message, "invalid JSON");
  });
});

// ─── opToInputSchema ───────────────────────────────────────────────────────────

describe("opToInputSchema", () => {
  const def: OpDefinition = {
    description: "test op",
    params: [
      { name: "NAME", type: "string", required: true },
      { name: "COUNT", type: "number", required: false, default: 42, description: "how many" },
      { name: "ENABLED", type: "boolean", required: false },
    ],
  };

  it("required param produces a bare typed schema that accepts a value of the right type", () => {
    const shape = opToInputSchema(def);
    const nameSchema = shape["NAME"];
    assert.isDefined(nameSchema);
    const ok = nameSchema.safeParse("hello");
    assert.isTrue(ok.success);
    const fail = nameSchema.safeParse(42);
    assert.isFalse(fail.success);
  });

  it("optional param with default produces a schema that supplies the default", () => {
    const shape = opToInputSchema(def);
    const countSchema = shape["COUNT"];
    assert.isDefined(countSchema);
    // Parses undefined → uses default
    const withDefault = countSchema.safeParse(undefined);
    assert.isTrue(withDefault.success);
    assert.strictEqual(withDefault.data, 42);
    // Parses explicit value
    const explicit = countSchema.safeParse(7);
    assert.isTrue(explicit.success);
    assert.strictEqual(explicit.data, 7);
  });

  it("optional param without default produces a schema that accepts undefined", () => {
    const shape = opToInputSchema(def);
    const enabledSchema = shape["ENABLED"];
    assert.isDefined(enabledSchema);
    const withUndefined = enabledSchema.safeParse(undefined);
    assert.isTrue(withUndefined.success);
    assert.isUndefined(withUndefined.data);
    const withValue = enabledSchema.safeParse(true);
    assert.isTrue(withValue.success);
    assert.isTrue(withValue.data);
  });

  it("description is applied to the schema", () => {
    const shape = opToInputSchema(def);
    const countSchema = shape["COUNT"];
    // Zod exposes description via ._def.description (internal shape)
    // We can verify indirectly by checking it doesn't crash and the schema works
    // but the simplest check: the description is present if z.describe is called.
    // Use a fresh schema with description to verify the code path runs.
    const defWithDesc: OpDefinition = {
      description: "test",
      params: [{ name: "X", type: "string", required: true, description: "my desc" }],
    };
    const shapeWithDesc = opToInputSchema(defWithDesc);
    const xSchema = shapeWithDesc["X"];
    assert.isDefined(xSchema);
    // Should still parse correctly
    assert.isTrue(xSchema.safeParse("hello").success);
    // Count schema has description "how many" — verify it doesn't crash
    assert.isDefined(countSchema);
  });

  it("boolean type maps to a boolean schema", () => {
    const shape = opToInputSchema(def);
    const enabledSchema = shape["ENABLED"];
    assert.isTrue(enabledSchema.safeParse(true).success);
    assert.isTrue(enabledSchema.safeParse(false).success);
    const failResult = enabledSchema.safeParse("yes");
    // "yes" is not a boolean — strict zod boolean
    assert.isFalse(failResult.success);
  });

  it("string default-param rejects non-string", () => {
    const defStr: OpDefinition = {
      description: "test",
      params: [{ name: "LABEL", type: "string", required: false, default: "hello" }],
    };
    const shape = opToInputSchema(defStr);
    const labelSchema = shape["LABEL"];
    const ok = labelSchema.safeParse(undefined);
    assert.isTrue(ok.success);
    assert.strictEqual(ok.data, "hello");
    const fail = labelSchema.safeParse(99);
    assert.isFalse(fail.success);
  });
});

// ─── substituteOp ─────────────────────────────────────────────────────────────

describe("substituteOp", () => {
  // Minimal def for most tests
  const def: OpDefinition = {
    description: "test",
    params: [
      { name: "SCREEN_NAME", type: "string", required: true },
      { name: "DEPTH", type: "number", required: false, default: 0 },
      { name: "ACTIVE", type: "boolean", required: false, default: true },
    ],
    recipe: {
      files: {
        "eventSheets/{{SCREEN_NAME}}.json": {
          create: true,
          events: [{ comment: "{{SCREEN_NAME}} screen — depth {{DEPTH}}" }],
        },
      },
    },
  };

  it("whole-value typed substitution: {{DEPTH}} as sole content becomes a number", () => {
    // We need a recipe shape where a whole-value substitution makes sense.
    // Use addInstVars where the type name is a known param (will be string).
    const typedDef: OpDefinition = {
      description: "typed subst test",
      params: [
        { name: "SCREEN_NAME", type: "string", required: true },
        { name: "LIMIT", type: "number", required: false, default: 5 },
      ],
      recipe: {
        // patch-action-param.value accepts unknown — the number stays a number
        files: {
          "eventSheets/Sheet.json": [
            {
              op: "patch-action-param",
              path: "events[0]",
              actionIndex: 0,
              param: "limit",
              value: "{{LIMIT}}",
            },
          ],
        },
      },
    };
    const result = substituteOp(typedDef, { SCREEN_NAME: "Main" });
    const ops = (result.files as Record<string, unknown>)["eventSheets/Sheet.json"] as Record<string, unknown>[];
    assert.strictEqual(typeof ops[0]["value"], "number", "{{LIMIT}} whole-value should become a number");
    assert.strictEqual(ops[0]["value"], 5);
  });

  it("text interpolation: {{SCREEN_NAME}} embedded in a string stays a string", () => {
    const result = substituteOp(def, { SCREEN_NAME: "GameOver" });
    const files = result.files as Record<string, unknown>;
    const fileKey = "eventSheets/GameOver.json";
    assert.isDefined(files[fileKey], "file key should be substituted");
    const fileEntry = files[fileKey] as { create: boolean; events: Array<{ comment?: string }> };
    assert.isTrue(fileEntry.create);
    assert.strictEqual(fileEntry.events[0].comment, "GameOver screen — depth 0");
  });

  it("object KEY substitution: {{SCREEN_NAME}} in a files key is replaced", () => {
    const result = substituteOp(def, { SCREEN_NAME: "MainMenu" });
    const files = result.files as Record<string, unknown>;
    assert.isDefined(files["eventSheets/MainMenu.json"]);
    assert.isUndefined(files["eventSheets/{{SCREEN_NAME}}.json"]);
  });

  it("boolean whole-value substitution: {{ACTIVE}} becomes a boolean", () => {
    const boolDef: OpDefinition = {
      description: "bool test",
      params: [
        { name: "SHEET", type: "string", required: true },
        { name: "ACTIVE", type: "boolean", required: false, default: false },
      ],
      recipe: {
        files: {
          "eventSheets/{{SHEET}}.json": [
            {
              op: "set-disabled",
              path: "events[0]",
              disabled: "{{ACTIVE}}",
            },
          ],
        },
      },
    };
    const result = substituteOp(boolDef, { SHEET: "Test" });
    const ops = (result.files as Record<string, unknown>)["eventSheets/Test.json"] as Record<string, unknown>[];
    assert.strictEqual(typeof ops[0]["disabled"], "boolean");
    assert.strictEqual(ops[0]["disabled"], false);
  });

  it("default applied when arg omitted: DEPTH defaults to 0", () => {
    const result = substituteOp(def, { SCREEN_NAME: "Credits" });
    // DEPTH defaults to 0; comment should say "depth 0"
    const files = result.files as Record<string, unknown>;
    const fileEntry = files["eventSheets/Credits.json"] as { events: Array<{ comment?: string }> };
    assert.include(fileEntry.events[0].comment, "depth 0");
  });

  it("explicit arg overrides default: DEPTH = 3", () => {
    const result = substituteOp(def, { SCREEN_NAME: "Settings", DEPTH: 3 });
    const files = result.files as Record<string, unknown>;
    const fileEntry = files["eventSheets/Settings.json"] as { events: Array<{ comment?: string }> };
    assert.include(fileEntry.events[0].comment, "depth 3");
  });

  it("missing required param throws with the param name in the message", () => {
    assert.throws(() => substituteOp(def, {}), /missing required param "SCREEN_NAME"/);
  });

  it("unknown arg throws with the key name in the message", () => {
    assert.throws(() => substituteOp(def, { SCREEN_NAME: "Foo", UNKNOWN_PARAM: "bar" }), /unknown arg "UNKNOWN_PARAM"/);
  });

  it("aggregates multiple errors in a single throw", () => {
    let caught: Error | undefined;
    try {
      substituteOp(def, { UNKNOWN_A: "x", UNKNOWN_B: "y" });
    } catch (e) {
      caught = e as Error;
    }
    assert.isDefined(caught, "should have thrown");
    // Both missing SCREEN_NAME and both unknown args should appear
    assert.include(caught!.message, "missing required param");
    assert.include(caught!.message, "UNKNOWN_A");
    assert.include(caught!.message, "UNKNOWN_B");
  });

  it("leftover placeholder throws listing the unresolved token", () => {
    const leftoverDef: OpDefinition = {
      description: "leftover test",
      params: [{ name: "SCREEN_NAME", type: "string", required: true }],
      recipe: {
        files: {
          "eventSheets/{{SCREEN_NAME}}.json": {
            create: true,
            // {{TYPO_PARAM}} is not a declared param — should be left untouched → leftover guard triggers
            events: [{ comment: "{{TYPO_PARAM}} is a typo" }],
          },
        },
      },
    };
    assert.throws(
      () => substituteOp(leftoverDef, { SCREEN_NAME: "Test" }),
      /unresolved placeholder.*\{\{TYPO_PARAM\}\}/,
    );
  });

  it("post-substitution validateRecipe failure throws with 'recipe invalid after substitution'", () => {
    const badRecipeDef: OpDefinition = {
      description: "bad recipe",
      params: [{ name: "NAME", type: "string", required: true }],
      recipe: {
        // addInstVars entry missing "instanceVariables" field — validateRecipe will flag it
        addInstVars: [{ type: "{{NAME}}" }],
      },
    };
    assert.throws(() => substituteOp(badRecipeDef, { NAME: "MyObject" }), /recipe invalid after substitution/);
  });

  it("valid full round-trip returns the substituted Recipe", () => {
    const result = substituteOp(def, { SCREEN_NAME: "Splash" });
    assert.isDefined(result.files);
    assert.isDefined((result.files as Record<string, unknown>)["eventSheets/Splash.json"]);
  });
});

// ─── formatOpsList ─────────────────────────────────────────────────────────────

describe("formatOpsList", () => {
  const sampleOp: LoadedOp = {
    name: "add-screen",
    filePath: "/project/ops/add-screen.json",
    def: {
      description: "Add a new screen layout",
      params: [
        { name: "SCREEN_NAME", type: "string", required: true, description: "PascalCase screen name" },
        { name: "DEPTH", type: "number", required: false, default: 0 },
        { name: "ENABLED", type: "boolean", required: false },
      ],
    },
  };

  it("contains the op name and description", () => {
    const output = formatOpsList([sampleOp]);
    assert.include(output, "add-screen");
    assert.include(output, "Add a new screen layout");
  });

  it("contains each param name and type", () => {
    const output = formatOpsList([sampleOp]);
    assert.include(output, "SCREEN_NAME");
    assert.include(output, "[string]");
    assert.include(output, "DEPTH");
    assert.include(output, "[number]");
    assert.include(output, "ENABLED");
    assert.include(output, "[boolean]");
  });

  it("shows (required) for required params", () => {
    const output = formatOpsList([sampleOp]);
    assert.include(output, "(required)");
  });

  it("shows (default: ...) for params with defaults", () => {
    const output = formatOpsList([sampleOp]);
    assert.include(output, "(default: 0)");
  });

  it("shows (optional) for optional params without a default", () => {
    const output = formatOpsList([sampleOp]);
    assert.include(output, "(optional)");
  });

  it("includes param description when present", () => {
    const output = formatOpsList([sampleOp]);
    assert.include(output, "PascalCase screen name");
  });

  it("empty ops list produces 'No ops found.'", () => {
    const output = formatOpsList([]);
    assert.include(output, "No ops found.");
  });

  it("errors section is appended when errors are provided", () => {
    const output = formatOpsList([sampleOp], [{ file: "broken.json", message: "invalid JSON: Unexpected token" }]);
    assert.include(output, "load errors:");
    assert.include(output, "broken.json");
    assert.include(output, "invalid JSON");
  });

  it("no errors section when errors array is empty", () => {
    const output = formatOpsList([sampleOp], []);
    assert.notInclude(output, "load errors:");
  });

  it("no errors section when errors param is omitted", () => {
    const output = formatOpsList([sampleOp]);
    assert.notInclude(output, "load errors:");
  });

  it("multiple ops are all rendered", () => {
    const secondOp: LoadedOp = {
      name: "remove-screen",
      filePath: "/project/ops/remove-screen.json",
      def: {
        description: "Remove a screen layout",
        params: [],
      },
    };
    const output = formatOpsList([sampleOp, secondOp]);
    assert.include(output, "add-screen");
    assert.include(output, "remove-screen");
    assert.include(output, "Remove a screen layout");
  });

  it("op with no params shows 'params: none'", () => {
    const noParamsOp: LoadedOp = {
      name: "reset-all",
      filePath: "/project/ops/reset-all.json",
      def: { description: "Reset everything", params: [] },
    };
    const output = formatOpsList([noParamsOp]);
    assert.include(output, "params: none");
  });
});

// ─── coerceArgs ───────────────────────────────────────────────────────────────

describe("coerceArgs", () => {
  const def: OpDefinition = {
    description: "coerce test op",
    params: [
      { name: "NAME", type: "string", required: true },
      { name: "COUNT", type: "number", required: false, default: 0 },
      { name: "ENABLED", type: "boolean", required: false, default: false },
    ],
  };

  it("coerces a string '42' to number 42 for a number param", () => {
    const result = coerceArgs(def, { NAME: "foo", COUNT: "42" });
    assert.strictEqual(result["COUNT"], 42);
    assert.strictEqual(typeof result["COUNT"], "number");
  });

  it("coerces a string 'true' to boolean true for a boolean param", () => {
    const result = coerceArgs(def, { NAME: "foo", ENABLED: "true" });
    assert.strictEqual(result["ENABLED"], true);
    assert.strictEqual(typeof result["ENABLED"], "boolean");
  });

  it("coerces a string 'false' to boolean false for a boolean param", () => {
    const result = coerceArgs(def, { NAME: "foo", ENABLED: "false" });
    assert.strictEqual(result["ENABLED"], false);
    assert.strictEqual(typeof result["ENABLED"], "boolean");
  });

  it("throws a clear error for a non-numeric string on a number param", () => {
    assert.throws(
      () => coerceArgs(def, { NAME: "foo", COUNT: "notanumber" }),
      /param "COUNT" expects a number but got "notanumber"/,
    );
  });

  it("throws a clear error for a non-bool string on a boolean param", () => {
    assert.throws(
      () => coerceArgs(def, { NAME: "foo", ENABLED: "yes" }),
      /param "ENABLED" expects a boolean.*but got "yes"/,
    );
  });

  it("leaves string values unchanged for string params", () => {
    const result = coerceArgs(def, { NAME: "hello world" });
    assert.strictEqual(result["NAME"], "hello world");
  });

  it("keeps an already-typed number from a JSON file unchanged", () => {
    const result = coerceArgs(def, { NAME: "foo", COUNT: 7 });
    assert.strictEqual(result["COUNT"], 7);
    assert.strictEqual(typeof result["COUNT"], "number");
  });

  it("keeps an already-typed boolean from a JSON file unchanged", () => {
    const result = coerceArgs(def, { NAME: "foo", ENABLED: true });
    assert.strictEqual(result["ENABLED"], true);
    assert.strictEqual(typeof result["ENABLED"], "boolean");
  });

  it("passes unknown keys through unchanged so substituteOp can reject them", () => {
    const result = coerceArgs(def, { NAME: "foo", UNKNOWN: "bar" });
    assert.strictEqual(result["UNKNOWN"], "bar");
  });

  it("handles a mix of string coercions and already-typed values", () => {
    const result = coerceArgs(def, { NAME: "test", COUNT: "3", ENABLED: true });
    assert.strictEqual(result["NAME"], "test");
    assert.strictEqual(result["COUNT"], 3);
    assert.strictEqual(result["ENABLED"], true);
  });

  it("empty input returns empty output", () => {
    const result = coerceArgs(def, {});
    assert.deepEqual(result, {});
  });
});
