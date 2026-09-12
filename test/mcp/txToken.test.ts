import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createProjectContext, type ProjectContext } from "../../src/mcp/projectContext.js";
import { formatTxToken, parseTxToken, compareTxToken } from "../../src/mcp/txToken.js";

function errorText(r: CallToolResult): string {
  const block = r.content[0];
  return block && block.type === "text" ? (block as { type: "text"; text: string }).text : String(r);
}

/** Stand in for a real OptimisticWatcher: ProjectContext's `watcher` field is
 * declared `!:` for the caller to wire up post-construction (see
 * projectContext.ts), and compareTxToken only ever reads `.txId`. */
function withTxId(ctx: ProjectContext, txId: number): ProjectContext {
  (ctx as unknown as { watcher: { txId: number } }).watcher = { txId };
  return ctx;
}

describe("txToken", () => {
  describe("formatTxToken", () => {
    it("formats id:counter", () => {
      expect(formatTxToken("alpha", 5)).to.equal("alpha:5");
    });

    it("formats a zero counter", () => {
      expect(formatTxToken("alpha", 0)).to.equal("alpha:0");
    });
  });

  describe("parseTxToken", () => {
    it("round-trips a well-formed token", () => {
      const parsed = parseTxToken(formatTxToken("alpha", 5));
      expect(parsed).to.deep.equal({ id: "alpha", counter: 5 });
    });

    it("round-trips a zero counter", () => {
      const parsed = parseTxToken(formatTxToken("alpha", 0));
      expect(parsed).to.deep.equal({ id: "alpha", counter: 0 });
    });

    // Malformed-input table — mirrors the table in src/mcp/txToken.ts's
    // parseTxToken docstring.
    const malformed: Array<[label: string, input: string]> = [
      ["no colon at all", "alpha"],
      ["empty counter segment", "alpha:"],
      ["non-numeric counter", "alpha:xyz"],
      ["empty id segment", ":5"],
      ["empty string", ""],
    ];

    for (const [label, input] of malformed) {
      it(`returns the error variant for ${label} (${JSON.stringify(input)})`, () => {
        const parsed = parseTxToken(input);
        expect(parsed).to.have.property("error");
        expect((parsed as { error: string }).error).to.be.a("string").and.not.empty;
        // Never NaN-propagate: no numeric field, and the error text must not
        // contain the literal "NaN".
        expect(parsed).to.not.have.property("counter");
        expect((parsed as { error: string }).error).to.not.include("NaN");
      });
    }

    it("splits at the LAST colon, so an id containing ':' takes the trailing segment as the counter", () => {
      // Ids may not contain ':' (enforced at ProjectRegistry.add through
      // upstream's isValidProjectId — #217) — this only documents parseTxToken's
      // own behavior as a pure function that doesn't re-validate that invariant.
      const parsed = parseTxToken("alpha:5:6");
      expect(parsed).to.deep.equal({ id: "alpha:5", counter: 6 });
    });
  });

  describe("compareTxToken", () => {
    let root: string;
    let ctx: ProjectContext;

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-txToken-"));
      ctx = await createProjectContext("alpha", root);
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("returns null when the token is undefined — the check stays opt-in", () => {
      withTxId(ctx, 12);
      expect(compareTxToken(ctx, undefined)).to.equal(null);
    });

    it("returns null when the token matches the context's current id and counter", () => {
      withTxId(ctx, 12);
      expect(compareTxToken(ctx, "alpha:12")).to.equal(null);
    });

    it("returns an error for a malformed token, never a thrown exception", () => {
      withTxId(ctx, 12);
      const result = compareTxToken(ctx, "not-a-token");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      expect(errorText(result!)).to.include("Invalid txId");
    });

    it("names BOTH the token's id and the context's id on an id mismatch", () => {
      withTxId(ctx, 12);
      const result = compareTxToken(ctx, "beta:12");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      const text = errorText(result!);
      expect(text).to.include("beta");
      expect(text).to.include("alpha");
    });

    it("uses the existing 'State changed' wording on a counter mismatch, naming both tokens", () => {
      withTxId(ctx, 12);
      const result = compareTxToken(ctx, "alpha:5");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      const text = errorText(result!);
      expect(text).to.include("State changed (expected alpha:5, got alpha:12) — re-validate");
    });

    it("reproduces each call site's trailing verb byte-identically when given an action", () => {
      withTxId(ctx, 12);
      // server.ts words this three ways across its six sites (applying / syncing /
      // scaffolding). The verb names the operation to redo, so threading it keeps
      // the token format the ONLY observable change at those sites.
      for (const action of ["applying", "syncing", "scaffolding"]) {
        const text = errorText(compareTxToken(ctx, "alpha:5", action)!);
        // Assert the whole payload, not just the first line: every rejection also
        // carries the current token as a footer, which is what each call site used
        // to append by hand. Matching only the message would let that footer
        // regress silently -- which is exactly how it was lost once already.
        expect(text).to.equal(
          `State changed (expected alpha:5, got alpha:12) — re-validate before ${action}\ntxId: alpha:12`,
        );
      }
    });

    it("carries the current token as a footer on every rejection path", () => {
      withTxId(ctx, 12);
      // Restores the pre-codec contract: each site rejected with
      // `{ extraLines: [txIdLine(ctx)] }` so a client could re-validate straight
      // away rather than making a second call to learn the value it was just
      // rejected against.
      for (const token of ["alpha:5", "beta:12", "not-a-token"]) {
        expect(errorText(compareTxToken(ctx, token)!), `rejection for ${token}`).to.match(/\ntxId: alpha:12$/);
      }
    });

    it("prefers the id-mismatch error over the counter-mismatch error when both would fire", () => {
      withTxId(ctx, 12);
      // beta:999 mismatches on BOTH id and counter — id mismatch must win, so
      // the message names 'beta' and 'alpha', not a "State changed" text.
      const result = compareTxToken(ctx, "beta:999");
      expect(result).to.not.equal(null);
      const text = errorText(result!);
      expect(text).to.not.include("State changed");
      expect(text).to.include("beta");
      expect(text).to.include("alpha");
    });
  });
});
