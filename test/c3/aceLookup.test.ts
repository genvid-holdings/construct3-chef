import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { lookup, formatLookupResult } from "../../src/c3/aceLookup.js";
import type { LookupResult } from "../../src/c3/aceLookup.js";

const ADDON_FIXTURE = path.resolve("test/fixtures/addon-sample");
const CACHE_FIXTURE = path.resolve("test/fixtures/c3reference-sample");

/** A temp dir with no contents — simulates an empty project / no cache. */
function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ace-lookup-"));
}

describe("aceLookup", () => {
  describe("lookup", () => {
    // ── Empty / no-source case ────────────────────────────────────────────────

    it("returns empty arrays and cachePresent=false when no addons and no cache", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, tmp, {});
        expect(result.aces).to.deep.equal([]);
        expect(result.chunks).to.deep.equal([]);
        expect(result.cachePresent).to.equal(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── Cache presence ────────────────────────────────────────────────────────

    it("sets cachePresent=true and includes builtin ACEs when cache is present", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, {});
        expect(result.cachePresent).to.equal(true);
        // The fixture has 3 builtin ACEs
        const builtins = result.aces.filter((a) => a.source === "builtin");
        expect(builtins.length).to.equal(3);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("includes chunk entries from the cache when no ACE-only filter is set", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, {});
        expect(result.chunks.length).to.equal(2);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── object filter ─────────────────────────────────────────────────────────

    it("object filter: exact case-insensitive match on ACE objectClass", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { object: "SPRITE" });
        expect(result.aces.length).to.be.greaterThan(0);
        for (const ace of result.aces) {
          expect(ace.objectClass.toLowerCase()).to.equal("sprite");
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("object filter: case-insensitive exact match excludes non-matching ACEs", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { object: "System" });
        for (const ace of result.aces) {
          expect(ace.objectClass).to.equal("System");
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("object filter: chunk title substring match (case-insensitive)", () => {
      const tmp = makeTmpDir();
      try {
        // "layout" appears in the chunk titled "Layouts and layers"
        const result = lookup(tmp, CACHE_FIXTURE, { object: "layout" });
        expect(result.chunks.length).to.be.greaterThan(0);
        for (const chunk of result.chunks) {
          expect(chunk.title.toLowerCase()).to.include("layout");
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── id filter ─────────────────────────────────────────────────────────────

    it("id filter: returns the matching ACE and EXCLUDES chunks", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { id: "set-position" });
        expect(result.aces.length).to.equal(1);
        expect(result.aces[0].id).to.equal("set-position");
        // id is an ACE-only filter — chunks must be excluded
        expect(result.chunks).to.deep.equal([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("id filter: case-insensitive exact match", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { id: "EVERY-TICK" });
        expect(result.aces.length).to.equal(1);
        expect(result.aces[0].id).to.equal("every-tick");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("id filter: no match returns empty aces", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { id: "no-such-ace" });
        expect(result.aces).to.deep.equal([]);
        expect(result.chunks).to.deep.equal([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── param filter ──────────────────────────────────────────────────────────

    it("param filter: substring matches ACEs with a matching param name", () => {
      const tmp = makeTmpDir();
      try {
        // "x" appears as a param in Sprite set-position (params: x, y)
        const result = lookup(tmp, CACHE_FIXTURE, { param: "x" });
        expect(result.aces.length).to.be.greaterThan(0);
        for (const ace of result.aces) {
          const hasParam = ace.params.some((p) => p.name.toLowerCase().includes("x"));
          expect(hasParam).to.equal(true);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("param filter: excludes chunks (ACE-only filter)", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { param: "path" });
        expect(result.chunks).to.deep.equal([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── query scoring ─────────────────────────────────────────────────────────

    it("query: token that matches an ACE id returns that ACE", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { query: "set-position" });
        const ids = result.aces.map((a) => a.id);
        expect(ids).to.include("set-position");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("query: ACE with more matching tokens ranks before ACE with fewer", () => {
      const tmp = makeTmpDir();
      try {
        // "sprite set-position" hits both objectClass and id for set-position;
        // "system every-tick" hits both for every-tick.
        // A query with just "sprite" should rank the Sprite ACE first.
        const result = lookup(tmp, CACHE_FIXTURE, { query: "sprite set-position" });
        expect(result.aces.length).to.be.greaterThan(0);
        // set-position matches both "sprite" (objectClass) and "set-position" (id) → score 2
        // The first result should be set-position
        expect(result.aces[0].id).to.equal("set-position");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("query: includes chunks that match by title or text", () => {
      const tmp = makeTmpDir();
      try {
        // "expressions" appears in the first chunk title
        const result = lookup(tmp, CACHE_FIXTURE, { query: "expressions" });
        const chunkTitles = result.chunks.map((c) => c.title);
        expect(chunkTitles.some((t) => t.toLowerCase().includes("expressions"))).to.equal(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── Ranking: addon sorts before builtin ───────────────────────────────────

    it("ranking: addon ACE sorts before builtin ACE when both match", () => {
      // addon-sample has FixtureClock; cache-fixture has builtin ACEs.
      // With no filter, addon entries should appear first.
      const result = lookup(ADDON_FIXTURE, CACHE_FIXTURE, {});
      const addonIdx = result.aces.findIndex((a) => a.source === "addon");
      const builtinIdx = result.aces.findIndex((a) => a.source === "builtin");
      expect(addonIdx).to.be.greaterThanOrEqual(0);
      expect(builtinIdx).to.be.greaterThanOrEqual(0);
      expect(addonIdx).to.be.lessThan(builtinIdx);
    });

    // ── Chunk filter combinations ─────────────────────────────────────────────

    it("object+query filter that matches a chunk includes it", () => {
      const tmp = makeTmpDir();
      try {
        // object="Expressions" (substring of "Expressions overview") + query="dynamically"
        const result = lookup(tmp, CACHE_FIXTURE, { object: "Expressions", query: "dynamically" });
        expect(result.chunks.length).to.be.greaterThan(0);
        expect(result.chunks[0].title).to.include("Expressions");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("id filter combined with object excludes chunks even if object matches chunk title", () => {
      const tmp = makeTmpDir();
      try {
        // "Expressions" matches a chunk title, but id filter is ACE-only → chunks excluded
        const result = lookup(tmp, CACHE_FIXTURE, { object: "JSON", id: "get" });
        expect(result.aces.length).to.equal(1);
        expect(result.chunks).to.deep.equal([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── ReDoS / query cap ────────────────────────────────────────────────────

    it("501-char query is capped silently — does not throw and returns a result", () => {
      const tmp = makeTmpDir();
      try {
        const longQuery = "a".repeat(501);
        let result: ReturnType<typeof lookup> | undefined;
        expect(() => {
          result = lookup(tmp, CACHE_FIXTURE, { query: longQuery });
        }).to.not.throw();
        expect(result).to.not.be.undefined;
        // "a" is a substring of e.g. "action", "params", "description" — may or may not match;
        // the important thing is no error was thrown.
        expect(result!.aces).to.be.an("array");
        expect(result!.chunks).to.be.an("array");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // ── limit ─────────────────────────────────────────────────────────────────

    it("limit=1 caps aces to at most 1 entry", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { limit: 1 });
        expect(result.aces.length).to.be.at.most(1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("limit=1 caps chunks to at most 1 entry", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { limit: 1 });
        expect(result.chunks.length).to.be.at.most(1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("limit is applied independently to aces and chunks", () => {
      // With limit=1 and the fixture having 3 ACEs + 2 chunks,
      // both arrays are capped independently (each at most 1), not combined.
      const tmp = makeTmpDir();
      try {
        const unlimited = lookup(tmp, CACHE_FIXTURE, {});
        const limited = lookup(tmp, CACHE_FIXTURE, { limit: 1 });
        expect(unlimited.aces.length).to.be.greaterThan(1);
        expect(unlimited.chunks.length).to.be.greaterThan(1);
        expect(limited.aces.length).to.equal(1);
        expect(limited.chunks.length).to.equal(1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("formatLookupResult", () => {
    // ── Empty / no results ────────────────────────────────────────────────────

    it('"No results found." when both arrays are empty and cache present', () => {
      const result: LookupResult = { aces: [], chunks: [], cachePresent: true };
      const text = formatLookupResult(result);
      expect(text).to.equal("No results found.");
    });

    it('"No results found." plus no-cache note when empty and cachePresent false', () => {
      const result: LookupResult = { aces: [], chunks: [], cachePresent: false };
      const text = formatLookupResult(result);
      expect(text).to.include("No results found.");
      expect(text).to.include("no c3-reference cache");
    });

    // ── Header line ───────────────────────────────────────────────────────────

    it("header line counts aces and chunks correctly", () => {
      const result = lookup(path.resolve("test/fixtures/addon-sample"), CACHE_FIXTURE, { query: "set" });
      expect(result.aces.length).to.be.greaterThan(0);
      const text = formatLookupResult(result);
      expect(text).to.match(new RegExp(`^${result.aces.length} ACE\\(s\\), ${result.chunks.length} doc chunk\\(s\\)`));
    });

    // ── ACE line format ───────────────────────────────────────────────────────

    it("ACE lines use [source kind] objectClass.id(params) format", () => {
      const result = lookup(path.resolve("test/fixtures/addon-sample"), CACHE_FIXTURE, {
        id: "set-position",
      });
      expect(result.aces.length).to.equal(1);
      const text = formatLookupResult(result);
      // Should contain [builtin action] Sprite.set-position(x, y)
      expect(text).to.include("[builtin action] Sprite.set-position(");
    });

    // ── No-cache note in non-empty result ─────────────────────────────────────

    it("no-cache note appears in non-empty result when cachePresent false", () => {
      // Use addon-sample as both projectRoot and extractedDir so there is no cache,
      // but FixtureClock addon ACEs are still present.
      const result = lookup(path.resolve("test/fixtures/addon-sample"), path.resolve("test/fixtures/addon-sample"), {
        object: "FixtureClock",
      });
      expect(result.cachePresent).to.equal(false);
      expect(result.aces.length).to.be.greaterThan(0);
      const text = formatLookupResult(result);
      expect(text).to.include("no c3-reference cache");
      // Header must still be present
      expect(text).to.match(/\d+ ACE\(s\), \d+ doc chunk\(s\)/);
    });

    // ── Chunk lines ───────────────────────────────────────────────────────────

    it("chunk lines appear after a blank separator", () => {
      const tmp = makeTmpDir();
      try {
        const result = lookup(tmp, CACHE_FIXTURE, { query: "expressions" });
        expect(result.chunks.length).to.be.greaterThan(0);
        const text = formatLookupResult(result);
        // blank line separating ACEs from chunks
        expect(text).to.include("\n\n");
        // chunk format: [category] title — text
        expect(text).to.match(/\[[^\]]+\] .+ — .+/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
