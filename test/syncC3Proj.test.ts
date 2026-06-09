import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import tmp from "tmp";
import { mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectManifestDrift, detectImageDrift, deriveExpectedImageNames, type DriftEntry } from "@genvid/c3source";
import {
  inferMimeType,
  collectAllSids,
  generateSid,
  readDiskDir,
  syncFileFolder,
  applyNameDrift,
  reportImageDrift,
  runSync,
  type FileItem,
  type FileFolder,
  type NameFolder,
  type FileSectionConfig,
  type Change,
} from "../src/c3/projectSync.js";

const sampleProjectDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "construct3-chef-sample");

// Helper to create a temp directory
function createTmpDir(): string {
  return tmp.dirSync({ unsafeCleanup: true }).name;
}

// Helper to create a file in a directory
function touchFile(dir: string, ...parts: string[]): void {
  const filePath = path.join(dir, ...parts);
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, "");
}

describe("syncC3Proj", () => {
  describe("inferMimeType", () => {
    it("returns correct MIME for .ts", () => {
      assert.equal(inferMimeType("main.ts"), "application/typescript");
    });

    it("returns correct MIME for .webm", () => {
      assert.equal(inferMimeType("sound.webm"), "audio/webm; codecs=opus");
    });

    it("returns correct MIME for .png", () => {
      assert.equal(inferMimeType("icon.png"), "image/png");
    });

    it("returns correct MIME for .json", () => {
      assert.equal(inferMimeType("data.json"), "application/json");
    });

    it("returns correct MIME for .html", () => {
      assert.equal(inferMimeType("page.html"), "text/html");
    });

    it("returns correct MIME for .css", () => {
      assert.equal(inferMimeType("styles.css"), "text/css");
    });

    it("returns correct MIME for .xml", () => {
      assert.equal(inferMimeType("config.xml"), "text/xml");
    });

    it("returns correct MIME for .plist", () => {
      assert.equal(inferMimeType("Info.plist"), "text/xml");
    });

    it("returns correct MIME for .ttf", () => {
      assert.equal(inferMimeType("font.ttf"), "application/font-sfnt");
    });

    it("returns correct MIME for .txt", () => {
      assert.equal(inferMimeType("readme.txt"), "text/plain");
    });

    it("returns octet-stream for unknown extension", () => {
      assert.equal(inferMimeType("file.xyz"), "application/octet-stream");
    });
  });

  describe("collectAllSids", () => {
    it("collects SIDs from nested file-based sections", () => {
      const project = {
        rootFileFolders: {
          script: {
            items: [{ name: "a.ts", type: "application/typescript", sid: 111, "script-info": { purpose: "none" } }],
            subfolders: [
              {
                items: [{ name: "b.ts", type: "application/typescript", sid: 222, "script-info": { purpose: "none" } }],
                subfolders: [],
                name: "sub",
              },
            ],
          },
          sound: {
            items: [{ name: "c.webm", type: "audio/webm; codecs=opus", sid: 333, "file-info": { purpose: "none" } }],
            subfolders: [],
          },
        },
      };
      const sids = collectAllSids(project);
      assert.isTrue(sids.has(111));
      assert.isTrue(sids.has(222));
      assert.isTrue(sids.has(333));
      assert.equal(sids.size, 3);
    });

    it("returns empty set when no rootFileFolders", () => {
      const sids = collectAllSids({});
      assert.equal(sids.size, 0);
    });
  });

  describe("generateSid", () => {
    it("generates a 15-digit number", () => {
      const sids = new Set<number>();
      const sid = generateSid(sids);
      assert.isAtLeast(sid, 100000000000000);
      assert.isAtMost(sid, 999999999999999);
    });

    it("avoids collisions with existing SIDs", () => {
      const sids = new Set<number>();
      const first = generateSid(sids);
      assert.isTrue(sids.has(first));
      const second = generateSid(sids);
      assert.notEqual(first, second);
      assert.isTrue(sids.has(second));
    });
  });

  describe("readDiskDir", () => {
    it("reads files filtered by extension", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.ts");
      touchFile(dir, "b.ts");
      touchFile(dir, "c.js");
      const result = readDiskDir(dir, [".ts"], undefined, undefined);
      assert.deepEqual(result.files.sort(), ["a.ts", "b.ts"]);
      assert.deepEqual(result.dirs, []);
    });

    it("reads all files when no extension filter", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.json");
      touchFile(dir, "b.html");
      touchFile(dir, "c.png");
      const result = readDiskDir(dir, undefined, undefined, undefined);
      assert.equal(result.files.length, 3);
    });

    it("ignores specified files", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.ts");
      touchFile(dir, "tsconfig.json");
      const result = readDiskDir(dir, [".ts"], ["tsconfig.json"], undefined);
      assert.deepEqual(result.files, ["a.ts"]);
    });

    it("ignores specified directories", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.ts");
      mkdirSync(path.join(dir, "ts-defs"));
      mkdirSync(path.join(dir, "shared"));
      const result = readDiskDir(dir, [".ts"], undefined, ["ts-defs"]);
      assert.deepEqual(result.dirs, ["shared"]);
    });

    it("returns empty for non-existent directory", () => {
      const result = readDiskDir("/nonexistent/path", undefined, undefined, undefined);
      assert.deepEqual(result, { files: [], dirs: [] });
    });
  });

  describe("runSync error contract", () => {
    it("throws 'Could not read' when project.c3proj is missing", () => {
      const dir = createTmpDir();
      assert.throws(() => runSync(dir, true), /Could not read/);
    });

    it("throws 'Could not parse' on malformed JSON", () => {
      const dir = createTmpDir();
      writeFileSync(path.join(dir, "project.c3proj"), "{ not valid json");
      assert.throws(() => runSync(dir, true), /Could not parse/);
    });

    it("throws 'Could not parse' on a structurally-invalid manifest (valid JSON, missing fields)", () => {
      // Valid JSON but not a well-formed manifest (no name/runtime/...). Before the
      // readProjectManifest adoption this slipped through; it now fails fast.
      const dir = createTmpDir();
      writeFileSync(path.join(dir, "project.c3proj"), JSON.stringify({ foo: "bar" }));
      assert.throws(() => runSync(dir, true), /Could not parse/);
    });
  });

  describe("oracle — detectManifestDrift on construct3-chef-sample", () => {
    // Cross-check our sync against c3source's upstream drift detector for the
    // sections it models the same way we do (the name-folder sections). The file
    // sections (rootFileFolders.*) are deliberately excluded: c3source walks them
    // shallowly and unfiltered, so scripts/*.ts + tsconfig.json would read as drift.
    const NAME_FOLDER_SECTIONS = new Set([
      "layouts",
      "eventSheets",
      "objectTypes",
      "timelines",
      "flowcharts",
      "families",
    ]);

    it("reports no drift on the name-folder sections", () => {
      const drift = detectManifestDrift(sampleProjectDir);
      const nameSections = drift.sections.filter((s) => NAME_FOLDER_SECTIONS.has(s.section));
      for (const s of nameSections) {
        assert.deepEqual(s.entries, [], `${s.section}: unexpected drift`);
      }
    });

    it("covers objectTypes-as-directories without drift", () => {
      // The fixture stores objectTypes in named subfolders (global/images/tiles).
      // Confirm detectManifestDrift resolves that layout without reporting drift.
      const drift = detectManifestDrift(sampleProjectDir);
      const ot = drift.sections.find((s) => s.section === "objectTypes");
      // If the section is in-sync it may be omitted entirely, or present with no entries.
      assert.deepEqual(ot?.entries ?? [], [], "objectTypes: unexpected drift");
    });
  });

  describe("oracle — detectImageDrift on construct3-chef-sample", () => {
    it("returns the images section with no drift entries", () => {
      const drift = detectImageDrift(sampleProjectDir);
      assert.equal(drift?.section, "images");
      assert.deepEqual(drift?.entries ?? [], [], "images: unexpected drift");
    });

    // #63: a non-PNG image member must resolve its on-disk extension from `fileType`
    // (MIME), not an assumed `.png`. The fixture's JPEGTileBackground is JPEG-backed
    // (images/jpegtilebackground.jpg); pre-1.3.0 this produced a false `jpegtilebackground.png
    // missing` + `jpegtilebackground.jpg untracked` pair. This pins the fix and keeps the
    // fixture's non-PNG coverage from silently regressing to all-PNG.
    it("resolves a JPEG member to its real .jpg extension, not assumed .png (#63)", () => {
      const jtb = JSON.parse(
        readFileSync(path.join(sampleProjectDir, "objectTypes", "tiles", "JPEGTileBackground.json"), "utf-8"),
      );
      assert.equal(jtb.image.fileType, "image/jpeg", "fixture must keep a non-PNG member for #63 coverage");
      assert.deepEqual(
        deriveExpectedImageNames(jtb),
        ["jpegtilebackground.jpg"],
        "expected name must derive from fileType, not assume .png",
      );
      const drift = detectImageDrift(sampleProjectDir);
      assert.deepEqual(drift?.entries ?? [], [], "no false missing/untracked pair for the jpeg asset");
    });

    // sync-project now also surfaces this line (#52), so pin reportImageDrift's
    // rendered no-drift output, not just detectImageDrift's data.
    it("reportImageDrift emits a single (no drift) line on the clean fixture", () => {
      const lines: string[] = [];
      reportImageDrift(sampleProjectDir, (m) => lines.push(m));
      assert.lengthOf(lines, 1);
      assert.match(lines[0], /^\[images\]\s+\(no drift\)$/);
    });
  });

  describe("reportImageDrift error guard", () => {
    // c3source >=1.3.0 makes detectImageDrift THROW on a malformed/unknown image
    // `fileType` (#63). reportImageDrift calls it directly (no detectManifestDrift
    // try/catch upstream), so it must catch and report rather than crash validate-project.
    it("reports an error line instead of throwing on a malformed fileType", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "images"), { recursive: true });
      writeFileSync(path.join(dir, "images", "foo.png"), "");
      mkdirSync(path.join(dir, "objectTypes"), { recursive: true });
      // image member with NO fileType -> deriveExpectedImageNames throws "malformed object type".
      writeFileSync(
        path.join(dir, "objectTypes", "Foo.json"),
        JSON.stringify({ name: "Foo", image: { width: 1, height: 1 } }),
      );
      const lines: string[] = [];
      assert.doesNotThrow(() => reportImageDrift(dir, (m) => lines.push(m)));
      assert.lengthOf(lines, 1);
      assert.match(lines[0], /^\[images\]\s+error: /, "expected a single [images] error: line");
      assert.include(lines[0], "Foo");
    });
  });

  describe("timelines transitions (nameless) subfolder", () => {
    // #62: the fixture's `timelines` tree mixes the awkward cases C3 produces —
    //   items: ["Timeline 1"]
    //   subfolders:
    //     - NAMELESS subfolder (C3's serialization of the on-disk `timelines/transitions/`
    //       dir, "Eases" in the editor): items ["Matt's Ease"], itself nesting a NAMED
    //       subfolder "Others" (disk `transitions/Others/`) with ["Matt's Ease2"]
    //     - NAMED subfolder "Mixing" (disk `timelines/Mixing/`) with ["Timeline 2"]
    // so a named subfolder sits both inside the nameless one and beside it. runSync must
    // report ZERO changes. Before c3source 1.3.0 (#28) the manifest walk gave the nameless
    // subfolder no path segment while disk yielded `transitions`, so sync reported a false
    // `transitions/ (new folder)` add and "corrected" it by appending a NAMED `"transitions"`
    // subfolder — duplicating the item. This pins the fixed round-trip: no spurious folder,
    // no item duplication.
    it("reports no changes syncing the populated transitions subfolder", () => {
      const result = runSync(sampleProjectDir, true, () => {}, "timelines");
      assert.deepEqual(result.changes, [], "timelines: unexpected changes");
      assert.equal(result.clean, true);
      // Explicit anti-corruption guard: no change may re-introduce a named `transitions` folder.
      assert.isUndefined(
        result.changes.find((c) => /transitions/i.test(c.detail)),
        "sync must not emit a transitions folder change",
      );
    });
  });

  describe("syncFileFolder", () => {
    it("detects new files on disk", () => {
      const dir = createTmpDir();
      touchFile(dir, "new.ts");

      const folder: FileFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "+");
      assert.include(changes[0].detail, "new.ts");
      assert.equal(folder.items.length, 1);
      assert.equal(folder.items[0].name, "new.ts");
      assert.equal(folder.items[0].type, "application/typescript");
      assert.isAbove(folder.items[0].sid, 0);
    });

    it("detects removed files (in project but not on disk)", () => {
      const dir = createTmpDir();
      // Empty dir — nothing on disk

      const folder: FileFolder = {
        items: [{ name: "old.ts", type: "application/typescript", sid: 12345, "script-info": { purpose: "none" } }],
        subfolders: [],
      };
      const changes: Change[] = [];
      const sids = new Set<number>([12345]);
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
      assert.include(changes[0].detail, "old.ts");
      assert.equal(folder.items.length, 0);
    });

    it("preserves existing items that match disk", () => {
      const dir = createTmpDir();
      touchFile(dir, "existing.ts");

      const existingItem: FileItem = {
        name: "existing.ts",
        type: "application/typescript",
        sid: 99999,
        "script-info": { purpose: "main" },
      };
      const folder: FileFolder = { items: [existingItem], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>([99999]);
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 0);
      assert.equal(folder.items.length, 1);
      assert.equal(folder.items[0].sid, 99999);
      assert.equal(folder.items[0]["script-info"].purpose, "main");
    });

    it("detects new subfolders on disk", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "newFolder"));
      touchFile(dir, "newFolder", "file.ts");

      const folder: FileFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.isTrue(changes.some((c) => c.action === "+" && c.detail.includes("newFolder/")));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail.includes("file.ts")));
      assert.equal(folder.subfolders.length, 1);
      assert.equal(folder.subfolders[0].name, "newFolder");
    });

    it("handles deeply nested subfolders", () => {
      const dir = createTmpDir();
      touchFile(dir, "Auth", "Login", "util.ts");

      const folder: FileFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(folder.subfolders.length, 1);
      assert.equal(folder.subfolders[0].name, "Auth");
      assert.equal(folder.subfolders[0].subfolders.length, 1);
      assert.equal(folder.subfolders[0].subfolders[0].name, "Login");
      assert.equal(folder.subfolders[0].subfolders[0].items[0].name, "util.ts");
    });

    it("detects removed subfolders", () => {
      const dir = createTmpDir();
      // Empty dir — no subfolders

      const folder: FileFolder = {
        items: [],
        subfolders: [{ items: [], subfolders: [], name: "oldFolder" }],
      };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
      assert.include(changes[0].detail, "oldFolder/");
      assert.equal(folder.subfolders.length, 0);
    });

    it("dry-run does not modify folder", () => {
      const dir = createTmpDir();
      touchFile(dir, "new.ts");

      const folder: FileFolder = {
        items: [{ name: "old.ts", type: "application/typescript", sid: 111, "script-info": { purpose: "none" } }],
        subfolders: [],
      };
      const changes: Change[] = [];
      const sids = new Set<number>([111]);
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, true);

      assert.equal(changes.length, 2); // one add, one remove
      // But folder should be unchanged
      assert.equal(folder.items.length, 1);
      assert.equal(folder.items[0].name, "old.ts");
    });
  });

  describe("applyNameDrift", () => {
    it("untracked item at root: adds it and records a '+' change", () => {
      const folder: NameFolder = { items: [], subfolders: [] };
      const entries: DriftEntry[] = [{ kind: "untracked", name: "NewEvent", diskPath: [] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.deepEqual(folder.items, ["NewEvent"]);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "+");
      assert.equal(changes[0].detail, "NewEvent");
    });

    it("missing item at root: removes it and records a '-' change", () => {
      const folder: NameFolder = { items: ["OldEvent"], subfolders: [] };
      const entries: DriftEntry[] = [{ kind: "missing", name: "OldEvent", manifestPath: [] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.deepEqual(folder.items, []);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
      assert.equal(changes[0].detail, "OldEvent");
    });

    it("folder-untracked + untracked item inside: creates subfolder with item and two '+' changes", () => {
      const folder: NameFolder = { items: [], subfolders: [] };
      const entries: DriftEntry[] = [
        { kind: "folder-untracked", name: "Login", diskPath: ["Login"] },
        { kind: "untracked", name: "LoginEvents", diskPath: ["Login"] },
      ];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.equal(folder.subfolders.length, 1);
      assert.equal(folder.subfolders[0].name, "Login");
      assert.deepEqual(folder.subfolders[0].items, ["LoginEvents"]);
      assert.equal(changes.length, 2);
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "Login/ (new folder)"));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "Login/LoginEvents"));
    });

    it("moved: emits remove@manifestPath + add@diskPath (two changes)", () => {
      const folder: NameFolder = { items: ["Sheet"], subfolders: [{ items: [], subfolders: [], name: "Sub" }] };
      const entries: DriftEntry[] = [{ kind: "moved", name: "Sheet", manifestPath: [], diskPath: ["Sub"] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      // Sheet removed from root, added to Sub
      assert.deepEqual(folder.items, []);
      assert.equal(folder.subfolders[0].items[0], "Sheet");
      assert.equal(changes.length, 2);
      assert.isTrue(changes.some((c) => c.action === "-" && c.detail === "Sheet"));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "Sub/Sheet"));
    });

    it("dry-run: changes recorded but folder object unmutated", () => {
      const folder: NameFolder = { items: ["OldItem"], subfolders: [] };
      const entries: DriftEntry[] = [
        { kind: "missing", name: "OldItem", manifestPath: [] },
        { kind: "untracked", name: "NewItem", diskPath: [] },
      ];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, true);

      // Changes are recorded
      assert.equal(changes.length, 2);
      assert.isTrue(changes.some((c) => c.action === "-" && c.detail === "OldItem"));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "NewItem"));
      // But folder is unmutated
      assert.deepEqual(folder.items, ["OldItem"]);
      assert.equal(folder.subfolders.length, 0);
    });

    it("folder-missing with a multi-segment path: removes the nested subfolder", () => {
      const folder: NameFolder = {
        items: [],
        subfolders: [
          {
            items: [],
            subfolders: [{ items: [], subfolders: [], name: "Nested" }],
            name: "Sub",
          },
        ],
      };
      const entries: DriftEntry[] = [{ kind: "folder-missing", name: "Nested", manifestPath: ["Sub", "Nested"] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.deepEqual(folder.subfolders[0].subfolders, []);
      assert.equal(changes.length, 1);
      assert.isTrue(changes.some((c) => c.action === "-" && c.detail === "Sub/Nested/"));
    });

    it("folder-missing with a missing parent: records the change but skips gracefully", () => {
      const folder: NameFolder = { items: [], subfolders: [] };
      const entries: DriftEntry[] = [
        { kind: "folder-missing", name: "Nested", manifestPath: ["NonExistent", "Nested"] },
      ];
      const changes: Change[] = [];

      // navigateFolder returns undefined for the missing parent → no crash, no mutation.
      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.deepEqual(folder.subfolders, []);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
    });
  });

  describe("runSync name-section integration", () => {
    it("full-project dry-run on fixture: name sections report no changes (inSync)", () => {
      const result = runSync(sampleProjectDir, true, () => {}, undefined);
      const nameSectionKeys = ["layouts", "eventSheets", "families", "objectTypes", "timelines", "flowcharts"];
      for (const key of nameSectionKeys) {
        const sectionChanges = result.changes.filter((c) => c.section === key);
        assert.deepEqual(sectionChanges, [], `${key}: unexpected changes`);
      }
      assert.equal(result.clean, true);
    });

    it("R6 section filter: eventSheets stray only surfaces when that section is requested", () => {
      const tmpDir = createTmpDir();
      cpSync(sampleProjectDir, tmpDir, { recursive: true });
      // Add a stray eventSheet on disk
      touchFile(tmpDir, "eventSheets", "Stray.json");

      const layoutsResult = runSync(tmpDir, true, () => {}, "layouts");
      const esInLayouts = layoutsResult.changes.filter((c) => c.section === "eventSheets");
      assert.deepEqual(esInLayouts, [], "layouts-only run should not report eventSheets drift");

      const esResult = runSync(tmpDir, true, () => {}, "eventSheets");
      const esChanges = esResult.changes.filter((c) => c.section === "eventSheets");
      assert.isTrue(
        esChanges.some((c) => c.action === "+" && c.detail.includes("Stray")),
        "eventSheets-only run should report Stray as untracked",
      );
    });

    it("R8 non-name-section exclusion: images-only drift does not produce name-section changes", () => {
      const tmpDir = createTmpDir();
      cpSync(sampleProjectDir, tmpDir, { recursive: true });
      // Add an unreferenced image on disk (images/ drift is detection-only, not a sync target)
      touchFile(tmpDir, "images", "orphan.png");

      const result = runSync(tmpDir, true, () => {}, undefined);
      // No change should be emitted for the images section
      const imageChanges = result.changes.filter((c) => c.section === "images");
      assert.deepEqual(imageChanges, [], "images drift should not produce sync changes");
    });
  });
});
