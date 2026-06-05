#!/usr/bin/env node

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { walkFiles, toPosixPath } from "@genvid/mcp-utils";
import { loadChefConfig } from "./c3/chefConfig.js";
import {
  extractScripts,
  generateDSL,
  generateLayoutSummaries,
  generateTemplateScope,
  generateSidRegistry,
  generateGlobalLayers,
} from "./c3/generators.js";
import { applyParsed, renameSymbols } from "./c3/recipeApplier.js";
import type { Recipe } from "./c3/recipeInterpreter.js";
import { ALL_SECTION_KEYS, runSync, reportImageDrift } from "./c3/projectSync.js";
import { collectAllUids, cloneLayout } from "./c3/layoutScaffold.js";
import { readRegistryFile } from "./c3/sidUtils.js";
import {
  collectAllObjectTypeSids,
  collectMaxImageSpriteId,
  discoverAndPlanImageCopies,
  cloneSprite,
} from "./c3/spriteScaffold.js";
import { findTemplates } from "./c3/templateLister.js";
import { buildLayoutEventSheetMap, findGoToLayoutCalls, generatePlantUML } from "./c3/navigationGraph.js";
import { resolveNavConvention } from "./c3/navConvention.js";

const GENERATOR_NAMES = ["scripts", "dsl", "layouts", "templates", "sid-registry", "global-layers"] as const;
type GeneratorName = (typeof GENERATOR_NAMES)[number];

// Resolve the package version for `--version`. The URL is relative to this
// module file, so it resolves correctly from both dist/cli.js (→ dist/../package.json)
// and src/cli.ts under tsx (→ src/../package.json).
const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }
).version;

function resolveProjectDir(argv: { projectDir: string }): string {
  return path.resolve(argv.projectDir);
}

async function resolveExtractedDir(rootDir: string): Promise<string> {
  return (await loadChefConfig(rootDir)).extractedDir;
}

function runGenerators(rootDir: string, extractedDir: string, only?: GeneratorName): void {
  const outDir = path.join(rootDir, extractedDir);

  const generators: Array<{ name: GeneratorName; run: () => void }> = [
    { name: "scripts", run: () => extractScripts(rootDir, outDir, console.log) },
    { name: "dsl", run: () => generateDSL(rootDir, outDir, console.log) },
    { name: "layouts", run: () => generateLayoutSummaries(rootDir, outDir, console.log) },
    { name: "templates", run: () => generateTemplateScope(rootDir, outDir, console.log) },
    { name: "sid-registry", run: () => generateSidRegistry(rootDir, extractedDir, console.log) },
    { name: "global-layers", run: () => generateGlobalLayers(rootDir, outDir, console.log) },
  ];

  const toRun = only ? generators.filter((g) => g.name === only) : generators;

  console.log("=== Generating C3 extracted files ===\n");
  for (let i = 0; i < toRun.length; i++) {
    if (i > 0) console.log("");
    toRun[i].run();
  }
  console.log("\n=== Done ===");
}

yargs(hideBin(process.argv))
  .option("project-dir", {
    type: "string",
    default: process.cwd(),
    describe: "Root directory of the C3 project",
    global: true,
  })
  .command(
    "server",
    "Start the MCP server",
    () => {},
    async (argv) => {
      const { startServer } = await import("./mcp/server.js");
      await startServer(resolveProjectDir(argv));
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
      y.option("section", {
        type: "string",
        choices: ALL_SECTION_KEYS,
        describe: "Only validate one section",
      }),
    (argv) => {
      const rootDir = resolveProjectDir(argv);
      const result = runSync(rootDir, true, console.log, argv.section);
      reportImageDrift(rootDir, console.log);
      if (!result.clean) process.exit(1);
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
      const existingUids = collectAllUids(path.join(rootDir, "layouts"));
      // Seed clone-SID minting against the project-wide registry so cloned SIDs can't
      // collide with anything in eventSheets/, layouts/, or objectTypes/.
      const registryPath = path.join(rootDir, extractedDir, "sid-registry.txt");
      const existingSids = existsSync(registryPath) ? readRegistryFile(registryPath) : new Set<number>();
      const cloned = cloneLayout(source, { name: argv.name, eventSheet: argv.eventSheet, existingUids, existingSids });
      writeFileSync(outPath, JSON.stringify(cloned, null, "\t") + "\n");
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
      const objectTypesDir = path.join(rootDir, "objectTypes");
      const imagesDir = path.join(rootDir, "images");
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
      writeFileSync(outFile, JSON.stringify(cloned, null, "\t") + "\n");
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
      const templates = findTemplates(path.join(rootDir, "layouts"));
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
      const layoutsDir = path.join(rootDir, "layouts");
      const config = await loadChefConfig(rootDir);
      const extractedDir = path.join(rootDir, config.extractedDir);
      const layoutEventSheetMap = buildLayoutEventSheetMap(layoutsDir);
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
      navEntries.sort((a, b) => {
        const sheetCmp = a.fromSheet.localeCompare(b.fromSheet);
        if (sheetCmp !== 0) return sheetCmp;
        return a.lineNumber - b.lineNumber;
      });
      if (navEntries.length === 0) {
        console.log("(no navigation calls found)");
        return;
      }
      const COL_FROM = 25;
      const COL_TO = 30;
      const COL_LINE = 6;
      const header = `${"From EventSheet".padEnd(COL_FROM)} → ${"Target Layout".padEnd(COL_TO)} ${"Line".padStart(COL_LINE)}`;
      console.log(header);
      console.log("─".repeat(header.length + 2));
      for (const entry of navEntries) {
        const fromPadded = entry.fromSheet.padEnd(COL_FROM);
        const toPadded = entry.targetLayout.padEnd(COL_TO);
        const linePadded = String(entry.lineNumber).padStart(COL_LINE);
        let annotation = "";
        const primaryLayout = sheetToLayout[entry.fromSheet];
        if (primaryLayout && primaryLayout !== entry.targetLayout) {
          annotation = `  ← primary sheet of ${primaryLayout}`;
        }
        console.log(`${fromPadded} → ${toPadded} ${linePadded}${annotation}`);
      }
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
  .demandCommand(1, "Please specify a subcommand. Use --help for available commands.")
  .strict()
  .version(pkgVersion)
  .help()
  .parse();
