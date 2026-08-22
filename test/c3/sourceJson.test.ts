import { describe, it, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeSourceJson } from "../../src/c3/sourceJson.js";

describe("writeSourceJson", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes an object with tab indentation and no trailing newline", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "source-json-"));
    const filePath = path.join(tmpDir, "sheet.json");

    writeSourceJson(filePath, { name: "Foo", value: 1 });

    const buf = readFileSync(filePath);
    const lastByte = buf[buf.length - 1];
    assert.strictEqual(lastByte, 0x7d, "last byte should be '}' (0x7d), not a trailing newline");

    const text = buf.toString("utf8");
    assert.include(text, '\n\t"name": "Foo"', "should be tab-indented");
    assert.strictEqual(text, JSON.stringify({ name: "Foo", value: 1 }, null, "\t"));
  });

  it("writes an array with tab indentation and no trailing newline", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "source-json-"));
    const filePath = path.join(tmpDir, "list.json");

    writeSourceJson(filePath, [{ id: 1 }, { id: 2 }]);

    const buf = readFileSync(filePath);
    const lastByte = buf[buf.length - 1];
    assert.strictEqual(lastByte, 0x5d, "last byte should be ']' (0x5d), not a trailing newline");

    const text = buf.toString("utf8");
    assert.include(text, '\n\t{\n\t\t"id": 1', "should be tab-indented");
    assert.strictEqual(text, JSON.stringify([{ id: 1 }, { id: 2 }], null, "\t"));
  });
});
