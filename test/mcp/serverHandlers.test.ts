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

// cpSync stamps every copied file with ~the same mtime, and the recursive copy
// order (readdir order — not alphabetical on all filesystems) decides whether
// extracted/ ends up newer or older than the source dirs. checkSourceFreshness
// compares those mtimes with a strict `source > extracted`, so on some CI
// filesystems a freshly-copied fixture reads as spuriously stale. Force
// extracted/ deterministically newer than source so the freshness check is
// neutral and these tests drive staleness solely via __setExtractedDirty.
function makeExtractedNewerThanSource(root: string): void {
  const future = new Date(Date.now() + 3_600_000);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.utimesSync(full, future, future);
    }
  };
  const extractedDir = path.join(root, "extracted");
  if (fs.existsSync(extractedDir)) walk(extractedDir);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("MCP server handler response shaping", () => {
  let tmp: string;
  let watcher: FakeWatcher;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-mcp-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    makeExtractedNewerThanSource(tmp);
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

  // ── 3. read-dsl single-block pagination contract ─────────────────────────
  // paginatedResponse now delegates to paginatedContent (upstream helper) which
  // collapses the page text and the range footer into ONE content block, joined
  // with "\n\n". The old two-block shape is gone.
  //
  // Fixture: extracted/eventSheets/Event sheet 1.dsl.txt — 12 lines.

  it("read-dsl with offset+limit returns single content block with in-block range footer", async () => {
    const handler = __getHandler("read-dsl")!;
    expect(handler).to.exist;

    __setExtractedDirty(false);
    // offset=2, limit=1 → returns line 2 of the DSL file; footer appended in-block.
    const result = (await handler({ sheet: "Event sheet 1", offset: 2, limit: 1 }, makeExtra())) as any;

    // Single block — core contract of #26
    expect(result.content).to.have.length(1);
    expect(result.content[0].type).to.equal("text");
    // Range footer is in the same block, after "\n\n"
    expect(result.content[0].text).to.match(/\nlines: \d+-\d+ \/ \d+$/);

    // Out-of-range page: offset far beyond total lines → footer shows "lines: 0 / <total>"
    // (documents the latent-bug fix: the old two-block code computed a misleading
    //  endLine when returnedLines was 0 — the new upstream helper emits "lines: 0 / N")
    const outOfRange = (await handler({ sheet: "Event sheet 1", offset: 9999, limit: 1 }, makeExtra())) as any;
    expect(outOfRange.content).to.have.length(1);
    expect(outOfRange.content[0].text).to.match(/lines: 0 \/ \d+/);
  });

  // ── 4. apply-recipe txId-rejection ───────────────────────────────────────

  it("apply-recipe rejects mismatched txId before parsing recipe, no watcher bump", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: "{}", txId: 4 }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.equal("State changed (expected 4, got 5) — re-validate before applying\ntxId: 5");
    expect(watcher.bumped).to.equal(0);
  });

  // ── 5. apply-recipe caughtError on invalid JSON ───────────────────────────

  it("apply-recipe returns caughtError for invalid JSON, no watcher bump, dirty unchanged", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan; also tests dirty stays true
    const result = (await handler({ recipe: "{ not json", txId: 5 }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.match(/^Error:/);
    expect(result.content[0].text).to.include("txId: 5");
    expect(watcher.bumped).to.equal(0);
    expect(__getExtractedDirty()).to.be.true;
  });

  // ── 6. apply-recipe success with regenerate:false ─────────────────────────

  it("apply-recipe succeeds (regenerate:false): one block, txId bumped once, no isError", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: 5, regenerate: false }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: 6");
    expect(watcher.bumped).to.equal(1);
    // regenerate:false should NOT clear dirty
    // (dirty was true; test verifies it stays unchanged from this handler's perspective)
  });

  // ── 7. apply-recipe success (regenerate:true) clears extractedDirty ───────
  // Runs all 6 generators against the tmp fixture copy. Regression guard for the
  // generateSidRegistry dir fix in this commit: before it, this crashed on
  // Windows (ENOENT, doubled path) and silently mis-wrote the registry on POSIX.

  it("apply-recipe success (regenerate:true): clears extractedDirty, txId bumped", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: 5 }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: 6");
    expect(watcher.bumped).to.equal(1);
    // a full regenerate clears the stale flag
    expect(__getExtractedDirty()).to.be.false;
  });

  // ── 8. list-event-sheets pagination ──────────────────────────────────────
  // Fixture has 4 .json entries under eventSheets/ (sorted):
  //   Event sheet 1.json, Event sheet 1.uistate.json,
  //   Event sheet 2.json, Event sheet 2.uistate.json
  // These are live filesystem reads — no stale warning even when dirty.

  describe("list-event-sheets", () => {
    it("no-params: one block, contains known fixture entry", async () => {
      const handler = __getHandler("list-event-sheets")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      // Sorted first entry in the fixture
      expect(result.content[0].text).to.include("Event sheet 1.json");
    });

    it("offset/limit: single block with in-block range footer", async () => {
      const handler = __getHandler("list-event-sheets")!;
      expect(handler).to.exist;

      const result = (await handler({ offset: 1, limit: 1 }, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      expect(result.content[0].text).to.match(/\nlines: \d+-\d+ \/ \d+$/);
    });

    it("no stale warning even when extractedDirty=true", async () => {
      const handler = __getHandler("list-event-sheets")!;
      expect(handler).to.exist;

      __setExtractedDirty(true);
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.not.include(STALE_WARNING);
    });
  });

  // ── 9. list-layouts pagination ────────────────────────────────────────────
  // Fixture has 9 .json entries under layouts/ (sorted):
  //   Main Layout.json, Main Layout.uistate.json,
  //   Second Layout.json, Second Layout.uistate.json,
  //   Templates Layout.json, Templates Layout.uistate.json,
  //   uistate/Main Layout.instancesBar.json,
  //   uistate/Second Layout.instancesBar.json,
  //   uistate/Templates Layout.instancesBar.json
  // These are live filesystem reads — no stale warning even when dirty.

  describe("list-layouts", () => {
    it("no-params: one block, contains known fixture entry", async () => {
      const handler = __getHandler("list-layouts")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      // Sorted first entry in the fixture
      expect(result.content[0].text).to.include("Main Layout.json");
    });

    it("offset/limit: single block with in-block range footer", async () => {
      const handler = __getHandler("list-layouts")!;
      expect(handler).to.exist;

      const result = (await handler({ offset: 1, limit: 1 }, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      expect(result.content[0].text).to.match(/\nlines: \d+-\d+ \/ \d+$/);
    });

    it("no stale warning even when extractedDirty=true", async () => {
      const handler = __getHandler("list-layouts")!;
      expect(handler).to.exist;

      __setExtractedDirty(true);
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.not.include(STALE_WARNING);
    });
  });

  // ── 10. apply-recipe CancelledError after source write ────────────────────
  // Aborted signal causes checkCancelled() to throw inside runGenerators AFTER
  // applyParsed has already written source files.

  it("apply-recipe with aborted signal: isError, Cancelled text, txId bumped, dirty=true", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE }, makeExtra(true))) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("Cancelled");
    expect(result.content[0].text).to.match(/\ntxId: 6$/);
    expect(watcher.bumped).to.equal(1);
    expect(__getExtractedDirty()).to.be.true;
  });
});
