import { describe, it } from "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Guards tracked Markdown against links through a **retired GitHub org**.
 *
 * Why this exists: 20 issue links across 7 `wiki/` pages still pointed at
 * `genvid-holdings/`, and `/gvt-dev:audit-conventions` reported the repo
 * clean the entire time. Two independent reasons, either of which alone is
 * sufficient — which is why a local guard is warranted rather than waiting
 * on the upstream fix:
 *
 *   1. The upstream retired-token scanner opens with
 *      `if (line.includes('http')) return;` — commented "provenance/issue URLs
 *      are correct-as-history". Every one of these hits *is* a URL, so the
 *      scanner structurally cannot see them.
 *   2. Its default deny-list is `['genvid:', 'genvid-dev:', 'genvid-c3']`,
 *      which does not contain this org at all, and this repo sets no
 *      `hygiene.retiredTokens` override.
 *
 * Fixing (1) upstream would still leave (2). See ADR 0032.
 *
 * **Scope is the URL form, never the bare token** — and that is what makes the
 * exclusion list empty. `CLAUDE.md` legitimately names the retired org twice in
 * prose: once as `formerly …` provenance, once in the very rule bullet that
 * declares it excluded. Matching the token would flag both; matching
 * `github.com/<org>/` excludes them structurally, with no line-number allow-list
 * to rot. This guard is the exact complement of the upstream scanner: it skips
 * every line containing `http`, this one looks only at those.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Orgs this repo has moved away from. A link through one of these resolves
 * today only because GitHub honours the rename redirect — a courtesy, not a
 * guarantee — and the prose misstates where the repo lives either way.
 */
const RETIRED_ORGS = ["genvid-holdings"];

/**
 * `raw/` is excluded on purpose: it holds immutable source captures, which
 * legitimately preserve retired links as part of the historical record.
 * Pinned by the negative-case row below so the exclusion cannot quietly
 * become "the walk found nothing".
 */
const EXCLUDED_PREFIXES = ["raw/"];

function trackedMarkdown(): string[] {
  const out = execFileSync("git", ["ls-files", "*.md"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function retiredOrgUrls(text: string): string[] {
  const pattern = new RegExp(`github\\.com/(?:${RETIRED_ORGS.join("|")})/[A-Za-z0-9._/-]*`, "g");
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

function scan(files: string[]): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const rel of files) {
    const found = retiredOrgUrls(readFileSync(path.join(REPO_ROOT, rel), "utf-8"));
    if (found.length > 0) hits.set(rel, found);
  }
  return hits;
}

const inScope = (): string[] => trackedMarkdown().filter((f) => !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)));

describe("retired-org links", () => {
  it("has no retired-org URLs in tracked Markdown outside raw/", () => {
    const hits = scan(inScope());
    const report = [...hits].map(([f, urls]) => `${f} (${urls.length}): ${urls.join(", ")}`);
    expect(
      report,
      `Tracked Markdown links through a retired GitHub org:\n  ${report.join("\n  ")}\n` +
        `Repoint each to the current org. Note a link to a *different repo* keeps its own name — ` +
        `verify the destination rather than assuming one path shape.`,
    ).to.deep.equal([]);
  });

  it("deliberately does not police raw/, which preserves retired links as history", () => {
    // Negative case. Without this the exclusion is indistinguishable from a
    // walk that happens to find nothing there — and if raw/ ever does carry a
    // retired link, the row above must still stay green.
    const excluded = trackedMarkdown().filter((f) => EXCLUDED_PREFIXES.some((p) => f.startsWith(p)));
    expect(excluded.length, "no tracked files under raw/ — the exclusion is no longer exercised").to.be.greaterThan(0);
    expect(
      inScope().some((f) => f.startsWith("raw/")),
      "raw/ leaked into the scanned set",
    ).to.equal(false);
  });

  it("finds a plausible corpus and actually detects a planted URL (guards the scanner itself)", () => {
    // Two ways this guard could pass while protecting nothing: the file walk
    // matches zero files, or the pattern matches nothing. Both would make the
    // row above vacuously green against an empty result set.
    expect(inScope().length, "git ls-files matched no Markdown — the walk has gone stale").to.be.greaterThan(40);

    const planted = `see [#1](https://github.com/${RETIRED_ORGS[0]}/some-repo/issues/1) for context`;
    expect(retiredOrgUrls(planted), "the detector no longer recognises a retired-org URL").to.have.lengthOf(1);

    const current = "see [#1](https://github.com/GenvidTechnologies/construct3-chef/issues/1) for context";
    expect(retiredOrgUrls(current), "the detector false-positives on a current-org URL").to.deep.equal([]);
  });
});
