#!/usr/bin/env node

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { walkFiles, toPosixPath } from "@genvidtech/mcp-utils";
import { openProject } from "@genvidtech/c3source";
import { loadChefConfig, resolveOpsDir } from "./c3/chefConfig.js";
import { GENERATORS, GENERATOR_NAMES, type GeneratorName } from "./c3/generators.js";
import { applyParsed, renameSymbols } from "./c3/recipeApplier.js";
import { writeSourceJson } from "./c3/sourceJson.js";
import type { Recipe } from "./c3/recipeInterpreter.js";
import { ALL_SECTION_KEYS, runSync, reportImageDrift, reportStrayFiles } from "./c3/projectSync.js";
import { collectAllUids, cloneLayout } from "./c3/layoutScaffold.js";
import { readRegistryFile } from "./c3/sidUtils.js";
import {
  collectAllObjectTypeSids,
  collectMaxImageSpriteId,
  discoverAndPlanImageCopies,
  cloneSprite,
} from "./c3/spriteScaffold.js";
import { findTemplates } from "./c3/templateLister.js";
import {
  buildLayoutEventSheetMap,
  findGoToLayoutCalls,
  formatNavTable,
  generatePlantUML,
} from "./c3/navigationGraph.js";
import { resolveNavConvention } from "./c3/navConvention.js";
import { lookup, formatLookupResult } from "./c3/aceLookup.js";
import { loadOpsFromDir, substituteOp, formatOpsList, coerceArgs } from "./c3/opTemplate.js";
import { discoverAddons, resolveAddonTarget } from "./c3/addonDiscovery.js";
import { readAddon, readAddonEntry, formatAddonInfo, formatAddonList } from "./c3/addonReader.js";
import { validateAddons, formatAddonValidation } from "./c3/addonValidator.js";
import { listAddons, formatAddonInventory } from "./c3/addonInventory.js";
import { diffAddonAces, formatAceDiff, resolveAceSource } from "./c3/addonAceDiff.js";
import { scanAddonUsage, formatAddonUsage } from "./c3/addonAceUsage.js";
import { syncAddonMetadata, formatAddonMetadataSync, type SyncDirection } from "./c3/addonMetadataSync.js";

// Resolve the package version for `--version`. The URL is relative to this
// module file, so it resolves correctly from both dist/cli.js (→ dist/../package.json)
// and src/cli.ts under tsx (→ src/../package.json).
const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }
).version;

function resolveProjectDir(argv: { projectDir?: string }): string {
  return path.resolve(argv.projectDir ?? process.cwd());
}

async function resolveExtractedDir(rootDir: string): Promise<string> {
  return (await loadChefConfig(rootDir)).extractedDir;
}

function runGenerators(rootDir: string, extractedDir: string, only?: GeneratorName): void {
  const outDir = path.join(rootDir, extractedDir);

  const toRun = only ? GENERATORS.filter((g) => g.name === only) : GENERATORS;

  console.log("=== Generating C3 extracted files ===\n");
  for (let i = 0; i < toRun.length; i++) {
    if (i > 0) console.log("");
    toRun[i].run(rootDir, outDir, console.log);
  }
  console.log("\n=== Done ===");
}

yargs(hideBin(process.argv))
  .option("project-dir", {
    type: "string",
    defaultDescription: "cwd",
    describe: "Root directory of the C3 project",
    global: true,
  })
  .command(
    "server",
    "Start the MCP server",
    () => {},
    async (argv) => {
      const { startServer } = await import("./mcp/server.js");
      await startServer(argv.projectDir);
    },
  )
  .command(
    "generate",
    "Generate extracted/ files (scripts, DSL, layouts, templates, sid-registry)",
    (y) =>
      y.option("only", {
        type: "string",
        choices: GENERATOR_NAMES,
        describe: "Generate only a specific type",
      }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const extractedDir = await resolveExtractedDir(rootDir);
      runGenerators(rootDir, extractedDir, argv.only as GeneratorName | undefined);
    },
  )
  .command(
    "apply-recipe <recipe>",
    "Apply an eventSheet mutation recipe",
    (y) =>
      y
        .positional("recipe", { type: "string", demandOption: true, describe: "Path to recipe JSON file" })
        .option("dry-run", { type: "boolean", default: false, describe: "Validate and preview without writing" })
        .option("preview", {
          type: "boolean",
          default: false,
          describe: "Show diff preview of script changes (implies --dry-run)",
        })
        .option("regenerate", {
          type: "boolean",
          default: true,
          describe: "Regenerate extracted files after applying",
        }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const dryRun = argv.preview ? true : argv.dryRun;
      const recipeContent = readFileSync(argv.recipe, "utf-8");
      const recipe: Recipe = JSON.parse(recipeContent);
      const extractedDir = await resolveExtractedDir(rootDir);
      applyParsed(rootDir, recipe, { dryRun, preview: argv.preview, regenerate: argv.regenerate, extractedDir });
    },
  )
  .command(
    "rename-symbol [from] [to]",
    "Rename symbols across all eventSheet script actions",
    (y) =>
      y
        .positional("from", { type: "string", describe: "Symbol to find" })
        .positional("to", { type: "string", describe: "Replacement symbol" })
        .option("replacements", { type: "string", describe: "Path to JSON file with array of { from, to } pairs" })
        .option("dry-run", { type: "boolean", default: false, describe: "Show what would change without writing" })
        .option("preview", {
          type: "boolean",
          default: false,
          describe: "Show diff preview of script changes (implies --dry-run)",
        })
        .option("regenerate", {
          type: "boolean",
          default: true,
          describe: "Regenerate extracted files after applying",
        })
        .check((argv) => {
          const hasInline = argv.from !== undefined && argv.to !== undefined;
          const hasFile = argv.replacements !== undefined;
          if (!hasInline && !hasFile) throw new Error("Provide either <from> <to> arguments or --replacements <file>");
          if (hasInline && hasFile) throw new Error("Cannot use both inline arguments and --replacements file");
          return true;
        }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const extractedDir = await resolveExtractedDir(rootDir);
      const pairs = argv.replacements
        ? (JSON.parse(readFileSync(argv.replacements, "utf-8")) as Array<{ from: string; to: string }>)
        : [{ from: argv.from!, to: argv.to! }];
      renameSymbols(rootDir, pairs, argv.dryRun, argv.preview, argv.regenerate, extractedDir);
    },
  )
  .command(
    "validate-project",
    "Validate project.c3proj matches disk (dry-run)",
    (y) =>
      y
        .option("section", {
          type: "string",
          choices: ALL_SECTION_KEYS,
          describe: "Only validate one section",
        })
        .option("fail-on-strays", {
          type: "boolean",
          default: false,
          describe: "Exit 1 when any stray file is reported (opt-in CI gate)",
        }),
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      // #184: reportImageDrift and reportStrayFiles are both manifest-INDEPENDENT
      // (they classify basenames under the section roots and never read the
      // manifest), so a project.c3proj that will not parse is exactly where they
      // help most. Caught at the CALL SITE — runSync's own fail-fast contract, and
      // the three rows in syncC3Proj.test.ts that pin it, stay untouched.
      let driftFailed = false;
      try {
        driftFailed = !runSync(rootDir, true, console.log, argv.section).clean;
      } catch (err) {
        // err.message verbatim: runSync stays the single source of the
        // "Could not read" / "Could not parse ... as JSON" wording. stderr, so
        // the reports below stay on stdout and each stream can be asserted alone.
        console.error(err instanceof Error ? err.message : String(err));
        driftFailed = true;
      }
      reportImageDrift(rootDir, console.log);
      const strays = reportStrayFiles(rootDir, console.log);
      if (driftFailed) process.exitCode = 1;
      if (argv.failOnStrays && strays.length > 0) process.exitCode = 1;
    },
  )
  .command(
    "sync-project",
    "Sync project.c3proj to match disk",
    (y) =>
      y.option("section", {
        type: "string",
        choices: ALL_SECTION_KEYS,
        describe: "Only sync one section",
      }),
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      runSync(rootDir, false, console.log, argv.section);
      // Images aren't a manifest section, so sync never acts on image drift — but
      // surface it (detection-only) so a direct sync, without a prior validate, still
      // shows it. Reported unconditionally, mirroring validate-project (#52).
      reportImageDrift(rootDir, console.log);
      reportStrayFiles(rootDir, console.log);
    },
  )
  .command(
    "scaffold-layout",
    "Clone a layout with new UIDs",
    (y) =>
      y
        .option("source", { type: "string", demandOption: true, describe: "Path to source layout JSON file" })
        .option("out", { type: "string", demandOption: true, describe: "Output path for the new layout JSON file" })
        .option("name", { type: "string", demandOption: true, describe: "Name for the new layout" })
        .option("event-sheet", { type: "string", demandOption: true, describe: "Event sheet name for the new layout" })
        .option("no-regenerate", { type: "boolean", default: false, describe: "Skip regenerating extracted/ files" }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const extractedDir = await resolveExtractedDir(rootDir);
      const sourcePath = path.resolve(argv.source);
      const outPath = path.resolve(argv.out);
      const source = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
      const existingUids = collectAllUids(openProject(rootDir).layoutsDir);
      // Seed clone-SID minting against the project-wide registry so cloned SIDs can't
      // collide with anything in eventSheets/, layouts/, or objectTypes/.
      const registryPath = path.join(rootDir, extractedDir, "sid-registry.txt");
      const existingSids = existsSync(registryPath) ? readRegistryFile(registryPath) : new Set<number>();
      const cloned = cloneLayout(source, { name: argv.name, eventSheet: argv.eventSheet, existingUids, existingSids });
      writeSourceJson(outPath, cloned);
      console.log(`Scaffolded ${argv.name} → ${path.relative(rootDir, outPath)}`);
      runSync(rootDir, false, console.log);
      if (!argv.noRegenerate) {
        runGenerators(rootDir, extractedDir);
      }
    },
  )
  .command(
    "scaffold-sprite",
    "Clone a sprite/objectType with new SIDs and images",
    (y) =>
      y
        .option("source", { type: "string", demandOption: true, describe: "Source objectType name" })
        .option("name", { type: "string", demandOption: true, describe: "Target objectType name" }),
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      const objectTypesDir = openProject(rootDir).objectTypesDir;
      const imagesDir = openProject(rootDir).imagesDir;
      const sourceFile = path.join(objectTypesDir, `${argv.source}.json`);
      const source = JSON.parse(readFileSync(sourceFile, "utf-8")) as Record<string, unknown>;
      const existingSids = collectAllObjectTypeSids(objectTypesDir);
      const maxImageSpriteId = collectMaxImageSpriteId(objectTypesDir);
      const cloned = cloneSprite(source, {
        name: argv.name,
        existingSids,
        nextImageSpriteId: maxImageSpriteId + 1,
      });
      const outFile = path.join(objectTypesDir, `${argv.name}.json`);
      writeSourceJson(outFile, cloned);
      console.log(`Scaffolded ${argv.name} → objectTypes/${argv.name}.json`);
      const imageCopies = discoverAndPlanImageCopies(imagesDir, argv.source, argv.name);
      for (const { sourcePath, targetPath, sourceBasename, targetBasename } of imageCopies) {
        copyFileSync(sourcePath, targetPath);
        console.log(`Copied images/${sourceBasename} → images/${targetBasename}`);
      }
      runSync(rootDir, false, console.log);
    },
  )
  .command(
    "remove-layer",
    "Remove a layer from a layout",
    (y) =>
      y
        .option("layout", {
          type: "string",
          demandOption: true,
          describe: "Relative path to the layout JSON within layouts/ (e.g. 'Main Layout.json')",
        })
        .option("layer", { type: "string", demandOption: true, describe: "Name of the layer to remove" })
        .option("cascade", { type: "boolean", describe: "Remove the entire sublayer subtree recursively" })
        .option("remove-instances", { type: "boolean", describe: "Force removal even when the layer has instances" })
        .option("dry-run", { type: "boolean", default: false, describe: "Validate and preview without writing" })
        .option("regenerate", {
          type: "boolean",
          default: true,
          describe: "Regenerate extracted files after applying",
        }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const extractedDir = await resolveExtractedDir(rootDir);
      const recipe: Recipe = {
        layouts: {
          [argv.layout]: [
            {
              op: "remove-layer",
              layer: argv.layer,
              ...(argv.cascade !== undefined ? { cascade: argv.cascade } : {}),
              ...(argv.removeInstances !== undefined ? { removeInstances: argv.removeInstances } : {}),
            },
          ],
        },
      };
      applyParsed(rootDir, recipe, {
        dryRun: argv.dryRun,
        regenerate: argv.regenerate,
        log: console.log,
        extractedDir,
      });
    },
  )
  .command(
    "list-templates",
    "List template instances across all layouts",
    () => {},
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      const templates = findTemplates(openProject(rootDir).layoutsDir);
      if (templates.length === 0) {
        console.log("(no template instances found)");
        return;
      }
      const byLayout = new Map<string, string[]>();
      for (const { layout, type } of templates) {
        let types = byLayout.get(layout);
        if (!types) {
          types = [];
          byLayout.set(layout, types);
        }
        types.push(type);
      }
      const entries = [...byLayout.entries()];
      for (let i = 0; i < entries.length; i++) {
        const [layoutName, types] = entries[i];
        console.log(`${layoutName}:`);
        for (const type of types) {
          console.log(`  ${type}`);
        }
        if (i < entries.length - 1) console.log("");
      }
    },
  )
  .command(
    "navigation-graph",
    "Show layout navigation graph (System go-to-layout / configured nav calls)",
    (y) =>
      y.option("plantuml", {
        type: "string",
        describe: "Write a PlantUML component diagram to this file",
      }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const config = await loadChefConfig(rootDir);
      const extractedDir = path.join(rootDir, config.extractedDir);
      const layoutEventSheetMap = buildLayoutEventSheetMap(openProject(rootDir).layoutsDir);
      const sheetToLayout: Record<string, string> = {};
      for (const [layoutName, sheetName] of Object.entries(layoutEventSheetMap)) {
        sheetToLayout[sheetName] = layoutName;
      }
      const navEntries = findGoToLayoutCalls(extractedDir, resolveNavConvention(config));
      if (argv.plantuml) {
        const outFile = argv.plantuml;
        const name = path.basename(outFile, path.extname(outFile));
        writeFileSync(outFile, generatePlantUML(navEntries, sheetToLayout, name), "utf-8");
        console.log(`Written to ${outFile}`);
        return;
      }
      console.log(formatNavTable(navEntries, sheetToLayout));
    },
  )
  .command(
    "search-dsl <pattern>",
    "Search DSL files for a regex pattern",
    (y) =>
      y
        .positional("pattern", { type: "string", demandOption: true, describe: "Regex pattern to search for" })
        .option("glob", { type: "string", describe: "Subdirectory within extracted/ to restrict search" }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const extractedDir = path.join(rootDir, await resolveExtractedDir(rootDir));
      const searchDir = argv.glob ? path.join(extractedDir, argv.glob) : extractedDir;

      let regex: RegExp;
      try {
        regex = new RegExp(argv.pattern);
      } catch (e) {
        console.error(`Invalid regex: ${argv.pattern}\n${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const ext = ".dsl.txt";
      const lines: string[] = [];
      const MAX_MATCHES = 1000;
      let truncated = false;

      for (const full of walkFiles(searchDir, ext)) {
        if (truncated) break;
        const rel = toPosixPath(path.relative(extractedDir, full));
        const content = readFileSync(full, "utf-8").split("\n");
        for (let i = 0; i < content.length; i++) {
          if (regex.test(content[i])) {
            lines.push(`${rel}:${i + 1}: ${content[i]}`);
            if (lines.length >= MAX_MATCHES) {
              truncated = true;
              break;
            }
          }
        }
      }
      if (lines.length === 0) {
        console.log(`No matches found for pattern: ${argv.pattern}`);
      } else {
        console.log(lines.join("\n"));
        if (truncated) {
          console.log(`\n[Truncated: showing first ${MAX_MATCHES} matches. Narrow your pattern or glob to see more.]`);
        }
      }
    },
  )
  .command(
    "search-docs",
    "Search C3 ACE reference (action/condition/expression ids, param names) for custom addons and the built-in reference cache",
    (y) =>
      y
        .option("query", { type: "string", describe: "Free-text search query" })
        .option("object", {
          type: "string",
          describe: "Filter by object/plugin name (case-insensitive exact match for ACEs)",
        })
        .option("id", { type: "string", describe: "Filter by ACE id (exact, case-insensitive)" })
        .option("param", { type: "string", describe: "Filter by ACE param name (substring, case-insensitive)" })
        .option("limit", { type: "number", describe: "Max results per array (aces and chunks independently)" }),
    async (argv) => {
      const { query, object, id, param, limit } = argv;
      if (!query && !object && !id && !param) {
        console.log("Provide at least one filter: query, object, id, or param.");
        return;
      }
      const rootDir = resolveProjectDir(argv);
      const extractedDir = path.join(rootDir, await resolveExtractedDir(rootDir));
      const result = lookup(rootDir, extractedDir, {
        query: query || undefined,
        object: object || undefined,
        id: id || undefined,
        param: param || undefined,
        limit,
      });
      console.log(formatLookupResult(result));
    },
  )
  .command(
    "read-addon [name]",
    "Read a C3 addon's metadata + ACE summary, a raw entry within it, or list all discovered addons",
    (y) =>
      y
        .positional("name", { type: "string", describe: "Addon name (e.g. 'FixtureClock'). Omit to list all addons." })
        .option("file", {
          type: "string",
          describe: "Read a raw entry within the addon (extracted dir or archive), e.g. 'aces.json'",
        }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);

      if (!argv.name) {
        console.log(formatAddonList(discoverAddons(rootDir)));
        return;
      }

      if (!argv.file) {
        const info = readAddon(rootDir, argv.name);
        if (info === null) {
          console.error(`Addon '${argv.name}' not found`);
          process.exitCode = 1;
          return;
        }
        console.log(formatAddonInfo(info));
        return;
      }

      // Path traversal guard — mirrors the MCP read-addon tool (belt-and-suspenders
      // on top of readAddonEntry's internal resolveWithin; the zip branch matches
      // by exact entry name so it can't escape the archive).
      if (argv.file.includes("..") || path.isAbsolute(argv.file)) {
        console.error(`Invalid file path '${argv.file}' — must stay within addon directory`);
        process.exitCode = 1;
        return;
      }
      const addon = discoverAddons(rootDir).find((a) => a.name === argv.name);
      if (!addon) {
        console.error(`Addon '${argv.name}' not found`);
        process.exitCode = 1;
        return;
      }
      const content = readAddonEntry(addon, argv.file);
      if (content === null) {
        console.error(`File '${argv.file}' not found in addon '${argv.name}'`);
        process.exitCode = 1;
        return;
      }
      console.log(content);
    },
  )
  .command(
    "validate-addons",
    "Validate bundled .c3addon packages against project.c3proj.usedAddons (metadata + integrity + orphan/missing/duplicate) and each addon's aces.json/properties against its lang/*.json; --addon scopes to one addon or source tree. Read-only.",
    (y) =>
      y.option("addon", {
        type: "string",
        describe:
          "Validate a single addon by discovered id or by path to an addon source tree (aces.json + lang/). Omit to validate all bundled addons.",
      }),
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      let result;
      if (argv.addon) {
        // Belt-and-suspenders traversal guard (resolveAddonTarget also containment-checks via resolveWithin).
        if (argv.addon.includes("..") || path.isAbsolute(argv.addon)) {
          console.error(`Invalid --addon path '${argv.addon}' — must stay within the project directory`);
          process.exitCode = 1;
          return;
        }
        const target = resolveAddonTarget(rootDir, argv.addon);
        if (target === null) {
          console.error(`Addon '${argv.addon}' not found`);
          process.exitCode = 1;
          return;
        }
        result = validateAddons(rootDir, target);
      } else {
        result = validateAddons(rootDir);
      }
      console.log(formatAddonValidation(result));
      if (result.findings.length > 0) process.exitCode = 1;
    },
  )
  .command(
    "list-addons",
    "List a unified addon inventory — bundled .c3addon packages, project.c3proj.usedAddons entries, and editor-only addons — one row per addon with status, version, and on-disk package path. Read-only.",
    () => {},
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      console.log(formatAddonInventory(listAddons(rootDir)));
    },
  )
  .command(
    "diff-addon-aces <from> <to>",
    "Diff the ACE contract (added/removed/changed ACEs + changed param signatures) between two addon sources. Read-only.",
    (y) =>
      y
        .positional("from", {
          type: "string",
          demandOption: true,
          describe: "First ACE source: a .c3addon file path, or a discovered addon id/dir",
        })
        .positional("to", {
          type: "string",
          demandOption: true,
          describe: "Second ACE source (same forms as 'from')",
        }),
    // No path-traversal guard here — a deliberate departure from the
    // read-addon/validate-addons sibling guards. diff-addon-aces exists
    // specifically to diff .c3addon files that live outside the project
    // (e.g. two downloaded release archives), and the tool is strictly
    // read-only; resolveAceSource containment-checks the addon-id/dir branch
    // internally.
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      const a = resolveAceSource(rootDir, argv.from);
      if ("error" in a) {
        console.error(a.error);
        process.exitCode = 1;
        return;
      }
      const b = resolveAceSource(rootDir, argv.to);
      if ("error" in b) {
        console.error(b.error);
        process.exitCode = 1;
        return;
      }
      console.log(formatAceDiff(diffAddonAces(a.aces, b.aces), a.label, b.label));
    },
  )
  .command(
    "scan-addon-usage <addon>",
    "Scan a project for usage of a plugin, behavior, or effect addon: object/family presence plus event-sheet ACE call sites and expression references (Object.expr / Object.Behavior.expr in parameters) (effects have no ACEs — their application sites on objects/families/layers/layouts are the whole report); --from reports blast radius, exiting non-zero when any affected call/expression/application site exists. Read-only.",
    (y) =>
      y
        .positional("addon", {
          type: "string",
          demandOption: true,
          describe:
            "Addon source to scan usage of: a discovered addon id, a .c3addon file path, or an extracted addon dir",
        })
        .option("from", {
          type: "string",
          describe: "Old-version ACE source (same forms as 'addon') to diff against, enabling blast-radius mode",
        }),
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      const result = scanAddonUsage(rootDir, argv.addon, argv.from);
      if ("error" in result) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(formatAddonUsage(result));
      if (result.blast !== undefined && result.blast.affectedCount > 0) {
        process.exitCode = 1;
      }
    },
  )
  .command(
    "sync-addon-metadata",
    "Sync a bundled .c3addon package's version/author with its project.c3proj.usedAddons entry, in either direction. --direction manifest-from-package writes the manifest to match the package; --direction package-from-manifest is a read-only report (chef has no .c3addon writer).",
    (y) =>
      y
        .option("direction", {
          type: "string",
          choices: ["manifest-from-package", "package-from-manifest"] as const,
          demandOption: true,
          describe: "Sync direction — REQUIRED, never defaulted: this is a human decision the tool must never guess.",
        })
        .option("addon", {
          type: "string",
          describe: "Scope to a single addon by discovered id (an id, not a path — see docs for accepted forms).",
        })
        .option("dry-run", { type: "boolean", default: false, describe: "Preview without writing" }),
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      const result = syncAddonMetadata(rootDir, {
        direction: argv.direction as SyncDirection,
        addon: argv.addon,
        dryRun: argv.dryRun,
      });
      if ("error" in result) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(formatAddonMetadataSync(result));
      const blocked = result.rows.some((r) => r.status === "blocked");
      const wouldChange = result.rows.some((r) => r.status === "would-change");
      if (blocked || (result.dryRun && wouldChange)) {
        process.exitCode = 1;
      }
    },
  )
  .command(
    "list-ops",
    "List available user-defined ops",
    () => {},
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const opsDir = await resolveOpsDir(rootDir);
      const { ops, errors } = loadOpsFromDir(opsDir);
      console.log(formatOpsList(ops, errors));
    },
  )
  .command(
    "apply-op <name>",
    "Apply a user-defined op by name",
    (y) =>
      y
        .positional("name", { type: "string", demandOption: true, describe: "Op name (e.g. add-screen)" })
        .option("param", {
          type: "string",
          array: true,
          describe: "Param as KEY=VALUE (repeatable). Overrides --params-file values.",
        })
        .option("params-file", {
          type: "string",
          describe: "Path to a JSON file containing { paramName: value } pairs (base values; --param overrides)",
        })
        .option("dry-run", { type: "boolean", default: false, describe: "Validate and preview without writing" })
        .option("preview", {
          type: "boolean",
          default: false,
          describe: "Show diff preview of script changes (implies --dry-run)",
        })
        .option("regenerate", {
          type: "boolean",
          default: true,
          describe: "Regenerate extracted files after applying",
        }),
    async (argv) => {
      const rootDir = resolveProjectDir(argv);
      const opsDir = await resolveOpsDir(rootDir);
      const { ops, errors } = loadOpsFromDir(opsDir);

      const op = ops.find((o) => o.name === argv.name);
      if (!op) {
        const available = ops.length > 0 ? ops.map((o) => o.name).join(", ") : "(none)";
        const errLines: string[] = [`Error: op "${argv.name}" not found. Available: ${available}`];
        if (errors.length > 0) {
          errLines.push("Load errors that may explain missing ops:");
          for (const e of errors) {
            errLines.push(`  ${e.file}: ${e.message}`);
          }
        }
        console.error(errLines.join("\n"));
        process.exitCode = 1;
        return;
      }

      // Build raw args: start from --params-file (if given), then overlay --param entries.
      const rawArgs: Record<string, unknown> = {};

      if (argv.paramsFile) {
        const fileContent = readFileSync(argv.paramsFile, "utf-8");
        const parsed: unknown = JSON.parse(fileContent);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`--params-file must contain a JSON object, got: ${JSON.stringify(parsed)}`);
        }
        Object.assign(rawArgs, parsed as Record<string, unknown>);
      }

      for (const entry of argv.param ?? []) {
        const eqIdx = entry.indexOf("=");
        if (eqIdx === -1) {
          throw new Error(`--param "${entry}" is not in KEY=VALUE format`);
        }
        const key = entry.slice(0, eqIdx);
        const value = entry.slice(eqIdx + 1);
        rawArgs[key] = value;
      }

      const coerced = coerceArgs(op.def, rawArgs);
      const recipe = substituteOp(op.def, coerced);

      const extractedDir = await resolveExtractedDir(rootDir);
      const dryRun = argv.preview ? true : argv.dryRun;
      applyParsed(rootDir, recipe, { dryRun, preview: argv.preview, regenerate: argv.regenerate, extractedDir });
    },
  )
  .demandCommand(1, "Please specify a subcommand. Use --help for available commands.")
  .strict()
  .version(pkgVersion)
  .help()
  .parse();
