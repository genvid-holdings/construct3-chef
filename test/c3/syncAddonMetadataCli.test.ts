import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, readFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROJECT_MANIFEST_FILE } from "@genvidtech/c3source";
import { runCli } from "../helpers/runCli.js";
import { seedManifestDrift } from "../helpers/seedManifestDrift.js";

// Wiring-only coverage for the `sync-addon-metadata` CLI subcommand (issue #145,
// #145). The library (src/c3/addonMetadataSync.ts) already has exhaustive unit
// coverage in test/c3/addonMetadataSync.test.ts — this file exists only for the
// handful of assertions that genuinely need a real process boundary: yargs'
// `demandOption` rejection (T1) and the exit-code decision table (T28), plus a
// light pass over `--addon` scoping through the CLI (T27). See test/helpers/runCli.ts
// for why this repo spawns a subprocess only here rather than everywhere.

const SAMPLE_FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const ADDON_VALIDATE_ROOT = path.resolve("test/fixtures/addon-validate");

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "sync-addon-metadata-cli-"));
}

/** A seeded temp COPY of test/fixtures/construct3-chef-sample — never the tracked fixture itself. */
function makeSeededProject(drift: boolean): string {
  const root = makeTempDir();
  seedManifestDrift(
    SAMPLE_FIXTURE_ROOT,
    root,
    drift ? [{ id: "MyCompany_MyBehavior", version: "0.9.0.0", author: "Nobody" }] : [],
  );
  return root;
}

/** A full temp COPY of test/fixtures/addon-validate (has real blocked rows: CorruptZip, LfsPointer). */
function makeCopiedAddonValidateProject(): string {
  const root = makeTempDir();
  cpSync(ADDON_VALIDATE_ROOT, root, { recursive: true });
  return root;
}

describe("sync-addon-metadata CLI wiring", function () {
  // Several `it`s here spawn the real CLI process via tsx (~0.5-2s each) — see
  // test/helpers/runCli.ts. A generous suite-level timeout avoids flaking on a
  // loaded CI runner without needing per-test overrides.
  this.timeout(30_000);

  describe("T1: --direction is demandOption", () => {
    it("rejects with a non-zero exit and yargs' own message, before the handler ever runs", () => {
      const root = makeSeededProject(false);
      try {
        const manifestPath = path.join(root, PROJECT_MANIFEST_FILE);
        const bytesBefore = readFileSync(manifestPath);
        const mtimeBefore = statSync(manifestPath).mtimeMs;

        const result = runCli(["sync-addon-metadata", "--project-dir", root]);

        expect(result.exitCode).to.not.equal(0);
        expect(result.stderr).to.include("Missing required argument: direction");

        const bytesAfter = readFileSync(manifestPath);
        const mtimeAfter = statSync(manifestPath).mtimeMs;
        expect(bytesAfter.equals(bytesBefore)).to.equal(true);
        expect(mtimeAfter).to.equal(mtimeBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("T27: --addon scoping through the CLI", () => {
    it("resolves a discovered addon's resolved id (would-change → exit 1 in read-only mode)", () => {
      const result = runCli([
        "sync-addon-metadata",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--direction",
        "package-from-manifest",
        "--addon",
        "Complete",
      ]);
      expect(result.stdout).to.include("[would-change] Complete");
      expect(result.exitCode).to.equal(1);
    });

    it("resolves a package filename with the .c3addon extension, even though it differs from the resolved id", () => {
      const result = runCli([
        "sync-addon-metadata",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--direction",
        "package-from-manifest",
        "--addon",
        "Misnamed.c3addon",
      ]);
      expect(result.stdout).to.include("[no-manifest-entry] NotMisnamed");
      expect(result.exitCode).to.equal(0);
    });

    it("rejects a path-shaped --addon value with the exact library error, no stack", () => {
      const result = runCli([
        "sync-addon-metadata",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--direction",
        "package-from-manifest",
        "--addon",
        "some/path",
      ]);
      expect(result.stderr.trim()).to.equal("--addon takes an addon id, not a path");
      expect(result.exitCode).to.equal(1);
    });

    it("rejects a '..'-escaping --addon value", () => {
      const result = runCli([
        "sync-addon-metadata",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--direction",
        "package-from-manifest",
        "--addon",
        "../escape",
      ]);
      expect(result.stderr.trim()).to.equal("--addon takes an addon id, not a path");
      expect(result.exitCode).to.equal(1);
    });

    it("rejects an absolute-path --addon value", () => {
      const result = runCli([
        "sync-addon-metadata",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--direction",
        "package-from-manifest",
        "--addon",
        path.resolve(ADDON_VALIDATE_ROOT, "addons/plugin/Complete.c3addon"),
      ]);
      expect(result.stderr.trim()).to.equal("--addon takes an addon id, not a path");
      expect(result.exitCode).to.equal(1);
    });

    it("errors cleanly on an unresolvable id", () => {
      const result = runCli([
        "sync-addon-metadata",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--direction",
        "package-from-manifest",
        "--addon",
        "NoSuchAddon",
      ]);
      expect(result.stderr.trim()).to.equal("Addon 'NoSuchAddon' not found");
      expect(result.exitCode).to.equal(1);
    });
  });

  describe("T28: exit-code decision matrix", () => {
    it("apply, no blocked rows → exit 0", () => {
      const root = makeSeededProject(true); // has a would-change row, but no blocked row
      try {
        const result = runCli(["sync-addon-metadata", "--project-dir", root, "--direction", "manifest-from-package"]);
        expect(result.stdout).to.include("[would-change] MyCompany_MyBehavior");
        expect(result.exitCode).to.equal(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("apply, ≥1 blocked row → exit 1", () => {
      const root = makeCopiedAddonValidateProject();
      try {
        const result = runCli(["sync-addon-metadata", "--project-dir", root, "--direction", "manifest-from-package"]);
        expect(result.stdout).to.include("[blocked] CorruptZip");
        expect(result.stdout).to.include("[blocked] LfsPointer");
        expect(result.exitCode).to.equal(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("dry-run, ≥1 would-change → exit 1, nothing written", () => {
      const root = makeSeededProject(true);
      try {
        const manifestPath = path.join(root, PROJECT_MANIFEST_FILE);
        const bytesBefore = readFileSync(manifestPath);

        const result = runCli([
          "sync-addon-metadata",
          "--project-dir",
          root,
          "--direction",
          "manifest-from-package",
          "--dry-run",
        ]);
        expect(result.stdout).to.include("[would-change] MyCompany_MyBehavior");
        expect(result.stdout).to.include("Nothing written (dry run).");
        expect(result.exitCode).to.equal(1);

        const bytesAfter = readFileSync(manifestPath);
        expect(bytesAfter.equals(bytesBefore)).to.equal(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("dry-run, all in-sync → exit 0", () => {
      const root = makeSeededProject(false);
      try {
        const result = runCli([
          "sync-addon-metadata",
          "--project-dir",
          root,
          "--direction",
          "manifest-from-package",
          "--dry-run",
        ]);
        expect(result.stdout).to.include("0 would-change");
        expect(result.stdout).to.not.include("[would-change]");
        expect(result.exitCode).to.equal(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("package-from-manifest, ≥1 stale (would-change) row → exit 1", () => {
      const result = runCli([
        "sync-addon-metadata",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--direction",
        "package-from-manifest",
      ]);
      expect(result.stdout).to.include("[would-change] Complete");
      expect(result.exitCode).to.equal(1);
    });

    it("manifest unreadable → exit 1, a clean message with no stack trace", () => {
      const root = makeTempDir(); // empty — no project.c3proj at all
      try {
        const result = runCli(["sync-addon-metadata", "--project-dir", root, "--direction", "manifest-from-package"]);
        expect(result.exitCode).to.equal(1);
        expect(result.stderr).to.include(`failed to read ${PROJECT_MANIFEST_FILE}`);
        expect(result.stderr).to.not.include(" at "); // no stack frame lines
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
