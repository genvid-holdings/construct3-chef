import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectSids,
  mintUniqueSid,
  readRegistryFile,
  freshSidGen,
} from "../../src/c3/sidUtils.js";

const MIN_SID = 1e14;
const MAX_SID = 1e15;

describe("sidUtils", () => {
  describe("collectSids(json)", () => {
    it("returns empty Set for null input", () => {
      const result = collectSids(null);
      assert.equal(result.size, 0);
    });

    it("returns empty Set for undefined input", () => {
      const result = collectSids(undefined);
      assert.equal(result.size, 0);
    });

    it("returns empty Set for non-object input (string)", () => {
      const result = collectSids("hello");
      assert.equal(result.size, 0);
    });

    it("returns empty Set for empty object", () => {
      const result = collectSids({});
      assert.equal(result.size, 0);
    });

    it("returns empty Set for sid-free JSON", () => {
      const result = collectSids({ name: "foo", count: 3 });
      assert.equal(result.size, 0);
    });

    it("collects top-level numeric sid", () => {
      const result = collectSids({ sid: 12345 });
      assert.ok(result.has(12345));
      assert.equal(result.size, 1);
    });

    it("ignores non-numeric sid values", () => {
      const result = collectSids({ sid: "not-a-number" });
      assert.equal(result.size, 0);
    });

    it("collects sids nested in objects", () => {
      const json = {
        outer: {
          sid: 111,
          inner: { sid: 222 },
        },
      };
      const result = collectSids(json);
      assert.ok(result.has(111));
      assert.ok(result.has(222));
      assert.equal(result.size, 2);
    });

    it("collects sids from arrays", () => {
      const json = [{ sid: 10 }, { sid: 20 }, { sid: 30 }];
      const result = collectSids(json);
      assert.ok(result.has(10));
      assert.ok(result.has(20));
      assert.ok(result.has(30));
      assert.equal(result.size, 3);
    });

    it("handles deeply nested mixed structure", () => {
      const json = {
        sid: 1,
        children: [{ sid: 2, actions: [{ sid: 3 }] }, { sid: 4 }],
        meta: { sid: 5 },
      };
      const result = collectSids(json);
      assert.deepEqual(result, new Set([1, 2, 3, 4, 5]));
    });

    it("handles arrays within arrays", () => {
      const json = [[{ sid: 100 }], [{ sid: 200 }]];
      const result = collectSids(json);
      assert.ok(result.has(100));
      assert.ok(result.has(200));
    });
  });

  describe("mintUniqueSid() — stateless", () => {
    it("returns a value in [1e14, 1e15)", () => {
      const used = new Set<number>();
      const sid = mintUniqueSid(used);
      assert.ok(sid >= MIN_SID && sid < MAX_SID, `sid ${sid} out of range`);
    });

    it("mutates the passed Set by adding the minted SID", () => {
      const used = new Set<number>();
      const sid = mintUniqueSid(used);
      assert.ok(used.has(sid), "minted SID was not added to used set");
      assert.equal(used.size, 1);
    });

    it("generates non-colliding SIDs across successive calls against the same Set", () => {
      const used = new Set<number>();
      const sids = new Set<number>();
      for (let i = 0; i < 50; i++) sids.add(mintUniqueSid(used));
      assert.equal(sids.size, 50, "duplicate SIDs minted within one Set");
    });

    it("avoids seeded SIDs", () => {
      const seed = new Set<number>([100000000000001, 100000000000002]);
      const used = new Set(seed);
      for (let i = 0; i < 30; i++) {
        const sid = mintUniqueSid(used);
        assert.ok(!seed.has(sid), `minted a seeded SID: ${sid}`);
      }
    });

    it("does NOT touch any module-level state — calling without prior init still works", () => {
      const used = new Set<number>();
      const sid = mintUniqueSid(used); // should NOT throw despite no prior setup
      assert.ok(sid >= MIN_SID && sid < MAX_SID);
    });

    it("throws after 100 attempts when every draw collides", () => {
      // Stub Math.random to always return the same value, then seed `used` with
      // exactly the SID that value produces. mintUniqueSid will draw it 100 times,
      // each time finding it in `used`, then throw.
      const originalRandom = Math.random;
      try {
        Math.random = () => 0.5; // deterministic — always yields the same SID
        const colliding = Math.floor(0.5 * (MAX_SID - MIN_SID)) + MIN_SID;
        const used = new Set<number>([colliding]);
        assert.throws(
          () => mintUniqueSid(used),
          /failed to find a unique SID after 100 attempts/,
        );
      } finally {
        Math.random = originalRandom;
      }
    });
  });

  describe("readRegistryFile() — pure parser", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "registry-parse-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns a Set of SIDs from the first column, ignoring comments and blanks", () => {
      const registryPath = path.join(tmpDir, "sid-registry.txt");
      writeFileSync(
        registryPath,
        [
          "# header",
          "500000000000001\tlayouts/Main.json\tlayer[0]",
          "",
          "500000000000002\tlayouts/Main.json\tinstance[0]",
        ].join("\n"),
        "utf-8",
      );
      const sids = readRegistryFile(registryPath);
      assert.deepEqual([...sids].sort(), [500000000000001, 500000000000002]);
    });

    it("throws with the correct command name if registry is missing", () => {
      // Guard against the legacy 'npm run generate-c3' message regression.
      const missing = path.join(tmpDir, "nope.txt");
      assert.throws(
        () => readRegistryFile(missing),
        /construct3-chef generate.*sid-registry/,
      );
    });
  });

  describe("freshSidGen()", () => {
    it("returns a SID in [1e14, 1e15)", () => {
      const sidGen = freshSidGen();
      const sid = sidGen();
      assert.ok(sid >= MIN_SID && sid < MAX_SID, `sid ${sid} out of range`);
    });

    it("back-to-back calls don't collide within one generator", () => {
      const sidGen = freshSidGen();
      const sids = new Set<number>();
      for (let i = 0; i < 50; i++) sids.add(sidGen());
      assert.equal(sids.size, 50, "duplicate SIDs minted by one freshSidGen");
    });

    it("two separate freshSidGen() instances are independent (no shared state)", () => {
      // Two generators each minting 30 SIDs — between them, mathematically near-zero
      // collision (range is 9e14), but the contract we're verifying is that they
      // don't share a Set under the hood (which would force serialization).
      const a = freshSidGen();
      const b = freshSidGen();
      const sidsA = new Set<number>();
      const sidsB = new Set<number>();
      for (let i = 0; i < 30; i++) sidsA.add(a());
      for (let i = 0; i < 30; i++) sidsB.add(b());
      assert.equal(sidsA.size, 30);
      assert.equal(sidsB.size, 30);
      // The generators are independent — generator B should not know about A's SIDs.
      // We can't easily prove independence without inspecting internals, but verify
      // they at least produce valid output and don't share a *visible* Set instance.
      assert.notEqual(a, b);
    });
  });
});
