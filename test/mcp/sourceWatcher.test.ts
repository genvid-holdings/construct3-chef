import { describe, it, beforeEach, afterEach } from "mocha";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExpectedChanges, type WatcherFactory } from "genvid-mcp-utils";
import { createSourceWatcher } from "../../src/mcp/sourceWatcher.js";

/**
 * Verifies the OptimisticWatcher wiring before it replaces server.ts's inline
 * txId/suppress/expected machinery. Uses an injected factory so fs events are
 * simulated deterministically (no real fs.watch races).
 */
describe("createSourceWatcher", () => {
  let root: string;
  let expected: ExpectedChanges;
  let fired: string[];
  // Captured (target -> onEvent) from the injected factory.
  let onEventByTarget: Map<string, (filename: string) => void>;
  let factory: WatcherFactory;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "c3chef-watcher-"));
    mkdirSync(path.join(root, "eventSheets"));
    mkdirSync(path.join(root, "layouts"));
    mkdirSync(path.join(root, "objectTypes"));
    // Deliberately omit families/ and scripts/ to exercise the existsSync filter.
    writeFileSync(path.join(root, "project.c3proj"), "{}");

    expected = new ExpectedChanges();
    fired = [];
    onEventByTarget = new Map();
    factory = (target, onEvent) => {
      onEventByTarget.set(path.resolve(target), onEvent);
      return { close: () => {} };
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function build() {
    const watcher = createSourceWatcher({
      projectRoot: root,
      expected,
      onSourceChange: (p) => fired.push(p),
      watcherFactory: factory,
    });
    watcher.start();
    return watcher;
  }

  /** Simulate an fs event for `file` under watched `target`. */
  function emit(target: string, file: string) {
    const onEvent = onEventByTarget.get(path.resolve(root, target));
    assert.ok(onEvent, `no watcher registered for ${target}`);
    onEvent(path.resolve(root, target, file));
  }

  it("watches existing source dirs + project.c3proj, skips missing dirs", () => {
    build();
    const targets = [...onEventByTarget.keys()];
    assert.ok(targets.includes(path.resolve(root, "eventSheets")));
    assert.ok(targets.includes(path.resolve(root, "layouts")));
    assert.ok(targets.includes(path.resolve(root, "objectTypes")));
    assert.ok(targets.includes(path.resolve(root, "project.c3proj")));
    assert.ok(!targets.includes(path.resolve(root, "families")));
    assert.ok(!targets.includes(path.resolve(root, "scripts")));
  });

  it("external source change bumps txId and fires onSourceChange", () => {
    const w = build();
    assert.equal(w.txId, 0);
    emit("eventSheets", "Foo.json");
    assert.equal(w.txId, 1);
    assert.deepEqual(fired, [path.resolve(root, "eventSheets", "Foo.json")]);
  });

  it("external project.c3proj change bumps txId but does NOT fire onSourceChange", () => {
    const w = build();
    const onEvent = onEventByTarget.get(path.resolve(root, "project.c3proj"));
    assert.ok(onEvent);
    onEvent(path.resolve(root, "project.c3proj"));
    assert.equal(w.txId, 1);
    assert.deepEqual(fired, []);
  });

  it("a pre-registered (expected) self-write is suppressed", () => {
    const w = build();
    const target = path.resolve(root, "layouts", "Main.json");
    w.expect(target);
    emit("layouts", "Main.json");
    assert.equal(w.txId, 0, "expected self-write must not bump txId");
    assert.deepEqual(fired, []);
  });

  it("events during suppress() are dropped", async () => {
    const w = build();
    await w.suppress(async () => {
      emit("objectTypes", "Sprite.json");
    });
    assert.equal(w.txId, 0, "suppressed write must not bump txId");
    assert.deepEqual(fired, []);
  });

  it("bump() increments txId (cancelled-write idiom)", () => {
    const w = build();
    w.bump();
    assert.equal(w.txId, 1);
  });
});
