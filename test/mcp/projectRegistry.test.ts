import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createProjectContext, type ProjectContext } from "../../src/mcp/projectContext.js";
import { createSourceWatcher } from "../../src/mcp/sourceWatcher.js";
import { ProjectRegistry, deriveProjectId } from "../../src/mcp/projectRegistry.js";
import { isValidProjectId } from "@genvidtech/mcp-utils";

/**
 * ProjectRegistry is the launch-fixed, id-keyed set of ProjectContexts that
 * `regP` (#95) resolves a tool call's `project` selector
 * against. These tests cover T-B2 (context independence), T-B3 (id
 * derivation/dedup/validation), and T-B4 (resolve() is a pure id lookup,
 * never a path/filesystem operation).
 */
describe("ProjectRegistry / deriveProjectId", () => {
  let tmpRoots: string[];

  beforeEach(() => {
    tmpRoots = [];
  });

  afterEach(() => {
    for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  });

  function mkRoot(prefix: string): string {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), `c3chef-projectRegistry-${prefix}-`));
    tmpRoots.push(r);
    return r;
  }

  /** Wire a no-op watcher onto `ctx.watcher` — createProjectContext leaves it
   *  unassigned for the caller (see projectContext.ts JSDoc). Uses a stub
   *  watcherFactory (no real fs.watch) so `.bump()` is the only thing driving
   *  txId in these tests, matching sourceWatcher.test.ts's own pattern. */
  function wireWatcher(ctx: ProjectContext): void {
    ctx.watcher = createSourceWatcher({
      projectRoot: ctx.root,
      expected: ctx.expected,
      watcherFactory: () => ({ close: () => {} }),
    });
  }

  // ── T-B2: two roots yield two independent contexts ──────────────────────
  describe("context independence (T-B2)", () => {
    it("gives each project its own rwlock, watcher, project handle, and extractedDir", async () => {
      const rootA = mkRoot("a");
      const rootB = mkRoot("b");
      const a = await createProjectContext("a", rootA);
      const b = await createProjectContext("b", rootB);
      wireWatcher(a);
      wireWatcher(b);

      const registry = new ProjectRegistry();
      registry.add(a);
      registry.add(b);

      expect(a.rwlock).to.not.equal(b.rwlock);
      expect(a.watcher).to.not.equal(b.watcher);
      expect(a.project).to.not.equal(b.project);
      expect(a.extractedDir).to.not.equal(b.extractedDir);

      // Mutating one context must never leak into the other.
      const bTxIdBefore = b.watcher.txId;
      a.watcher.bump();
      expect(a.watcher.txId).to.equal(1);
      expect(b.watcher.txId).to.equal(bTxIdBefore);

      expect(registry.get("a")).to.equal(a);
      expect(registry.get("b")).to.equal(b);
    });
  });

  // ── T-B3: id derivation and validation ───────────────────────────────────
  //
  // Two production rules feed the same sanitize() pipeline: a path segment
  // that's already lowercase-hyphenated passes through unchanged
  // ("../game-a" -> "game-a"), and a space is one of the "anything outside
  // [a-z0-9-]" characters collapsed to a hyphen ("Game A" -> "game-a"). Both
  // rows land on "game-a" for consistent reasons, not by coincidence.
  describe("id derivation (T-B3)", () => {
    it("derives from a relative path, basename only", () => {
      expect(deriveProjectId("../game-a")).to.equal("game-a");
    });

    it("lowercases and maps a space to a hyphen", () => {
      expect(deriveProjectId("Game A")).to.equal("game-a");
    });

    it("collapses a run of separators to a single hyphen", () => {
      expect(deriveProjectId("Game   A")).to.equal("game-a");
      expect(deriveProjectId("../game--a")).to.equal("game-a");
    });

    it("dedupes two roots that basename to the same id, warning on stderr", () => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      let captured = "";
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        captured += chunk.toString();
        return true;
      }) as typeof process.stderr.write;
      try {
        const used = new Set<string>();
        const first = deriveProjectId("/projects/sample", used);
        used.add(first);
        const second = deriveProjectId("/other/sample", used);

        expect(first).to.equal("sample");
        expect(second).to.equal("sample-2");
        expect(captured).to.match(/duplicate project id 'sample'/);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("an explicit <id>= spec always wins over derivation", () => {
      expect(deriveProjectId("alpha=../x")).to.equal("alpha");
    });

    it("rejects an id containing ':' at registry construction (the composite-token invariant)", () => {
      const registry = new ProjectRegistry();
      const fake = { id: "bad:id", root: "/fake", extractedDir: "/fake/extracted" } as unknown as ProjectContext;
      expect(() => registry.add(fake)).to.throw(/project ids may not contain ':'/);
    });
  });

  // ── #217: the id guard is the shared wire-format rule, not a local one ────
  //
  // `ProjectRegistry.add` historically guarded only ':'. Measured against the
  // pre-change tree, it ACCEPTED `"al pha"`, `"a\tb"`, and `""` — so chef could
  // mint a project id that `@genvidtech/mcp-utils`' `parseTxToken` rejects,
  // making a chef-minted token unparseable by the other named consumer of this
  // wire format (`c3-domain-manager`). That is an interop defect independent of
  // whether chef ever adopts upstream's codec (deferred to mcp-utils#25).
  //
  // Note the two DISTINCT enforcement points, easily conflated: `EXPLICIT_ID_RE`
  // in `splitSpec` constrains what the explicit `<id>=<path>` branch can PRODUCE
  // (no '/', '\', '='), while `add` validates whatever it is HANDED. `add` never
  // checked those characters — `add("al/pha")` is accepted here and upstream
  // both — so routing `add` through `isValidProjectId` loosens nothing; it is a
  // strict superset of the old ':'-only check.
  describe("the id guard matches upstream's wire-format rule (#217)", () => {
    function addId(id: string): () => void {
      const registry = new ProjectRegistry();
      const fake = { id, root: "/fake", extractedDir: "/fake/extracted" } as unknown as ProjectContext;
      return () => registry.add(fake);
    }

    // R1 — baseline: ACCEPTED before this change.
    it("rejects an id containing a space", () => {
      expect(addId("al pha")).to.throw(/project ids may not contain/);
    });

    // R1 — the vector is whitespace generally, not the space character.
    it("rejects an id containing a tab", () => {
      expect(addId("a\tb")).to.throw(/project ids may not contain/);
    });

    // R2 — baseline: ACCEPTED before this change. A hole nobody had noticed.
    it("rejects an empty id", () => {
      expect(addId("")).to.throw(/project ids may not contain|may not be empty/);
    });

    // R4 — the invariant the rows above exist to establish: what survives `add`
    // must be something upstream can parse back.
    //
    // Stated as an explicit expected-disposition table rather than a
    // conditional. A `if (accepted) expect(isValidProjectId(id)).to.be.true`
    // form is tautological against an implementation whose guard IS
    // `isValidProjectId` — and worse, it contributes NO assertion at all for
    // the whitespace rows, which take the reject branch and fall through. The
    // rows this test names as the regression vector would have been silently
    // unexercised.
    it("derives, validates, and admits each launch spec exactly as upstream's rule dictates", () => {
      const cases: Array<[spec: string, expectedId: string, admitted: boolean]> = [
        ["al pha=/tmp/x", "al pha", false], // explicit branch, space — the regression vector
        ["a\tb=/tmp/x", "a\tb", false], // explicit branch, tab — whitespace generally, not just ' '
        ["alpha=/tmp/x", "alpha", true], // explicit branch, clean
        ["/tmp/some project", "some-project", true], // bare branch -> sanitize() always yields a valid id
        ["/tmp/Weird Name!", "weird-name", true],
        ["/tmp/plain", "plain", true],
      ];
      for (const [spec, expectedId, admitted] of cases) {
        const id = deriveProjectId(spec);
        expect(id, `deriveProjectId(${JSON.stringify(spec)})`).to.equal(expectedId);
        expect(isValidProjectId(id), `isValidProjectId(${JSON.stringify(id)})`).to.equal(admitted);
        if (admitted) {
          expect(addId(id), `add(${JSON.stringify(id)}) should be admitted`).to.not.throw();
        } else {
          expect(addId(id), `add(${JSON.stringify(id)}) should be rejected`).to.throw(/Invalid project id/);
        }
      }
    });

    // R5 — the sanitize() branch must be untouched: a bare path containing
    // spaces is NOT the defect, and must keep deriving a usable id.
    it("leaves the bare-path branch working — spaces there are sanitized, not rejected", () => {
      expect(deriveProjectId("/tmp/some project")).to.equal("some-project");
      expect(deriveProjectId("/tmp/Weird Name!")).to.equal("weird-name");
      expect(addId("some-project")).to.not.throw();
    });
  });

  // ── T-B4: the selector is an id, never a path ────────────────────────────
  describe("resolve() is a pure id lookup, never a path/filesystem operation (T-B4)", () => {
    /**
     * `createProjectContext` (P1, `src/mcp/projectContext.ts`) has no
     * injection seam for `openProject`/`C3Project`, and that file is out of
     * this task's scope to modify. A literal "counting C3Project factory" as
     * the acceptance row names is therefore not constructible without either
     * changing P1's file or monkeypatching `openProject` from the test side —
     * and the latter is verified NOT to work: `@genvidtech/c3source` is a
     * genuine ESM package (`"type": "module"`), so its exported bindings are
     * read-only live bindings; reassigning `c3source.openProject` throws
     * `TypeError: Cannot assign to read only property 'openProject' of
     * object '[object Module]'` (confirmed with a throwaway scratchpad probe
     * this session — not asserted here since it's a fact about the platform,
     * not this codebase).
     *
     * Substituted with a genuinely equivalent two-part proof instead of
     * silently dropping the "no openProject/fs call occurs" half:
     *
     * 1. Below: register contexts that were NEVER constructed via
     *    `createProjectContext`/`openProject` at all — plain duck-typed
     *    objects — and confirm `resolve()` still behaves correctly against
     *    them. If `resolve()`'s logic path depended on `openProject`/`fs` in
     *    any way, it would need to dereference something these fakes don't
     *    have, or reach for an import this module doesn't carry (part 2).
     * 2. The "structural companion" the issue calls "loose" on its own is
     *    strengthened here to name the actual I/O-capable import that
     *    matters — `@genvidtech/c3source` (where `openProject` lives) — not
     *    just `node:path`/`node:fs`. Asserted on the import list, which is
     *    what settles it where a body grep could not distinguish a call from
     *    a comment (CLAUDE.md's own "grep -c overcounts" trap).
     */
    function fakeCtx(id: string, root: string): ProjectContext {
      return { id, root, extractedDir: path.join(root, "extracted") } as unknown as ProjectContext;
    }

    let registry: ProjectRegistry;

    beforeEach(() => {
      registry = new ProjectRegistry();
      registry.add(fakeCtx("game-a", "/fake/game-a"));
      registry.add(fakeCtx("game-b", "/fake/game-b"));
    });

    function isError(r: ProjectContext | CallToolResult): r is CallToolResult {
      return (r as CallToolResult).isError === true;
    }

    for (const sel of ["../other", "C:/tmp", "./x"]) {
      it(`returns an error enumerating known ids for selector '${sel}'`, () => {
        const result = registry.resolve(sel);
        expect(isError(result)).to.equal(true);
        const text = isError(result) ? (result.content[0] as { text: string }).text : "";
        expect(text).to.match(/game-a/);
        expect(text).to.match(/game-b/);
      });
    }

    it("resolves a known id to its exact registered (fake, non-I/O-backed) context", () => {
      const result = registry.resolve("game-a");
      expect(isError(result)).to.equal(false);
      expect(result).to.equal(registry.get("game-a"));
    });

    it("resolves undefined to the default (first-registered) context", () => {
      const result = registry.resolve(undefined);
      expect(isError(result)).to.equal(false);
      expect((result as ProjectContext).id).to.equal("game-a");
    });

    it("imports neither node:path, node:fs, nor @genvidtech/c3source (structural companion)", () => {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/mcp/projectRegistry.ts"), "utf-8");
      const importLines = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
      const importsOf = (specifier: string) => importLines.some((line) => line.includes(`"${specifier}"`));
      expect(importsOf("node:path"), "must not import node:path").to.equal(false);
      expect(importsOf("node:fs"), "must not import node:fs").to.equal(false);
      expect(importsOf("@genvidtech/c3source"), "must not import @genvidtech/c3source").to.equal(false);
    });
  });

  describe("list()", () => {
    it("reports id, root, extractedDir, and isDefault for every registered project", () => {
      const registry = new ProjectRegistry();
      const a = { id: "a", root: "/fake/a", extractedDir: "/fake/a/extracted" } as unknown as ProjectContext;
      const b = { id: "b", root: "/fake/b", extractedDir: "/fake/b/extracted" } as unknown as ProjectContext;
      registry.add(a);
      registry.add(b);

      expect(registry.list()).to.deep.equal([
        { id: "a", root: "/fake/a", extractedDir: "/fake/a/extracted", isDefault: true },
        { id: "b", root: "/fake/b", extractedDir: "/fake/b/extracted", isDefault: false },
      ]);
    });
  });

  describe("add()", () => {
    it("rejects a duplicate id", () => {
      const registry = new ProjectRegistry();
      const a = { id: "a", root: "/fake/a", extractedDir: "/fake/a/extracted" } as unknown as ProjectContext;
      const a2 = { id: "a", root: "/fake/a2", extractedDir: "/fake/a2/extracted" } as unknown as ProjectContext;
      registry.add(a);
      expect(() => registry.add(a2)).to.throw(/Duplicate project id 'a'/);
    });
  });
});
