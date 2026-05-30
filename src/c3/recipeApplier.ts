import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { extractScripts, generateDSL, generateLayoutSummaries } from "./generators.js";
import type { Logger } from "genvid-mcp-utils";
import { escapeRegExp } from "genvid-mcp-utils";
import type { ApplyOptions } from "./types.js";
import type { EventSheet, EventSheetEvent, SidSlot } from "c3source";
import { find_all_eventsheets_path, find_all_objectTypes_path, find_all_layouts_path, findSid } from "c3source";
import {
  type Recipe,
  type ObjectTypeCreate,
  type AddInstVarsEntry,
  type AddNonworldInstanceOp,
  type PatchScriptOp,
  type RenameSymbolOp,
  type PrimitiveLayoutOp,
  type FileOp,
  validateRecipe,
  executeFileOps,
  isFileCreate,
  applyReplacements,
  createSheet,
  extractSheetName,
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
import { collectAllUids, collectLayoutSids } from "./layoutScaffold.js";
import { readRegistryFile, makeSidGen, freshSidGen, type SidGenerator } from "./sidUtils.js";
import { diffScripts } from "./previewDiff.js";
import { expandWorkflows, type LoadLayout } from "./workflowExpansion.js";
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

/**
 * Max value of a numeric Set. Avoids `Math.max(...set, 0)` because spreading
 * a large Set onto the argument list hits V8's argument-count limit (~100k+)
 * with `RangeError: Maximum call stack size exceeded`. For typical C3 projects
 * the Set is small, but `validate-recipe` runs on this path too and shouldn't
 * inherit a scaling cliff. Returns 0 when the Set is empty.
 */
function maxFromSet(set: Set<number>): number {
  let max = 0;
  for (const v of set) {
    if (v > max) max = v;
  }
  return max;
}

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
  sidGen: SidGenerator,
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger = console.log,
): boolean {
  const relPath = getObjectTypePath(objectType);
  const fullPath = path.join(rootDir, relPath);

  // Respect the SKIP-if-exists fast path before validating the plugin so a
  // recipe that re-declares an already-existing objectType (a benign no-op)
  // stays a no-op even if the recipe carries a stale or typoed plugin name.
  // For new objectTypes we still reject unknown plugins up-front — otherwise
  // updateInstanceTypes would silently write `class X extends undefined`.
  if (existsSync(fullPath)) {
    log(`  SKIP ${relPath} (already exists)`);
    return false;
  }

  if (!(objectType.plugin in PLUGIN_BASE_CLASS)) {
    throw new Error(
      `createObjectType: unknown plugin "${objectType.plugin}" for objectType "${objectType.name}". ` +
        `Valid plugins: ${Object.keys(PLUGIN_BASE_CLASS).join(", ")}.`,
    );
  }

  const ivars = (objectType.instanceVariables ?? []).map((v) => ({
    name: v.name,
    type: v.type,
    desc: "",
    show: true,
    sid: sidGen(),
  }));

  const json = {
    name: objectType.name,
    "plugin-id": objectType.plugin,
    sid: sidGen(),
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
  sidGen: SidGenerator,
  rootDir: string,
  entries: AddInstVarsEntry[],
  dryRun: boolean,
  log: Logger = console.log,
  pendingObjectTypes?: ObjectTypeCreate[],
): void {
  const pending = new Map<string, ObjectTypeCreate>();
  for (const ot of pendingObjectTypes ?? []) pending.set(ot.name, ot);

  for (const entry of entries) {
    const newVars: InstVarDef[] = entry.instanceVariables;

    // In dry-run, a type being created earlier in the same recipe won't be on
    // disk yet (createObjectType's write is suppressed). Without this branch,
    // validate-recipe would spuriously throw `objectType "X" not found` for a
    // recipe that apply-recipe would accept. The createObjectType pass already
    // logged the would-be create, so we just merge addInstVars into the
    // pending entry's variable list (no layout instances exist for a
    // brand-new type, and updateInstanceTypes will declare the class).
    if (dryRun && pending.has(entry.type)) {
      const ot = pending.get(entry.type)!;
      const existing = new Set((ot.instanceVariables ?? []).map((v) => v.name));
      const added = newVars.filter((v) => !existing.has(v.name)).map((v) => v.name);
      if (added.length === 0) {
        log(`  SKIP pending objectType "${entry.type}" (all instVars already declared)`);
      } else {
        log(`  UPDATE pending objectType "${entry.type}" (+${added.join(", ")})`);
      }
      continue;
    }

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
    const added = addInstVarsToObjectType(sidGen, objectType, newVars);
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
  sidGen: SidGenerator,
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
    sid: sidGen(),
    tags: op.tags ?? "",
    instanceVariables: resolvedIVars,
  };

  if (!layout["nonworld-instances"]) {
    layout["nonworld-instances"] = [];
  }
  layout["nonworld-instances"].push(newInstance);
}

// ─── Main apply function ───

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

// ─── SID location lookup (apply-time hinting) ───

/**
 * Reports which slot the given `sid` lives in (event / condition / action /
 * function-parameter), or `null` when truly absent. Thin wrapper over
 * c3source's `findSid`, which owns the schema knowledge of which slots carry
 * sids. Used to enrich the "SID not found in event sheet" / "does not support
 * actions" errors when the SID actually exists on a non-event slot — the
 * canonical trap behind "agents grab a non-event SID surfaced by
 * read-dsl-index". `buildSidIndex` only indexes top-level events, so the
 * SID-resolution path can't otherwise distinguish "totally missing" from
 * "present on a non-event slot".
 */
function findSidLocation(sheet: EventSheet, sid: number): SidSlot | null {
  return findSid(sheet, sid)?.slot ?? null;
}

/**
 * Locate `sid` in either the pre-batch `original` sheet or the post-mutation
 * `clone`, preferring whichever finds a more specific slot. Callers don't know
 * whether the failure is "SID never existed" vs "SID was just inserted by an
 * earlier op" vs "SID was just removed" — checking both views catches all three.
 */
function findSidLocationEither(
  original: EventSheet,
  clone: EventSheet,
  sid: number,
): SidSlot | null {
  // Try clone first — reflects in-batch insertions and most current state.
  return findSidLocation(clone, sid) ?? findSidLocation(original, sid);
}

/** Build the human-readable "did you mean the parent block?" guidance. */
function sidLocationHint(filePath: string, sid: number, location: SidSlot): string {
  if (location === "event") {
    // The op tried to do something the event kind doesn't support (e.g.
    // insert-actions into a group). Point the user at the parent block.
    return (
      ` (in ${filePath}). ` +
      `Hint: SID ${sid} exists on an event that doesn't support this op kind. ` +
      `Recipe ops like insert-actions / replace-action / patch-action-param target a ` +
      `block (or function-block / custom-ace-block); walk into a child block.sid.`
    );
  }
  return (
    ` (in ${filePath}). ` +
    `Hint: SID ${sid} exists on a ${location}, not on an event. ` +
    `Recipe \`in:\`/\`after:\`/\`before:\` targets must address an event block — ` +
    `walk up to the enclosing block.sid (not block.conditions[].sid, block.actions[].sid, ` +
    `or function-block.functionParameters[].sid).`
  );
}

/**
 * Runs `executeFileOps` against a clone of the original sheet, catching SID
 * resolution and SID kind-mismatch errors to add a location hint when the SID
 * actually lives on a condition / action / function-parameter — or on an event
 * of the wrong kind. Used by both the dry-run pass and the apply pass so
 * validate-recipe and apply-recipe surface the same diagnostics.
 *
 * Preserves the original error's stack/cause when wrapping (Node's
 * `{ cause }` option).
 */
function executeFileOpsWithHints(
  sidGen: SidGenerator,
  filePath: string,
  original: EventSheet,
  clone: EventSheet,
  ops: FileOp[],
  options?: { autoAdjust?: boolean },
): void {
  try {
    executeFileOps(sidGen, clone, ops, options);
  } catch (e) {
    if (!(e instanceof Error)) throw e;

    // (1) "SID not found in event sheet" — the SID didn't resolve at all.
    //     Common cause: the SID lives on a condition / action / function param.
    const notFoundMatch = /^SID (\d+) not found in event sheet/.exec(e.message);
    if (notFoundMatch) {
      const sid = Number(notFoundMatch[1]);
      const location = findSidLocationEither(original, clone, sid);
      if (location && location !== "event") {
        throw new Error(e.message + sidLocationHint(filePath, sid, location), { cause: e });
      }
      throw e;
    }

    // (2) "<op>: target "sid:X" (eventType: "Y") does not support …" — the
    //     SID resolves to an event, but the wrong kind. Point the user at a
    //     child block when the SID names a group / function-block / etc.
    const kindMatch = /target "sid:(\d+)" \(eventType: "[^"]+"\) does not support/.exec(e.message);
    if (kindMatch) {
      const sid = Number(kindMatch[1]);
      throw new Error(e.message + sidLocationHint(filePath, sid, "event"), { cause: e });
    }

    throw e;
  }
}

// ─── Layout op dispatch ───

interface LayoutOpContext {
  rootDir: string;
  uidCounter: { next: number };
  sourceLayoutCache: Map<string, MutatorLayoutJson>;
  sidGen: SidGenerator;
  objectTypes: ObjectTypeCreate[];
}

/**
 * Mutates `layout` by applying a single layout op. Logs the per-op `MODIFIED`
 * line via `log`; for a dry-run validation pass, pass a no-op logger so the
 * caller's own summary log is the only output.
 *
 * Throws (via the underlying layoutMutator) when the op references a missing
 * layer, missing instance type, etc. — that's the apply-time error we want
 * dry-run to surface.
 */
function applyLayoutOp(
  layout: LayoutJson,
  layoutPath: string,
  op: PrimitiveLayoutOp,
  ctx: LayoutOpContext,
  log: Logger,
): void {
  switch (op.op) {
    case "add-nonworld-instance": {
      const uid = ctx.uidCounter.next;
      applyNonworldInstance(ctx.sidGen, layout, op, ctx.uidCounter.next++, ctx.objectTypes);
      log(`  MODIFIED ${layoutPath} (+nonworld ${op.type} uid=${uid})`);
      break;
    }

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
      let sourceLayout = ctx.sourceLayoutCache.get(op.from);
      if (!sourceLayout) {
        const sourceFullPath = path.join(ctx.rootDir, op.from);
        sourceLayout = JSON.parse(readFileSync(sourceFullPath, "utf-8")) as MutatorLayoutJson;
        ctx.sourceLayoutCache.set(op.from, sourceLayout);
      }
      copyInstance({
        sourceLayout,
        targetLayout: layout as MutatorLayoutJson,
        instanceType: op.type,
        includeChildren: op.includeChildren ?? false,
        targetLayer: op.targetLayer,
        childrenLayer: op.childrenLayer,
        uidCounter: ctx.uidCounter,
        sidGenerator: ctx.sidGen,
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
      let sourceLayout = ctx.sourceLayoutCache.get(op.from);
      if (!sourceLayout) {
        const sourceFullPath = path.join(ctx.rootDir, op.from);
        sourceLayout = JSON.parse(readFileSync(sourceFullPath, "utf-8")) as MutatorLayoutJson;
        ctx.sourceLayoutCache.set(op.from, sourceLayout);
      }
      addReplica({
        sourceLayout,
        sourceTemplateName: op.sourceTemplateName,
        targetLayout: layout as MutatorLayoutJson,
        targetLayer: op.targetLayer,
        childrenLayer: op.childrenLayer,
        uidCounter: ctx.uidCounter,
        sidGenerator: ctx.sidGen,
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
        uidCounter: ctx.uidCounter,
        sidGenerator: ctx.sidGen,
      });
      log(`  MODIFIED ${layoutPath} (move ${op.type} → "${op.targetLayer}")`);
      break;

    case "rename-layer":
      renameLayer(layout as MutatorLayoutJson, op.currentName, op.newName);
      log(`  MODIFIED ${layoutPath} (rename layer "${op.currentName}" → "${op.newName}")`);
      break;

    default: {
      // Exhaustiveness check: adding a new PrimitiveLayoutOp variant in
      // recipeInterpreter.ts is a compile error here until this switch is
      // updated. Without this, a new op would silently no-op through both
      // dry-run validation and apply.
      const exhaustive: never = op;
      throw new Error(`applyLayoutOp: unsupported op ${(exhaustive as { op: string }).op}`);
    }
  }
}

export function applyRecipeInner(sidGen: SidGenerator, rootDir: string, recipe: Recipe, opts: ApplyOptions = {}) {
  const { dryRun = false, preview = false, regenerate = true, log = console.log } = opts;
  // Validate recipe structure
  const errors = validateRecipe(recipe);
  if (errors.length > 0) {
    throw new Error("Recipe validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  }

  // Composite workflow ops (extract-template, templatize-in-place,
  // clone-replica-to-layouts, replace-instance-with-replica) expand into
  // primitive layout ops here so dry-run and apply share one expansion and
  // any expansion-time errors (e.g. instance-not-found for
  // replace-instance-with-replica's snapshot) surface in validate-recipe too.
  // The expansion's `loadLayout` cache is separate from the apply loop's
  // `sourceLayoutCache` — the expansion only reads from disk; apply reads
  // and writes its own copies. For typical recipes (one or two workflows)
  // the duplicate disk reads are negligible.
  const expansionCache = new Map<string, MutatorLayoutJson>();
  const loadLayout: LoadLayout = (layoutPath) => {
    let cached = expansionCache.get(layoutPath);
    if (!cached) {
      const fullPath = path.join(rootDir, layoutPath);
      cached = JSON.parse(readFileSync(fullPath, "utf-8")) as MutatorLayoutJson;
      expansionCache.set(layoutPath, cached);
    }
    return cached;
  };
  const layoutsForLoop: Map<string, PrimitiveLayoutOp[]> =
    recipe.layouts && Object.keys(recipe.layouts).length > 0
      ? expandWorkflows(recipe, loadLayout)
      : new Map();

  const objectTypeCount = recipe.objectTypes?.length ?? 0;
  const addInstVarsCount = recipe.addInstVars?.length ?? 0;
  const fileCount = recipe.files ? Object.keys(recipe.files).length : 0;
  // Summary counts mirror what the user wrote, not the post-expansion view —
  // an agent diffing the summary against their recipe JSON should see the
  // same shape. The per-layout `MODIFY ... (N ops)` lines in dry-run output
  // are where the expansion fan-out becomes visible.
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
        createObjectType(sidGen, rootDir, ot, true, log);
        updateInstanceTypes(rootDir, ot, true, log);
        updateObjects(rootDir, ot, true, log);
      }
      log();
    }

    // addInstVars dry-run output. Pass recipe.objectTypes so entries targeting
    // a type being CREATED in this recipe (not yet on disk in dry-run) are
    // recognized as pending instead of "objectType not found".
    if (recipe.addInstVars && recipe.addInstVars.length > 0) {
      log("addInstVars:");
      processAddInstVars(sidGen, rootDir, recipe.addInstVars, true, log, recipe.objectTypes);
      log();
    }

    // layouts dry-run output + in-memory validation. Match the non-dry-run
    // section order (objectTypes → addInstVars → layouts → files) so any
    // cross-section dependency surfaces consistently. Iterates `layoutsForLoop`
    // (the workflow-expanded view) so workflow ops are validated as their
    // primitive sequence, matching what apply will do.
    if (layoutsForLoop.size > 0) {
      log("layouts:");
      const layoutsDir = path.join(rootDir, "layouts");
      const allUids = collectAllUids(layoutsDir);
      const dryRunUidCounter = { next: maxFromSet(allUids) + 1 };
      const dryRunSourceCache = new Map<string, MutatorLayoutJson>();
      const noopLog: Logger = () => {};

      for (const [filePath, ops] of layoutsForLoop) {
        // Defensive skip — same rationale as the apply loop below.
        if (ops.length === 0) continue;
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
              log(`    - ${op.op} "${op.currentName}" → "${op.newName}"`);
              break;
            default: {
              // Matches the exhaustiveness check in applyLayoutOp so a new
              // PrimitiveLayoutOp variant is a compile error here too. Workflow
              // ops never reach this switch — expandWorkflows replaces them
              // with primitive ops before the dry-run loop iterates.
              const exhaustive: never = op;
              throw new Error(`layouts dry-run: unsupported op ${(exhaustive as { op: string }).op}`);
            }
          }
        }

        // Validate by running each op against a clone. Errors thrown by
        // layoutMutator (missing layer, missing instance type, etc.) now
        // surface in dry-run instead of only at apply.
        const fullPath = path.join(rootDir, filePath);
        const original = JSON.parse(readFileSync(fullPath, "utf-8")) as LayoutJson;
        const clone = JSON.parse(JSON.stringify(original)) as LayoutJson;
        // Validation pass uses a per-layout fresh SID generator seeded with
        // the layout's existing SIDs — keeps the dry-run mutations isolated
        // from the recipe-wide sidGen.
        const dryRunCtx: LayoutOpContext = {
          rootDir,
          uidCounter: dryRunUidCounter,
          sourceLayoutCache: dryRunSourceCache,
          sidGen: makeSidGen(collectLayoutSids(clone as Record<string, unknown>)),
          objectTypes: recipe.objectTypes ?? [],
        };
        for (const op of ops) {
          applyLayoutOp(clone, filePath, op, dryRunCtx, noopLog);
        }

        // Cross-layout consistency: a later layout's `copy-instance` /
        // `add-replica` with `from: filePath` should see the mutated clone,
        // matching apply behavior where each layout is written to disk before
        // the next iterates (and reads the modified version via cache miss).
        // Without this, a recipe `{ layouts: { A: [add X], B: [copy X from A] } }`
        // throws spuriously at dry-run while apply succeeds.
        dryRunSourceCache.set(filePath, clone as MutatorLayoutJson);
      }
      log();
    }

    // files dry-run output + in-memory validation. Errors thrown by
    // executeFileOps (SID-kind mismatches, missing nodes, etc.) and by
    // createSheet (malformed file-create events) now surface during
    // validate-recipe instead of only at apply.
    if (recipe.files && Object.keys(recipe.files).length > 0) {
      log("files:");
      // Ordered preview entries: preserves recipe.files insertion order so
      // creates and modifies interleave the same way the user wrote them.
      type PreviewEntry =
        | { filePath: string; kind: "create"; eventCount: number }
        | { filePath: string; kind: "diff"; diffs: string[] };
      const previewEntries: PreviewEntry[] = [];

      for (const [filePath, entry] of Object.entries(recipe.files)) {
        if (isFileCreate(entry)) {
          log(`  CREATE ${filePath} (${entry.events.length} events)`);
          // Validate the create by building the sheet directly — createSheet
          // is the only thing executeRecipe would have called for a FileCreate
          // entry, so calling it here avoids the throwing-loader contract trap.
          createSheet(sidGen, extractSheetName(filePath), entry.events);
          if (preview) previewEntries.push({ filePath, kind: "create", eventCount: entry.events.length });
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

          // Validate by load → clone → executeFileOps. SID-kind mismatches
          // and other apply-time errors throw here; the wrapper enriches
          // "SID not found" / "does not support …" errors with a hint when the
          // SID lives on a condition / action / function-param or on the wrong
          // event kind. Defensive clone of `entry` keeps executeFileOps's
          // internal remove-event normalization from mutating the caller's
          // Recipe object.
          const original = loadSheet(rootDir, filePath);
          const clone = JSON.parse(JSON.stringify(original)) as EventSheet;
          const opsClone = JSON.parse(JSON.stringify(entry)) as FileOp[];
          executeFileOpsWithHints(sidGen, filePath, original, clone, opsClone, {
            autoAdjust: recipe.autoAdjust,
          });
          if (preview) {
            previewEntries.push({ filePath, kind: "diff", diffs: diffScripts(filePath, original, clone) });
          }
        }
      }
      log();

      if (preview && previewEntries.length > 0) {
        log("--- Preview (script diffs) ---\n");
        for (const entry of previewEntries) {
          if (entry.kind === "create") {
            log(`  CREATE ${entry.filePath} — new file with ${entry.eventCount} event(s)`);
          } else if (entry.diffs.length === 0) {
            log(`  ${entry.filePath} — no script changes`);
          } else {
            log(`  ${entry.filePath}:`);
            for (const d of entry.diffs) {
              log(d);
            }
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
      const created = createObjectType(sidGen, rootDir, ot, false, log);
      if (created) {
        updateInstanceTypes(rootDir, ot, false, log);
        updateObjects(rootDir, ot, false, log);
      }
    }
  }

  // ─── Step 1b: Process addInstVars ───
  if (recipe.addInstVars && recipe.addInstVars.length > 0) {
    log("\naddInstVars:");
    // In apply mode the objectType files have already been written by Step 1,
    // so passing pendingObjectTypes is harmless (findObjectTypeFile will find
    // them on disk). Still passed for symmetry with the dry-run call.
    processAddInstVars(sidGen, rootDir, recipe.addInstVars, false, log, recipe.objectTypes);
  }

  // ─── Step 2: Process layouts ───
  // Iterates `layoutsForLoop` (workflow-expanded), so a workflow's fan-out
  // across multiple layout keys is applied as a sequence of primitives —
  // each layout is loaded once, all its ops run, then it's written back.
  if (layoutsForLoop.size > 0) {
    log("\nlayouts:");
    const layoutsDir = path.join(rootDir, "layouts");
    const allUids = collectAllUids(layoutsDir);
    const uidCounter = { next: maxFromSet(allUids) + 1 };
    const sourceLayoutCache = new Map<string, MutatorLayoutJson>();

    for (const [layoutPath, ops] of layoutsForLoop) {
      // Defensive skip: workflowExpansion no longer pre-seeds empty arrays,
      // but a future workflow that conditionally fans out could still emit
      // zero primitives to a key. Skipping prevents a load+write of an
      // unchanged file (which would bump mtime and produce a misleading
      // "MODIFIED" log line).
      if (ops.length === 0) continue;

      const fullPath = path.join(rootDir, layoutPath);
      const layout = JSON.parse(readFileSync(fullPath, "utf-8")) as LayoutJson;
      const ctx: LayoutOpContext = {
        rootDir,
        uidCounter,
        sourceLayoutCache,
        sidGen,
        objectTypes: recipe.objectTypes ?? [],
      };

      for (const op of ops) {
        applyLayoutOp(layout, layoutPath, op, ctx, log);
      }

      // Defense in depth: the dry-run branch early-returns above, so dryRun is
      // false here today — but the explicit guard means a future code path
      // that reaches the loop without an early return can't accidentally
      // overwrite the project.
      if (!dryRun) {
        writeFileSync(fullPath, JSON.stringify(layout, null, "\t") + "\n");
      }
    }
  }

  // ─── Step 3: Process files ───
  // We do the load → clone → executeFileOps loop ourselves (instead of calling
  // executeRecipe) so the same `executeFileOpsWithHints` wrapper covers both
  // apply and dry-run paths — that gives the SID kind / function-parameter
  // hints to operators running `apply-recipe` directly without a prior
  // `validate-recipe`.
  if (recipe.files && Object.keys(recipe.files).length > 0) {
    log("\nfiles:");
    for (const [filePath, entry] of Object.entries(recipe.files)) {
      const fullPath = path.join(rootDir, filePath);
      if (isFileCreate(entry)) {
        const sheet = createSheet(sidGen, extractSheetName(filePath), entry.events);
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, JSON.stringify(sheet, null, "\t") + "\n");
        log(`  CREATED ${filePath}`);
      } else {
        const original = loadSheet(rootDir, filePath);
        const clone = JSON.parse(JSON.stringify(original)) as EventSheet;
        const opsClone = JSON.parse(JSON.stringify(entry)) as FileOp[];
        executeFileOpsWithHints(sidGen, filePath, original, clone, opsClone, {
          autoAdjust: recipe.autoAdjust,
        });
        writeFileSync(fullPath, JSON.stringify(clone, null, "\t") + "\n");
        log(`  MODIFIED ${filePath}`);
      }
    }
  }

  log("\nDone.");
  log("\nReminder: run 'npm run sync-c3proj' to register new files with Construct 3.");

  if (regenerate) {
    regenerateExtracted(rootDir, layoutsForLoop.size > 0, log);
  }
}

export function applyParsed(rootDir: string, recipe: Recipe, opts: ApplyOptions = {}): void {
  const resolved: ApplyOptions = { ...opts };
  if (resolved.preview) resolved.dryRun = true;

  // Seed the SID generator from the full sid-registry.txt (eventSheets/ + layouts/ + objectTypes/).
  // The closure mutates `used` as SIDs are minted, so every builder call in this recipe shares
  // one cumulative used-SID Set — no init/reset lifecycle needed.
  const registryPath = path.join(rootDir, "extracted", "sid-registry.txt");
  const used = readRegistryFile(registryPath);

  // Defence-in-depth against a stale registry: for every layout this recipe touches,
  // union the on-disk SIDs into `used` so layout ops can't mint a SID already present
  // in the file. The registry covers layouts/ but may lag behind a prior apply with
  // `regenerate: false` or a watcher-missed external edit.
  if (recipe.layouts) {
    for (const layoutPath of Object.keys(recipe.layouts)) {
      const fullPath = path.join(rootDir, layoutPath);
      if (!existsSync(fullPath)) continue;
      try {
        const layoutJson = JSON.parse(readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
        for (const sid of collectLayoutSids(layoutJson)) used.add(sid);
      } catch {
        // Unparseable layout — skip the defensive seed; the recipe op will surface a real error.
      }
    }
  }

  const sidGen = makeSidGen(used);
  applyRecipeInner(sidGen, rootDir, recipe, resolved);
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
