import { describe, it, after } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateSidRegistry } from "../../src/c3/generators.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..", "..", "..");

describe("generateSidRegistry", () => {
  // ─── Fixture-based unit tests ───

  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "burbank-sid-registry-"));
    tmpDirs.push(dir);
    return dir;
  }

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function readRegistry(projectDir: string): string[] {
    const outPath = path.join(projectDir, "extracted", "sid-registry.txt");
    assert.isTrue(existsSync(outPath), `sid-registry.txt should exist at ${outPath}`);
    return readFileSync(outPath, "utf-8").split("\n");
  }

  function parseDataLines(lines: string[]): Array<{ sid: number; sourceFile: string; location: string }> {
    return lines
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => {
        const parts = l.split("\t");
        assert.equal(parts.length, 3, `Each data line must have 3 tab-separated columns: "${l}"`);
        return { sid: Number(parts[0]), sourceFile: parts[1], location: parts[2] };
      });
  }

  it("produces a file with header and tab-separated entries", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
    writeFileSync(
      path.join(dir, "eventSheets", "TestSheet.json"),
      JSON.stringify({
        name: "TestSheet",
        sid: 100000000000001,
        events: [
          {
            eventType: "block",
            sid: 100000000000002,
            conditions: [{ id: "on-start", objectClass: "System", sid: 100000000000003, parameters: {} }],
            actions: [],
          },
        ],
      }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const lines = readRegistry(dir);

    // Header lines
    assert.include(lines[0], "# SID Registry");
    // Data lines
    const entries = parseDataLines(lines);
    assert.isAbove(entries.length, 0, "should have at least one entry");
    for (const e of entries) {
      assert.isNumber(e.sid, "sid must be a number");
      assert.isAbove(e.sid, 0, "sid must be positive");
      assert.isString(e.sourceFile, "sourceFile must be a string");
      assert.isString(e.location, "location must be a string");
    }
  });

  it("entries are sorted by SID ascending", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
    writeFileSync(
      path.join(dir, "eventSheets", "SortTest.json"),
      JSON.stringify({
        name: "SortTest",
        sid: 300000000000003,
        events: [
          { eventType: "block", sid: 100000000000001, conditions: [], actions: [] },
          { eventType: "block", sid: 200000000000002, conditions: [], actions: [] },
        ],
      }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const entries = parseDataLines(readRegistry(dir));
    for (let i = 1; i < entries.length; i++) {
      assert.isAtMost(entries[i - 1].sid, entries[i].sid, "entries should be in ascending SID order");
    }
  });

  it("eventSheet root SID uses location 'sheet'", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
    const rootSid = 999000000000001;
    writeFileSync(
      path.join(dir, "eventSheets", "RootTest.json"),
      JSON.stringify({ name: "RootTest", sid: rootSid, events: [] }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const entries = parseDataLines(readRegistry(dir));
    const rootEntry = entries.find((e) => e.sid === rootSid);
    assert.isOk(rootEntry, "root SID should appear");
    assert.equal(rootEntry!.location, "sheet");
  });

  it("objectType root SID uses location 'objectType'", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "objectTypes"), { recursive: true });
    const rootSid = 888000000000001;
    writeFileSync(
      path.join(dir, "objectTypes", "MyObj.json"),
      JSON.stringify({ name: "MyObj", "plugin-id": "Json", sid: rootSid }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const entries = parseDataLines(readRegistry(dir));
    const rootEntry = entries.find((e) => e.sid === rootSid);
    assert.isOk(rootEntry, "objectType root SID should appear");
    assert.equal(rootEntry!.location, "objectType");
  });

  it("handles objectType instVar SIDs with correct location", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "objectTypes"), { recursive: true });
    const instVarSid = 777000000000001;
    writeFileSync(
      path.join(dir, "objectTypes", "MyData.json"),
      JSON.stringify({
        name: "MyData",
        "plugin-id": "Json",
        sid: 777000000000000,
        instanceVariables: [{ name: "myVar", type: "string", desc: "", show: true, sid: instVarSid }],
      }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const entries = parseDataLines(readRegistry(dir));
    const instVarEntry = entries.find((e) => e.sid === instVarSid);
    assert.isOk(instVarEntry, "instVar SID should appear");
    assert.include(instVarEntry!.location, "instanceVariables");
  });

  it("handles nested eventSheet SIDs (conditions inside events)", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
    const condSid = 555000000000001;
    writeFileSync(
      path.join(dir, "eventSheets", "NestedTest.json"),
      JSON.stringify({
        name: "NestedTest",
        sid: 555000000000000,
        events: [
          {
            eventType: "block",
            sid: 555000000000002,
            conditions: [{ id: "on-start", objectClass: "System", sid: condSid, parameters: {} }],
            actions: [],
          },
        ],
      }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const entries = parseDataLines(readRegistry(dir));
    const condEntry = entries.find((e) => e.sid === condSid);
    assert.isOk(condEntry, "condition SID should appear in registry");
    assert.include(condEntry!.location, "conditions");
  });

  it("scans subdirectories of eventSheets and objectTypes", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "eventSheets", "Login"), { recursive: true });
    mkdirSync(path.join(dir, "objectTypes", "Heroes"), { recursive: true });
    const sheetSid = 444000000000001;
    const objSid = 444000000000002;
    writeFileSync(
      path.join(dir, "eventSheets", "Login", "LoginEvents.json"),
      JSON.stringify({ name: "LoginEvents", sid: sheetSid, events: [] }),
      "utf-8",
    );
    writeFileSync(
      path.join(dir, "objectTypes", "Heroes", "HeroData.json"),
      JSON.stringify({ name: "HeroData", "plugin-id": "Json", sid: objSid }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const entries = parseDataLines(readRegistry(dir));
    const sidValues = entries.map((e) => e.sid);
    assert.include(sidValues, sheetSid, "sheet SID from subdirectory should appear");
    assert.include(sidValues, objSid, "objectType SID from subdirectory should appear");
    const sheetEntry = entries.find((e) => e.sid === sheetSid);
    assert.include(sheetEntry!.sourceFile, "eventSheets/Login/LoginEvents.json");
  });

  it("no duplicate SIDs for the same JSON object", () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
    const sid = 333000000000001;
    writeFileSync(
      path.join(dir, "eventSheets", "DedupTest.json"),
      JSON.stringify({ name: "DedupTest", sid, events: [] }),
      "utf-8",
    );

    generateSidRegistry(dir, path.join(dir, "extracted"));
    const entries = parseDataLines(readRegistry(dir));
    const matching = entries.filter((e) => e.sid === sid);
    assert.equal(matching.length, 1, "each SID should appear exactly once per occurrence");
  });

  // ─── Integration test against the real project ───

  const hasProjectRoot = existsSync(path.join(projectRoot, "eventSheets"));

  (hasProjectRoot ? it : it.skip)("integration: generates sid-registry.txt for the real project", function () {
    // This test uses the actual project root — may be slow on large projects
    this.timeout(30000);

    generateSidRegistry(projectRoot, path.join(projectRoot, "extracted"));

    const outPath = path.join(projectRoot, "extracted", "sid-registry.txt");
    assert.isTrue(existsSync(outPath), "extracted/sid-registry.txt should exist");

    const lines = readFileSync(outPath, "utf-8").split("\n");
    const entries = parseDataLines(lines);

    assert.isAbove(entries.length, 100, "real project should have many SID entries");

    // All SIDs parse as numbers
    for (const e of entries) {
      assert.isNumber(e.sid);
      assert.isFalse(isNaN(e.sid), `SID should be a valid number: "${e.sid}"`);
    }

    // Entries are sorted ascending
    for (let i = 1; i < entries.length; i++) {
      assert.isAtMost(
        entries[i - 1].sid,
        entries[i].sid,
        `entries should be sorted: ${entries[i - 1].sid} > ${entries[i].sid}`,
      );
    }

    // Source files all start with eventSheets/ or objectTypes/
    for (const e of entries) {
      assert.isTrue(
        e.sourceFile.startsWith("eventSheets/") || e.sourceFile.startsWith("objectTypes/"),
        `sourceFile should be relative to project root: "${e.sourceFile}"`,
      );
    }
  });

  (hasProjectRoot ? it : it.skip)("integration: known objectType SIDs appear in registry", function () {
    this.timeout(10000);

    // AJAX.json has sid 524908132553448 at the root
    generateSidRegistry(projectRoot, path.join(projectRoot, "extracted"));
    const outPath = path.join(projectRoot, "extracted", "sid-registry.txt");
    const lines = readFileSync(outPath, "utf-8").split("\n");
    const entries = parseDataLines(lines);

    const ajaxRootSid = 524908132553448;
    const ajaxEntry = entries.find((e) => e.sid === ajaxRootSid);
    assert.isOk(ajaxEntry, `AJAX objectType root SID ${ajaxRootSid} should appear in registry`);
    assert.equal(ajaxEntry!.location, "objectType");
    assert.include(ajaxEntry!.sourceFile, "AJAX.json");
  });
});
