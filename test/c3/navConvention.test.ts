import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { defaultNavConvention, resolveNavConvention } from "../../src/c3/navConvention.js";
import { loadChefConfig } from "../../src/c3/chefConfig.js";

describe("navConvention", () => {
  // ────────────────────────────────────────────────────────────
  // defaultNavConvention
  // ────────────────────────────────────────────────────────────

  describe("defaultNavConvention", () => {
    it("returns a non-empty targetRegexes array", () => {
      const conv = defaultNavConvention();
      assert.isAbove(conv.targetRegexes.length, 0);
    });

    it("isDefinitionLine always returns false", () => {
      const conv = defaultNavConvention();
      assert.isFalse(conv.isDefinitionLine("function GoToLayout(...)"));
      assert.isFalse(conv.isDefinitionLine("anything"));
      assert.isFalse(conv.isDefinitionLine(""));
    });
  });

  // ────────────────────────────────────────────────────────────
  // resolveNavConvention
  // ────────────────────────────────────────────────────────────

  describe("resolveNavConvention", () => {
    it("no navigation config => same regex count as defaultNavConvention and isDefinitionLine is always false", () => {
      const config = { extractedDir: "extracted" };
      const conv = resolveNavConvention(config);
      assert.strictEqual(conv.targetRegexes.length, defaultNavConvention().targetRegexes.length);
      assert.isFalse(conv.isDefinitionLine("anything"));
    });

    it("custom targetPatterns: a matching line is captured by one of targetRegexes", () => {
      const config = {
        extractedDir: "extracted",
        navigation: { targetPatterns: ['Foo\\("([^"]+)"'] },
      };
      const conv = resolveNavConvention(config);
      assert.lengthOf(conv.targetRegexes, 1);

      const line = 'call Foo("Bar")';
      const match = conv.targetRegexes[0].exec(line);
      assert.isNotNull(match, "expected regex to match the line");
      assert.strictEqual(match![1], "Bar");
    });

    it("bad regex is dropped: does not throw and the good pattern survives", () => {
      const config = {
        extractedDir: "extracted",
        navigation: { targetPatterns: ["(unclosed", "Good\\(([^)]+)\\)"] },
      };

      let conv!: ReturnType<typeof resolveNavConvention>;
      assert.doesNotThrow(() => {
        conv = resolveNavConvention(config);
      });
      assert.lengthOf(conv.targetRegexes, 1, "only the good pattern should remain");

      const match = conv.targetRegexes[0].exec("Good(hello)");
      assert.isNotNull(match);
      assert.strictEqual(match![1], "hello");
    });

    it("all-bad patterns fall back to default convention regex count (non-empty)", () => {
      const config = {
        extractedDir: "extracted",
        navigation: { targetPatterns: ["(unclosed", "[invalid"] },
      };
      const conv = resolveNavConvention(config);
      assert.isAbove(conv.targetRegexes.length, 0, "fallback must be non-empty");
      assert.strictEqual(conv.targetRegexes.length, defaultNavConvention().targetRegexes.length);
    });

    it("definitionMarkers: isDefinitionLine returns true when marker is present", () => {
      const config = {
        extractedDir: "extracted",
        navigation: { definitionMarkers: ["function Foo"] },
      };
      const conv = resolveNavConvention(config);
      assert.isTrue(conv.isDefinitionLine("  function Foo(...)"));
      assert.isFalse(conv.isDefinitionLine("  call Foo(...)"));
    });

    it("definitionMarkers: isDefinitionLine returns false when no markers are configured", () => {
      const config = {
        extractedDir: "extracted",
        navigation: { targetPatterns: ["Foo(.+)"] },
      };
      const conv = resolveNavConvention(config);
      assert.isFalse(conv.isDefinitionLine("function Foo(...)"));
    });
  });
});

// ────────────────────────────────────────────────────────────
// loadChefConfig — navigation block integration
// ────────────────────────────────────────────────────────────

describe("loadChefConfig — navigation block", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-nav-"));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses navigation.targetPatterns and definitionMarkers from config file", async () => {
    writeFileSync(
      path.join(tmpDir, "construct3-chef.config.json"),
      JSON.stringify({
        extractedDir: "out",
        navigation: {
          targetPatterns: ['GoToLayout\\("([^"]+)"'],
          definitionMarkers: ["function GoToLayout"],
        },
      }),
    );
    const cfg = await loadChefConfig(tmpDir);
    assert.deepEqual(cfg.navigation?.targetPatterns, ['GoToLayout\\("([^"]+)"']);
    assert.deepEqual(cfg.navigation?.definitionMarkers, ["function GoToLayout"]);
    assert.strictEqual(cfg.extractedDir, "out");
  });

  it("navigation block is optional: missing navigation => undefined", async () => {
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "extracted" }));
    const cfg = await loadChefConfig(tmpDir);
    assert.isUndefined(cfg.navigation);
    assert.strictEqual(cfg.extractedDir, "extracted");
  });

  it("malformed navigation value falls back safely: extractedDir still resolves to schema default", async () => {
    // Write a config where navigation has an invalid type (not an object) to
    // trigger schema validation failure; the fallback should not throw.
    writeFileSync(
      path.join(tmpDir, "construct3-chef.config.json"),
      JSON.stringify({ extractedDir: "extracted", navigation: "not-an-object" }),
    );
    const cfg = await loadChefConfig(tmpDir);
    // After a schema violation the fallback path returns the safe default.
    assert.strictEqual(cfg.extractedDir, "extracted");
  });

  it("overrides.navigation is preserved in fallback when config file is malformed", async () => {
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), "{ bad json");
    const cfg = await loadChefConfig(tmpDir, {
      navigation: { definitionMarkers: ["myMarker"] },
    });
    // extractedDir falls back to schema default
    assert.strictEqual(cfg.extractedDir, "extracted");
    // navigation override is preserved through the fallback branch
    assert.deepEqual(cfg.navigation?.definitionMarkers, ["myMarker"]);
  });
});
