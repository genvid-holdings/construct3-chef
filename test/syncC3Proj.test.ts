import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import tmp from "tmp";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  inferMimeType,
  collectAllSids,
  generateSid,
  readDiskDir,
  readDiskDirNames,
  syncFileFolder,
  syncNameFolder,
  type FileItem,
  type FileFolder,
  type NameFolder,
  type FileSectionConfig,
  type NameSectionConfig,
  type Change,
} from "../src/c3/projectSync.js";

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

  describe("readDiskDirNames", () => {
    it("reads .json files as names without extension", () => {
      const dir = createTmpDir();
      touchFile(dir, "EventA.json");
      touchFile(dir, "EventB.json");
      const result = readDiskDirNames(dir, false);
      assert.deepEqual(result.files.sort(), ["EventA", "EventB"]);
    });

    it("ignores .uistate.json when configured", () => {
      const dir = createTmpDir();
      touchFile(dir, "Layout1.json");
      touchFile(dir, "Layout1.uistate.json");
      const result = readDiskDirNames(dir, true);
      assert.deepEqual(result.files, ["Layout1"]);
    });

    it("includes .uistate.json when not ignoring", () => {
      const dir = createTmpDir();
      touchFile(dir, "Layout1.json");
      touchFile(dir, "Layout1.uistate.json");
      const result = readDiskDirNames(dir, false);
      assert.equal(result.files.length, 2);
    });

    it("reads subdirectories", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "SubFolder"));
      const result = readDiskDirNames(dir, false);
      assert.deepEqual(result.dirs, ["SubFolder"]);
    });

    it("ignores the uistate directory when configured", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "SubFolder"));
      mkdirSync(path.join(dir, "uistate"));
      const result = readDiskDirNames(dir, true);
      assert.deepEqual(result.dirs, ["SubFolder"]);
    });

    it("includes the uistate directory when not ignoring", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "uistate"));
      const result = readDiskDirNames(dir, false);
      assert.deepEqual(result.dirs, ["uistate"]);
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

  describe("syncNameFolder", () => {
    it("detects new items on disk", () => {
      const dir = createTmpDir();
      touchFile(dir, "NewEvent.json");

      const folder: NameFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const config: NameSectionConfig = { key: "eventSheets", diskDir: dir, ignoreUistate: true };

      syncNameFolder(folder, dir, "", config, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "+");
      assert.include(changes[0].detail, "NewEvent");
      assert.deepEqual(folder.items, ["NewEvent"]);
    });

    it("detects removed items", () => {
      const dir = createTmpDir();
      // Empty dir

      const folder: NameFolder = { items: ["OldEvent"], subfolders: [] };
      const changes: Change[] = [];
      const config: NameSectionConfig = { key: "eventSheets", diskDir: dir, ignoreUistate: true };

      syncNameFolder(folder, dir, "", config, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
      assert.include(changes[0].detail, "OldEvent");
      assert.deepEqual(folder.items, []);
    });

    it("preserves existing items that match disk", () => {
      const dir = createTmpDir();
      touchFile(dir, "Existing.json");

      const folder: NameFolder = { items: ["Existing"], subfolders: [] };
      const changes: Change[] = [];
      const config: NameSectionConfig = { key: "eventSheets", diskDir: dir, ignoreUistate: true };

      syncNameFolder(folder, dir, "", config, changes, false);

      assert.equal(changes.length, 0);
      assert.deepEqual(folder.items, ["Existing"]);
    });

    it("ignores .uistate.json files when configured", () => {
      const dir = createTmpDir();
      touchFile(dir, "Layout1.json");
      touchFile(dir, "Layout1.uistate.json");

      const folder: NameFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const config: NameSectionConfig = { key: "layouts", diskDir: dir, ignoreUistate: true };

      syncNameFolder(folder, dir, "", config, changes, false);

      assert.equal(changes.length, 1);
      assert.deepEqual(folder.items, ["Layout1"]);
    });

    it("ignores the uistate subfolder (editor state) when configured", () => {
      const dir = createTmpDir();
      // Recent C3 editors persist instances-bar UI state under layouts/uistate/.
      mkdirSync(path.join(dir, "uistate", "Level1"), { recursive: true });
      writeFileSync(path.join(dir, "uistate", "Level1", "Bar.instancesBar.json"), "");

      const folder: NameFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const config: NameSectionConfig = { key: "layouts", diskDir: dir, ignoreUistate: true };

      syncNameFolder(folder, dir, "", config, changes, false);

      assert.deepEqual(changes, []);
      assert.deepEqual(folder.subfolders, []);
    });

    it("detects new subfolders on disk", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "Login"));
      touchFile(dir, "Login", "LoginEvents.json");

      const folder: NameFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const config: NameSectionConfig = { key: "eventSheets", diskDir: dir, ignoreUistate: true };

      syncNameFolder(folder, dir, "", config, changes, false);

      assert.isTrue(changes.some((c) => c.action === "+" && c.detail.includes("Login/")));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail.includes("LoginEvents")));
      assert.equal(folder.subfolders.length, 1);
      assert.equal(folder.subfolders[0].name, "Login");
    });

    it("dry-run does not modify folder", () => {
      const dir = createTmpDir();
      touchFile(dir, "New.json");

      const folder: NameFolder = { items: ["Old"], subfolders: [] };
      const changes: Change[] = [];
      const config: NameSectionConfig = { key: "eventSheets", diskDir: dir, ignoreUistate: true };

      syncNameFolder(folder, dir, "", config, changes, true);

      assert.equal(changes.length, 2);
      // Folder should be unchanged
      assert.deepEqual(folder.items, ["Old"]);
    });
  });
});
