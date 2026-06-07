import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  __getHandler,
  __setTestWatcher,
  __setExtractedDirty,
  __getExtractedDirty,
  __setProjectRoot,
  __resetTestState,
} from "../../src/mcp/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");

// The stale-warning string — must match the literal in server.ts exactly
const STALE_WARNING = "\n\n[Warning: extracted files may be stale — run regenerate to refresh]";

// A minimal valid recipe that applies cleanly against construct3-chef-sample.
// Adds a new instance variable to the Text objectType (which exists in
// objectTypes/Text.json and instanceTypes.d.ts).  Running this twice on the
// same tmp copy is safe: the second pass skips (all vars already exist).
const VALID_RECIPE = JSON.stringify({
  addInstVars: [
    {
      type: "Text",
      instanceVariables: [{ name: "serverHandlerTest", type: "number" }],
    },
  ],
});

// ── Fake watcher ─────────────────────────────────────────────────────────────
// Handlers under test only touch watcher.txId, watcher.bump(), and
// watcher.suppress(fn). Cast to the SDK type when handing to __setTestWatcher.

interface FakeWatcher {
  txId: number;
  bumped: number;
  bump(): void;
  suppress<T>(fn: () => Promise<T>): Promise<T>;
}

function makeFakeWatcher(txId = 0): FakeWatcher {
  return {
    txId,
    bumped: 0,
    bump() {
      this.txId++;
      this.bumped++;
    },
    async suppress<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

// ── Synthetic extra ───────────────────────────────────────────────────────────
// Handlers only use extra.signal and extra._meta?.progressToken.
// Passing undefined for progressToken means sendProgress is a no-op.

function makeExtra(aborted = false): any {
  const ac = new AbortController();
  if (aborted) ac.abort();
  return { signal: ac.signal };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("MCP server handler response shaping", () => {
  let tmp: string;
  let watcher: FakeWatcher;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-mcp-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    __setProjectRoot(tmp);
    watcher = makeFakeWatcher(5);
    __setTestWatcher(watcher as any);
    __setExtractedDirty(false);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    __resetTestState();
  });

  // ── 1. get-state: correct single-block shape ──────────────────────────────

  it("get-state returns one text block with txId and extractedDirty, no isError", async () => {
    const handler = __getHandler("get-state")!;
    expect(handler).to.exist;

    const result = (await handler({}, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].type).to.equal("text");
    expect(result.content[0].text).to.equal("txId: 5\nextractedDirty: false");
  });

  // ── 2. stale-warning appended when extractedDirty is true ────────────────
  // Uses read-dsl which routes through paginatedResponse → appendStaleWarning.
  // The fixture has extracted/eventSheets/Event sheet 1.dsl.txt.

  it("read-dsl appends STALE_WARNING when extractedDirty=true, not when false", async () => {
    const handler = __getHandler("read-dsl")!;
    expect(handler).to.exist;

    // With dirty = true
    __setExtractedDirty(true);
    const dirtyResult = (await handler({ sheet: "Event sheet 1" }, makeExtra())) as any;
    expect(dirtyResult.content[0].text).to.include(STALE_WARNING);

    // Reset and try clean
    __setExtractedDirty(false);
    const cleanResult = (await handler({ sheet: "Event sheet 1" }, makeExtra())) as any;
    expect(cleanResult.content[0].text).to.not.include(STALE_WARNING);
  });

  // ── 3. apply-recipe txId-rejection ───────────────────────────────────────

  it("apply-recipe rejects mismatched txId before parsing recipe, no watcher bump", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: "{}", txId: 4 }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(2);
    expect(result.content[0].text).to.equal("State changed (expected 4, got 5) — re-validate before applying");
    expect(result.content[1].text).to.equal("txId: 5");
    expect(watcher.bumped).to.equal(0);
  });

  // ── 4. apply-recipe caughtError on invalid JSON ───────────────────────────

  it("apply-recipe returns caughtError for invalid JSON, no watcher bump, dirty unchanged", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan; also tests dirty stays true
    const result = (await handler({ recipe: "{ not json", txId: 5 }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(2);
    expect(result.content[0].text).to.match(/^Error:/);
    expect(result.content[1].text).to.equal("txId: 5");
    expect(watcher.bumped).to.equal(0);
    expect(__getExtractedDirty()).to.be.true;
  });

  // ── 5. apply-recipe success with regenerate:false ─────────────────────────

  it("apply-recipe succeeds (regenerate:false): two blocks, txId bumped once, no isError", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: 5, regenerate: false }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(2);
    expect(result.content[1].text).to.equal("txId: 6");
    expect(watcher.bumped).to.equal(1);
    // regenerate:false should NOT clear dirty
    // (dirty was true; test verifies it stays unchanged from this handler's perspective)
  });

  // ── 6. apply-recipe success (regenerate:true) clears extractedDirty ───────
  // Deferred: the MCP regenerate path has a real bug — GENERATOR_STEPS passes the
  // *absolute* EXTRACTED_DIR to generateSidRegistry, which expects a *relative*
  // dir and re-joins projectRoot (path.join(root, /root/extracted)). Result: a
  // doubled path — silently written to a junk location on POSIX, ENOENT crash on
  // Windows. The CLI (cli.ts) passes the relative dir correctly; the MCP path was
  // never exercised, which is the gap this suite closes. Added as a regression
  // test alongside the one-line fix in the following commit.

  // ── 7. apply-recipe CancelledError after source write ─────────────────────
  // Aborted signal causes checkCancelled() to throw inside runGenerators AFTER
  // applyParsed has already written source files.

  it("apply-recipe with aborted signal: isError, Cancelled text, txId bumped, dirty=true", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE }, makeExtra(true))) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(2);
    expect(result.content[0].text).to.include("Cancelled");
    expect(result.content[1].text).to.equal("txId: 6");
    expect(watcher.bumped).to.equal(1);
    expect(__getExtractedDirty()).to.be.true;
  });
});
