import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __getHandler, __setRegistry, __wireAllProjects, __resetTestState } from "../../src/mcp/server.js";
import { createProjectContext } from "../../src/mcp/projectContext.js";
import { ProjectRegistry } from "../../src/mcp/projectRegistry.js";
import type { OpsRegistry } from "../../src/mcp/opsRegistry.js";

/**
 * T-W1 — every REGISTERED project gets a live runtime, not just the default.
 *
 * This file exists because of a defect that shipped green through every other
 * suite. `startServer` wired OpsRegistries in a per-project loop but called
 * `setupWatchers(defaultCtx)` once, outside it. `ProjectContext.watcher` uses a
 * definite-assignment assertion, so a non-default context held `undefined`, and
 * the first `ctx.watcher.txId` read threw at runtime — which is most of the
 * tx-tracked surface (`txIdLine`, `compareTxToken`, `get-state`). Multi-project
 * was therefore broken for every project except the default.
 *
 * Nothing caught it because the cross-project suites install contexts through
 * `__setRegistry` and hand each one a fake watcher via `__setTestWatcher`. Those
 * tests prove the LOGIC is right while never executing the wiring that was
 * wrong — a test that supplies the missing piece itself cannot notice that
 * production never supplied it.
 *
 * So these rows deliberately go through `__wireAllProjects()`, the real
 * function `startServer` calls, and assert on contexts that were given NO
 * watcher by the test.
 */
describe("MCP server per-project runtime wiring (#95, T-W1)", () => {
  const tmpRoots: string[] = [];
  let started: OpsRegistry[] = [];

  function tmpProject(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wiring-${name}-`));
    tmpRoots.push(root);
    return root;
  }

  afterEach(() => {
    for (const r of started) r.stop();
    started = [];
    __resetTestState();
  });

  after(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  });

  async function twoProjectRegistry(): Promise<ProjectRegistry> {
    const alpha = await createProjectContext("alpha", tmpProject("alpha"));
    const beta = await createProjectContext("beta", tmpProject("beta"));
    // Deliberately NO watcher assigned here — that is the whole point.
    expect(alpha.watcher, "precondition: alpha starts without a watcher").to.equal(undefined);
    expect(beta.watcher, "precondition: beta starts without a watcher").to.equal(undefined);
    const reg = new ProjectRegistry();
    reg.add(alpha);
    reg.add(beta);
    return reg;
  }

  it("gives every registered project a watcher, not only the default", async () => {
    const reg = await twoProjectRegistry();
    __setRegistry(reg);

    started = __wireAllProjects();

    for (const { id } of reg.list()) {
      const c = reg.get(id)!;
      expect(c.watcher, `${id} must have a watcher after wiring`).to.not.equal(undefined);
      expect(c.watcher.txId, `${id}'s watcher must expose a readable txId`).to.be.a("number");
    }
  });

  it("gives every registered project its own watcher instance", async () => {
    const reg = await twoProjectRegistry();
    __setRegistry(reg);

    started = __wireAllProjects();

    const alpha = reg.get("alpha")!;
    const beta = reg.get("beta")!;
    // A shared watcher would let alpha's write blind beta's external-change
    // detection: suppress() is a per-instance depth counter.
    expect(alpha.watcher).to.not.equal(beta.watcher);
    expect(alpha.ops).to.not.equal(beta.ops);
  });

  it("lets a NON-default project serve a tx-tracked call without throwing", async () => {
    const reg = await twoProjectRegistry();
    __setRegistry(reg);
    started = __wireAllProjects();

    // get-state dereferences ctx.watcher.txId directly. Against a non-default
    // project this threw "Cannot read properties of undefined (reading 'txId')"
    // before the wiring was moved into the per-project loop.
    const handler = __getHandler("get-state")!;
    const result = (await handler({ project: "beta" }, {} as never)) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(result.isError, "get-state against a non-default project must not error").to.not.equal(true);
    expect(result.content[0].text).to.match(/^txId: beta:\d+$/m);
  });
});
