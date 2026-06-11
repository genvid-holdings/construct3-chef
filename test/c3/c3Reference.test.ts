import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadReferenceCache } from "../../src/c3/c3Reference.js";

describe("c3Reference", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── loadReferenceCache ────────────────────────────────────────────────────

  describe("loadReferenceCache", () => {
    it("returns null when the cache file does not exist", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "c3ref-"));
      expect(loadReferenceCache(tmpDir)).to.be.null;
    });

    it("returns parsed aces and chunks from a valid index", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "c3ref-"));
      mkdirSync(path.join(tmpDir, "c3-reference"), { recursive: true });

      const index = {
        schemaVersion: 1,
        manualVersion: "r414",
        generatedAt: "2026-01-01T00:00:00.000Z",
        aces: [
          {
            source: "builtin",
            objectClass: "System",
            kind: "action",
            id: "go-to-layout",
            scriptName: "goToLayout",
            params: [{ name: "layout", type: "layout" }],
            description: "Go to a layout.",
            canonicalUrl: "https://www.construct.net/en/make-games/manuals/construct-3/system-reference/system-actions",
          },
          {
            source: "addon",
            objectClass: "Sprite",
            kind: "condition",
            id: "on-collision",
            params: [{ name: "other", type: "object" }],
          },
        ],
        chunks: [
          {
            title: "Layouts",
            text: "A layout is a visual arrangement of objects.",
            canonicalUrl: "https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/layouts",
            category: "layout",
          },
        ],
      };

      writeFileSync(path.join(tmpDir, "c3-reference", "index.json"), JSON.stringify(index));

      const result = loadReferenceCache(tmpDir);
      expect(result).to.not.be.null;
      expect(result!.aces).to.have.length(2);
      expect(result!.chunks).to.have.length(1);
      expect(result!.aces[0].id).to.equal("go-to-layout");
      expect(result!.aces[0].scriptName).to.equal("goToLayout");
      expect(result!.aces[1].id).to.equal("on-collision");
      expect(result!.chunks[0].category).to.equal("layout");
    });

    it("normalizes absent aces/chunks arrays to []", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "c3ref-"));
      mkdirSync(path.join(tmpDir, "c3-reference"), { recursive: true });

      const index = {
        schemaVersion: 1,
        manualVersion: "r414",
        generatedAt: "2026-01-01T00:00:00.000Z",
        // no aces, no chunks
      };

      writeFileSync(path.join(tmpDir, "c3-reference", "index.json"), JSON.stringify(index));

      const result = loadReferenceCache(tmpDir);
      expect(result).to.not.be.null;
      expect(result!.aces).to.deep.equal([]);
      expect(result!.chunks).to.deep.equal([]);
    });

    it("returns null for malformed JSON", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "c3ref-"));
      mkdirSync(path.join(tmpDir, "c3-reference"), { recursive: true });

      writeFileSync(path.join(tmpDir, "c3-reference", "index.json"), "{ not json");

      expect(loadReferenceCache(tmpDir)).to.be.null;
    });

    it("returns null when required top-level fields are missing", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "c3ref-"));
      mkdirSync(path.join(tmpDir, "c3-reference"), { recursive: true });

      // Missing schemaVersion, manualVersion, generatedAt
      const index = {
        aces: [],
        chunks: [],
      };

      writeFileSync(path.join(tmpDir, "c3-reference", "index.json"), JSON.stringify(index));

      expect(loadReferenceCache(tmpDir)).to.be.null;
    });

    it("returns null when an ace entry has an invalid kind enum", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "c3ref-"));
      mkdirSync(path.join(tmpDir, "c3-reference"), { recursive: true });

      const index = {
        schemaVersion: 1,
        manualVersion: "r414",
        generatedAt: "2026-01-01T00:00:00.000Z",
        aces: [
          {
            source: "builtin",
            objectClass: "System",
            kind: "frobnicate", // invalid enum value
            id: "some-ace",
            params: [],
          },
        ],
      };

      writeFileSync(path.join(tmpDir, "c3-reference", "index.json"), JSON.stringify(index));

      expect(loadReferenceCache(tmpDir)).to.be.null;
    });

    it("returns null when a chunk entry has an invalid category enum", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "c3ref-"));
      mkdirSync(path.join(tmpDir, "c3-reference"), { recursive: true });

      const index = {
        schemaVersion: 1,
        manualVersion: "r414",
        generatedAt: "2026-01-01T00:00:00.000Z",
        chunks: [
          {
            title: "Some Chunk",
            text: "Some text.",
            canonicalUrl: "https://example.com",
            category: "unknown-category", // invalid
          },
        ],
      };

      writeFileSync(path.join(tmpDir, "c3-reference", "index.json"), JSON.stringify(index));

      expect(loadReferenceCache(tmpDir)).to.be.null;
    });
  });
});
