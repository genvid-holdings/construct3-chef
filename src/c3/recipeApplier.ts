import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { extractScripts, generateDSL, generateLayoutSummaries } from "./generators.js";
import type { Logger } from "genvid-mcp-utils";
import type { ApplyOptions } from "./types.js";
import type { EventSheet, EventSheetEvent } from "c3source";
import { find_all_eventsheets_path, find_all_objectTypes_path, find_all_layouts_path } from "c3source";
import {
  type Recipe,
  type ObjectTypeCreate,
  type AddInstVarsEntry,
  type AddNonworldInstanceOp,
  type PatchScriptOp,
  type RenameSymbolOp,
  validateRecipe,
  executeRecipe,
  executeFileOps,
  isFileCreate,
  applyReplacements,
} from "./recipeInterpreter.js";
import {
  findLayer,
  addSublayer,
  addLayer,
  copyInstance,
  templatize,
  replicify,
  addReplica,
  removeInstance,
  removeLayer,
  moveInstance,
  renameLayer,
  type LayoutJson as MutatorLayoutJson,
} from "./layoutMutator.js";
import { collectAllUids, collectLayoutSids, generateUniqueSid } from "./layoutScaffold.js";
import {
  initSidContext,
  resetSidContext,
  generateUniqueSid as generateContextSid,
} from "./sidUtils.js";
import { diffScripts } from "./previewDiff.js";
import {
  addInstVarsToObjectType,
  addInstVarsToLayout,
  addInstVarsToTypesDts,
  type InstVarDef,
} from "./instVarMutator.js";

// ─── Constants ───

export const PLUGIN_BASE_CLASS: Record<string, string> = {
  Json: "IJSONInstance",
  Dictionary: "IDictionaryInstance",
  Arr: "IArrayInstance",
};

// ─── Types ───

interface NonworldInstance {
  type: string;
  properties: Record<string, unknown>;
  uid: number;
  sid: number;
  tags: string;
  instanceVariables: Record<string, unknown>;
}

interface LayoutJson {
  "nonworld-instances"?: NonworldInstance[];
  [key: string]: unknown;
}

// ─── Helper functions ───

export function loadSheet(rootDir: string, filePath: string): EventSheet {
  const fullPath = path.join(rootDir, filePath);
  const content = readFileSync(fullPath, "utf-8");
  return JSON.parse(content) as EventSheet;
}

export function regenerateExtracted(rootDir: string, withLayouts = false, log: Logger = console.log) {
  const outDir = path.join(rootDir, "extracted");

  log("\n--- Regenerating extracted files ---\n");

  log("Extracting scripts...");
  extractScripts(rootDir, outDir, log);

  log("\nGenerating DSL...");
  generateDSL(rootDir, outDir, log);

  if (withLayouts) {
    log("\nGenerating layout summaries...");
    generateLayoutSummaries(rootDir, outDir, log);
  }
}

// ─── objectTypes helpers ───

export function getObjectTypePath(objectType: ObjectTypeCreate): string {
  return objectType.folder
    ? `objectTypes/${objectType.folder}/${objectType.name}.json`
    : `objectTypes/${objectType.name}.json`;
}

export function createObjectType(
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger = console.log,
): boolean {
  const relPath = getObjectTypePath(objectType);
  const fullPath = path.join(rootDir, relPath);

  if (existsSync(fullPath)) {
    log(`  SKIP ${relPath} (already exists)`);
    return false;
  }

  const ivars = (objectType.instanceVariables ?? []).map((v) => ({
    name: v.name,
    type: v.type,
    desc: "",
    show: true,
    sid: generateContextSid(),
  }));

  const json = {
    name: objectType.name,
    "plugin-id": objectType.plugin,
    sid: generateContextSid(),
    isGlobal: true,
    editorNewInstanceIsReplica: true,
    instanceVariables: ivars,
  };

  if (dryRun) {
    log(`  CREATE ${relPath} (plugin: ${objectType.plugin})`);
    return true;
  }

  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(json, null, "\t") + "\n");
  log(`  CREATED ${relPath}`);
  return true;
}

export function updateInstanceTypes(
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger = console.log,
): void {
  const filePath = path.join(rootDir, "scripts/ts-defs/instanceTypes.d.ts");
  const content = readFileSync(filePath, "utf-8");

  const baseClass = PLUGIN_BASE_CLASS[objectType.plugin];
  const ivars = objectType.instanceVariables ?? [];

  let classBody: string;
  if (ivars.length === 0) {
    classBody = `\tclass ${objectType.name} extends ${baseClass} {\n\t}`;
  } else {
    const fields = ivars.map((v) => `\t\t\t${v.name}: ${v.type},`).join("\n");
    classBody = `\tclass ${objectType.name} extends ${baseClass} {\n\t\tinstVars: {\n${fields}\n\t\t};\n\t}`;
  }

  // Insert before the closing `}` of the namespace (last line `}`)
  const lastBrace = content.lastIndexOf("\n}");
  const updated = content.slice(0, lastBrace) + "\n" + classBody + "\n" + content.slice(lastBrace);

  if (dryRun) {
    log(`  UPDATE scripts/ts-defs/instanceTypes.d.ts`);
    return;
  }

  writeFileSync(filePath, updated);
  log(`  UPDATED scripts/ts-defs/instanceTypes.d.ts`);
}

export function updateObjects(
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger = console.log,
): void {
  const filePath = path.join(rootDir, "scripts/ts-defs/objects.d.ts");
  const content = readFileSync(filePath, "utf-8");

  const line = `\treadonly ${objectType.name}: IObjectType<InstanceType.${objectType.name}>;`;

  // Insert before the closing `}` of the class (last line `}`)
  const lastBrace = content.lastIndexOf("\n}");
  const updated = content.slice(0, lastBrace) + "\n" + line + "\n" + content.slice(lastBrace);

  if (dryRun) {
    log(`  UPDATE scripts/ts-defs/objects.d.ts`);
    return;
  }

  writeFileSync(filePath, updated);
  log(`  UPDATED scripts/ts-defs/objects.d.ts`);
}

// ─── addInstVars helpers ───

export function findObjectTypeFile(rootDir: string, typeName: string): string | null {
  const objectTypesDir = path.join(rootDir, "objectTypes");
  const allPaths = find_all_objectTypes_path(objectTypesDir);
  for (const p of allPaths) {
    const basename = path.basename(p, ".json");
    if (basename === typeName) return p;
  }
  return null;
}

export function processAddInstVars(
  rootDir: string,
  entries: AddInstVarsEntry[],
  dryRun: boolean,
  log: Logger = console.log,
): void {
  for (const entry of entries) {
    const newVars: InstVarDef[] = entry.instanceVariables;

    // 1. Update objectType JSON
    const objectTypeFile = findObjectTypeFile(rootDir, entry.type);
    if (!objectTypeFile) {
      throw new Error(`addInstVars: objectType "${entry.type}" not found under objectTypes/`);
    }
    const relOtPath = path.relative(rootDir, objectTypeFile).replace(/\\/g, "/");

    const objectType = JSON.parse(readFileSync(objectTypeFile, "utf-8"));
    if (!objectType.instanceVariables) {
      objectType.instanceVariables = [];
    }
    const added = addInstVarsToObjectType(objectType, newVars);
    if (added.length === 0) {
      log(`  SKIP ${relOtPath} (all instVars already exist)`);
    } else if (dryRun) {
      log(`  UPDATE ${relOtPath} (+${added.join(", ")})`);
    } else {
      writeFileSync(objectTypeFile, JSON.stringify(objectType, null, "\t") + "\n");
      log(`  UPDATED ${relOtPath} (+${added.join(", ")})`);
    }

    // 2. Update layout instances
    const layoutsDir = path.join(rootDir, "layouts");
    const allLayouts = find_all_layouts_path(layoutsDir);
    let totalInstances = 0;
    for (const layoutPath of allLayouts) {
      const layout = JSON.parse(readFileSync(layoutPath, "utf-8"));
      const count = addInstVarsToLayout(layout, entry.type, newVars);
      if (count > 0) {
        totalInstances += count;
        const relPath = path.relative(rootDir, layoutPath).replace(/\\/g, "/");
        if (dryRun) {
          log(`  UPDATE ${relPath} (${count} instance(s))`);
        } else {
          writeFileSync(layoutPath, JSON.stringify(layout, null, "\t") + "\n");
          log(`  UPDATED ${relPath} (${count} instance(s))`);
        }
      }
    }
    if (totalInstances === 0) {
      log(`  No layout instances found for ${entry.type}`);
    }

    // 3. Update instanceTypes.d.ts
    if (added.length > 0) {
      const typesFile = path.join(rootDir, "scripts/ts-defs/instanceTypes.d.ts");
      const typesContent = readFileSync(typesFile, "utf-8");
      const updatedTypes = addInstVarsToTypesDts(typesContent, entry.type, newVars);
      if (updatedTypes === null) {
        log(`  WARN: class "${entry.type}" not found in instanceTypes.d.ts — manual update needed`);
      } else if (updatedTypes === typesContent) {
        log(`  SKIP instanceTypes.d.ts (instVars already declared)`);
      } else if (dryRun) {
        log(`  UPDATE scripts/ts-defs/instanceTypes.d.ts (+${added.join(", ")})`);
      } else {
        writeFileSync(typesFile, updatedTypes);
        log(`  UPDATED scripts/ts-defs/instanceTypes.d.ts (+${added.join(", ")})`);
      }
    }
  }
}

// ─── Layout mutation helpers ───

export function buildDefaultValue(type: "string" | "number" | "boolean"): string | number | boolean {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

export function applyNonworldInstance(
  layout: LayoutJson,
  op: AddNonworldInstanceOp,
  uid: number,
  objectTypes: ObjectTypeCreate[],
): void {
  // Resolve default properties based on plugin
  const ot = objectTypes.find((o) => o.name === op.type);
  let defaultProps: Record<string, unknown> = {};
  if (ot?.plugin === "Arr") {
    defaultProps = { width: 1, height: 1, depth: 1 };
  }

  // Resolve instance variables: use provided values, fallback to defaults from objectType definition
  const resolvedIVars: Record<string, string | number | boolean> = {};
  if (ot?.instanceVariables) {
    for (const ivar of ot.instanceVariables) {
      resolvedIVars[ivar.name] = op.instanceVariables?.[ivar.name] ?? buildDefaultValue(ivar.type);
    }
  }
  // Also apply any extra values from op.instanceVariables
  if (op.instanceVariables) {
    for (const [k, v] of Object.entries(op.instanceVariables)) {
      resolvedIVars[k] = v;
    }
  }

  const newInstance: NonworldInstance = {
    type: op.type,
    properties: op.properties ?? defaultProps,
    uid,
    sid: generateContextSid(),
    tags: op.tags ?? "",
    instanceVariables: resolvedIVars,
  };

  if (!layout["nonworld-instances"]) {
    layout["nonworld-instances"] = [];
  }
  layout["nonworld-instances"].push(newInstance);
}

// ─── Main apply function ───

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve a `"sid:X"` variable ref to its name in the given sheet, or null. */
function findVariableNameBySidRef(sheet: EventSheet, ref: string): string | null {
  const sid = Number(ref.slice("sid:".length));
  if (!Number.isFinite(sid)) return null;
  let found: string | null = null;
  function walk(nodes: EventSheetEvent[]): void {
    for (const ev of nodes) {
      if (found) return;
      if (ev.eventType === "variable" && ev.sid === sid) {
        found = ev.name;
        return;
      }
      const children = (ev as { children?: EventSheetEvent[] }).children;
      if (Array.isArray(children)) walk(children);
    }
  }
  walk(sheet.events);
  return found;
}

/**
 * Refuse a global → local demotion when the variable is referenced from other
 * event sheets — a project-wide global cannot be confined to a single local
 * scope. The check is conservative: it matches the variable name as a whole
 * word in each other sheet's raw JSON (covering both `runtime.globalVars.NAME`
 * script refs and bare-name C3 expression params), so it may over-refuse on a
 * coincidental match; resolve by replacing the external usages or relocating
 * the global first. `$symbol` refs are skipped (they name an in-recipe variable
 * that cannot have pre-existing external references).
 */
function checkMoveVariableDemotions(
  rootDir: string,
  files: NonNullable<Recipe["files"]>,
  log: Logger,
): void {
  const demotions: Array<{ filePath: string; varName: string }> = [];
  for (const [filePath, entry] of Object.entries(files)) {
    if (isFileCreate(entry)) continue;
    for (const op of entry) {
      if (op.op !== "move-variable" || op.to === "root") continue;
      if (!op.variable.startsWith("sid:")) continue;
      const varName = findVariableNameBySidRef(loadSheet(rootDir, filePath), op.variable);
      if (varName !== null) demotions.push({ filePath, varName });
    }
  }
  if (demotions.length === 0) return;

  const allFiles = find_all_eventsheets_path(path.join(rootDir, "eventSheets"));
  for (const { filePath, varName } of demotions) {
    const targetResolved = path.resolve(rootDir, filePath);
    const wordRe = new RegExp(`\\b${escapeRegExp(varName)}\\b`);
    const offending: string[] = [];
    for (const fullPath of allFiles) {
      if (path.resolve(fullPath) === targetResolved) continue;
      if (wordRe.test(readFileSync(fullPath, "utf-8"))) {
        offending.push(path.relative(rootDir, fullPath));
      }
    }
    if (offending.length > 0) {
      throw new Error(
        `move-variable: cannot demote global variable "${varName}" to local — it is referenced in ` +
          `${offending.length} other event sheet(s): ${offending.join(", ")}. ` +
          `Replace those usages (e.g. via shared getter/setter functions) or relocate the global first.`,
      );
    }
  }
  log(`move-variable: demotion safety check passed for ${demotions.map((d) => `"${d.varName}"`).join(", ")}`);
}

export function applyRecipeInner(rootDir: string, recipe: Recipe, opts: ApplyOptions = {}) {
  const { dryRun = false, preview = false, regenerate = true, log = console.log } = opts;
  // Validate recipe structure
  const errors = validateRecipe(recipe);
  if (errors.length > 0) {
    throw new Error("Recipe validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  }

  const objectTypeCount = recipe.objectTypes?.length ?? 0;
  const addInstVarsCount = recipe.addInstVars?.length ?? 0;
  const fileCount = recipe.files ? Object.keys(recipe.files).length : 0;
  const layoutFileCount = recipe.layouts ? Object.keys(recipe.layouts).length : 0;
  const layoutOpCount = recipe.layouts
    ? Object.values(recipe.layouts).reduce((sum, ops) => sum + ops.length, 0)
    : 0;
  const fileOpCount = recipe.files
    ? Object.entries(recipe.files).reduce((sum, [, entry]) => sum + (Array.isArray(entry) ? entry.length : 1), 0)
    : 0;
  const totalOpCount = fileOpCount + layoutOpCount;

  const summaryParts: string[] = [];
  if (objectTypeCount > 0) summaryParts.push(`${objectTypeCount} objectType(s)`);
  if (addInstVarsCount > 0) summaryParts.push(`${addInstVarsCount} addInstVars type(s)`);
  if (fileCount > 0) summaryParts.push(`${fileCount} eventSheet file(s)`);
  if (layoutFileCount > 0) summaryParts.push(`${layoutFileCount} layout file(s)`);
  summaryParts.push(`${totalOpCount} operation(s)`);
  log(`Recipe: ${summaryParts.join(", ")}`);

  // Safety: a move-variable global → local demotion is only valid when the
  // global is not referenced from other event sheets. Check before any dry-run
  // output or write so validate-recipe surfaces it too.
  if (recipe.files && Object.keys(recipe.files).length > 0) {
    checkMoveVariableDemotions(rootDir, recipe.files, log);
  }

  if (dryRun) {
    log("\n--- Dry run (no files written) ---\n");

    // objectTypes dry-run output
    if (recipe.objectTypes && recipe.objectTypes.length > 0) {
      log("objectTypes:");
      for (const ot of recipe.objectTypes) {
        createObjectType(rootDir, ot, true, log);
        updateInstanceTypes(rootDir, ot, true, log);
        updateObjects(rootDir, ot, true, log);
      }
      log();
    }

    // addInstVars dry-run output
    if (recipe.addInstVars && recipe.addInstVars.length > 0) {
      log("addInstVars:");
      processAddInstVars(rootDir, recipe.addInstVars, true, log);
      log();
    }

    // files dry-run output
    if (recipe.files && Object.keys(recipe.files).length > 0) {
      log("files:");
      for (const [filePath, entry] of Object.entries(recipe.files)) {
        if (isFileCreate(entry)) {
          log(`  CREATE ${filePath} (${entry.events.length} events)`);
        } else {
          log(`  MODIFY ${filePath} (${entry.length} ops)`);
          for (const op of entry) {
            const opPath = "path" in op ? op.path : undefined;
            const opPaths = "paths" in op ? op.paths : undefined;
            const pathStr = opPath ?? (opPaths ? `[${opPaths.length} paths]` : "");
            const indexStr =
              "actionIndex" in op && (op as { actionIndex?: number }).actionIndex !== undefined
                ? ` [actionIndex: ${(op as { actionIndex: number }).actionIndex}]`
                : "";
            log(`    - ${op.op}${pathStr ? ` @ ${pathStr}` : ""}${indexStr}`);
            if (op.op === "patch-script") {
              const patchOp = op as PatchScriptOp;
              if (patchOp.matchScript !== undefined) {
                log(`      matchScript: ${JSON.stringify(patchOp.matchScript)}`);
              }
              log(`      find:    ${JSON.stringify(patchOp.find)}`);
              log(
                `      replace: ${JSON.stringify(Array.isArray(patchOp.replace) ? patchOp.replace.join("\n") : patchOp.replace)}`,
              );
            }
            if (op.op === "rename-symbol") {
              const renameOp = op as RenameSymbolOp;
              for (const r of renameOp.replacements) {
                log(`      ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
              }
            }
          }
        }
      }
      log();
    }

    // layouts dry-run output
    if (recipe.layouts && Object.keys(recipe.layouts).length > 0) {
      log("layouts:");
      for (const [filePath, ops] of Object.entries(recipe.layouts)) {
        log(`  MODIFY ${filePath} (${ops.length} ops)`);
        for (const op of ops) {
          switch (op.op) {
            case "add-nonworld-instance":
              log(`    - ${op.op} type=${op.type}`);
              break;
            case "add-sublayer":
              log(`    - ${op.op} name="${op.name}" parent="${op.parent}"${op.after ? ` after="${op.after}"` : ""}`);
              break;
            case "add-layer":
              log(`    - ${op.op} name="${op.name}"${op.after ? ` after="${op.after}"` : ""}`);
              break;
            case "copy-instance":
              log(`    - ${op.op} type=${op.type} from=${op.from} targetLayer="${op.targetLayer}"`);
              break;
            case "templatize":
              log(`    - ${op.op} type=${op.type} templateName="${op.templateName}"`);
              break;
            case "replicify":
              log(`    - ${op.op} type=${op.type} sourceTemplateName="${op.sourceTemplateName}"`);
              break;
            case "add-replica":
              log(
                `    - ${op.op} sourceTemplateName="${op.sourceTemplateName}" from=${op.from} targetLayer="${op.targetLayer}"`,
              );
              break;
            case "remove-instance":
              log(`    - ${op.op} type=${op.type}`);
              break;
            case "remove-layer":
              log(`    - ${op.op} layer="${op.layer}"`);
              break;
            case "move-instance":
              log(`    - ${op.op} type=${op.type} targetLayer="${op.targetLayer}"`);
              break;
            case "rename-layer":
              log(`    - ${op.op} "${op.currentName}" \u2192 "${op.newName}"`);
              break;
          }
        }
      }
      log();
    }

    if (preview && recipe.files) {
      log("--- Preview (script diffs) ---\n");
      for (const [filePath, entry] of Object.entries(recipe.files)) {
        if (isFileCreate(entry)) {
          log(`  CREATE ${filePath} — new file with ${entry.events.length} event(s)`);
          continue;
        }
        const original = loadSheet(rootDir, filePath);
        const clone = JSON.parse(JSON.stringify(original)) as EventSheet;
        executeFileOps(clone, entry);

        const diffs = diffScripts(filePath, original, clone);
        if (diffs.length === 0) {
          log(`  ${filePath} — no script changes`);
        } else {
          log(`  ${filePath}:`);
          for (const d of diffs) {
            log(d);
          }
        }
      }
    }

    log("\nValidation passed. Run without --dry-run to apply.");
    return;
  }

  // ─── Step 1: Process objectTypes ───
  if (recipe.objectTypes && recipe.objectTypes.length > 0) {
    log("\nobjectTypes:");
    for (const ot of recipe.objectTypes) {
      const created = createObjectType(rootDir, ot, false, log);
      if (created) {
        updateInstanceTypes(rootDir, ot, false, log);
        updateObjects(rootDir, ot, false, log);
      }
    }
  }

  // ─── Step 1b: Process addInstVars ───
  if (recipe.addInstVars && recipe.addInstVars.length > 0) {
    log("\naddInstVars:");
    processAddInstVars(rootDir, recipe.addInstVars, false, log);
  }

  // ─── Step 2: Process layouts ───
  if (recipe.layouts && Object.keys(recipe.layouts).length > 0) {
    log("\nlayouts:");
    const layoutsDir = path.join(rootDir, "layouts");
    const allUids = collectAllUids(layoutsDir);
    const uidCounter = { next: Math.max(...allUids, 0) + 1 };
    const sourceLayoutCache = new Map<string, MutatorLayoutJson>();

    for (const [layoutPath, ops] of Object.entries(recipe.layouts)) {
      const fullPath = path.join(rootDir, layoutPath);
      const layout = JSON.parse(readFileSync(fullPath, "utf-8")) as LayoutJson;
      const layoutSids = collectLayoutSids(layout as Record<string, unknown>);

      for (const op of ops) {
        switch (op.op) {
          case "add-nonworld-instance":
            applyNonworldInstance(layout, op, uidCounter.next++, recipe.objectTypes ?? []);
            log(`  MODIFIED ${layoutPath} (+nonworld ${op.type} uid=${uidCounter.next - 1})`);
            break;

          case "add-sublayer": {
            const parentLayer = findLayer(layout as MutatorLayoutJson, op.parent);
            if (!parentLayer) {
              throw new Error(`add-sublayer: parent layer "${op.parent}" not found in ${layoutPath}`);
            }
            addSublayer(parentLayer, op.name, op.after ? { after: op.after } : undefined);
            log(`  MODIFIED ${layoutPath} (+sublayer "${op.name}" under "${op.parent}")`);
            break;
          }

          case "add-layer":
            addLayer(layout as MutatorLayoutJson, op.name, op.after ? { after: op.after } : undefined);
            log(`  MODIFIED ${layoutPath} (+layer "${op.name}")`);
            break;

          case "copy-instance": {
            let sourceLayout = sourceLayoutCache.get(op.from);
            if (!sourceLayout) {
              const sourceFullPath = path.join(rootDir, op.from);
              sourceLayout = JSON.parse(readFileSync(sourceFullPath, "utf-8")) as MutatorLayoutJson;
              sourceLayoutCache.set(op.from, sourceLayout);
            }
            copyInstance({
              sourceLayout,
              targetLayout: layout as MutatorLayoutJson,
              instanceType: op.type,
              includeChildren: op.includeChildren ?? false,
              targetLayer: op.targetLayer,
              childrenLayer: op.childrenLayer,
              uidCounter,
              sidGenerator: () => generateUniqueSid(layoutSids),
              overrides: op.overrides,
              childOverrides: op.childOverrides,
            });
            log(`  MODIFIED ${layoutPath} (+copy ${op.type} from ${op.from})`);
            break;
          }

          case "templatize":
            templatize(layout as MutatorLayoutJson, op.type, op.templateName, op.inheritOverrides);
            log(`  MODIFIED ${layoutPath} (templatize ${op.type} as "${op.templateName}")`);
            break;

          case "replicify":
            replicify(layout as MutatorLayoutJson, op.type, op.sourceTemplateName, op.inheritOverrides);
            log(`  MODIFIED ${layoutPath} (replicify ${op.type} as replica of "${op.sourceTemplateName}")`);
            break;

          case "add-replica": {
            let sourceLayout = sourceLayoutCache.get(op.from);
            if (!sourceLayout) {
              const sourceFullPath = path.join(rootDir, op.from);
              sourceLayout = JSON.parse(readFileSync(sourceFullPath, "utf-8")) as MutatorLayoutJson;
              sourceLayoutCache.set(op.from, sourceLayout);
            }
            addReplica({
              sourceLayout,
              sourceTemplateName: op.sourceTemplateName,
              targetLayout: layout as MutatorLayoutJson,
              targetLayer: op.targetLayer,
              childrenLayer: op.childrenLayer,
              uidCounter,
              sidGenerator: () => generateUniqueSid(layoutSids),
              overrides: op.overrides,
              childOverrides: op.childOverrides,
              inheritOverrides: op.inheritOverrides,
            });
            log(`  MODIFIED ${layoutPath} (+replica "${op.sourceTemplateName}" from ${op.from})`);
            break;
          }

          case "remove-instance":
            removeInstance(layout as MutatorLayoutJson, op.type, op.layer);
            log(`  MODIFIED ${layoutPath} (-instance ${op.type}${op.layer ? ` from layer ${op.layer}` : ""})`);
            break;

          case "remove-layer":
            removeLayer(layout as MutatorLayoutJson, op.layer);
            log(`  MODIFIED ${layoutPath} (-layer ${op.layer})`);
            break;

          case "move-instance":
            moveInstance({
              layout: layout as MutatorLayoutJson,
              typeName: op.type,
              targetLayer: op.targetLayer,
              childrenLayer: op.childrenLayer,
              uidCounter,
              sidGenerator: () => generateUniqueSid(layoutSids),
            });
            log(`  MODIFIED ${layoutPath} (move ${op.type} \u2192 "${op.targetLayer}")`);
            break;

          case "rename-layer":
            renameLayer(layout as MutatorLayoutJson, op.currentName, op.newName);
            log(`  MODIFIED ${layoutPath} (rename layer "${op.currentName}" \u2192 "${op.newName}")`);
            break;
        }
      }

      if (!dryRun) {
        writeFileSync(fullPath, JSON.stringify(layout, null, "\t") + "\n");
      }
    }
  }

  // ─── Step 3: Process files ───
  if (recipe.files && Object.keys(recipe.files).length > 0) {
    log("\nfiles:");
    const result = executeRecipe({ files: recipe.files }, (filePath) => loadSheet(rootDir, filePath));

    for (const [filePath, sheet] of result.modified) {
      const fullPath = path.join(rootDir, filePath);
      writeFileSync(fullPath, JSON.stringify(sheet, null, "\t") + "\n");
      log(`  MODIFIED ${filePath}`);
    }

    for (const [filePath, sheet] of result.created) {
      const fullPath = path.join(rootDir, filePath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, JSON.stringify(sheet, null, "\t") + "\n");
      log(`  CREATED ${filePath}`);
    }
  }

  log("\nDone.");
  log("\nReminder: run 'npm run sync-c3proj' to register new files with Construct 3.");

  if (regenerate) {
    regenerateExtracted(rootDir, recipe.layouts !== undefined && Object.keys(recipe.layouts).length > 0, log);
  }
}

export function applyParsed(rootDir: string, recipe: Recipe, opts: ApplyOptions = {}): void {
  const resolved: ApplyOptions = { ...opts };
  if (resolved.preview) resolved.dryRun = true;

  const registryPath = path.join(rootDir, "extracted", "sid-registry.txt");
  initSidContext(registryPath);
  try {
    applyRecipeInner(rootDir, recipe, resolved);
  } finally {
    resetSidContext();
  }
}

// ─── Rename symbols function ───

export function renameSymbols(
  rootDir: string,
  replacements: Array<{ from: string; to: string }>,
  dryRun: boolean,
  preview: boolean,
  regenerate: boolean,
  log: Logger = console.log,
) {
  if (preview) dryRun = true;

  // Validate replacements
  for (const r of replacements) {
    if (!r.from) {
      throw new Error("Error: replacement 'from' field must be non-empty");
    }
  }

  log(`Replacements (${replacements.length}):`);
  for (const r of replacements) {
    log(`  ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
  }

  // Discover all eventSheet files
  const eventSheetsDir = path.join(rootDir, "eventSheets");
  const allFiles = find_all_eventsheets_path(eventSheetsDir);
  log(`\nScanning ${allFiles.length} eventSheet file(s)...\n`);

  // Apply replacements to each file
  const matched: Array<{ filePath: string; count: number; original: EventSheet; modified: EventSheet }> = [];

  for (const fullPath of allFiles) {
    const relPath = path.relative(rootDir, fullPath);
    const original = loadSheet(rootDir, relPath);
    const clone = JSON.parse(JSON.stringify(original)) as EventSheet;
    const count = applyReplacements(clone, replacements);
    if (count > 0) {
      matched.push({ filePath: relPath, count, original, modified: clone });
    }
  }

  if (matched.length === 0) {
    const fromList = replacements.map((r) => `"${r.from}"`).join(", ");
    throw new Error(`No matches found in any eventSheet. Searched for: ${fromList}`);
  }

  const totalActions = matched.reduce((sum, m) => sum + m.count, 0);
  log(`Found ${totalActions} modified script action(s) across ${matched.length} file(s):`);
  for (const m of matched) {
    log(`  ${m.filePath} (${m.count} action(s))`);
  }

  if (preview) {
    log("\n--- Preview (script diffs) ---\n");
    for (const m of matched) {
      const diffs = diffScripts(m.filePath, m.original, m.modified);
      if (diffs.length === 0) {
        log(`  ${m.filePath} — no script changes`);
      } else {
        log(`  ${m.filePath}:`);
        for (const d of diffs) {
          log(d);
        }
      }
    }
  }

  if (dryRun) {
    log("\nDry run complete. Run without --dry-run to apply.");
    return;
  }

  // Write modified files
  for (const m of matched) {
    const fullPath = path.join(rootDir, m.filePath);
    writeFileSync(fullPath, JSON.stringify(m.modified, null, "\t") + "\n");
    log(`  MODIFIED ${m.filePath}`);
  }

  log(`\nDone. ${matched.length} file(s) modified, ${totalActions} script action(s) updated.`);

  if (regenerate) {
    regenerateExtracted(rootDir);
  }
}
