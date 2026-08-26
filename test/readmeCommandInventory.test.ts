import { describe, it } from "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards the README's CLI inventory against `src/cli.ts`.
 *
 * Why this exists: `README.md` is what npmjs.com renders for the published
 * package, and its command table had silently fallen three commands behind
 * (`list-addons`, `diff-addon-aces`, `scan-addon-usage` — the whole read-only
 * half of the #100 addon-tooling cluster) while claiming "17 subcommands"
 * against an actual 21. Adding a subcommand touches ~6 sites; four of them
 * drifted without anything going red.
 *
 * `CLAUDE.md` documents the analogous "adding a generator touches ~10 sites in
 * lockstep" — and that lockstep is documented and *still* drifts. Documentation
 * alone demonstrably does not hold this invariant, so it is asserted instead.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");
const README_PATH = path.join(REPO_ROOT, "README.md");
const SERVER_PATH = path.join(REPO_ROOT, "src", "mcp", "server.ts");
const OPS_REGISTRY_PATH = path.join(REPO_ROOT, "src", "mcp", "opsRegistry.ts");

/**
 * Command names registered via yargs in `src/cli.ts`.
 *
 * The registrations are **multi-line** — `.command(` sits on its own line and
 * the command string is on the next — which is exactly why casual grepping
 * missed the drift. Match across the newline, then keep the leading token so
 * positional args (`diff-addon-aces <from> <to>`) reduce to the bare name.
 */
function registeredCommands(): string[] {
  const src = readFileSync(CLI_PATH, "utf-8");
  const names = [...src.matchAll(/\.command\(\s*\n\s*"([^"]+)"/g)].map((m) => m[1].split(/\s+/)[0]);
  return [...new Set(names)].sort();
}

/**
 * Command names in the README's `## CLI Overview` table.
 *
 * Scoped to that section deliberately: the file also carries an MCP **tool**
 * table, whose names overlap but are a different surface (`read-dsl`,
 * `resolve-anchor`, … are tools, never subcommands). Matching table rows
 * file-wide would conflate the two and make this assertion meaningless.
 *
 * That scoping is still right, but it is no longer the whole story: the MCP
 * surface has its own guard below (`README MCP tool inventory`), added by #199.
 * The two stay separate parsers over separate sections rather than one merged
 * one — conflating them is exactly what this comment warns against.
 */
function readmeCommands(): string[] {
  const readme = readFileSync(README_PATH, "utf-8");
  const start = readme.indexOf("## CLI Overview");
  expect(start, "README is missing its '## CLI Overview' heading").to.be.greaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);

  const names = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1].split(/\s+/)[0]);
  return [...new Set(names)].sort();
}

describe("README CLI inventory", () => {
  it("documents every command src/cli.ts registers", () => {
    const missing = registeredCommands().filter((c) => !readmeCommands().includes(c));
    expect(
      missing,
      `Registered in src/cli.ts but absent from the README '## CLI Overview' table: ${missing.join(", ")}. ` +
        `Add a row for each, and update the subcommand count in the same section.`,
    ).to.deep.equal([]);
  });

  it("does not document a command src/cli.ts no longer registers", () => {
    const stale = readmeCommands().filter((c) => !registeredCommands().includes(c));
    expect(
      stale,
      `Listed in the README '## CLI Overview' table but not registered in src/cli.ts: ${stale.join(", ")}. ` +
        `Remove the row, or restore the registration if the removal was accidental.`,
    ).to.deep.equal([]);
  });

  it("states a subcommand count matching the registered total", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    const stated = readme.match(/^(\d+) subcommands\b/m);
    expect(stated, "README's '## CLI Overview' no longer states an 'N subcommands' count").to.not.equal(null);
    expect(
      Number(stated![1]),
      `README says "${stated![1]} subcommands" but src/cli.ts registers ${registeredCommands().length}.`,
    ).to.equal(registeredCommands().length);
  });

  it("finds a plausible number of commands on both sides (guards the parsers themselves)", () => {
    // Without this, a regex that silently stops matching — a formatting change
    // in either file — would make both set comparisons above pass vacuously on
    // two empty sets. Same trap as the uistate assertions in #149.
    expect(
      registeredCommands().length,
      "parsed no commands out of src/cli.ts — the regex has gone stale",
    ).to.be.greaterThan(15);
    expect(
      readmeCommands().length,
      "parsed no commands out of the README table — the regex has gone stale",
    ).to.be.greaterThan(15);
  });
});

// ── MCP tool inventory (#199) ────────────────────────────────────────────────

interface McpTool {
  name: string;
  annotation: string;
}

/**
 * Sub-table label each annotation preset renders under in the README.
 *
 * The mapping is deliberately **total**: the README's bold-labelled sub-tables
 * *are* a rendering of the annotation classes, so every class has exactly one
 * slot and the placement assertion needs no per-tool exception. A fifth preset
 * therefore requires a fifth sub-table, by construction — which is the point.
 * See ADR 0031.
 */
const ANNOTATION_TABLE: Record<string, string> = {
  READ_ONLY: "Read tools",
  MUTATE: "Mutate tools",
  REGENERATE: "Regenerate tool",
  NON_IDEMPOTENT_READ: "Non-idempotent read tool",
};

/**
 * Pull `(name, annotation)` out of every registration matched by `callPattern`.
 *
 * Each registration's span is bounded by the *next* match rather than by a
 * fixed character window, so the `annotations:` lookup can never run past this
 * call into the following one.
 */
function parseRegistrations(src: string, callPattern: RegExp): McpTool[] {
  const calls = [...src.matchAll(callPattern)];
  return calls.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < calls.length ? calls[i + 1].index! : src.length;
    const annotation = src.slice(start, end).match(/annotations:\s*([A-Z_]+)/);
    return { name: m[1], annotation: annotation ? annotation[1] : "(none)" };
  });
}

/**
 * Every **statically** registered MCP tool, across both modules that register one.
 *
 * Two modules, not one. `server.ts` registers 36 tools through its local `reg()`
 * wrapper; `opsRegistry.ts` registers `list-ops` via `server.registerTool`
 * directly, from an unconditional `start()` path — so it is just as static, and
 * a `server.ts`-only parse is structurally blind to it. That blindness fails
 * *both* ways: green while `list-ops` stays undocumented, and a false red the
 * day someone adds its correct row. See ADR 0031.
 *
 * Both patterns anchor on a **double-quoted** string literal. That is what
 * excludes the dynamic `op-<name>` tools, which are registered from a template
 * literal (`op-${op.name}`) — a per-project name *cannot* be a static literal,
 * so the anchor excludes them for the reason they are dynamic, rather than by
 * an exception list. Pinned by the negative-case test below.
 */
function registeredMcpTools(): McpTool[] {
  return [
    ...parseRegistrations(readFileSync(SERVER_PATH, "utf-8"), /\bregP?\(\s*\n\s*"([^"]+)"/g),
    ...parseRegistrations(readFileSync(OPS_REGISTRY_PATH, "utf-8"), /\bregisterTool\(\s*\n?\s*"([^"]+)"/g),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tool names per sub-table in the README's `### Available MCP tools` section.
 *
 * The section is heading-scoped (to the next `## `), but the read/mutate split
 * inside it is expressed by **bold labels**, not headings — so the sub-split
 * needs its own boundary mechanism rather than the `indexOf("\n## ")` the CLI
 * half uses.
 */
function readmeMcpTables(): Map<string, string[]> {
  const readme = readFileSync(README_PATH, "utf-8");
  const start = readme.indexOf("### Available MCP tools");
  expect(start, "README is missing its '### Available MCP tools' heading").to.be.greaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);

  const labels = [...section.matchAll(/^\*\*([^*]+?)\*\*/gm)];
  const tables = new Map<string, string[]>();
  labels.forEach((label, i) => {
    const from = label.index!;
    const to = i + 1 < labels.length ? labels[i + 1].index! : section.length;
    const names = [...section.slice(from, to).matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1].split(/\s+/)[0]);
    tables.set(label[1].trim(), names);
  });
  return tables;
}

function documentedMcpTools(): string[] {
  return [...new Set([...readmeMcpTables().values()].flat())].sort();
}

describe("README MCP tool inventory", () => {
  it("documents every MCP tool the server statically registers", () => {
    const documented = documentedMcpTools();
    const missing = registeredMcpTools()
      .filter((t) => !documented.includes(t.name))
      .map((t) => `${t.name} [${t.annotation}]`);
    expect(
      missing,
      `Statically registered but absent from the README '### Available MCP tools' tables: ${missing.join(", ")}. ` +
        `Add a row for each under the sub-table matching its annotation.`,
    ).to.deep.equal([]);
  });

  it("does not document an MCP tool nothing registers", () => {
    const registered = registeredMcpTools().map((t) => t.name);
    const stale = documentedMcpTools().filter((n) => !registered.includes(n));
    expect(
      stale,
      `Listed in the README '### Available MCP tools' tables but not registered: ${stale.join(", ")}. ` +
        `Remove the row, or restore the registration if the removal was accidental.`,
    ).to.deep.equal([]);
  });

  it("places every tool in the sub-table matching its annotation", () => {
    const tables = readmeMcpTables();
    const misplaced: string[] = [];
    for (const tool of registeredMcpTools()) {
      const expected = ANNOTATION_TABLE[tool.annotation];
      if (!expected) {
        misplaced.push(`${tool.name} has annotation ${tool.annotation}, which maps to no README sub-table`);
        continue;
      }
      for (const [label, names] of tables) {
        if (names.includes(tool.name) && label !== expected) {
          misplaced.push(`${tool.name} (${tool.annotation}) is under "${label}" but belongs under "${expected}"`);
        }
      }
    }
    expect(
      misplaced,
      `README MCP sub-table placement disagrees with src/mcp annotations:\n  ${misplaced.join("\n  ")}`,
    ).to.deep.equal([]);
  });

  it("excludes dynamically-registered op-* tools, which vary per project", () => {
    // `OpsRegistry` registers one `op-<name>` tool per file in the project's
    // ops/ dir. A static guard cannot enumerate those, so it must not try.
    const names = registeredMcpTools().map((t) => t.name);
    expect(
      names.filter((n) => n.startsWith("op-")),
      "dynamic op-* tools leaked into the static set",
    ).to.deep.equal([]);
    expect(names, "the static tool registered in opsRegistry.ts is missing").to.include("list-ops");

    // Positive control for the exclusion: widening the same scan to accept a
    // template literal DOES find the dynamic registration. Without this, the
    // assertion above would pass just as well against a pattern that matches
    // nothing in opsRegistry.ts at all — exclusion by breakage, not by design.
    const ops = readFileSync(OPS_REGISTRY_PATH, "utf-8");
    const widened = [...ops.matchAll(/\bregisterTool\(\s*\n?\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]);
    expect(widened, "widened scan no longer sees the dynamic op registration — the pattern has gone stale").to.include(
      "op-${op.name}",
    );
  });

  it("states a generator count matching src/c3/generators.ts", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    const generators = readFileSync(path.join(REPO_ROOT, "src", "c3", "generators.ts"), "utf-8");
    const declared = generators.match(/export const GENERATORS[^=]*=\s*\[([\s\S]*?)\n\]/);
    expect(declared, "could not find the GENERATORS array in src/c3/generators.ts").to.not.equal(null);
    const total = (declared![1].match(/name:/g) ?? []).length;

    const stated = readme.match(/Run all (\d+) generators\b/);
    expect(stated, "README's regenerate row no longer states a 'Run all N generators' count").to.not.equal(null);
    expect(
      Number(stated![1]),
      `README says "Run all ${stated![1]} generators" but src/c3/generators.ts declares ${total}.`,
    ).to.equal(total);
  });

  it("finds a plausible number of tools on both sides (guards the parsers themselves)", () => {
    // The load-bearing row. A regex that silently matches zero — a formatting
    // change in either module, or a rename of `reg` — would make every set
    // comparison above pass vacuously against two empty sets, and the guard
    // would report green while protecting nothing.
    expect(
      registeredMcpTools().length,
      "parsed no tools out of src/mcp — the registration regexes have gone stale",
    ).to.be.greaterThan(30);
    expect(
      documentedMcpTools().length,
      "parsed no tools out of the README MCP tables — the row regex has gone stale",
    ).to.be.greaterThan(20);
    expect(
      [...readmeMcpTables().keys()],
      "the README MCP section no longer renders one bold-labelled sub-table per annotation class",
    ).to.have.members(Object.values(ANNOTATION_TABLE));
  });
});
