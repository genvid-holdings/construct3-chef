import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_ONLY, walkFiles, toPosixPath } from "@genvidtech/mcp-utils";
import {
  __getHandler,
  __getToolConfig,
  __listToolNames,
  __setTestWatcher,
  __setExtractedDirty,
  __getExtractedDirty,
  __setProjectRoot,
  __resetTestState,
} from "../../src/mcp/server.js";
import { validateAddons, formatAddonValidation } from "../../src/c3/addonValidator.js";
import { listAddons, formatAddonInventory } from "../../src/c3/addonInventory.js";
import { syncAddonMetadata, formatAddonMetadataSync, type AddonSyncResult } from "../../src/c3/addonMetadataSync.js";
import { SID_SOURCE_DIRS } from "../../src/c3/generators.js";
import { reportStrayFiles } from "../../src/c3/projectSync.js";
import { seedManifestDrift } from "../helpers/seedManifestDrift.js";

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
// Handlers under test only touch watcher.txId, watcher.bump(), watcher.suppress(fn),
// and (sync-addon-metadata, deliberately NOT) watcher.expect(path) — expectCalls
// records calls to prove the latter, T24 below asserts it stays empty.
// Cast to the SDK type when handing to __setTestWatcher.

interface FakeWatcher {
  txId: number;
  bumped: number;
  suppressCalls: number;
  expectCalls: string[];
  bump(): void;
  suppress<T>(fn: () => Promise<T>): Promise<T>;
  expect(filePath: string): void;
}

function makeFakeWatcher(txId = 0): FakeWatcher {
  return {
    txId,
    bumped: 0,
    suppressCalls: 0,
    expectCalls: [],
    bump() {
      this.txId++;
      this.bumped++;
    },
    async suppress<T>(fn: () => Promise<T>): Promise<T> {
      this.suppressCalls++;
      return fn();
    },
    expect(filePath: string) {
      this.expectCalls.push(filePath);
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

// Deterministic mtime control for the checkRegistryFreshness tests below:
// stamps every file under `dir` (recursively) with an explicit mtime, so the
// freshness comparison isn't at the mercy of cpSync/wall-clock ordering.
function setAllMtimesRecursive(dir: string, time: Date): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) setAllMtimesRecursive(full, time);
    else fs.utimesSync(full, time, time);
  }
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
    expect(result.content[0].text).to.equal("txId: default:5\nextractedDirty: false");
  });

  // ── 1b. list-projects: reflects the single-entry registry __setProjectRoot
  //       reseeds (#95) ──────────────────────────────────────────────────

  it("list-projects reports the sole registered project as default", async () => {
    const handler = __getHandler("list-projects")!;
    expect(handler).to.exist;

    const result = (await handler({}, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    const text = result.content[0].text as string;
    expect(text).to.match(/^default \(default\)/);
    expect(text).to.include(`root: ${tmp}`);
    expect(text).to.include(`extractedDir: ${path.join(tmp, "extracted")}`);
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
    const result = (await handler({ recipe: "{}", txId: "default:4" }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.equal(
      "State changed (expected default:4, got default:5) — re-validate before applying\ntxId: default:5",
    );
    expect(watcher.bumped).to.equal(0);
  });

  // ── 5. apply-recipe caughtError on invalid JSON ───────────────────────────

  it("apply-recipe returns caughtError for invalid JSON, no watcher bump, dirty unchanged", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan; also tests dirty stays true
    const result = (await handler({ recipe: "{ not json", txId: "default:5" }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.match(/^Error:/);
    expect(result.content[0].text).to.include("txId: default:5");
    expect(watcher.bumped).to.equal(0);
    expect(__getExtractedDirty()).to.be.true;
  });

  // ── 6. apply-recipe success with regenerate:false ─────────────────────────

  it("apply-recipe succeeds (regenerate:false): one block, txId bumped once, no isError", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: "default:5", regenerate: false }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: default:6");
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
    const result = (await handler({ recipe: VALID_RECIPE, txId: "default:5" }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: default:6");
    expect(watcher.bumped).to.equal(1);
    // a full regenerate clears the stale flag
    expect(__getExtractedDirty()).to.be.false;
  });

  // ── 8. list-event-sheets pagination ──────────────────────────────────────
  // Fixture has 2 real event sheet entries under eventSheets/ (sorted):
  //   Event sheet 1.json, Event sheet 2.json
  // Editor-local exclusion here is an UPSTREAM c3source contract, not a
  // chef-side filter: the handler calls PROJECT.findAllEventSheets(), which
  // routes through c3source's find_all_eventsheets_path, which applies
  // isEditorLocalPath internally. There is nothing in this repo to revert, so
  // K1-K3 below cannot be driven red by reverting a local change — see the
  // three-part anti-vacuity comment above those tests for what substitutes.
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

    // K1-K3: one test per EDITOR_LOCAL_EXCLUSIONS dimension (fileSuffixes,
    // dirs, exactNames — ADR 0016 precedent, see includeTree.test.ts for the
    // same three-dimension split), each replacing the single vacuous test
    // that used to live here. The canonical construct3-sample fixture tracks
    // ZERO *.uistate.json/uistate/ files at every tag (verify-fixture-parity.mjs),
    // so a bare `not.include` against the pristine fixture passes without
    // exercising anything — and since the filter is c3source's, not chef's,
    // there is no local hunk to revert for a genuine red (see the describe-
    // level comment above). Each test below is therefore a THREE-part device:
    //   (i)   an UNFILTERED baseline walk of the same tmp dir proves the
    //         seeded editor-local file and the seeded real file both landed
    //         and are reachable — kills a typo'd/misplaced seed.
    //   (iii) a seeded REAL file (`Seeded Real.json`) proves the handler is
    //         actually reading `tmp` (via __setProjectRoot) and not silently
    //         falling back to the pristine fixture — if __setProjectRoot ever
    //         stopped reassigning PROJECT, the handler would still list the
    //         fixture's 2 real sheets and a bare not.include would still pass.
    //   (ii)  the exclusion count is DERIVED (`baseline.length - 1`), never a
    //         hardcoded literal, so the assertion survives a construct3-sample
    //         pin bump that adds a real sheet to the fixture.
    it("K1 fileSuffixes: excludes an *.uistate.json sibling, includes all real sheets", async () => {
      const esDir = path.join(tmp, "eventSheets");
      fs.writeFileSync(path.join(esDir, "Seeded Real.json"), JSON.stringify({ events: [] }));
      fs.writeFileSync(path.join(esDir, "Event sheet 1.uistate.json"), JSON.stringify({ events: [] }));

      const baseline = walkFiles(esDir, ".json").map((p) => toPosixPath(path.relative(esDir, p)));
      expect(baseline).to.include("Event sheet 1.uistate.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-event-sheets")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("Event sheet 1.uistate.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("K2 dirs: excludes a uistate/ subfolder file, includes all real sheets", async () => {
      const esDir = path.join(tmp, "eventSheets");
      fs.writeFileSync(path.join(esDir, "Seeded Real.json"), JSON.stringify({ events: [] }));
      fs.mkdirSync(path.join(esDir, "uistate"), { recursive: true });
      fs.writeFileSync(path.join(esDir, "uistate", "Hidden.json"), JSON.stringify({ events: [] }));

      const baseline = walkFiles(esDir, ".json").map((p) => toPosixPath(path.relative(esDir, p)));
      expect(baseline).to.include("uistate/Hidden.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-event-sheets")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("uistate/Hidden.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("K3 exactNames: excludes the editor-owned tsconfig.json, includes all real sheets", async () => {
      const esDir = path.join(tmp, "eventSheets");
      fs.writeFileSync(path.join(esDir, "Seeded Real.json"), JSON.stringify({ events: [] }));
      fs.writeFileSync(path.join(esDir, "tsconfig.json"), JSON.stringify({}));

      const baseline = walkFiles(esDir, ".json").map((p) => toPosixPath(path.relative(esDir, p)));
      expect(baseline).to.include("tsconfig.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-event-sheets")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("tsconfig.json");
      expect(lines).to.have.length(baseline.length - 1);
    });
  });

  // ── 9. list-layouts pagination ────────────────────────────────────────────
  // Fixture has 3 real layout entries under layouts/ (sorted):
  //   Main Layout.json, Second Layout.json, Templates Layout.json
  // Editor-local exclusion here is an UPSTREAM c3source contract, not a
  // chef-side filter: the handler calls PROJECT.findAllLayouts(), which
  // routes through c3source's find_all_layouts_path, which applies
  // isEditorLocalPath internally. There is nothing in this repo to revert, so
  // L1-L3 below cannot be driven red by reverting a local change — the same
  // three-part anti-vacuity device documented above list-event-sheets' K1-K3
  // applies here, with ONE difference worth stating explicitly: the baseline
  // walk below uses `walkFiles(layoutsDir, () => true)` with NO `.json`
  // predicate, because find_all_layouts_path itself carries no `.json`
  // filter (only !isEditorLocalPath) — unlike find_all_eventsheets_path. A
  // `.json`-filtered baseline here would make the derived exclusion count
  // wrong.
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

    // L1-L3: the list-event-sheets K1-K3 device, replayed against list-layouts.
    // See the describe-level comment above for why no genuine red is possible
    // here and why the baseline predicate differs (no `.json` filter).
    it("L1 fileSuffixes: excludes an *.uistate.json sibling, includes all real layouts", async () => {
      const layoutsDir = path.join(tmp, "layouts");
      fs.writeFileSync(path.join(layoutsDir, "Seeded Real.json"), JSON.stringify({ layers: [] }));
      fs.writeFileSync(path.join(layoutsDir, "Main Layout.uistate.json"), JSON.stringify({ layers: [] }));

      const baseline = walkFiles(layoutsDir, () => true).map((p) => toPosixPath(path.relative(layoutsDir, p)));
      expect(baseline).to.include("Main Layout.uistate.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-layouts")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("Main Layout.uistate.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("L2 dirs: excludes a uistate/ subfolder file, includes all real layouts", async () => {
      const layoutsDir = path.join(tmp, "layouts");
      fs.writeFileSync(path.join(layoutsDir, "Seeded Real.json"), JSON.stringify({ layers: [] }));
      fs.mkdirSync(path.join(layoutsDir, "uistate"), { recursive: true });
      fs.writeFileSync(path.join(layoutsDir, "uistate", "Hidden.json"), JSON.stringify({ layers: [] }));

      const baseline = walkFiles(layoutsDir, () => true).map((p) => toPosixPath(path.relative(layoutsDir, p)));
      expect(baseline).to.include("uistate/Hidden.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-layouts")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("uistate/Hidden.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("L3 exactNames: excludes the editor-owned tsconfig.json, includes all real layouts", async () => {
      const layoutsDir = path.join(tmp, "layouts");
      fs.writeFileSync(path.join(layoutsDir, "Seeded Real.json"), JSON.stringify({ layers: [] }));
      fs.writeFileSync(path.join(layoutsDir, "tsconfig.json"), JSON.stringify({}));

      const baseline = walkFiles(layoutsDir, () => true).map((p) => toPosixPath(path.relative(layoutsDir, p)));
      expect(baseline).to.include("tsconfig.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-layouts")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("tsconfig.json");
      expect(lines).to.have.length(baseline.length - 1);
    });
  });

  // ── 10. apply-recipe CancelledError after source write ────────────────────
  // Aborted signal causes checkCancelled() to throw inside runGenerators AFTER
  // applyParsed has already written source files.

  // ── 11. navigation-graph ──────────────────────────────────────────────────
  // Fixture has two nav entries:
  //   Event sheet 1 → Second Layout  (line 11 in Event sheet 1.dsl.txt)
  //   Event sheet 2 → Main Layout    (line 7  in Event sheet 2.dsl.txt)

  describe("navigation-graph", () => {
    it("default (table): one block, contains header and fixture nav entries", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      const text: string = result.content[0].text;
      expect(text).to.include("From EventSheet");
      expect(text).to.include("Event sheet 1");
      expect(text).to.include("Second Layout");
    });

    it("format 'plantuml': one block, contains @startuml/@enduml/-->", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      const result = (await handler({ format: "plantuml" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      const text: string = result.content[0].text;
      expect(text).to.include("@startuml");
      expect(text).to.include("@enduml");
      expect(text).to.include("-->");
    });

    it("stale warning: appended when extractedDirty=true, absent when false", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      __setExtractedDirty(true);
      const dirtyResult = (await handler({}, makeExtra())) as any;
      expect(dirtyResult.content[0].text).to.include(STALE_WARNING);

      __setExtractedDirty(false);
      const cleanResult = (await handler({}, makeExtra())) as any;
      expect(cleanResult.content[0].text).to.not.include(STALE_WARNING);
    });

    it("pagination footer: offset/limit yields single block with in-block range footer", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      const result = (await handler({ offset: 0, limit: 1 }, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      expect(result.content[0].text).to.include("lines: ");
    });
  });

  // ── 12. scan-addon-usage txId footer on a behavior scan ──────────────────
  // Fixture carries the MyCompany_MyBehavior behavior addon
  // (addons/behavior/MyCompany_MyBehavior), instantiated on Sprite2/9patch —
  // a read-only tool, so no watcher.bump() and the response carries the
  // CURRENT txId (5, from makeFakeWatcher(5) in beforeEach).

  describe("scan-addon-usage (behavior addon)", () => {
    it("behavior scan response carries the txId footer, no bump, single block", async () => {
      const handler = __getHandler("scan-addon-usage")!;
      expect(handler).to.exist;

      const result = (await handler({ addon: "MyCompany_MyBehavior" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      const text: string = result.content[0].text;
      expect(text).to.match(/\ntxId: default:5$/);
      expect(text).to.include("Sprite2 [MyCustomBehavior]");
      expect(text).to.include("9patch [MyCustomBehavior]");
      expect(watcher.bumped).to.equal(0);
    });
  });

  it("apply-recipe with aborted signal: isError, Cancelled text, txId bumped, dirty=true", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE }, makeExtra(true))) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("Cancelled");
    expect(result.content[0].text).to.match(/\ntxId: default:6$/);
    expect(watcher.bumped).to.equal(1);
    expect(__getExtractedDirty()).to.be.true;
  });

  // ── 13. preview-addon-metadata-sync / sync-addon-metadata (F2) ────────────
  // sync-addon-metadata is the FIRST MUTATE tool in the addon surface — every
  // other addon tool (read-addon, validate-addons, list-addons, diff-addon-aces,
  // scan-addon-usage) is READ_ONLY. `tmp` (the mkdtempSync fixture copy set up
  // in the outer beforeEach) is used directly by these tests, exactly like the
  // apply-recipe MUTATE tests above — never the tracked fixture itself.

  describe("addon-metadata-sync MCP tools", () => {
    // MyCompany_MyBehavior's addon.json (version 1.0.0.0, author Scirra) matches
    // the PRISTINE fixture's usedAddons entry exactly (see
    // test/c3/addonMetadataSync.test.ts's makeSeededProject) — seeding this drift
    // and then successfully applying manifest-from-package must reproduce
    // project.c3proj byte-for-byte against FIXTURE_DIR's pristine copy.
    function seedDrift(): void {
      seedManifestDrift(FIXTURE_DIR, tmp, [{ id: "MyCompany_MyBehavior", version: "0.9.0.0", author: "Nobody" }]);
    }

    it("T2: direction is a required (non-optional) z.enum on both tools — the schema rejects a missing/invalid value before either handler body runs", () => {
      for (const name of ["preview-addon-metadata-sync", "sync-addon-metadata"]) {
        const config = __getToolConfig(name);
        expect(config, `${name} should be registered`).to.exist;
        const schema = z.object(config!.inputSchema as Record<string, z.ZodTypeAny>);

        expect(schema.safeParse({}).success, `${name}: missing direction should be rejected`).to.equal(false);
        expect(
          schema.safeParse({ direction: "bogus" }).success,
          `${name}: invalid direction should be rejected`,
        ).to.equal(false);
        expect(
          schema.safeParse({ direction: "manifest-from-package" }).success,
          `${name}: a valid direction should be accepted`,
        ).to.equal(true);
      }
      expect(watcher.bumped).to.equal(0);
    });

    it("T20: validate-addons and list-addons keep READ_ONLY annotations and byte-identical output; neither module imports addonMetadataSync", async () => {
      expect(__getToolConfig("validate-addons")!.annotations).to.deep.equal(READ_ONLY);
      expect(__getToolConfig("list-addons")!.annotations).to.deep.equal(READ_ONLY);

      const validateHandler = __getHandler("validate-addons")!;
      const validateResult = (await validateHandler({}, makeExtra())) as any;
      expect(validateResult.content[0].text).to.equal(`${formatAddonValidation(validateAddons(tmp))}\ntxId: default:5`);

      const listHandler = __getHandler("list-addons")!;
      const listResult = (await listHandler({}, makeExtra())) as any;
      expect(listResult.content[0].text).to.equal(`${formatAddonInventory(listAddons(tmp))}\ntxId: default:5`);

      // A prose cross-reference to addonMetadataSync.ts (its module doc comment
      // names the sibling module by design — see the "Duality note" above
      // checkMetadataMismatch) is fine; an actual `import ... from
      // "./addonMetadataSync.js"` is the regression this guards against.
      for (const modulePath of ["src/c3/addonValidator.ts", "src/c3/addonInventory.ts"]) {
        const source = fs.readFileSync(path.resolve(modulePath), "utf-8");
        expect(source, `${modulePath} should not import addonMetadataSync`).to.not.match(
          /from\s+["']\.\/addonMetadataSync\.js["']/,
        );
      }
    });

    it("T21: sync-addon-metadata rejects a stale txId BEFORE any write, does not bump, response carries txId", async () => {
      seedDrift();
      const manifestPath = path.join(tmp, "project.c3proj");
      const before = fs.readFileSync(manifestPath);

      const handler = __getHandler("sync-addon-metadata")!;
      const result = (await handler({ direction: "manifest-from-package", txId: "default:4" }, makeExtra())) as any;

      expect(result.isError).to.be.true;
      expect(result.content).to.have.length(1);
      expect(result.content[0].text).to.equal(
        "State changed (expected default:4, got default:5) — re-validate before syncing\ntxId: default:5",
      );
      expect(watcher.bumped).to.equal(0);
      expect(fs.readFileSync(manifestPath).equals(before), "manifest bytes must be unchanged").to.equal(true);
    });

    it("T22: a successful apply writes exactly one content block with a txId footer, bumps exactly once, and leaves extractedDirty unchanged", async () => {
      seedDrift();
      expect(__getExtractedDirty()).to.equal(false);

      const handler = __getHandler("sync-addon-metadata")!;
      const result = (await handler({ direction: "manifest-from-package", txId: "default:5" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      expect(result.content[0].text).to.include("txId: default:6");
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.equal(false);

      const written = fs.readFileSync(path.join(tmp, "project.c3proj"));
      const pristine = fs.readFileSync(path.join(FIXTURE_DIR, "project.c3proj"));
      expect(written.equals(pristine), "restored manifest should equal the pristine fixture byte-for-byte").to.equal(
        true,
      );
    });

    it("T23: preview, a package-from-manifest sync, and a no-drift apply never call bump(); extractedDirty stays unchanged", async () => {
      // Deliberately NOT seeded — the pristine fixture has no drift, so a
      // manifest-from-package apply here is the no-write branch.
      const previewHandler = __getHandler("preview-addon-metadata-sync")!;
      const previewResult = (await previewHandler({ direction: "manifest-from-package" }, makeExtra())) as any;
      expect(previewResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      const syncHandler = __getHandler("sync-addon-metadata")!;

      const packageFromManifestResult = (await syncHandler(
        { direction: "package-from-manifest", txId: `default:${watcher.txId}` },
        makeExtra(),
      )) as any;
      expect(packageFromManifestResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      const noDriftResult = (await syncHandler(
        { direction: "manifest-from-package", txId: `default:${watcher.txId}` },
        makeExtra(),
      )) as any;
      expect(noDriftResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      expect(__getExtractedDirty()).to.equal(false);
    });

    it("T24: the manifest write happens INSIDE watcher.suppress, and watcher.expect is never called", async () => {
      seedDrift();
      const manifestPath = path.join(tmp, "project.c3proj");

      let changedDuringSuppress = false;
      const trackingWatcher = makeFakeWatcher(5);
      trackingWatcher.suppress = async <T>(fn: () => Promise<T>): Promise<T> => {
        trackingWatcher.suppressCalls++;
        const before = fs.readFileSync(manifestPath);
        const result = await fn();
        const after = fs.readFileSync(manifestPath);
        changedDuringSuppress = !before.equals(after);
        return result;
      };
      __setTestWatcher(trackingWatcher as any);

      const handler = __getHandler("sync-addon-metadata")!;
      const result = (await handler({ direction: "manifest-from-package", txId: "default:5" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(trackingWatcher.suppressCalls).to.equal(1);
      expect(changedDuringSuppress, "the manifest write should happen inside the suppress window").to.equal(true);
      expect(trackingWatcher.expectCalls).to.deep.equal([]);
    });

    it("T25: MCP response text equals formatAddonMetadataSync's direct render of the same result — both surfaces route through the shared formatter", async () => {
      seedDrift();

      const previewHandler = __getHandler("preview-addon-metadata-sync")!;
      const previewResult = (await previewHandler({ direction: "manifest-from-package" }, makeExtra())) as any;

      const expected = syncAddonMetadata(tmp, { direction: "manifest-from-package", dryRun: true });
      expect("error" in expected, "expected a success result").to.equal(false);
      expect(previewResult.content[0].text).to.equal(
        `${formatAddonMetadataSync(expected as AddonSyncResult)}\ntxId: default:5`,
      );

      // Both tools must render via the shared formatter — not hand-built strings.
      const serverSource = fs.readFileSync(path.resolve("src/mcp/server.ts"), "utf-8");
      const callCount = (serverSource.match(/formatAddonMetadataSync\(/g) ?? []).length;
      expect(callCount, "both tools should call formatAddonMetadataSync").to.be.at.least(2);
    });
  });

  // ── 14. checkRegistryFreshness excludes editor-local paths (ADR 0018 site 2) ─
  // generate-sids is the only handler whose response surfaces the effect of
  // checkRegistryFreshness's own scan directly (via appendStaleWarning), rather
  // than a stale flag set earlier by something else — so it's the right probe.
  // Mtimes are set explicitly (utimesSync) on every real source file plus the
  // registry, never relying on wall-clock/cpSync ordering.

  describe("checkRegistryFreshness (generate-sids probe)", () => {
    const BASELINE = new Date(2020, 0, 1);
    const NEWER = new Date(BASELINE.getTime() + 100_000);

    function pinBaseline(): void {
      for (const dir of SID_SOURCE_DIRS) {
        setAllMtimesRecursive(path.join(tmp, dir), BASELINE);
      }
      fs.utimesSync(path.join(tmp, "extracted", "sid-registry.txt"), BASELINE, BASELINE);
    }

    it("a newer *.uistate.json sibling under layouts/ does NOT set extractedDirty or bump", async () => {
      pinBaseline();
      const uistatePath = path.join(tmp, "layouts", "Main Layout.uistate.json");
      fs.writeFileSync(uistatePath, "{}");
      fs.utimesSync(uistatePath, NEWER, NEWER);

      const handler = __getHandler("generate-sids")!;
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.not.include(STALE_WARNING);
      expect(__getExtractedDirty()).to.equal(false);
      expect(watcher.bumped).to.equal(0);
    });

    it("positive control: a newer REAL layouts/*.json file DOES set extractedDirty and bump", async () => {
      pinBaseline();
      const layoutPath = path.join(tmp, "layouts", "Main Layout.json");
      fs.utimesSync(layoutPath, NEWER, NEWER);

      const handler = __getHandler("generate-sids")!;
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.include(STALE_WARNING);
      expect(__getExtractedDirty()).to.equal(true);
      expect(watcher.bumped).to.equal(1);
    });
  });

  // ── 15. [strays] detection-only report at the MCP surfaces (#177) ───────────
  // KNOWN-RED at the commit that introduces these two rows: nothing in
  // `server.ts` emits a `[strays]` line until the wiring task lands. Their red
  // state is the structural revert-confirm that the wiring is load-bearing.
  //
  // Both rows re-point PROJECT_ROOT at their OWN synthetic temp-dir project
  // rather than the fixture copy the outer beforeEach seeds: `detectStrayFiles`
  // returns `[]` on `construct3-chef-sample` and `verify-fixture-parity.mjs`
  // forbids adding a stray there, so a fixture-based assertion here would pass
  // vacuously (the #149/#175 shape). The reporter-behaviour rows live in
  // `test/c3/strayFileReport.test.ts`; these two exist only for the MCP wiring.

  describe("[strays] report (#177)", () => {
    let strayRoot: string;

    /**
     * A shape-valid, in-sync project. Two traps encoded here: each section's
     * `items` is a `string[]` of BARE NAMES (not objects carrying a `sid`), and
     * the `rootFileFolders` key for the general file folder is `general`, NOT
     * `file`. Getting either wrong throws `Could not parse … as JSON` out of
     * `readProjectManifest` — a seeding failure, not the missing-`[strays]`-line
     * failure these rows are meant to produce.
     */
    function seedStrayProject(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-strays-"));
      const empty = () => ({ items: [] as string[], subfolders: [] as unknown[] });
      const manifest = {
        projectFormatVersion: 1,
        savedWithRelease: 49500,
        name: "StrayReportProbe",
        runtime: "c3",
        usedAddons: [],
        containers: [],
        layouts: { items: ["MainLayout"], subfolders: [] },
        eventSheets: empty(),
        families: empty(),
        objectTypes: empty(),
        timelines: empty(),
        flowcharts: empty(),
        rootFileFolders: {
          script: empty(),
          sound: empty(),
          music: empty(),
          video: empty(),
          font: empty(),
          icon: empty(),
          general: empty(),
        },
      };
      fs.writeFileSync(path.join(root, "project.c3proj"), JSON.stringify(manifest, undefined, "\t"));
      fs.mkdirSync(path.join(root, "layouts"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "layouts", "MainLayout.json"),
        JSON.stringify({ name: "MainLayout", layers: [] }, null, "\t"),
      );
      fs.writeFileSync(path.join(root, "layouts", "notes.txt"), "a stray note\n");
      return root;
    }

    function strayLinesOf(text: string): string[] {
      return text.split("\n").filter((l) => l.startsWith("[strays]"));
    }

    /**
     * Mirrors `seedStrayProject()`, but `project.c3proj` is the literal
     * `{ NOT JSON` — unparseable — so `runSync`'s top-of-function
     * `readProjectManifest` throws. Seeds TWO stray files under `layouts/`
     * (not one) so T13's order assertion below is meaningful. Callers own
     * cleanup: this does not participate in the `strayRoot`/`afterEach` pair
     * above, since T12/T13 need a distinct root from the shape-valid seed the
     * other rows in this block use.
     */
    function seedUnparseableStrayProject(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-strays-unparseable-"));
      fs.mkdirSync(path.join(root, "layouts"), { recursive: true });
      fs.writeFileSync(path.join(root, "project.c3proj"), "{ NOT JSON");
      fs.writeFileSync(path.join(root, "layouts", "notes.txt"), "a stray note\n");
      fs.writeFileSync(path.join(root, "layouts", "scratch.txt"), "another stray note\n");
      return root;
    }

    beforeEach(() => {
      strayRoot = seedStrayProject();
      __setProjectRoot(strayRoot);
    });

    afterEach(() => {
      fs.rmSync(strayRoot, { recursive: true, force: true });
    });

    it("R2: scaffold-layout emits no [strays] lines, while validate-project on the same project does", async () => {
      const scaffold = __getHandler("scaffold-layout")!;
      expect(scaffold).to.exist;

      const scaffolded = (await scaffold(
        {
          source: "MainLayout.json",
          name: "ClonedLayout",
          path: "ClonedLayout.json",
          eventSheet: "MainEvents",
          regenerate: false,
        },
        makeExtra(),
      )) as any;

      // The scaffold must actually SUCCEED — an error response would contain no
      // `[strays]` line for the wrong reason, making the assertion below vacuous.
      expect(scaffolded.isError, scaffolded.content[0].text).to.be.undefined;
      expect(strayLinesOf(scaffolded.content[0].text)).to.deep.equal([]);

      // Positive control on the SAME project: validate-project does report it,
      // so the absence above is a deliberate scope boundary and not an artifact
      // of the seed carrying no stray at all.
      const validate = __getHandler("validate-project")!;
      const validated = (await validate({}, makeExtra())) as any;
      expect(validated.content[0].text).to.include("! layouts/notes.txt");
    });

    it("R15: the MCP validate-project block's [strays] lines are byte-identical to the reporter's", async () => {
      fs.writeFileSync(path.join(strayRoot, "layouts", "another.md"), "# also stray\n");

      const expected: string[] = [];
      reportStrayFiles(strayRoot, (m) => expected.push(m));
      expect(expected.length, "seed must produce at least two stray rows for order to be meaningful").to.be.at.least(2);

      const validate = __getHandler("validate-project")!;
      const validated = (await validate({}, makeExtra())) as any;

      // Order included — the CLI and MCP surfaces render through the same
      // reporter, so their `[strays]` output must not drift.
      expect(strayLinesOf(validated.content[0].text)).to.deep.equal(expected);
    });

    it("R16: both tools that emit [strays] lines document the report in their description", () => {
      for (const name of ["validate-project", "sync-project"]) {
        const config = __getToolConfig(name);
        expect(config, `${name} should be registered`).to.exist;
        expect(config!.description, `${name} description should mention the stray report`).to.match(/stray/i);
      }
    });

    it("T17: MCP validate-project gains no stray-gating input", () => {
      // Exit-code gating is CLI-only (--fail-on-strays); MCP reports findings in
      // the text block and reserves isError for genuine tool failure (ADR 0025
      // decision 4), so validate-project's inputSchema must stay free of any
      // stray-gating key. The sync-project/txId assertion below is a MANDATORY
      // positive control: without it, the zero-hit check on validate-project
      // would pass just as happily if __getToolConfig returned undefined, an
      // empty object, or the wrong tool entirely — the vacuous-negative shape
      // this repo has shipped twice.
      const validateConfig = __getToolConfig("validate-project");
      expect(validateConfig, "validate-project should be registered").to.exist;
      const validateKeys = Object.keys(validateConfig!.inputSchema as Record<string, z.ZodTypeAny>);
      expect(
        validateKeys.some((key) => /strays?/i.test(key)),
        `validate-project inputSchema keys: ${validateKeys.join(", ")}`,
      ).to.equal(false);

      const syncConfig = __getToolConfig("sync-project");
      expect(syncConfig, "sync-project should be registered").to.exist;
      const syncKeys = Object.keys(syncConfig!.inputSchema as Record<string, z.ZodTypeAny>);
      expect(syncKeys, `sync-project inputSchema keys: ${syncKeys.join(", ")}`).to.include("txId");
    });

    // ── T12/T13 — [strays] survives a manifest failure (#184) ─────────────────
    // KNOWN-RED at the commit that introduces these two rows: `runSync` parses
    // `project.c3proj` at the very top and throws on unparseable JSON, and the
    // outer `withMcpErrors` catches that and returns `mcpError(...)` BEFORE
    // `reportImageDrift`/`reportStrayFiles` ever run — so the response text
    // carries no `[strays]` line at all. The later wiring task (not this one)
    // moves the throw into an inner try/catch so both reporters still run
    // alongside the error. This red state is the structural revert-confirm
    // that the wiring is genuinely load-bearing, matching the committed-red
    // discipline `test/c3/strayFileTolerance.test.ts` already uses.

    it("T12: MCP validate-project reports strays past a manifest failure", async () => {
      const unparseableRoot = seedUnparseableStrayProject();
      __setProjectRoot(unparseableRoot);
      try {
        const validate = __getHandler("validate-project")!;
        const result = (await validate({}, makeExtra())) as any;

        // The contract is DELIBERATELY UNCHANGED here: the tool genuinely
        // failed to parse the manifest, so the response must still be
        // isError — the diagnostics ride ALONGSIDE the failure, they do not
        // turn it into a success. A reader seeing [strays] lines below might
        // otherwise assume the fix flips this to a success response; it does
        // not.
        expect(result.isError).to.equal(true);
        expect(result.content[0].text).to.include("Could not parse");
        expect(result.content[0].text).to.include("! layouts/notes.txt");
      } finally {
        fs.rmSync(unparseableRoot, { recursive: true, force: true });
      }
    });

    it("T13: the MCP error block's [strays] lines are byte-identical to the reporter's", async () => {
      const unparseableRoot = seedUnparseableStrayProject();
      __setProjectRoot(unparseableRoot);
      try {
        const expected: string[] = [];
        reportStrayFiles(unparseableRoot, (m) => expected.push(m));
        expect(expected.length, "seed must produce at least two stray rows for order to be meaningful").to.be.at.least(
          2,
        );

        const validate = __getHandler("validate-project")!;
        const result = (await validate({}, makeExtra())) as any;

        // Order included — the error block must render the SAME reporter
        // output the success path does, just alongside the failure text.
        expect(strayLinesOf(result.content[0].text)).to.deep.equal(expected);
      } finally {
        fs.rmSync(unparseableRoot, { recursive: true, force: true });
      }
    });
  });

  // ── writeSourceJson wiring — no trailing newline on real write paths ──────
  // (#195 T3). T1/T2 proved writeSourceJson itself
  // (test/c3/sourceJson.test.ts) and wired every C3-source write site onto
  // it. This proves the WIRING: a real mutate path (apply-recipe →
  // objectTypes/Text.json) and real create paths (scaffold-layout,
  // scaffold-sprite) still land bytes with no trailing newline when driven
  // end-to-end through the MCP handlers — not just through the helper in
  // isolation, which a stray bare `writeFileSync` reintroduced at a call
  // site would not be caught by. Reads a Buffer and asserts on the raw last
  // byte, since a string `.endsWith()` check can't distinguish "no trailing
  // newline" from "file happens to not end in whitespace" as precisely.

  describe("writeSourceJson wiring — no trailing newline on real write paths (#195 T3)", () => {
    function assertNoTrailingNewline(filePath: string, expectedByte: 0x7d | 0x5d): void {
      const buf = fs.readFileSync(filePath);
      const last = buf[buf.length - 1];
      expect(last, `last byte was 0x${last.toString(16)}, expected 0x${expectedByte.toString(16)}`).to.equal(
        expectedByte,
      );
      expect(last, "last byte must never be a trailing newline (0x0a)").to.not.equal(0x0a);
    }

    it("mutate path: apply-recipe (addInstVars) writes objectTypes/Text.json ending in '}', no trailing newline", async () => {
      const handler = __getHandler("apply-recipe")!;
      expect(handler).to.exist;

      __setExtractedDirty(true); // skip registry freshness scan
      const result = (await handler(
        { recipe: VALID_RECIPE, txId: "default:5", regenerate: false },
        makeExtra(),
      )) as any;

      expect(result.isError, result.content?.[0]?.text).to.be.undefined;

      assertNoTrailingNewline(path.join(tmp, "objectTypes", "Text.json"), 0x7d);
    });

    it("create path: scaffold-layout writes a new layout JSON ending in '}', no trailing newline", async () => {
      const handler = __getHandler("scaffold-layout")!;
      expect(handler).to.exist;

      const result = (await handler(
        {
          source: "Main Layout.json",
          name: "T3ClonedLayout",
          path: "T3ClonedLayout.json",
          eventSheet: "Event sheet 1",
          regenerate: false,
        },
        makeExtra(),
      )) as any;

      expect(result.isError, result.content?.[0]?.text).to.be.undefined;

      assertNoTrailingNewline(path.join(tmp, "layouts", "T3ClonedLayout.json"), 0x7d);
    });

    it("create path: scaffold-sprite writes a new objectType JSON ending in '}', no trailing newline", async () => {
      const handler = __getHandler("scaffold-sprite")!;
      expect(handler).to.exist;

      const result = (await handler({ source: "Text", name: "T3ClonedSprite" }, makeExtra())) as any;

      expect(result.isError, result.content?.[0]?.text).to.be.undefined;

      assertNoTrailingNewline(path.join(tmp, "objectTypes", "T3ClonedSprite.json"), 0x7d);
    });
  });
});

// ── Project-scoped tool registration (#95) ──────────────────────────────
// Independent of the FIXTURE_DIR/watcher/tmp-project scaffolding above —
// __getToolConfig/__listToolNames read the module-level `toolConfigs` map
// populated once at import time by every `reg`/`regP` call, not per-project
// state, so this suite needs no beforeEach/afterEach of its own.

describe("MCP server project-scoped tool registration (#95)", () => {
  // list-projects is the sole exemption from the `project` selector every
  // other tool accepts via `regP` — it enumerates the registry, so it
  // cannot itself belong to one project (see server.ts's own comment above
  // the list-projects registration).
  const EXEMPT = ["list-projects"];

  it("T-C1: every non-exempt registered tool declares a 'project' input param", () => {
    const names = __listToolNames();

    // Positive control: derived from the LIVE handler registry, so a
    // registry that silently enumerates nothing (e.g. a broken import path)
    // cannot pass this assertion vacuously.
    expect(names.length, `registered tool count: ${names.length}`).to.be.greaterThan(30);

    const nonExempt = names.filter((n) => !EXEMPT.includes(n));
    expect(nonExempt.length, "non-exempt tool count").to.be.greaterThan(30);

    for (const name of nonExempt) {
      const config = __getToolConfig(name);
      expect(config, `${name}: no registered tool config`).to.exist;
      const inputSchema = config!.inputSchema as Record<string, z.ZodTypeAny> | undefined;
      expect(inputSchema, `${name}: no inputSchema`).to.exist;
      expect(inputSchema!.project, `${name}: missing 'project' input param`).to.exist;
    }
  });

  it("T-C1b: the sole exemption (list-projects) does NOT declare a 'project' param", () => {
    const config = __getToolConfig("list-projects");
    expect(config, "list-projects: no registered tool config").to.exist;
    const inputSchema = config!.inputSchema as Record<string, z.ZodTypeAny> | undefined;
    expect(inputSchema?.project, "list-projects unexpectedly gained a 'project' param").to.be.undefined;
  });
});
