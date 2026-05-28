import type {
  EventSheet,
  EventSheetEvent,
  EventSheetVariable,
  Condition,
  ScriptAction,
  BlockEvent,
  GroupEvent,
  IncludeEvent,
  FunctionBlockEvent,
  CustomAceBlockEvent,
  FunctionParameter,
} from "c3source";

import {
  buildBlock,
  buildFunctionBlock,
  buildCustomAceBlock,
  buildAction,
  buildCallAction,
  buildScriptAction,
  buildVariable,
  buildCondition,
  buildGroup,
  buildInclude,
  buildCommentEvent,
  buildCommentAction,
  buildCustomAction,
  insertEvent,
  removeEvent,
  replaceEvent,
  insertAction,
  removeAction,
  replaceAction,
  insertCondition,
  removeCondition,
  replaceCondition,
  resolveNode,
  hasActions,
  hasChildren,
  walkScriptActions,
  walkScriptActionsInArray,
  buildSidIndex,
  type SidIndex,
  type SidIndexEntry,
  type C3Action,
  isParameterizedAction,
  getActionIdentifier,
  isStandardAction,
  isFunctionCallAction,
  isCustomAction,
} from "./eventSheetMutator.js";

import type { SidGenerator } from "./sidUtils.js";

// ─── Part 1: Recipe Format Types ───

export interface Recipe {
  objectTypes?: ObjectTypeCreate[];
  addInstVars?: AddInstVarsEntry[];
  files?: Record<string, FileCreate | FileOp[]>;
  layouts?: Record<string, LayoutOp[]>;
  autoAdjust?: boolean;
}

export interface AddInstVarsEntry {
  type: string;
  instanceVariables: Array<{ name: string; type: "string" | "number" | "boolean" }>;
}

export interface FileCreate {
  create: true;
  events: BuilderEvent[];
}

export type FileOp =
  | InsertEventOp
  | InsertVariablesOp
  | InsertActionsOp
  | InsertConditionsOp
  | ReplaceActionOp
  | ReplaceConditionOp
  | ReplaceEventOp
  | RemoveEventOp
  | RemoveActionOp
  | RemoveConditionOp
  | AddIncludeOp
  | PatchScriptOp
  | PatchActionParamOp
  | SetOrBlockOp
  | SetDisabledOp
  | RenameSymbolOp
  | PatchFunctionBlockOp
  | WrapInGroupOp
  | MoveVariableOp;

export interface InsertEventOp {
  op: "insert-event";
  path?: string;
  in?: string;
  id?: string;
  index?: number;
  after?: string | number;
  block?: BlockShorthand;
  "function-block"?: FunctionBlockShorthand;
  "custom-ace-block"?: CustomAceBlockShorthand;
  variable?: VariableShorthand;
  group?: GroupShorthand;
  comment?: string;
}

export interface InsertVariablesOp {
  op: "insert-variables";
  path?: string;
  in?: string;
  after: number;
  variables: Array<VariableShorthand | { variable: VariableShorthand }>;
}

export interface InsertActionsOp {
  op: "insert-actions";
  path?: string;
  paths?: string[];
  in?: string;
  after: number;
  actions: BuilderAction[];
}

export interface InsertConditionsOp {
  op: "insert-conditions";
  path?: string;
  paths?: string[];
  in?: string;
  after: number;
  conditions: BuilderCondition[];
}

export interface ReplaceActionOp {
  op: "replace-action";
  path?: string;
  paths?: string[];
  in?: string;
  index: number;
  action: BuilderAction;
}

export interface ReplaceConditionOp {
  op: "replace-condition";
  path?: string;
  paths?: string[];
  in?: string;
  index: number;
  condition: BuilderCondition;
}

export interface ReplaceEventOp {
  op: "replace-event";
  path?: string;
  index: number;
  block?: BlockShorthand;
  "function-block"?: FunctionBlockShorthand;
  "custom-ace-block"?: CustomAceBlockShorthand;
  variable?: VariableShorthand;
  group?: GroupShorthand;
  comment?: string;
}

export interface RemoveEventOp {
  op: "remove-event";
  path?: string;
  in?: string;
  index?: number;
}

export interface RemoveActionOp {
  op: "remove-action";
  path?: string;
  paths?: string[];
  in?: string;
  index: number;
}

export interface RemoveConditionOp {
  op: "remove-condition";
  path?: string;
  paths?: string[];
  in?: string;
  index: number;
}

export interface AddIncludeOp {
  op: "add-include";
  include: string;
  after?: string;
}

export interface PatchScriptOp {
  op: "patch-script";
  path?: string;
  paths?: string[];
  in?: string;
  actionIndex?: number;
  matchScript?: string;
  find: string;
  replace: string | string[];
  replaceAll?: boolean;
}

export interface PatchActionParamOp {
  op: "patch-action-param";
  path?: string;
  paths?: string[];
  in?: string;
  actionIndex?: number;
  matchAction?: string;
  param?: string;
  value?: unknown;
  params?: Record<string, unknown>;
}

export interface SetOrBlockOp {
  op: "set-or-block";
  path?: string;
  paths?: string[];
  in?: string;
}

export interface SetDisabledOp {
  op: "set-disabled";
  path?: string;
  paths?: string[];
  in?: string;
  disabled: boolean;
}

export interface RenameSymbolOp {
  op: "rename-symbol";
  replacements: Array<{ from: string; to: string }>;
}

export interface PatchFunctionBlockOp {
  op: "patch-function-block";
  path?: string;
  in?: string;
  addParam?: { name: string; type: "string" | "number" | "boolean"; initialValue?: string };
  removeParam?: string;
}

export interface WrapInGroupOp {
  op: "wrap-in-group";
  in?: string;
  events: string[];
  title: string;
  id?: string;
  activeOnStart?: boolean;
  disabled?: boolean;
}

/**
 * Move a variable between global and local scope within one event sheet.
 *
 * Scope is positional: a `variable` event at the sheet root is global
 * (`runtime.globalVars.X` in scripts); nested in a group/block it is local
 * (`localVars.X`). `to: "root"` promotes a local to global; a `to` SID ref to
 * a group/block demotes a global to local inside that container.
 *
 * On move the variable's SID is preserved, its `localVars.X` ⇄
 * `runtime.globalVars.X` script references are rewritten within the relevant
 * scope subtree, and (per C3 semantics — globals are effectively always static)
 * `isStatic` is normalized to `true`. The cross-sheet safety check that refuses
 * a demotion when the global is referenced from other sheets lives in the
 * applier (`recipeApplier.ts`), which can see the whole project.
 */
export interface MoveVariableOp {
  op: "move-variable";
  variable: string;
  to: string;
  index?: number;
  id?: string;
}

// ─── objectTypes / layouts Section Types ───

export interface ObjectTypeCreate {
  name: string;
  plugin: "Json" | "Dictionary" | "Arr";
  folder?: string;
  instanceVariables?: Array<{ name: string; type: "string" | "number" | "boolean" }>;
}

export type LayoutOp = AddNonworldInstanceOp | AddSublayerOp | AddLayerOp | CopyInstanceOp | TemplatizeOp | ReplicifyOp | AddReplicaOp | RemoveInstanceOp | RemoveLayerOp | MoveInstanceOp | RenameLayerOp;

export interface AddNonworldInstanceOp {
  op: "add-nonworld-instance";
  type: string;
  instanceVariables?: Record<string, string | number | boolean>;
  properties?: Record<string, unknown>;
  tags?: string;
}

export interface AddSublayerOp {
  op: "add-sublayer";
  parent: string;
  name: string;
  after?: string;
}

export interface AddLayerOp {
  op: "add-layer";
  name: string;
  after?: string;
}

export interface CopyInstanceOp {
  op: "copy-instance";
  from: string;
  type: string;
  includeChildren?: boolean;
  targetLayer: string;
  childrenLayer?: string;
  overrides?: import("./layoutMutator.js").InstanceOverrides;
  childOverrides?: Record<string, import("./layoutMutator.js").InstanceOverrides>;
}

export interface TemplatizeOp {
  op: "templatize";
  type: string;
  templateName: string;
  inheritOverrides?: Record<string, boolean>;
}

export interface ReplicifyOp {
  op: "replicify";
  type: string;
  sourceTemplateName: string;
  inheritOverrides?: Record<string, boolean>;
}

export interface AddReplicaOp {
  op: "add-replica";
  from: string;
  sourceTemplateName: string;
  targetLayer: string;
  childrenLayer?: string;
  overrides?: import("./layoutMutator.js").InstanceOverrides;
  childOverrides?: Record<string, import("./layoutMutator.js").InstanceOverrides>;
  inheritOverrides?: Record<string, boolean>;
}

export interface RemoveInstanceOp {
  op: "remove-instance";
  type: string;
  layer?: string;
}

export interface MoveInstanceOp {
  op: "move-instance";
  type: string;
  targetLayer: string;
  childrenLayer?: string;
}

export interface RemoveLayerOp {
  op: "remove-layer";
  layer: string;
}

export interface RenameLayerOp {
  op: "rename-layer";
  currentName: string;
  newName: string;
}

// ─── Builder Shorthand Types ───

export type BuilderAction =
  | { script: string[] }
  | { call: string; params?: (string | number | boolean)[] }
  | { "custom-action": string; object?: string; objectClass?: string; params?: unknown[] }
  | { comment: string }
  | { id: string; object?: string; objectClass?: string; params?: Record<string, string | number | boolean>; behavior?: string };

export type BuilderCondition =
  | { else: true }
  | { "trigger-once": true }
  | { id: string; object?: string; objectClass?: string; params?: Record<string, string | number | boolean>; inverted?: boolean; behavior?: string };

export type BuilderEvent =
  | { variable: VariableShorthand }
  | { block: BlockShorthand }
  | { "function-block": FunctionBlockShorthand }
  | { "custom-ace-block": CustomAceBlockShorthand }
  | { group: GroupShorthand }
  | { comment: string }
  | { include: string };

export interface VariableShorthand {
  name: string;
  type: "string" | "number" | "boolean";
  value?: string;
  initialValue?: string;
  constant?: boolean;
  isConstant?: boolean;
  static?: boolean;
  isStatic?: boolean;
}

export interface BlockShorthand {
  conditions?: BuilderCondition[];
  actions?: BuilderAction[];
  children?: BuilderEvent[];
  orBlock?: boolean;
}

export interface FunctionBlockShorthand {
  name: string;
  params?: Array<{ name: string; type: "string" | "number" | "boolean"; initialValue?: string }>;
  returnType?: string;
  async?: boolean;
  copyPicked?: boolean;
  description?: string;
  category?: string;
  actions?: BuilderAction[];
  children?: BuilderEvent[];
}

export interface CustomAceBlockShorthand {
  name: string;
  object: string;
  aceType?: string;
  params?: Array<{ name: string; type: "string" | "number" | "boolean"; initialValue?: string }>;
  returnType?: string;
  async?: boolean;
  copyPicked?: boolean;
  description?: string;
  category?: string;
  actions?: BuilderAction[];
  children?: BuilderEvent[];
}

export interface GroupShorthand {
  title: string;
  children?: BuilderEvent[];
  activeOnStart?: boolean;
  disabled?: boolean;
}

// ─── Part 2: Builder Expansion Functions ───

/**
 * Well-known object-less C3 "System" action ids. A `{ "id": "<id>" }` shorthand with no `object`
 * auto-resolves to `objectClass: "System"`. Kept deliberately small — only ids that can never
 * legitimately target a non-System object — so the default never masks a real missing-object error.
 */
export const SYSTEM_ACTION_IDS = new Set<string>([
  "wait",
  "wait-for-previous-actions",
  "wait-for-signal",
  "signal",
]);

export function expandAction(sidGen: SidGenerator, shorthand: BuilderAction): C3Action {
  if ("script" in shorthand) {
    return buildScriptAction({ script: shorthand.script });
  }
  if ("call" in shorthand) {
    return buildCallAction(sidGen, {
      callFunction: shorthand.call,
      parameters: shorthand.params?.map((p) => (typeof p === "string" ? p : String(p))),
    });
  }
  if ("custom-action" in shorthand) {
    // Heuristic: warn if custom-action looks like a plugin action id
    if (/^[a-z]/.test(shorthand["custom-action"]) && shorthand["custom-action"].includes("-")) {
      console.warn(
        `Warning: custom-action "${shorthand["custom-action"]}" looks like a plugin action id. Did you mean { "id": "${shorthand["custom-action"]}" }?`,
      );
    }
    const objectClass = shorthand.object ?? shorthand.objectClass;
    if (objectClass === undefined) {
      throw new Error(
        `custom-action "${shorthand["custom-action"]}" requires an "object" (or "objectClass") naming the target object class`,
      );
    }
    return buildCustomAction(sidGen, {
      name: shorthand["custom-action"],
      objectClass,
      parameters: shorthand.params,
    });
  }
  if ("comment" in shorthand) {
    return buildCommentAction(shorthand.comment);
  }
  if ("id" in shorthand) {
    // Heuristic: warn if id looks like a custom ACE name
    if (/^[A-Z]/.test(shorthand.id) && !shorthand.id.includes("-")) {
      console.warn(
        `Warning: Action id "${shorthand.id}" looks like a custom ACE name. Did you mean { "custom-action": "${shorthand.id}" }?`,
      );
    }
    // Accept `objectClass` (the on-disk JSON field) as an alias for `object`; auto-default
    // well-known object-less System actions to "System".
    const objectClass =
      shorthand.object ?? shorthand.objectClass ?? (SYSTEM_ACTION_IDS.has(shorthand.id) ? "System" : undefined);
    if (objectClass === undefined) {
      throw new Error(
        `Action "${shorthand.id}" is missing its target object — add "object" (or "objectClass"). ` +
          `If this is a System action, add it to SYSTEM_ACTION_IDS or set "object": "System".`,
      );
    }
    const params = shorthand.params
      ? Object.fromEntries(Object.entries(shorthand.params).map(([k, v]) => [k, String(v)]))
      : undefined;
    return buildAction(sidGen, {
      id: shorthand.id,
      objectClass,
      parameters: params,
      behaviorType: shorthand.behavior,
    });
  }
  throw new Error("Unrecognized action shorthand");
}

export function expandCondition(sidGen: SidGenerator, shorthand: BuilderCondition): Condition {
  if ("else" in shorthand) {
    return buildCondition(sidGen, { id: "else", objectClass: "System" });
  }
  if ("trigger-once" in shorthand) {
    return buildCondition(sidGen, { id: "trigger-once-while-true", objectClass: "System" });
  }
  if ("id" in shorthand) {
    // Accept `objectClass` (the on-disk JSON field) as an alias for `object`.
    const objectClass = shorthand.object ?? shorthand.objectClass;
    if (objectClass === undefined) {
      throw new Error(`Condition "${shorthand.id}" is missing its target object — add "object" (or "objectClass").`);
    }
    return buildCondition(sidGen, {
      id: shorthand.id,
      objectClass,
      parameters: shorthand.params,
      isInverted: shorthand.inverted,
      behaviorType: shorthand.behavior,
    });
  }
  throw new Error("Unrecognized condition shorthand");
}

export function expandEvent(sidGen: SidGenerator, shorthand: BuilderEvent): EventSheetEvent {
  if ("variable" in shorthand) {
    return buildVariable(sidGen, shorthand.variable);
  }
  if ("block" in shorthand) {
    const b = shorthand.block;
    return buildBlock(sidGen, {
      conditions: b.conditions?.map((c) => expandCondition(sidGen, c)),
      actions: b.actions?.map((a) => expandAction(sidGen, a)),
      children: b.children?.map((e) => expandEvent(sidGen, e)),
      isOrBlock: b.orBlock,
    });
  }
  if ("function-block" in shorthand) {
    const fb = shorthand["function-block"];
    return buildFunctionBlock(sidGen, {
      functionName: fb.name,
      params: fb.params,
      returnType: fb.returnType,
      isAsync: fb.async,
      copyPicked: fb.copyPicked,
      description: fb.description,
      category: fb.category,
      actions: fb.actions?.map((a) => expandAction(sidGen, a)),
      children: fb.children?.map((e) => expandEvent(sidGen, e)),
    });
  }
  if ("custom-ace-block" in shorthand) {
    const cab = shorthand["custom-ace-block"];
    return buildCustomAceBlock(sidGen, {
      aceName: cab.name,
      objectClass: cab.object,
      aceType: cab.aceType,
      params: cab.params,
      returnType: cab.returnType,
      isAsync: cab.async,
      copyPicked: cab.copyPicked,
      description: cab.description,
      category: cab.category,
      actions: cab.actions?.map((a) => expandAction(sidGen, a)),
      children: cab.children?.map((e) => expandEvent(sidGen, e)),
    });
  }
  if ("group" in shorthand) {
    const g = shorthand.group;
    return buildGroup(sidGen, {
      title: g.title,
      children: g.children?.map((e) => expandEvent(sidGen, e)),
      activeOnStart: g.activeOnStart,
      disabled: g.disabled,
    });
  }
  if ("comment" in shorthand) {
    return buildCommentEvent(shorthand.comment);
  }
  if ("include" in shorthand) {
    return buildInclude(shorthand.include);
  }
  throw new Error("Unrecognized event shorthand");
}

// ─── Part 3: Path Resolution Helper ───

function resolvePaths(op: { path?: string; paths?: string[] }): string[] {
  if (op.path !== undefined && op.paths !== undefined) {
    throw new Error("Cannot specify both 'path' and 'paths' in the same operation");
  }
  if (op.paths !== undefined) {
    return op.paths;
  }
  return [op.path ?? ""];
}

// ─── Part 4: Inline Event Extraction Helper ───

function extractInlineEvent(op: InsertEventOp | ReplaceEventOp): BuilderEvent {
  const keys: Array<keyof BuilderEvent> = [];

  if (op.block !== undefined) keys.push("block" as keyof BuilderEvent);
  if (op["function-block"] !== undefined) keys.push("function-block" as keyof BuilderEvent);
  if (op["custom-ace-block"] !== undefined) keys.push("custom-ace-block" as keyof BuilderEvent);
  if (op.variable !== undefined) keys.push("variable" as keyof BuilderEvent);
  if (op.group !== undefined) keys.push("group" as keyof BuilderEvent);
  if (op.comment !== undefined) keys.push("comment" as keyof BuilderEvent);

  if (keys.length === 0) {
    throw new Error(`No inline event key found in ${op.op} operation. Expected one of: block, function-block, custom-ace-block, variable, group, comment`);
  }
  if (keys.length > 1) {
    throw new Error(`Multiple inline event keys found in ${op.op} operation: ${keys.join(", ")}. Exactly one is required`);
  }

  const key = keys[0];
  if (key === "block") return { block: op.block! };
  if (key === "function-block") return { "function-block": op["function-block"]! };
  if (key === "custom-ace-block") return { "custom-ace-block": op["custom-ace-block"]! };
  if (key === "variable") return { variable: op.variable! };
  if (key === "group") return { group: op.group! };
  return { comment: op.comment! };
}

// ─── Part 4b: Path Splitting Helper ───

const PATH_TAIL_RE = /^(.*?)\.?(events|children)\[(\d+)\]$/;

/**
 * Split a full node path (e.g., "events[4].children[1]") into container + index.
 * Returns { container: "events[4]", index: 1 }.
 * For root-level paths like "events[2]", returns { container: "", index: 2 }.
 */
function splitNodePath(fullPath: string): { container: string; index: number } {
  const m = PATH_TAIL_RE.exec(fullPath);
  if (!m) {
    throw new Error(`Cannot split node path "${fullPath}" — expected format like "events[N]" or "events[N].children[M]"`);
  }
  const [, prefix, _segment, indexStr] = m;
  return { container: prefix, index: Number(indexStr) };
}

/**
 * Resolve container path + index for event-level ops.
 * If `index` is provided, uses `path` as container (existing behavior).
 * If `index` is omitted, splits `path` into container + index (new behavior).
 */
function resolveEventTarget(path: string | undefined, index: number | undefined): { container: string; index: number } {
  if (index !== undefined) {
    return { container: path ?? "", index };
  }
  if (path === undefined || path === "") {
    throw new Error("Either 'index' must be provided, or 'path' must be a full node path (e.g., 'events[4].children[1]')");
  }
  return splitNodePath(path);
}

// ─── Part 4c: SID Resolution Helpers ───

/**
 * Resolve an event reference string to a SidIndexEntry.
 * Supports:
 *   "sid:XXXXXXXXXXXXXXX" — direct SID lookup
 *   "$symbol"            — symbol table lookup → SID → index lookup
 */
function resolveEventRef(
  ref: string,
  sidIndex: SidIndex,
  symbolTable: Map<string, number>,
): SidIndexEntry {
  if (ref.startsWith("sid:")) {
    const sid = Number(ref.slice(4));
    if (!Number.isFinite(sid)) {
      throw new Error(`Invalid SID ref "${ref}": not a finite number`);
    }
    const entry = sidIndex.get(sid);
    if (!entry) {
      throw new Error(`SID ${sid} not found in event sheet`);
    }
    return entry;
  }
  if (ref.startsWith("$")) {
    const sid = symbolTable.get(ref);
    if (sid === undefined) {
      throw new Error(`Symbol "${ref}" not found in symbol table`);
    }
    const entry = sidIndex.get(sid);
    if (!entry) {
      throw new Error(`Symbol "${ref}" resolved to SID ${sid} but SID not found in index`);
    }
    return entry;
  }
  throw new Error(`Invalid event ref "${ref}": must start with "sid:" or "$"`);
}

/**
 * Resolve the target node for an op that supports `in` (SID-based) addressing.
 * Falls back to `path`-based resolveNode when `in` is not set.
 */
function resolveNodeFromRef(
  sheet: EventSheet,
  ref: string | undefined,
  path: string | undefined,
  sidIndex: SidIndex,
  symbolTable: Map<string, number>,
): EventSheetEvent {
  if (ref !== undefined) {
    return resolveEventRef(ref, sidIndex, symbolTable).node;
  }
  if (path === undefined || path === "") {
    throw new Error("Either 'in' or 'path' must be specified for this operation");
  }
  return resolveNode(sheet, path);
}

// ─── Part 5: Operation Execution ───

export function executeOp(
  sidGen: SidGenerator,
  sheet: EventSheet,
  op: FileOp,
  sidIndex?: SidIndex,
  symbolTable?: Map<string, number>,
): void {
  const _sidIndex: SidIndex = sidIndex ?? new Map();
  const _symbolTable: Map<string, number> = symbolTable ?? new Map();
  switch (op.op) {
    case "insert-event": {
      const builderEvent = extractInlineEvent(op);
      const expanded = expandEvent(sidGen, builderEvent);

      // Register symbol if `id` is set (for later $symbol lookups)
      const newSid = typeof (expanded as { sid?: unknown }).sid === "number"
        ? (expanded as { sid: number }).sid
        : undefined;
      if (op.id !== undefined && op.id.startsWith("$")) {
        if (newSid === undefined) {
          throw new Error(`insert-event: cannot register symbol "${op.id}" — expanded event has no SID`);
        }
        _symbolTable.set(op.id, newSid);
        // Temporary sidIndex entry so later ops can resolve this symbol immediately.
        // parentArray/indexInParent are placeholders; updated after splice (lines below).
        _sidIndex.set(newSid, { node: expanded, parentArray: [], indexInParent: -1 });
      }

      if (op.in !== undefined) {
        // `in` on insert-event means "insert into this container's children"
        const containerEntry = resolveEventRef(op.in, _sidIndex, _symbolTable);
        const containerNode = containerEntry.node;
        if (!hasChildren(containerNode)) {
          throw new Error(`insert-event: target "${op.in}" (eventType: "${containerNode.eventType}") is not a container`);
        }
        if (!containerNode.children) {
          (containerNode as { children: EventSheetEvent[] }).children = [];
        }
        const children = containerNode.children as EventSheetEvent[];
        let insertIdx: number;
        if (op.after !== undefined) {
          if (typeof op.after === "string" && (op.after.startsWith("sid:") || op.after.startsWith("$"))) {
            const afterEntry = resolveEventRef(op.after, _sidIndex, _symbolTable);
            const afterIdx = children.indexOf(afterEntry.node);
            if (afterIdx === -1) {
              throw new Error(`insert-event: "after" ref "${op.after}" not found in container "${op.in}"`);
            }
            insertIdx = afterIdx + 1;
          } else {
            insertIdx = (op.after as number) + 1;
          }
        } else if (op.index !== undefined) {
          insertIdx = op.index;
        } else {
          insertIdx = children.length;
        }
        children.splice(insertIdx < 0 ? children.length : insertIdx, 0, expanded);
        // Update sidIndex registration with correct parentArray/indexInParent
        if (newSid !== undefined) {
          _sidIndex.set(newSid, { node: expanded, parentArray: children, indexInParent: children.indexOf(expanded) });
        }
      } else if (typeof op.after === "string" && (op.after.startsWith("sid:") || op.after.startsWith("$"))) {
        // `after: "sid:X"` or `after: "$symbol"` — insert after the referenced event
        const afterEntry = resolveEventRef(op.after, _sidIndex, _symbolTable);
        const parentArray = afterEntry.parentArray;
        const insertIdx = afterEntry.indexInParent + 1;
        parentArray.splice(insertIdx, 0, expanded);
        // Update sidIndex registration
        if (newSid !== undefined) {
          _sidIndex.set(newSid, { node: expanded, parentArray, indexInParent: parentArray.indexOf(expanded) });
        }
      } else {
        const path = op.path ?? "";
        insertEvent(sheet, path, op.index ?? -1, expanded);
        // Update sidIndex registration if we have a SID
        if (newSid !== undefined && !op.id?.startsWith("$")) {
          // Find the inserted node in the target array for accurate sidIndex entry
          // (path-based insert handles its own array; just record the SID→node mapping)
          _sidIndex.set(newSid, { node: expanded, parentArray: [], indexInParent: -1 });
        }
      }
      break;
    }

    case "insert-variables": {
      if (op.in !== undefined) {
        const containerEntry = resolveEventRef(op.in, _sidIndex, _symbolTable);
        const containerNode = containerEntry.node;
        if (!hasChildren(containerNode)) {
          throw new Error(`insert-variables: target "${op.in}" (eventType: "${containerNode.eventType}") is not a container`);
        }
        if (!containerNode.children) {
          (containerNode as { children: EventSheetEvent[] }).children = [];
        }
        const children = containerNode.children as EventSheetEvent[];
        for (let i = 0; i < op.variables.length; i++) {
          const item = op.variables[i];
          const opts = "variable" in item ? item.variable : item;
          const variable = buildVariable(sidGen, opts);
          children.splice(op.after + 1 + i, 0, variable);
        }
      } else {
        const path = op.path ?? "";
        for (let i = 0; i < op.variables.length; i++) {
          const item = op.variables[i];
          const opts = "variable" in item ? item.variable : item;
          const variable = buildVariable(sidGen, opts);
          insertEvent(sheet, path, op.after + 1 + i, variable);
        }
      }
      break;
    }

    case "insert-actions": {
      if (op.in !== undefined) {
        const targetNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (!hasActions(targetNode)) {
          throw new Error(`insert-actions: target "${op.in}" (eventType: "${targetNode.eventType}") does not support actions`);
        }
        const actions = targetNode.actions as C3Action[];
        for (let i = 0; i < op.actions.length; i++) {
          const action = expandAction(sidGen, op.actions[i]);
          const insertIdx = op.after + 1 + i;
          const resolved = insertIdx < 0 ? actions.length : Math.min(insertIdx, actions.length);
          actions.splice(resolved, 0, action);
        }
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          for (let i = 0; i < op.actions.length; i++) {
            const action = expandAction(sidGen, op.actions[i]);
            insertAction(sheet, p, op.after + 1 + i, action);
          }
        }
      }
      break;
    }

    case "insert-conditions": {
      if (op.in !== undefined) {
        const targetNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (!(targetNode.eventType === "block" || targetNode.eventType === "function-block" || targetNode.eventType === "custom-ace-block")) {
          throw new Error(`insert-conditions: target "${op.in}" (eventType: "${targetNode.eventType}") does not support conditions`);
        }
        const condBlock = targetNode as { conditions: Condition[] };
        for (let i = 0; i < op.conditions.length; i++) {
          const condition = expandCondition(sidGen, op.conditions[i]);
          const insertIdx = op.after + 1 + i;
          const resolved = insertIdx < 0 ? condBlock.conditions.length : Math.min(insertIdx, condBlock.conditions.length);
          condBlock.conditions.splice(resolved, 0, condition);
        }
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          for (let i = 0; i < op.conditions.length; i++) {
            const condition = expandCondition(sidGen, op.conditions[i]);
            insertCondition(sheet, p, op.after + 1 + i, condition);
          }
        }
      }
      break;
    }

    case "replace-action": {
      const action = expandAction(sidGen, op.action);
      if (op.in !== undefined) {
        const targetNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (!hasActions(targetNode)) {
          throw new Error(`replace-action: target "${op.in}" (eventType: "${targetNode.eventType}") does not support actions`);
        }
        const actions = targetNode.actions as C3Action[];
        if (op.index < 0 || op.index >= actions.length) {
          throw new Error(`replace-action: index ${op.index} out of bounds (${actions.length} actions) in "${op.in}"`);
        }
        actions[op.index] = action;
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          replaceAction(sheet, p, op.index, action);
        }
      }
      break;
    }

    case "replace-condition": {
      const condition = expandCondition(sidGen, op.condition);
      if (op.in !== undefined) {
        const targetNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (!(targetNode.eventType === "block" || targetNode.eventType === "function-block" || targetNode.eventType === "custom-ace-block")) {
          throw new Error(`replace-condition: target "${op.in}" (eventType: "${targetNode.eventType}") does not support conditions`);
        }
        const condBlock = targetNode as { conditions: Condition[] };
        if (op.index < 0 || op.index >= condBlock.conditions.length) {
          throw new Error(`replace-condition: index ${op.index} out of bounds (${condBlock.conditions.length} conditions) in "${op.in}"`);
        }
        condBlock.conditions[op.index] = condition;
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          replaceCondition(sheet, p, op.index, condition);
        }
      }
      break;
    }

    case "replace-event": {
      const builderEvent = extractInlineEvent(op);
      const expanded = expandEvent(sidGen, builderEvent);
      const path = op.path ?? "";
      replaceEvent(sheet, path, op.index, expanded);
      break;
    }

    case "remove-event": {
      if (op.in !== undefined) {
        const entry = resolveEventRef(op.in, _sidIndex, _symbolTable);
        // parentArray ref is stable, but indexInParent is a snapshot from buildSidIndex —
        // earlier splices in the same batch shift siblings. Look up current position.
        const currentIndex = entry.parentArray.indexOf(entry.node);
        if (currentIndex === -1) {
          throw new Error(
            `remove-event: node for "${op.in}" is no longer in its parent array (already removed?)`,
          );
        }
        entry.parentArray.splice(currentIndex, 1);
      } else {
        const { container, index } = resolveEventTarget(op.path, op.index);
        removeEvent(sheet, container, index);
      }
      break;
    }

    case "remove-action": {
      if (op.in !== undefined) {
        const targetNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (!hasActions(targetNode)) {
          throw new Error(`remove-action: target "${op.in}" (eventType: "${targetNode.eventType}") does not support actions`);
        }
        const actions = targetNode.actions as C3Action[];
        if (op.index < 0 || op.index >= actions.length) {
          throw new Error(`remove-action: index ${op.index} out of bounds (${actions.length} actions) in "${op.in}"`);
        }
        actions.splice(op.index, 1);
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          removeAction(sheet, p, op.index);
        }
      }
      break;
    }

    case "remove-condition": {
      if (op.in !== undefined) {
        const targetNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (!(targetNode.eventType === "block" || targetNode.eventType === "function-block" || targetNode.eventType === "custom-ace-block")) {
          throw new Error(`remove-condition: target "${op.in}" (eventType: "${targetNode.eventType}") does not support conditions`);
        }
        const condBlock = targetNode as { conditions: Condition[] };
        if (op.index < 0 || op.index >= condBlock.conditions.length) {
          throw new Error(`remove-condition: index ${op.index} out of bounds (${condBlock.conditions.length} conditions) in "${op.in}"`);
        }
        condBlock.conditions.splice(op.index, 1);
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          removeCondition(sheet, p, op.index);
        }
      }
      break;
    }

    case "add-include": {
      let index = 0;
      if (op.after) {
        const afterIndex = sheet.events.findIndex(
          (e) => e.eventType === "include" && (e as IncludeEvent).includeSheet === op.after,
        );
        if (afterIndex === -1) {
          throw new Error(`add-include: could not find include "${op.after}" to insert after`);
        }
        index = afterIndex + 1;
      }
      insertEvent(sheet, "", index, buildInclude(op.include));
      break;
    }

    case "patch-script": {
      const paths = op.in !== undefined ? [op.in] : resolvePaths(op);
      const useSidRef = op.in !== undefined;
      for (const p of paths) {
        const targetNode = useSidRef
          ? resolveNodeFromRef(sheet, p, undefined, _sidIndex, _symbolTable)
          : undefined;
        const actionIdx = op.matchScript !== undefined
          ? (useSidRef ? findScriptActionByNode(targetNode!, op.matchScript) : findScriptActionByContent(sheet, p, op.matchScript))
          : op.actionIndex;
        if (actionIdx === undefined) {
          throw new Error(`patch-script: either "actionIndex" or "matchScript" must be provided`);
        }
        if (useSidRef) {
          patchScriptOnNode(targetNode!, p, actionIdx, op.find, op.replace, op.replaceAll);
        } else {
          patchScript(sheet, p, actionIdx, op.find, op.replace, op.replaceAll);
        }
      }
      break;
    }

    case "patch-action-param": {
      const paths = op.in !== undefined ? [op.in] : resolvePaths(op);
      const useSidRef = op.in !== undefined;
      for (const p of paths) {
        const targetNode = useSidRef
          ? resolveNodeFromRef(sheet, p, undefined, _sidIndex, _symbolTable)
          : undefined;
        const actionIdx = op.matchAction !== undefined
          ? (useSidRef ? findActionByIdentifierOnNode(targetNode!, op.matchAction) : findActionByIdentifier(sheet, p, op.matchAction))
          : op.actionIndex;
        if (actionIdx === undefined) {
          throw new Error(`patch-action-param: either "actionIndex" or "matchAction" must be provided`);
        }
        if (useSidRef) {
          patchActionParamOnNode(targetNode!, p, actionIdx, op);
        } else {
          patchActionParam(sheet, p, actionIdx, op);
        }
      }
      break;
    }

    case "set-or-block": {
      if (op.in !== undefined) {
        const node = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (node.eventType !== "block") {
          throw new Error(`set-or-block: expected block at "${op.in}", got "${node.eventType}"`);
        }
        (node as BlockEvent & { isOrBlock: boolean }).isOrBlock = true;
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          const node = resolveNode(sheet, p);
          if (node.eventType !== "block") {
            throw new Error(`set-or-block: expected block at "${p}", got "${node.eventType}"`);
          }
          (node as BlockEvent & { isOrBlock: boolean }).isOrBlock = true;
        }
      }
      break;
    }

    case "set-disabled": {
      if (op.in !== undefined) {
        const node = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (node.eventType !== "group") {
          throw new Error(`set-disabled: expected group at "${op.in}", got "${node.eventType}"`);
        }
        (node as GroupEvent).disabled = op.disabled;
      } else {
        const paths = resolvePaths(op);
        for (const p of paths) {
          const node = resolveNode(sheet, p);
          if (node.eventType !== "group") {
            throw new Error(`set-disabled: expected group at "${p}", got "${node.eventType}"`);
          }
          (node as GroupEvent).disabled = op.disabled;
        }
      }
      break;
    }

    case "rename-symbol": {
      renameSymbol(sheet, op.replacements);
      break;
    }

    case "patch-function-block": {
      const node = op.in !== undefined
        ? resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable)
        : resolveNode(sheet, op.path ?? "");
      if (node.eventType !== "function-block" && node.eventType !== "custom-ace-block") {
        throw new Error(
          `patch-function-block: expected function-block or custom-ace-block at "${op.in ?? op.path}", got "${node.eventType}"`,
        );
      }
      const fnNode = node as FunctionBlockEvent | CustomAceBlockEvent;
      if (op.addParam) {
        const defaultInitialValue = (type: "string" | "number" | "boolean"): string => {
          switch (type) {
            case "string": return "";
            case "number": return "0";
            case "boolean": return "false";
          }
        };
        // Validate uniqueness BEFORE minting a SID so a rejected op doesn't burn
        // a SID slot from the shared used-set.
        const duplicate = fnNode.functionParameters.some((p) => p.name === op.addParam!.name);
        if (duplicate) {
          throw new Error(
            `patch-function-block: parameter "${op.addParam.name}" already exists on function "${(fnNode as FunctionBlockEvent).functionName ?? (fnNode as CustomAceBlockEvent).aceName}"`,
          );
        }
        const newParam: FunctionParameter = {
          name: op.addParam.name,
          type: op.addParam.type,
          initialValue: op.addParam.initialValue ?? defaultInitialValue(op.addParam.type),
          sid: sidGen(),
        };
        fnNode.functionParameters.push(newParam);
      }
      if (op.removeParam) {
        const idx = fnNode.functionParameters.findIndex((p) => p.name === op.removeParam);
        if (idx === -1) {
          throw new Error(
            `patch-function-block: parameter "${op.removeParam}" not found on function "${(fnNode as FunctionBlockEvent).functionName ?? (fnNode as CustomAceBlockEvent).aceName}"`,
          );
        }
        fnNode.functionParameters.splice(idx, 1);
      }
      break;
    }

    case "wrap-in-group": {
      // Resolve parent container
      let parentArray: EventSheetEvent[];
      if (op.in !== undefined) {
        const containerNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
        if (!("children" in containerNode)) {
          throw new Error(`wrap-in-group: target "${op.in}" is not a container (has no children)`);
        }
        parentArray = containerNode.children as EventSheetEvent[];
      } else {
        parentArray = sheet.events;
      }

      // Resolve target events, deduplicate, validate same parent
      if (!op.events || op.events.length === 0) {
        throw new Error("wrap-in-group: events array must not be empty");
      }
      const seenSids = new Set<number>();
      const targets: { node: EventSheetEvent; entry: SidIndexEntry }[] = [];
      for (const ref of op.events) {
        const entry = resolveEventRef(ref, _sidIndex, _symbolTable);
        const sid = (entry.node as { sid?: number }).sid ?? 0;
        if (seenSids.has(sid)) continue; // deduplicate
        seenSids.add(sid);
        if (!parentArray.includes(entry.node)) {
          throw new Error(
            `wrap-in-group: event "${ref}" is not in the specified parent container`,
          );
        }
        targets.push({ node: entry.node, entry });
      }

      // Determine insertion position (min current index)
      const currentIndices = targets.map((t) => parentArray.indexOf(t.node));
      const insertPos = Math.min(...currentIndices);

      // Build group
      const group = buildGroup(sidGen, {
        title: op.title,
        children: [],
        activeOnStart: op.activeOnStart,
        disabled: op.disabled,
      });

      // Remove events from parent and add to group children (preserve original order)
      const sorted = [...targets].sort(
        (a, b) => parentArray.indexOf(a.node) - parentArray.indexOf(b.node),
      );
      for (const t of sorted) {
        const idx = parentArray.indexOf(t.node);
        parentArray.splice(idx, 1);
        (group.children as EventSheetEvent[]).push(t.node);
      }

      // Insert group at original position of first event
      parentArray.splice(insertPos, 0, group);

      // Register group SID in sidIndex
      _sidIndex.set(group.sid, {
        node: group,
        parentArray,
        indexInParent: insertPos,
      });

      // Register symbol if requested
      if (op.id !== undefined && op.id.startsWith("$")) {
        _symbolTable.set(op.id, group.sid);
      }

      break;
    }

    case "move-variable": {
      // Resolve the variable and its current location.
      const varEntry = resolveEventRef(op.variable, _sidIndex, _symbolTable);
      const varNode = varEntry.node;
      if (varNode.eventType !== "variable") {
        throw new Error(
          `move-variable: "${op.variable}" resolves to a "${varNode.eventType}" event, not a variable`,
        );
      }
      const variable = varNode as EventSheetVariable;
      const sourceArray = varEntry.parentArray;
      const isCurrentlyGlobal = sourceArray === sheet.events;

      // Resolve the destination array. `to: "root"` = global (sheet root);
      // any other ref = local (inside that container).
      const toRoot = op.to === "root";
      let destArray: EventSheetEvent[];
      if (toRoot) {
        destArray = sheet.events;
      } else {
        const destContainer = resolveNodeFromRef(sheet, op.to, undefined, _sidIndex, _symbolTable);
        if (!hasChildren(destContainer)) {
          throw new Error(`move-variable: destination "${op.to}" is not a container (has no children)`);
        }
        if (!destContainer.children) {
          (destContainer as { children: EventSheetEvent[] }).children = [];
        }
        destArray = destContainer.children as EventSheetEvent[];
      }

      // Phase 1 supports only the two canonical directions (root ⇄ nested).
      if (toRoot && isCurrentlyGlobal) {
        throw new Error(`move-variable: variable "${variable.name}" is already global (at sheet root)`);
      }
      if (!toRoot && !isCurrentlyGlobal) {
        throw new Error(
          `move-variable: variable "${variable.name}" is already local. ` +
            `Re-parenting between local scopes is not supported; promote to "root" first.`,
        );
      }
      const direction: "toGlobal" | "toLocal" = toRoot ? "toGlobal" : "toLocal";

      // Reject a name collision in the destination scope.
      for (const ev of destArray) {
        if (ev !== varNode && ev.eventType === "variable" && (ev as EventSheetVariable).name === variable.name) {
          throw new Error(
            `move-variable: ${toRoot ? "sheet root" : `destination "${op.to}"`} ` +
              `already declares a variable named "${variable.name}"`,
          );
        }
      }

      // Rewrite localVars.X ⇄ runtime.globalVars.X within the variable's scope
      // subtree. Promotion: the former local scope = the source container's
      // children (== sourceArray). Demotion: the new local scope = destArray.
      rewriteVarRefsInArray(direction === "toGlobal" ? sourceArray : destArray, variable.name, direction);

      // Relocate the variable node (SID preserved).
      const curIdx = sourceArray.indexOf(varNode);
      sourceArray.splice(curIdx, 1);
      let insertIdx = op.index ?? 0;
      if (insertIdx < 0) insertIdx = 0;
      if (insertIdx > destArray.length) insertIdx = destArray.length;
      destArray.splice(insertIdx, 0, varNode);

      // Globals are effectively always static; a demoted global must stay static
      // to preserve persist-across-ticks semantics. Normalize in both directions.
      variable.isStatic = true;

      // Keep the SID index consistent for later ops in the same recipe.
      _sidIndex.set(variable.sid, { node: varNode, parentArray: destArray, indexInParent: insertIdx });

      // Register symbol if requested.
      if (op.id !== undefined && op.id.startsWith("$")) {
        _symbolTable.set(op.id, variable.sid);
      }

      break;
    }

    default: {
      const exhaustive: never = op;
      throw new Error(`Unknown operation: ${(exhaustive as { op: string }).op}`);
    }
  }
}

// ─── Part 6: patch-script Implementation ───

function patchScript(
  sheet: EventSheet,
  jsonPath: string,
  actionIndex: number,
  find: string,
  replace: string | string[],
  replaceAll?: boolean,
): void {
  const node = resolveNode(sheet, jsonPath);
  if (!hasActions(node)) {
    throw new Error(`patch-script: cannot access actions on '${node.eventType}' event at "${jsonPath}"`);
  }

  const actions = node.actions;
  if (actionIndex < 0 || actionIndex >= actions.length) {
    throw new Error(
      `patch-script: action index ${actionIndex} out of bounds (${actions.length} actions) at "${jsonPath}"`,
    );
  }

  const action = actions[actionIndex];
  if (!isScriptAction(action)) {
    throw new Error(
      `patch-script: action at index ${actionIndex} is not a script action at "${jsonPath}"`,
    );
  }

  const joined = action.script.join("\n");
  const findIndex = joined.indexOf(find);
  if (findIndex === -1) {
    throw new Error(
      `patch-script: find string not found in script at action index ${actionIndex}, path "${jsonPath}". ` +
        `Find: "${find}"`,
    );
  }

  const replaceStr = Array.isArray(replace) ? replace.join("\n") : replace;
  const patched = replaceAll
    ? joined.split(find).join(replaceStr)
    : joined.substring(0, findIndex) + replaceStr + joined.substring(findIndex + find.length);
  action.script = patched.split("\n");
}

function findScriptActionByContent(
  sheet: EventSheet,
  jsonPath: string,
  matchScript: string,
): number {
  const node = resolveNode(sheet, jsonPath);
  if (!hasActions(node)) {
    throw new Error(`patch-script: cannot access actions on '${node.eventType}' event at "${jsonPath}"`);
  }

  const matches: number[] = [];
  for (let i = 0; i < node.actions.length; i++) {
    const action = node.actions[i];
    if (isScriptAction(action) && action.script.join("\n").includes(matchScript)) {
      matches.push(i);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `patch-script: matchScript string not found in any script action at "${jsonPath}". ` +
        `matchScript: "${matchScript}"`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `patch-script: matchScript matched ${matches.length} script actions at "${jsonPath}" (indices: ${matches.join(", ")}). ` +
        `Expected exactly one match. matchScript: "${matchScript}"`,
    );
  }

  return matches[0];
}

function isScriptAction(action: ScriptAction | Record<string, unknown>): action is ScriptAction {
  return (
    (action as ScriptAction).type === "script" &&
    (action as ScriptAction).language === "typescript"
  );
}

// Node-based variants used by SID-resolved ops

function findScriptActionByNode(node: EventSheetEvent, matchScript: string): number {
  if (!hasActions(node)) {
    throw new Error(`patch-script: cannot access actions on '${node.eventType}' event`);
  }
  const matches: number[] = [];
  for (let i = 0; i < node.actions.length; i++) {
    const action = node.actions[i];
    if (isScriptAction(action) && action.script.join("\n").includes(matchScript)) {
      matches.push(i);
    }
  }
  if (matches.length === 0) {
    throw new Error(`patch-script: matchScript string not found in any script action. matchScript: "${matchScript}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `patch-script: matchScript matched ${matches.length} script actions (indices: ${matches.join(", ")}). Expected exactly one match. matchScript: "${matchScript}"`,
    );
  }
  return matches[0];
}

function patchScriptOnNode(
  node: EventSheetEvent,
  ref: string,
  actionIndex: number,
  find: string,
  replace: string | string[],
  replaceAll?: boolean,
): void {
  if (!hasActions(node)) {
    throw new Error(`patch-script: cannot access actions on '${node.eventType}' event at "${ref}"`);
  }
  const actions = node.actions;
  if (actionIndex < 0 || actionIndex >= actions.length) {
    throw new Error(`patch-script: action index ${actionIndex} out of bounds (${actions.length} actions) at "${ref}"`);
  }
  const action = actions[actionIndex];
  if (!isScriptAction(action)) {
    throw new Error(`patch-script: action at index ${actionIndex} is not a script action at "${ref}"`);
  }
  const joined = action.script.join("\n");
  const findIndex = joined.indexOf(find);
  if (findIndex === -1) {
    throw new Error(`patch-script: find string not found in script at action index ${actionIndex}, ref "${ref}". Find: "${find}"`);
  }
  const replaceStr = Array.isArray(replace) ? replace.join("\n") : replace;
  const patched = replaceAll
    ? joined.split(find).join(replaceStr)
    : joined.substring(0, findIndex) + replaceStr + joined.substring(findIndex + find.length);
  action.script = patched.split("\n");
}

function findActionByIdentifierOnNode(node: EventSheetEvent, matchAction: string): number {
  if (!hasActions(node)) {
    throw new Error(`patch-action-param: cannot access actions on '${node.eventType}' event`);
  }
  const matches: number[] = [];
  for (let i = 0; i < node.actions.length; i++) {
    const action = node.actions[i] as C3Action;
    const id = getActionIdentifier(action);
    if (id === matchAction) matches.push(i);
  }
  if (matches.length === 0) {
    throw new Error(`patch-action-param: matchAction "${matchAction}" not found in any action`);
  }
  if (matches.length > 1) {
    throw new Error(
      `patch-action-param: matchAction matched ${matches.length} actions (indices: ${matches.join(", ")}). Expected exactly one match. matchAction: "${matchAction}"`,
    );
  }
  return matches[0];
}

function patchActionParamOnNode(
  node: EventSheetEvent,
  ref: string,
  actionIndex: number,
  op: PatchActionParamOp,
): void {
  if (!hasActions(node)) {
    throw new Error(`patch-action-param: cannot access actions on '${node.eventType}' event at "${ref}"`);
  }
  const actions = node.actions;
  if (actionIndex < 0 || actionIndex >= actions.length) {
    throw new Error(`patch-action-param: action index ${actionIndex} out of bounds (${actions.length} actions) at "${ref}"`);
  }
  const action = actions[actionIndex] as C3Action;
  if (!isParameterizedAction(action)) {
    throw new Error(`patch-action-param: action at index ${actionIndex} is not a parameterized action at "${ref}"`);
  }
  const updates: Record<string, unknown> = op.params ? op.params : { [op.param!]: op.value };
  if (isStandardAction(action)) {
    if (!action.parameters) action.parameters = {};
    for (const [key, val] of Object.entries(updates)) action.parameters[key] = val as string;
  } else if (isFunctionCallAction(action)) {
    if (!action.parameters) action.parameters = [];
    for (const [key, val] of Object.entries(updates)) action.parameters[Number(key)] = val as string;
  } else if (isCustomAction(action)) {
    if (!action.parameters) action.parameters = [];
    for (const [key, val] of Object.entries(updates)) action.parameters[Number(key)] = val;
  }
}

// ─── Part 6a: patch-action-param Implementation ───

function findActionByIdentifier(
  sheet: EventSheet,
  jsonPath: string,
  matchAction: string,
): number {
  const node = resolveNode(sheet, jsonPath);
  if (!hasActions(node)) {
    throw new Error(`patch-action-param: cannot access actions on '${node.eventType}' event at "${jsonPath}"`);
  }

  const matches: number[] = [];
  for (let i = 0; i < node.actions.length; i++) {
    const action = node.actions[i] as C3Action;
    const id = getActionIdentifier(action);
    if (id === matchAction) {
      matches.push(i);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `patch-action-param: matchAction "${matchAction}" not found in any action at "${jsonPath}"`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `patch-action-param: matchAction matched ${matches.length} actions at "${jsonPath}" (indices: ${matches.join(", ")}). ` +
        `Expected exactly one match. matchAction: "${matchAction}"`,
    );
  }

  return matches[0];
}

function patchActionParam(
  sheet: EventSheet,
  jsonPath: string,
  actionIndex: number,
  op: PatchActionParamOp,
): void {
  const node = resolveNode(sheet, jsonPath);
  if (!hasActions(node)) {
    throw new Error(`patch-action-param: cannot access actions on '${node.eventType}' event at "${jsonPath}"`);
  }

  const actions = node.actions;
  if (actionIndex < 0 || actionIndex >= actions.length) {
    throw new Error(
      `patch-action-param: action index ${actionIndex} out of bounds (${actions.length} actions) at "${jsonPath}"`,
    );
  }

  const action = actions[actionIndex] as C3Action;
  if (!isParameterizedAction(action)) {
    throw new Error(
      `patch-action-param: action at index ${actionIndex} is not a parameterized action at "${jsonPath}"`,
    );
  }

  // Collect the param updates from either param+value or params
  const updates: Record<string, unknown> = op.params
    ? op.params
    : { [op.param!]: op.value };

  if (isStandardAction(action)) {
    if (!action.parameters) {
      action.parameters = {};
    }
    for (const [key, val] of Object.entries(updates)) {
      action.parameters[key] = val as string;
    }
  } else if (isFunctionCallAction(action)) {
    if (!action.parameters) {
      action.parameters = [];
    }
    for (const [key, val] of Object.entries(updates)) {
      const idx = Number(key);
      action.parameters[idx] = val as string;
    }
  } else if (isCustomAction(action)) {
    if (!action.parameters) {
      action.parameters = [];
    }
    for (const [key, val] of Object.entries(updates)) {
      const idx = Number(key);
      action.parameters[idx] = val;
    }
  }
}

// ─── Part 6b: rename-symbol Implementation ───

export function applyReplacements(
  sheet: EventSheet,
  replacements: Array<{ from: string; to: string }>,
): number {
  if (replacements.length === 0) return 0;

  // Sort replacements by `from` length descending to handle substring ordering
  // (e.g., "getLocalizedPriceWithoutNumOfDecimals" before "getLocalizedPrice")
  const sorted = [...replacements].sort((a, b) => b.from.length - a.from.length);

  const scriptActions = walkScriptActions(sheet);
  let totalReplacements = 0;

  for (const action of scriptActions) {
    const joined = action.script.join("\n");
    let result = joined;

    for (const { from, to } of sorted) {
      result = result.split(from).join(to);
    }

    if (result !== joined) {
      action.script = result.split("\n");
      totalReplacements++;
    }
  }

  return totalReplacements;
}

function renameSymbol(
  sheet: EventSheet,
  replacements: Array<{ from: string; to: string }>,
): void {
  const count = applyReplacements(sheet, replacements);
  if (count === 0) {
    const sorted = [...replacements].sort((a, b) => b.from.length - a.from.length);
    const fromList = sorted.map((r) => `"${r.from}"`).join(", ");
    throw new Error(
      `rename-symbol: no replacements matched in any script action. Searched for: ${fromList}`,
    );
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite `localVars.NAME` ⇄ `runtime.globalVars.NAME` script references within
 * the subtree rooted at `nodes`. Word-boundary anchored so `localVars.score`
 * does not match `localVars.scoreMultiplier`. Used by move-variable to keep
 * script references in sync with a variable's scope change.
 */
function rewriteVarRefsInArray(
  nodes: EventSheetEvent[],
  name: string,
  direction: "toGlobal" | "toLocal",
): void {
  const escaped = escapeRegExp(name);
  const fromRe =
    direction === "toGlobal"
      ? new RegExp(`\\blocalVars\\.${escaped}\\b`, "g")
      : new RegExp(`\\bruntime\\.globalVars\\.${escaped}\\b`, "g");
  const to = direction === "toGlobal" ? `runtime.globalVars.${name}` : `localVars.${name}`;
  for (const action of walkScriptActionsInArray(nodes)) {
    const joined = action.script.join("\n");
    const result = joined.replace(fromRe, to);
    if (result !== joined) {
      action.script = result.split("\n");
    }
  }
}

// ─── Part 7: Recipe Orchestration ───

// ─── Stale Path Detection & Auto-Adjust Helpers ───

interface ShiftInfo {
  container: string; // container path, e.g., "" or "events[3]"
  arraySegment: string; // e.g., "events" or "events[3].children"
  shiftAt: number; // index at which the shift starts
  delta: number; // +N for insert, -1 for remove
}

/**
 * Returns shift info for structural ops that change event indices.
 * Returns null for non-structural ops.
 */
function getShiftInfo(op: FileOp, sheet?: EventSheet): ShiftInfo | null {
  switch (op.op) {
    case "insert-event": {
      // SID-addressed or after-string inserts don't have a reliable position-based shift
      if (op.in !== undefined || op.index === undefined) return null;
      const container = op.path ?? "";
      const arraySegment = container === "" ? "events" : `${container}.children`;
      return { container, arraySegment, shiftAt: op.index, delta: 1 };
    }
    case "remove-event": {
      const container = op.path ?? "";
      const arraySegment = container === "" ? "events" : `${container}.children`;
      return { container, arraySegment, shiftAt: op.index!, delta: -1 };
    }
    case "insert-variables": {
      const container = op.path ?? "";
      const arraySegment = container === "" ? "events" : `${container}.children`;
      return { container, arraySegment, shiftAt: op.after + 1, delta: op.variables.length };
    }
    case "add-include": {
      if (!sheet) return null;
      const insertedIndex = sheet.events.findIndex(
        (e) => e.eventType === "include" && (e as IncludeEvent).includeSheet === op.include,
      );
      if (insertedIndex === -1) return null;
      return { container: "", arraySegment: "events", shiftAt: insertedIndex, delta: 1 };
    }
    default:
      return null;
  }
}

/** Returns all paths referenced by an op. */
function getOpPaths(op: FileOp): string[] {
  if ("path" in op && op.path !== undefined) return [op.path];
  if ("paths" in op && op.paths !== undefined) return [...op.paths];
  // Ops without path/paths default to "" (top-level)
  if (op.op === "rename-symbol" || op.op === "add-include" || op.op === "move-variable") return [];
  return [""];
}

/**
 * Checks if a target path is affected by a shift in a specific array segment.
 * E.g., if arraySegment="events" and shiftAt=3, then "events[5]..." is affected.
 */
function isAffectedByShift(targetPath: string, arraySegment: string, shiftAt: number): boolean {
  const prefix = `${arraySegment}[`;
  const startIdx = targetPath.indexOf(prefix);
  if (startIdx !== 0 && (startIdx === -1 || targetPath[startIdx - 1] !== ".")) {
    return false;
  }
  const indexStart = startIdx + prefix.length;
  const indexEnd = targetPath.indexOf("]", indexStart);
  if (indexEnd === -1) return false;
  const n = parseInt(targetPath.substring(indexStart, indexEnd), 10);
  if (isNaN(n)) return false;
  return n >= shiftAt;
}


export function executeFileOps(sidGen: SidGenerator, sheet: EventSheet, ops: FileOp[], options?: { autoAdjust?: boolean }): void {
  // autoAdjust is deprecated — SID-based addressing ("in": "sid:X") supersedes it
  if (options?.autoAdjust) {
    console.warn('autoAdjust is deprecated — use SID-based addressing ("in": "sid:X") instead');
  }

  // Build SID index once for this file; symbol table accumulates as ops run
  const sidIndex = buildSidIndex(sheet);
  const symbolTable = new Map<string, number>();

  // Normalize position-based remove-event ops that use full-path syntax (no index)
  for (const op of ops) {
    if (op.op === "remove-event" && op.index === undefined && op.in === undefined) {
      const { container, index } = resolveEventTarget(op.path, op.index);
      op.path = container || undefined;
      op.index = index;
    }
  }

  // Warn about consecutive position-based remove-event ops in ascending order
  // (SID-based ops are immune to index shifts and need no reordering)
  for (let i = 0; i < ops.length - 1; i++) {
    const op = ops[i];
    const next = ops[i + 1];
    const opIsPositionBased = op.op === "remove-event" && (op as RemoveEventOp).in === undefined;
    const nextIsPositionBased = next.op === "remove-event" && (next as RemoveEventOp).in === undefined;
    if (opIsPositionBased && nextIsPositionBased) {
      const containerA = (op as RemoveEventOp).path ?? "";
      const containerB = (next as RemoveEventOp).path ?? "";
      if (containerA === containerB && (op as RemoveEventOp).index! < (next as RemoveEventOp).index!) {
        console.warn(
          `WARNING: consecutive remove-event ops in "${containerA}" are in ascending index order. ` +
            `List removes in descending index order, or switch to SID-based addressing (immune to index shifts).`,
        );
      }
    }
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    executeOp(sidGen, sheet, op, sidIndex, symbolTable);

    // Warning mode: scan remaining ops for potentially affected paths (skip SID-addressed ops)
    const shift = getShiftInfo(op, sheet);
    if (shift) {
      for (let j = i + 1; j < ops.length; j++) {
        const laterOp = ops[j];
        // Skip SID-addressed ops — they can't be affected by position shifts
        if ("in" in laterOp && (laterOp as { in?: string }).in !== undefined) continue;
        const laterPaths = getOpPaths(ops[j]);
        for (const lp of laterPaths) {
          if (isAffectedByShift(lp, shift.arraySegment, shift.shiftAt)) {
            console.warn(
              `WARNING: ${op.op} at index ${shift.shiftAt} in "${shift.container}" shifted indices. ` +
                `Op "${ops[j].op}" references "${lp}" — index may be stale`,
            );
          }
        }
        // Also check index/after fields for event-container ops targeting the same container
        if (
          (ops[j].op === "insert-event" || ops[j].op === "remove-event" || ops[j].op === "replace-event") &&
          "index" in ops[j]
        ) {
          const laterContainer = (ops[j] as { path?: string }).path ?? "";
          const laterIndex = (ops[j] as { index: number }).index;
          if (laterContainer === shift.container && laterIndex >= shift.shiftAt) {
            // Only warn if we didn't already warn about the path itself
            if (!laterPaths.some((lp) => isAffectedByShift(lp, shift.arraySegment, shift.shiftAt))) {
              console.warn(
                `WARNING: ${op.op} at index ${shift.shiftAt} in "${shift.container}" shifted indices. ` +
                  `Op "${ops[j].op}" has index ${laterIndex} in same container — index may be stale`,
              );
            }
          }
        }
      }
    }
  }
}

export function createSheet(sidGen: SidGenerator, name: string, events: BuilderEvent[]): EventSheet {
  return {
    name,
    events: events.map((e) => expandEvent(sidGen, e)),
    sid: sidGen(),
  };
}

export function isFileCreate(value: FileCreate | FileOp[]): value is FileCreate {
  return !Array.isArray(value) && (value as FileCreate).create === true;
}

export interface RecipeResult {
  modified: Map<string, EventSheet>;
  created: Map<string, EventSheet>;
}

export function executeRecipe(
  sidGen: SidGenerator,
  recipe: Recipe,
  loadSheet: (path: string) => EventSheet,
): RecipeResult {
  const modified = new Map<string, EventSheet>();
  const created = new Map<string, EventSheet>();

  for (const [filePath, entry] of Object.entries(recipe.files ?? {})) {
    if (isFileCreate(entry)) {
      const name = extractSheetName(filePath);
      const sheet = createSheet(sidGen, name, entry.events);
      created.set(filePath, sheet);
    } else {
      const sheet = loadSheet(filePath);
      executeFileOps(sidGen, sheet, entry, { autoAdjust: recipe.autoAdjust });
      modified.set(filePath, sheet);
    }
  }

  return { modified, created };
}

export function extractSheetName(filePath: string): string {
  const basename = filePath.split("/").pop() ?? filePath;
  return basename.replace(/\.json$/, "");
}

// ─── Part 8: Validation ───

export const VALID_OPS = new Set([
  "insert-event",
  "insert-variables",
  "insert-actions",
  "insert-conditions",
  "replace-action",
  "replace-condition",
  "replace-event",
  "remove-event",
  "remove-action",
  "remove-condition",
  "add-include",
  "patch-script",
  "patch-action-param",
  "set-or-block",
  "set-disabled",
  "rename-symbol",
  "patch-function-block",
  "wrap-in-group",
  "move-variable",
]);

const INLINE_EVENT_KEYS = ["block", "function-block", "custom-ace-block", "variable", "group", "comment"];

// ─── Field Schemas ───

export interface OpFieldSchema {
  required: string[];
  optional: string[];
  misspellings: Record<string, string>;
}

export const OP_FIELD_SCHEMAS: Record<string, OpFieldSchema> = {
  "insert-event": {
    required: [],
    optional: ["path", "in", "id", "index", "after", "block", "function-block", "custom-ace-block", "variable", "group", "comment"],
    misspellings: {},
  },
  "insert-variables": {
    required: ["after", "variables"],
    optional: ["path", "in"],
    misspellings: {},
  },
  "insert-actions": {
    required: ["after", "actions"],
    optional: ["path", "paths", "in"],
    misspellings: {},
  },
  "insert-conditions": {
    required: ["after", "conditions"],
    optional: ["path", "paths", "in"],
    misspellings: {},
  },
  "replace-action": {
    required: ["index", "action"],
    optional: ["path", "paths", "in"],
    misspellings: { actions: "action" },
  },
  "replace-condition": {
    required: ["index", "condition"],
    optional: ["path", "paths", "in"],
    misspellings: { conditions: "condition" },
  },
  "replace-event": {
    required: ["index"],
    optional: ["path", "block", "function-block", "custom-ace-block", "variable", "group", "comment"],
    misspellings: {},
  },
  "remove-event": {
    required: [],
    optional: ["path", "in", "index"],
    misspellings: {},
  },
  "remove-action": {
    required: ["index"],
    optional: ["path", "paths", "in"],
    misspellings: {},
  },
  "remove-condition": {
    required: ["index"],
    optional: ["path", "paths", "in"],
    misspellings: {},
  },
  "add-include": {
    required: ["include"],
    optional: ["after"],
    misspellings: { sheet: "include" },
  },
  "patch-script": {
    required: ["find", "replace"],
    optional: ["path", "paths", "in", "actionIndex", "matchScript", "replaceAll"],
    misspellings: { old: "find", new: "replace" },
  },
  "patch-action-param": {
    required: [],
    optional: ["path", "paths", "in", "actionIndex", "matchAction", "param", "value", "params"],
    misspellings: {},
  },
  "set-or-block": {
    required: [],
    optional: ["path", "paths", "in"],
    misspellings: {},
  },
  "set-disabled": {
    required: ["disabled"],
    optional: ["path", "paths", "in"],
    misspellings: {},
  },
  "rename-symbol": {
    required: ["replacements"],
    optional: [],
    misspellings: {},
  },
  "patch-function-block": {
    required: [],
    optional: ["path", "in", "addParam", "removeParam"],
    misspellings: {},
  },
  "wrap-in-group": {
    required: ["events", "title"],
    optional: ["in", "id", "activeOnStart", "disabled"],
    misspellings: { event: "events", name: "title" },
  },
  "move-variable": {
    required: ["variable", "to"],
    optional: ["index", "id"],
    misspellings: { name: "variable", into: "to", destination: "to", sid: "variable" },
  },
};

export const SHORTHAND_FIELD_SCHEMAS: Record<string, OpFieldSchema> = {
  variable: {
    required: ["name", "type"],
    optional: ["value", "constant", "static", "initialValue", "isStatic", "isConstant"],
    misspellings: {},
  },
  block: {
    required: [],
    optional: ["conditions", "actions", "children", "orBlock"],
    misspellings: {},
  },
  "function-block": {
    required: ["name"],
    optional: ["params", "returnType", "async", "copyPicked", "description", "category", "actions", "children"],
    misspellings: {},
  },
  "custom-ace-block": {
    required: ["name", "object"],
    optional: ["aceType", "params", "returnType", "async", "copyPicked", "description", "category", "actions", "children"],
    misspellings: {},
  },
  group: {
    required: ["title"],
    optional: ["children", "activeOnStart", "disabled"],
    misspellings: {},
  },
};

/**
 * Field schemas for action builder shorthands, keyed by the discriminator key that selects the
 * variant. `object` and `objectClass` are BOTH allowed on the `id`/`custom-action` variants —
 * `objectClass` is the on-disk JSON field, accepted as an alias — while a typo like `objclass`
 * is rejected.
 */
export const ACTION_SHORTHAND_SCHEMAS: Record<string, OpFieldSchema> = {
  script: { required: ["script"], optional: [], misspellings: {} },
  call: { required: ["call"], optional: ["params"], misspellings: { callFunction: "call", function: "call" } },
  "custom-action": {
    required: ["custom-action"],
    optional: ["object", "objectClass", "params"],
    misspellings: { customAction: "custom-action", name: "custom-action" },
  },
  comment: { required: ["comment"], optional: [], misspellings: {} },
  id: {
    required: ["id"],
    optional: ["object", "objectClass", "params", "behavior"],
    misspellings: { behaviorType: "behavior" },
  },
};

/** Field schemas for condition builder shorthands, keyed by discriminator key. */
export const CONDITION_SHORTHAND_SCHEMAS: Record<string, OpFieldSchema> = {
  else: { required: ["else"], optional: [], misspellings: {} },
  "trigger-once": { required: ["trigger-once"], optional: [], misspellings: {} },
  id: {
    required: ["id"],
    optional: ["object", "objectClass", "params", "inverted", "behavior"],
    misspellings: { behaviorType: "behavior", isInverted: "inverted" },
  },
};

/** Pick the schema whose discriminator key is present on the shorthand. */
function pickShorthandSchema(
  item: Record<string, unknown>,
  schemas: Record<string, OpFieldSchema>,
): { key: string; schema: OpFieldSchema } | undefined {
  for (const key of Object.keys(schemas)) {
    if (item[key] !== undefined) return { key, schema: schemas[key] };
  }
  return undefined;
}

/** Validate required + unknown fields on a shorthand object (mirrors the inline-event field check). */
function validateShorthandFields(
  item: Record<string, unknown>,
  schema: OpFieldSchema,
  label: string,
  prefix: string,
): string[] {
  const errors: string[] = [];
  for (const field of schema.required) {
    if (item[field] === undefined) {
      errors.push(`${prefix}: ${label} shorthand missing required field "${field}"`);
    }
  }
  const allAllowed = new Set([...schema.required, ...schema.optional]);
  for (const field of Object.keys(item)) {
    if (!allAllowed.has(field)) {
      const suggestion = schema.misspellings[field];
      errors.push(
        suggestion
          ? `${prefix}: ${label} shorthand unknown field "${field}" — did you mean "${suggestion}"?`
          : `${prefix}: ${label} shorthand unknown field "${field}"`,
      );
    }
  }
  return errors;
}

// ─── Param Type Rules ───

interface ParamTypeRule {
  param: string;
  check: (value: unknown) => boolean;
  message: string;
}

/**
 * Rules for validating C3 action/condition parameter types in builder shorthands.
 * Maps action/condition IDs to parameter constraints.
 * Only checks literal values — C3 expressions that might evaluate correctly are not flagged.
 */
export const PARAM_TYPE_RULES: Record<string, ParamTypeRule[]> = {
  "compare-two-values": [
    {
      param: "comparison",
      check: (v) => typeof v === "number" && Number.isInteger(v),
      message: '"comparison" must be an integer (0=equal, 1=not-equal, 2=less, 3=less-or-equal, 4=greater, 5=greater-or-equal)',
    },
  ],
  "set-layer-visible": [
    {
      param: "layer",
      check: (v) => typeof v === "string" && v.startsWith('"') && v.endsWith('"'),
      message: '"layer" must be a quoted C3 expression (e.g., "\\"LayerName\\""), not a bare string',
    },
    {
      param: "visibility",
      check: (v) => v === "visible" || v === "invisible",
      message: '"visibility" must be "visible" or "invisible"',
    },
  ],
  "layer-is-visible": [
    {
      param: "layer",
      check: (v) => typeof v === "string" && v.startsWith('"') && v.endsWith('"'),
      message: '"layer" must be a quoted C3 expression (e.g., "\\"LayerName\\""), not a bare string',
    },
  ],
  "set-layer-interactive": [
    {
      param: "layer",
      check: (v) => typeof v === "string" && v.startsWith('"') && v.endsWith('"'),
      message: '"layer" must be a quoted C3 expression (e.g., "\\"LayerName\\""), not a bare string',
    },
    {
      param: "interactive",
      check: (v) => typeof v === "boolean",
      message: '"interactive" must be a boolean (true/false), not a string',
    },
  ],
  "is-on-layer": [
    {
      param: "layer",
      check: (v) => typeof v === "string" && v.startsWith('"') && v.endsWith('"'),
      message: '"layer" must be a quoted C3 expression (e.g., "\\"LayerName\\""), not a bare string',
    },
  ],
  "set-animation": [
    {
      param: "animation",
      check: (v) => typeof v === "string" && v.startsWith('"') && v.endsWith('"'),
      message: '"animation" must be a quoted C3 expression (e.g., "\\"animName\\""), not a bare string',
    },
  ],
  "on-touched-object": [
    {
      param: "type",
      check: (v) => v === "start" || v === "end" || v === "move",
      message: '"type" must be "start", "end", or "move" (not "0")',
    },
  ],
};

/**
 * Validate params of a builder action shorthand against PARAM_TYPE_RULES.
 * Returns warning strings for any type mismatches found.
 */
export function validateActionParams(action: Record<string, unknown>, prefix: string): string[] {
  const warnings: string[] = [];

  // Field-name validation: reject unknown keys, accept `objectClass` as an alias for `object`,
  // reject shapes that match no discriminator (expandAction would throw), and flag an
  // `id`/`custom-action` action with no target object. `id` System actions auto-default to "System".
  const picked = pickShorthandSchema(action, ACTION_SHORTHAND_SCHEMAS);
  if (!picked) {
    warnings.push(
      `${prefix}: unrecognized action shorthand — expected one of ${Object.keys(ACTION_SHORTHAND_SCHEMAS)
        .map((k) => `"${k}"`)
        .join(", ")}`,
    );
  } else {
    warnings.push(...validateShorthandFields(action, picked.schema, picked.key, prefix));
    const needsObject = picked.key === "id" || picked.key === "custom-action";
    const isSystemId = picked.key === "id" && typeof action.id === "string" && SYSTEM_ACTION_IDS.has(action.id);
    if (needsObject && action.object === undefined && action.objectClass === undefined && !isSystemId) {
      const name = picked.key === "id" ? `action "${action.id}"` : `custom-action "${action["custom-action"]}"`;
      warnings.push(
        `${prefix}: ${name} is missing "object" (or "objectClass"). Add the target object class` +
          (picked.key === "id" ? `, or use "object": "System" for System actions.` : "."),
      );
    }
  }

  // Standard actions: { id: "action-id", params: { ... } }
  if (typeof action.id === "string" && action.params && typeof action.params === "object" && !Array.isArray(action.params)) {
    const rules = PARAM_TYPE_RULES[action.id as string];
    if (rules) {
      const params = action.params as Record<string, unknown>;
      for (const rule of rules) {
        if (rule.param in params && !rule.check(params[rule.param])) {
          warnings.push(`${prefix}: action "${action.id}" param ${rule.message}`);
        }
      }
    }
  }

  // Call shorthand: { call: "funcName", params: [...] }
  if (typeof action.call === "string" && action.params !== undefined) {
    if (!Array.isArray(action.params)) {
      warnings.push(
        `${prefix}: "call" shorthand "params" must be an array, not ${typeof action.params}. ` +
        `Use ["arg1", "arg2"], not {"0": "arg1", "1": "arg2"}`,
      );
    }
  }

  return warnings;
}

/**
 * Validate params of a builder condition shorthand against PARAM_TYPE_RULES.
 */
export function validateConditionParams(condition: Record<string, unknown>, prefix: string): string[] {
  const warnings: string[] = [];

  // Field-name validation: reject unknown keys, accept `objectClass` as an alias for `object`,
  // reject shapes that match no discriminator (expandCondition would throw), and flag an
  // `id` condition with no target object.
  const picked = pickShorthandSchema(condition, CONDITION_SHORTHAND_SCHEMAS);
  if (!picked) {
    warnings.push(
      `${prefix}: unrecognized condition shorthand — expected one of ${Object.keys(CONDITION_SHORTHAND_SCHEMAS)
        .map((k) => `"${k}"`)
        .join(", ")}`,
    );
  } else {
    warnings.push(...validateShorthandFields(condition, picked.schema, picked.key, prefix));
    if (
      picked.key === "id" &&
      condition.object === undefined &&
      condition.objectClass === undefined &&
      typeof condition.id === "string"
    ) {
      warnings.push(
        `${prefix}: condition "${condition.id}" is missing "object" (or "objectClass"). Add the target object class.`,
      );
    }
  }

  if (typeof condition.id === "string" && condition.params && typeof condition.params === "object" && !Array.isArray(condition.params)) {
    const rules = PARAM_TYPE_RULES[condition.id as string];
    if (rules) {
      const params = condition.params as Record<string, unknown>;
      for (const rule of rules) {
        if (rule.param in params && !rule.check(params[rule.param])) {
          warnings.push(`${prefix}: condition "${condition.id}" param ${rule.message}`);
        }
      }
    }
  }

  return warnings;
}

// ─── Path Normalization ───

/** Expand a bare eventSheet key to full path: "Goals/GoalsEvents" → "eventSheets/Goals/GoalsEvents.json" */
export function normalizeFileKey(key: string): string {
  let result = key;
  if (!result.startsWith("eventSheets/")) {
    result = `eventSheets/${result}`;
  }
  if (!result.endsWith(".json")) {
    result = `${result}.json`;
  }
  return result;
}

/** Expand a bare layout key to full path: "Login/LoginLayout" → "layouts/Login/LoginLayout.json" */
export function normalizeLayoutKey(key: string): string {
  let result = key;
  if (!result.startsWith("layouts/")) {
    result = `layouts/${result}`;
  }
  if (!result.endsWith(".json")) {
    result = `${result}.json`;
  }
  return result;
}

/** Normalize all bare keys in a recipe to full paths. Mutates the recipe in place. */
export function normalizeRecipePaths(recipe: Recipe): void {
  // Normalize files keys
  if (recipe.files) {
    const normalized: Record<string, (typeof recipe.files)[string]> = {};
    for (const [key, value] of Object.entries(recipe.files)) {
      normalized[normalizeFileKey(key)] = value;
    }
    recipe.files = normalized;
  }

  // Normalize layouts keys and copy-instance/add-replica from fields
  if (recipe.layouts) {
    const normalized: Record<string, (typeof recipe.layouts)[string]> = {};
    for (const [key, ops] of Object.entries(recipe.layouts)) {
      const normalizedOps = ops.map((op) => {
        if ((op.op === "copy-instance" || op.op === "add-replica") && "from" in op && typeof op.from === "string") {
          return { ...op, from: normalizeLayoutKey(op.from) };
        }
        return op;
      });
      normalized[normalizeLayoutKey(key)] = normalizedOps;
    }
    recipe.layouts = normalized;
  }
}

export function validateRecipe(recipe: Recipe): string[] {
  normalizeRecipePaths(recipe);
  const errors: string[] = [];

  const hasSections =
    recipe.objectTypes !== undefined || recipe.addInstVars !== undefined || recipe.files !== undefined || recipe.layouts !== undefined;
  if (!hasSections) {
    errors.push('recipe must have at least one section: "objectTypes", "addInstVars", "files", or "layouts"');
    return errors;
  }

  // Validate objectTypes section
  if (recipe.objectTypes !== undefined) {
    if (!Array.isArray(recipe.objectTypes)) {
      errors.push('recipe.objectTypes must be an array. Expected: [{ "name": "FooJSON", "plugin": "Json" }]');
    } else {
      for (let i = 0; i < recipe.objectTypes.length; i++) {
        const entry = recipe.objectTypes[i] as unknown as Record<string, unknown>;
        if (!entry.name || typeof entry.name !== "string") {
          errors.push(`objectTypes[${i}]: missing or invalid "name" field. Expected: { "name": "FooJSON", "plugin": "Json" }`);
        }
        const validPlugins = ["Json", "Dictionary", "Arr"];
        if (!entry.plugin || !validPlugins.includes(entry.plugin as string)) {
          errors.push(`objectTypes[${i}]: "plugin" must be one of: Json, Dictionary, Arr`);
        }
      }
    }
  }

  // Validate addInstVars section
  if (recipe.addInstVars !== undefined) {
    if (!Array.isArray(recipe.addInstVars)) {
      errors.push('recipe.addInstVars must be an array. Expected: [{ "type": "MyObject", "instanceVariables": [...] }]');
    } else {
      const validTypes = ["string", "number", "boolean"];
      for (let i = 0; i < recipe.addInstVars.length; i++) {
        const entry = recipe.addInstVars[i] as unknown as Record<string, unknown>;
        if (!entry.type || typeof entry.type !== "string") {
          errors.push(`addInstVars[${i}]: missing or invalid "type" field. Expected: { "type": "MyObject", "instanceVariables": [...] }`);
        }
        if (!Array.isArray(entry.instanceVariables) || (entry.instanceVariables as unknown[]).length === 0) {
          errors.push(`addInstVars[${i}]: "instanceVariables" must be a non-empty array`);
        } else {
          for (let j = 0; j < (entry.instanceVariables as unknown[]).length; j++) {
            const iv = (entry.instanceVariables as Record<string, unknown>[])[j];
            if (!iv.name || typeof iv.name !== "string") {
              errors.push(`addInstVars[${i}].instanceVariables[${j}]: missing or invalid "name"`);
            }
            if (!iv.type || !validTypes.includes(iv.type as string)) {
              errors.push(`addInstVars[${i}].instanceVariables[${j}]: "type" must be one of: string, number, boolean`);
            }
          }
        }
      }
    }
  }

  // Validate files section
  if (recipe.files !== undefined) {
    if (typeof recipe.files !== "object" || Array.isArray(recipe.files)) {
      errors.push('recipe.files must be an object. Expected: { "eventSheets/Path/Sheet.json": [...operations] }');
    } else {
      for (const [filePath, entry] of Object.entries(recipe.files)) {
        if (Array.isArray(entry)) {
          // FileOp[]
          for (let i = 0; i < entry.length; i++) {
            const op = entry[i] as unknown as Record<string, unknown>;
            if (!op.op || typeof op.op !== "string") {
              errors.push(`${filePath}[${i}]: missing or invalid 'op' field. Expected: { "op": "insert-event", "path": "...", ... }`);
              continue;
            }
            if (!VALID_OPS.has(op.op as string)) {
              errors.push(`${filePath}[${i}]: unknown op "${op.op}". Valid ops: ${[...VALID_OPS].join(", ")}`);
              continue;
            }

            // Validate fields against per-op schema
            const schema = OP_FIELD_SCHEMAS[op.op as string];
            if (schema) {
              // Check for missing required fields
              for (const field of schema.required) {
                if (op[field] === undefined) {
                  errors.push(`${filePath}[${i}]: ${op.op} missing required field "${field}"`);
                }
              }
              // Check every field on the op (excluding "op" itself)
              const allAllowed = new Set([...schema.required, ...schema.optional]);
              for (const key of Object.keys(op)) {
                if (key === "op") continue;
                if (!allAllowed.has(key)) {
                  const suggestion = schema.misspellings[key];
                  if (suggestion) {
                    errors.push(`${filePath}[${i}]: ${op.op} unknown field "${key}" — did you mean "${suggestion}"?`);
                  } else {
                    errors.push(`${filePath}[${i}]: ${op.op} unknown field "${key}"`);
                  }
                }
              }
            }

            // Validate path/paths mutual exclusivity
            if (op.path !== undefined && op.paths !== undefined) {
              errors.push(`${filePath}[${i}]: cannot specify both 'path' and 'paths'. Use "path" for single target, "paths" for multiple targets`);
            }

            // Validate rename-symbol has replacements array
            if (op.op === "rename-symbol") {
              const replacements = op.replacements as unknown;
              if (!Array.isArray(replacements) || replacements.length === 0) {
                errors.push(`${filePath}[${i}]: rename-symbol requires a non-empty "replacements" array of { from, to } objects`);
              }
            }

            // Validate patch-action-param
            if (op.op === "patch-action-param") {
              const hasActionIndex = (op as unknown as Record<string, unknown>).actionIndex !== undefined;
              const hasMatchAction = (op as unknown as Record<string, unknown>).matchAction !== undefined;
              if (!hasActionIndex && !hasMatchAction) {
                errors.push(`${filePath}[${i}]: patch-action-param requires either "actionIndex" or "matchAction". Use actionIndex for index-based targeting, matchAction for content-based targeting`);
              }
              if (hasActionIndex && hasMatchAction) {
                errors.push(`${filePath}[${i}]: patch-action-param cannot have both "actionIndex" and "matchAction". Use one or the other`);
              }
              const hasParam = (op as unknown as Record<string, unknown>).param !== undefined;
              const hasParams = (op as unknown as Record<string, unknown>).params !== undefined;
              if (!hasParam && !hasParams) {
                errors.push(`${filePath}[${i}]: patch-action-param requires either "param" + "value" or "params" object`);
              }
              if (hasParam && hasParams) {
                errors.push(`${filePath}[${i}]: patch-action-param cannot have both "param" and "params". Use "param" + "value" for a single change, or "params" for multiple`);
              }
            }

            // Validate patch-script has actionIndex or matchScript (not both)
            if (op.op === "patch-script") {
              const hasActionIndex = (op as unknown as Record<string, unknown>).actionIndex !== undefined;
              const hasMatchScript = (op as unknown as Record<string, unknown>).matchScript !== undefined;
              if (!hasActionIndex && !hasMatchScript) {
                errors.push(`${filePath}[${i}]: patch-script requires either "actionIndex" or "matchScript". Use actionIndex for index-based targeting, matchScript for content-based targeting`);
              }
              if (hasActionIndex && hasMatchScript) {
                errors.push(`${filePath}[${i}]: patch-script cannot have both "actionIndex" and "matchScript". Use one or the other`);
              }
            }

            // Validate patch-function-block has addParam or removeParam (not both)
            if (op.op === "patch-function-block") {
              const hasAddParam = (op as unknown as Record<string, unknown>).addParam !== undefined;
              const hasRemoveParam = (op as unknown as Record<string, unknown>).removeParam !== undefined;
              if (!hasAddParam && !hasRemoveParam) {
                errors.push(`${filePath}[${i}]: patch-function-block requires either "addParam" or "removeParam"`);
              }
              if (hasAddParam && hasRemoveParam) {
                errors.push(`${filePath}[${i}]: patch-function-block cannot have both "addParam" and "removeParam". Use separate ops`);
              }
              if (hasAddParam) {
                const addParam = (op as unknown as Record<string, unknown>).addParam as Record<string, unknown>;
                if (!addParam.name || typeof addParam.name !== "string") {
                  errors.push(`${filePath}[${i}]: patch-function-block addParam.name is required and must be a string`);
                }
                if (!addParam.type || !["string", "number", "boolean"].includes(addParam.type as string)) {
                  errors.push(`${filePath}[${i}]: patch-function-block addParam.type must be "string", "number", or "boolean"`);
                }
              }
            }

            // For insert-event and replace-event, validate inline event keys
            if (op.op === "insert-event" || op.op === "replace-event") {
              const foundKeys = INLINE_EVENT_KEYS.filter((k) => op[k] !== undefined);
              if (foundKeys.length === 0) {
                errors.push(`${filePath}[${i}]: ${op.op} requires exactly one inline event key (${INLINE_EVENT_KEYS.join(", ")})`);
              } else if (foundKeys.length > 1) {
                errors.push(`${filePath}[${i}]: ${op.op} has multiple inline event keys: ${foundKeys.join(", ")}. Use exactly one of: ${INLINE_EVENT_KEYS.join(", ")}`);
              }

              // Validate shorthand fields on the inline event
              for (const key of foundKeys) {
                if (key === "comment") continue; // comment is a plain string, not a shorthand object
                const shorthand = op[key] as Record<string, unknown> | undefined;
                if (shorthand && typeof shorthand === "object") {
                  const shorthandSchema = SHORTHAND_FIELD_SCHEMAS[key];
                  if (shorthandSchema) {
                    errors.push(...validateShorthandFields(shorthand, shorthandSchema, key, `${filePath}[${i}]`));
                  }
                }
              }
            }

            // Validate insert-variables shorthand fields
            if (op.op === "insert-variables") {
              const variables = op.variables as unknown[];
              if (Array.isArray(variables)) {
                for (let j = 0; j < variables.length; j++) {
                  // Variables can be { variable: {...} } or just {...}
                  const entry = variables[j] as Record<string, unknown>;
                  // Variables can be wrapped (`{ variable: {...} }`) or bare (`{...}`); validate the inner object.
                  const target = entry.variable ? (entry.variable as Record<string, unknown>) : entry;
                  if (target && typeof target === "object") {
                    errors.push(
                      ...validateShorthandFields(
                        target,
                        SHORTHAND_FIELD_SCHEMAS["variable"],
                        "variable",
                        `${filePath}[${i}].variables[${j}]`,
                      ),
                    );
                  }
                }
              }
            }

            // Validate C3 parameter types on builder action/condition shorthands
            if (op.op === "insert-actions" || op.op === "insert-conditions") {
              const items = (op as unknown as Record<string, unknown>).actions ?? (op as unknown as Record<string, unknown>).conditions;
              if (Array.isArray(items)) {
                for (let j = 0; j < items.length; j++) {
                  const item = items[j] as Record<string, unknown>;
                  if (item && typeof item === "object") {
                    const validator = op.op === "insert-actions" ? validateActionParams : validateConditionParams;
                    errors.push(...validator(item, `${filePath}[${i}].${op.op === "insert-actions" ? "actions" : "conditions"}[${j}]`));
                  }
                }
              }
            }
            if (op.op === "replace-action") {
              const action = (op as unknown as Record<string, unknown>).action as Record<string, unknown> | undefined;
              if (action && typeof action === "object") {
                errors.push(...validateActionParams(action, `${filePath}[${i}].action`));
              }
            }
            if (op.op === "replace-condition") {
              const condition = (op as unknown as Record<string, unknown>).condition as Record<string, unknown> | undefined;
              if (condition && typeof condition === "object") {
                errors.push(...validateConditionParams(condition, `${filePath}[${i}].condition`));
              }
            }

            // Validate params in inline event actions/conditions (insert-event, replace-event)
            if (op.op === "insert-event" || op.op === "replace-event") {
              for (const key of INLINE_EVENT_KEYS) {
                const shorthand = (op as unknown as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
                if (shorthand && typeof shorthand === "object") {
                  // Check actions on the inline event
                  const actions = shorthand.actions as unknown[] | undefined;
                  if (Array.isArray(actions)) {
                    for (let j = 0; j < actions.length; j++) {
                      const action = actions[j] as Record<string, unknown>;
                      if (action && typeof action === "object") {
                        errors.push(...validateActionParams(action, `${filePath}[${i}].${key}.actions[${j}]`));
                      }
                    }
                  }
                  // Check conditions on the inline event
                  const conditions = shorthand.conditions as unknown[] | undefined;
                  if (Array.isArray(conditions)) {
                    for (let j = 0; j < conditions.length; j++) {
                      const condition = conditions[j] as Record<string, unknown>;
                      if (condition && typeof condition === "object") {
                        errors.push(...validateConditionParams(condition, `${filePath}[${i}].${key}.conditions[${j}]`));
                      }
                    }
                  }
                }
              }
            }
          }

          // Warn if add-include is mixed with path-based refs in the same file
          const hasAddInclude = entry.some((o) => o.op === "add-include");
          if (hasAddInclude) {
            const hasPathBasedRef = entry.some((o) => {
              if (o.op === "add-include") return false;
              const rec = o as unknown as Record<string, unknown>;
              const pathVal = typeof rec.path === "string" && rec.path.includes("events[");
              const afterVal = typeof rec.after === "string" && rec.after.includes("events[");
              return pathVal || afterVal;
            });
            if (hasPathBasedRef) {
              errors.push(`Warning: ${filePath}: add-include shifts root events[] indices — path-based references in the same file may target wrong nodes. Use SID-based "in"/"after" instead.`);
            }
          }
        } else if (entry && typeof entry === "object" && (entry as FileCreate).create === true) {
          // FileCreate — valid
        } else {
          errors.push(`${filePath}: entry must be a FileCreate object or an array of FileOp. Expected: { "create": true, "events": [...] } or [{ "op": "...", ... }]`);
        }
      }
    }
  }

  // Validate layouts section
  if (recipe.layouts !== undefined) {
    if (typeof recipe.layouts !== "object" || Array.isArray(recipe.layouts)) {
      errors.push('recipe.layouts must be an object. Expected: { "layouts/Path/Layout.json": [...operations] }');
    } else {
      for (const [filePath, ops] of Object.entries(recipe.layouts)) {
        if (!Array.isArray(ops)) {
          errors.push(`layouts["${filePath}"]: value must be an array of layout operations. Expected: [{ "op": "add-nonworld-instance", "type": "..." }]`);
          continue;
        }
        const VALID_LAYOUT_OPS = new Set(["add-nonworld-instance", "add-sublayer", "add-layer", "copy-instance", "templatize", "replicify", "add-replica", "remove-instance", "remove-layer", "move-instance", "rename-layer"]);
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i] as unknown as Record<string, unknown>;
          if (!op.op || !VALID_LAYOUT_OPS.has(op.op as string)) {
            errors.push(`layouts["${filePath}"][${i}]: unknown op "${op.op}". Valid ops: ${[...VALID_LAYOUT_OPS].join(", ")}`);
            continue;
          }
          switch (op.op) {
            case "add-nonworld-instance":
              if (!op.type || typeof op.type !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "type" field is required for add-nonworld-instance. Expected: { "op": "add-nonworld-instance", "type": "FooJSON" }`);
              }
              break;
            case "add-sublayer":
              if (!op.parent || typeof op.parent !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "parent" field is required for add-sublayer. Expected: { "op": "add-sublayer", "parent": "LayerName", "name": "SubName" }`);
              }
              if (!op.name || typeof op.name !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "name" field is required for add-sublayer. Expected: { "op": "add-sublayer", "parent": "LayerName", "name": "SubName" }`);
              }
              break;
            case "add-layer":
              if (!op.name || typeof op.name !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "name" field is required for add-layer. Expected: { "op": "add-layer", "name": "LayerName" }`);
              }
              break;
            case "copy-instance":
              if (!op.from || typeof op.from !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "from" field is required for copy-instance. Expected: { "op": "copy-instance", "from": "layouts/Source.json", "type": "ObjName", "targetLayer": "Layer" }`);
              }
              if (!op.type || typeof op.type !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "type" field is required for copy-instance. Expected: { "op": "copy-instance", "from": "layouts/Source.json", "type": "ObjName", "targetLayer": "Layer" }`);
              }
              if (!op.targetLayer || typeof op.targetLayer !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "targetLayer" field is required for copy-instance. Expected: { "op": "copy-instance", "from": "layouts/Source.json", "type": "ObjName", "targetLayer": "Layer" }`);
              }
              break;
            case "templatize":
              if (!op.type || typeof op.type !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "type" field is required for templatize`);
              }
              if (!op.templateName || typeof op.templateName !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "templateName" field is required for templatize`);
              }
              break;
            case "replicify":
              if (!op.type || typeof op.type !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "type" field is required for replicify`);
              }
              if (!op.sourceTemplateName || typeof op.sourceTemplateName !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "sourceTemplateName" field is required for replicify`);
              }
              break;
            case "add-replica":
              if (!op.from || typeof op.from !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "from" field is required for add-replica`);
              }
              if (!op.sourceTemplateName || typeof op.sourceTemplateName !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "sourceTemplateName" field is required for add-replica`);
              }
              if (!op.targetLayer || typeof op.targetLayer !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "targetLayer" field is required for add-replica`);
              }
              break;
            case "remove-instance":
              if (!op.type || typeof op.type !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "type" field is required for remove-instance`);
              }
              if (op.layer !== undefined && typeof op.layer !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "layer" must be a string for remove-instance`);
              }
              break;
            case "remove-layer":
              if (!op.layer || typeof op.layer !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "layer" field is required for remove-layer`);
              }
              break;
            case "move-instance":
              if (!op.type || typeof op.type !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "type" field is required for move-instance`);
              }
              if (!op.targetLayer || typeof op.targetLayer !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "targetLayer" field is required for move-instance`);
              }
              break;
            case "rename-layer":
              if (!op.currentName || typeof op.currentName !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "currentName" field is required for rename-layer`);
              }
              if (!op.newName || typeof op.newName !== "string") {
                errors.push(`layouts["${filePath}"][${i}]: "newName" field is required for rename-layer`);
              }
              break;
          }
        }
      }
    }
  }

  return errors;
}
