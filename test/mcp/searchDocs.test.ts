import { expect } from "chai";
import * as path from "node:path";
import { __getHandler, __setProjectRoot, __setExtractedDir, __resetTestState } from "../../src/mcp/server.js";

// Fixtures:
//   addon-sample  — has addons/plugin/FixtureClock/aces.json (objectClass "FixtureClock")
//   c3reference-sample — has c3-reference/index.json with builtin Sprite/System/JSON ACEs + chunks

const ADDON_FIXTURE = path.resolve("test/fixtures/addon-sample");
const C3REF_FIXTURE = path.resolve("test/fixtures/c3reference-sample");

function makeExtra(): any {
  const ac = new AbortController();
  return { signal: ac.signal };
}

describe("search-docs MCP tool", () => {
  afterEach(() => {
    __resetTestState();
  });

  // ── 1. Present cache + addon fixture ─────────────────────────────────────────
  // Project root = addon-sample (has FixtureClock addon).
  // extractedDir  = c3reference-sample (has c3-reference/index.json with builtins).

  it("returns addon and builtin ACEs when cache is present", async () => {
    __setProjectRoot(ADDON_FIXTURE);
    __setExtractedDir(C3REF_FIXTURE);

    const handler = __getHandler("search-docs")!;
    expect(handler).to.exist;

    const result = (await handler({ query: "set" }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].type).to.equal("text");

    const text: string = result.content[0].text;

    // Header counts present
    expect(text).to.match(/\d+ ACE\(s\), \d+ doc chunk\(s\)/);

    // Addon ACE present (FixtureClock.set-rate)
    expect(text).to.include("FixtureClock");

    // At least one builtin ACE from the cache (Sprite.set-position matches "set")
    expect(text).to.include("Sprite");

    // No stale warning (stale: false)
    expect(text).to.not.include("[Warning:");
  });

  // ── 2. Absent cache (extractedDir has no c3-reference/) ──────────────────────

  it("returns addon ACEs and no-cache note when c3-reference cache is absent", async () => {
    __setProjectRoot(ADDON_FIXTURE);
    // Point extractedDir at addon-sample itself — no c3-reference/ subdirectory there
    __setExtractedDir(ADDON_FIXTURE);

    const handler = __getHandler("search-docs")!;
    const result = (await handler({ object: "FixtureClock" }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    const text: string = result.content[0].text;

    // No-cache note present
    expect(text).to.include("no c3-reference cache");

    // Addon ACEs still returned
    expect(text).to.include("FixtureClock");
  });

  // ── 3. No filters → guidance message ─────────────────────────────────────────

  it("returns guidance message when no filters are provided", async () => {
    __setProjectRoot(ADDON_FIXTURE);
    __setExtractedDir(C3REF_FIXTURE);

    const handler = __getHandler("search-docs")!;
    const result = (await handler({}, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("Provide at least one filter");
  });

  // ── 4. Long query (>500 chars) does not throw ─────────────────────────────────

  it("handles a very long query without throwing", async () => {
    __setProjectRoot(ADDON_FIXTURE);
    __setExtractedDir(C3REF_FIXTURE);

    const handler = __getHandler("search-docs")!;
    const result = (await handler({ query: "x".repeat(600) }, makeExtra())) as any;

    // Should resolve to a single content block — not throw and not isError
    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].type).to.equal("text");
  });

  // ── 5. Filter matching nothing → "No results found." ─────────────────────────

  it("returns 'No results found.' when filter matches nothing", async () => {
    __setProjectRoot(ADDON_FIXTURE);
    __setExtractedDir(C3REF_FIXTURE);

    const handler = __getHandler("search-docs")!;
    const result = (await handler({ id: "does-not-exist" }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("No results found.");
  });
});
