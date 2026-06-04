import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadChefConfig } from "../../src/c3/chefConfig.js";

describe("loadChefConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns schema default when no config file is present", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg).to.deep.equal({ extractedDir: "extracted" });
  });

  it("returns value from config file when present", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "my-extracted" }));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg).to.deep.equal({ extractedDir: "my-extracted" });
  });

  it("override beats file value", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "from-file" }));
    const cfg = await loadChefConfig(tmpDir, { extractedDir: "from-override" });
    expect(cfg.extractedDir).to.equal("from-override");
  });

  it("override beats schema default when no file present", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    const cfg = await loadChefConfig(tmpDir, { extractedDir: "ovr" });
    expect(cfg.extractedDir).to.equal("ovr");
  });

  it("falls back to default when config contains a path-escaping extractedDir", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "../escape" }));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg.extractedDir).to.not.equal("../escape");
    expect(cfg.extractedDir).to.equal("extracted");
  });

  it("falls back to default when config file contains malformed JSON", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), "{ not valid json");
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg).to.deep.equal({ extractedDir: "extracted" });
  });
});
