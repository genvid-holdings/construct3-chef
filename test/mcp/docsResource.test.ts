import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __getServer } from "../../src/mcp/server.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * #207. @genvidtech/mcp-utils 0.8.0 shipped `exposeDocs`' `docsDir`/
 * `recursive` options plus a real `list` callback for the `docs:///{+path}`
 * template — the shape ADR 0029 named as the flat-alias mechanism's
 * retirement condition. `src/mcp/server.ts` opts in with
 * `{ docsDir: "wiki", recursive: true }`, so the server serves every wiki
 * page at its real nested path and enumerates them all.
 *
 * The two assertions in the "live server" block below were **committed red**
 * one commit before the call site opted in, which is what establishes they
 * are not vacuous: both assert capabilities that did not exist at all before
 * 0.8.0, so neither could have been proven by reverting a fix. Their
 * recorded failure modes were attributable, not incidental — the nested read
 * raised upstream's own `!recursive && name.includes("/")` guard, and the
 * enumeration returned exactly the static `docs:///readme`, i.e. the
 * measured zero template-contributed resources left by `list: undefined`.
 *
 * Keep them paired. Either one alone is weak: a nested read could pass on a
 * flat-but-recursive scan, and enumeration could pass while nested reads
 * stayed broken.
 */
describe("MCP docs resource — packaged tarball (#207)", function () {
  this.timeout(60000);

  let packDir: string;
  let extractDir: string;
  let pkgRoot: string;

  before(function () {
    packDir = mkdtempSync(path.join(os.tmpdir(), "c3chef-pack-"));
    extractDir = mkdtempSync(path.join(os.tmpdir(), "c3chef-extract-"));

    // `npm pack --pack-destination` on Windows needs the `.cmd` shim, which
    // requires `shell: true` to resolve (spawning `npm.cmd` directly fails
    // with EINVAL) — see the same npm-vs-npm.cmd shape documented in
    // package.json's own tooling notes. POSIX runners resolve plain `npm`
    // fine without a shell.
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npmCmd, ["pack", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    expect(tarballs, "npm pack should produce exactly one tarball").to.have.lengthOf(1);
    const tgzPath = path.join(packDir, tarballs[0]);

    // `--force-local` is required on Windows: Git for Windows ships a GNU
    // tar ahead of the System32 bsdtar on PATH, and GNU tar misparses a
    // `C:/...` path as a `host:path` remote-shell spec without it, failing
    // with "tar (child): Cannot connect to C: resolve failed". Harmless
    // (and accepted) on POSIX tar implementations too.
    execFileSync("tar", ["--force-local", "-xzf", tgzPath, "-C", extractDir], { encoding: "utf8" });

    pkgRoot = path.join(extractDir, "package");
  });

  after(function () {
    if (packDir) rmSync(packDir, { recursive: true, force: true });
    if (extractDir) rmSync(extractDir, { recursive: true, force: true });
  });

  it("survival: packaged wiki/reference/cli.md byte-equals wiki/reference/cli.md", () => {
    const packagedPath = path.join(pkgRoot, "wiki", "reference", "cli.md");
    const packaged = readFileSync(packagedPath);
    const source = readFileSync(path.join(REPO_ROOT, "wiki", "reference", "cli.md"));
    expect(packaged.equals(source)).to.equal(true);
  });

  // --- T10: survival assertions -------------------------------------------
  // Both already pass today. They are evidence of nothing on their own —
  // they exist only to be paired with future assertions in this suite, so a
  // regression that breaks README packaging or double-registers exposeDocs
  // is caught by the same suite rather than assumed to still hold.

  it("T10 (survival): README.md is present at the package root", () => {
    expect(readdirSync(pkgRoot)).to.include("README.md");
  });

  it("T10 (survival): src/mcp/server.ts calls exposeDocs( exactly once", () => {
    // Anchored on the call form `exposeDocs(`, not the bare token — the
    // bare identifier also appears in the import list, so a plain-token
    // count would overcount by one (this repo's documented eighth-trap
    // shape: a mention is not a call site).
    const serverSrc = readFileSync(path.join(REPO_ROOT, "src", "mcp", "server.ts"), "utf8");
    const callSites = serverSrc.match(/exposeDocs\(/g) ?? [];
    expect(callSites).to.have.lengthOf(1);
  });
});

/**
 * Drives the live MCP server (not a packed tarball) over an in-memory
 * transport pair, so these assertions exercise the actual `exposeDocs` call
 * site in `src/mcp/server.ts` rather than a packaging artifact. This is the
 * first test in this repo to connect an SDK `Client` to the server — every
 * prior handler test reaches handlers directly via `__getHandler`.
 */
describe("MCP docs resource — live server (#207)", function () {
  let client: Client;

  before(async function () {
    client = new Client({ name: "docsResource-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), __getServer().connect(serverTransport)]);
  });

  after(async function () {
    // Close BOTH ends. The server is a module-level singleton shared with
    // every other test file that imports `src/mcp/server.js`, so leaving it
    // bound to this suite's transport would outlive the suite. Closing the
    // transport does not unregister its tools or resources — the handler
    // table other tests reach through `__getHandler` is a separate module
    // map — so a later file is unaffected either way.
    await client.close();
    await __getServer().close();
  });

  it("a nested page is readable at its path-shaped docs:/// URI", async () => {
    const result = await client.readResource({ uri: "docs:///reference/cli" });
    expect(result.contents).to.have.lengthOf(1);
    const content = result.contents[0] as { text?: string };
    expect(content.text).to.equal(readFileSync(path.join(REPO_ROOT, "wiki", "reference", "cli.md"), "utf8"));
  });

  it("resources/list enumerates at least one template-contributed resource", async () => {
    const result = await client.listResources();
    const templateContributed = result.resources.filter(
      (r) => r.uri.startsWith("docs:///") && r.uri !== "docs:///readme",
    );
    expect(
      templateContributed.length,
      `expected at least one template-contributed docs:/// resource, got: ${JSON.stringify(result.resources)}`,
    ).to.be.at.least(1);
  });
});
