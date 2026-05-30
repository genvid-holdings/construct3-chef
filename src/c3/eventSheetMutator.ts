import type {
  EventSheet,
  EventSheetEvent,
  EventSheetVariable,
  BlockEvent,
  FunctionBlockEvent,
  CustomAceBlockEvent,
  GroupEvent,
  IncludeEvent,
  CommentEvent,
  Condition,
  FunctionParameter,
  ScriptAction,
} from "c3source";
import { isScriptAction, hasActions, hasConditions, canHaveChildren, visitEvents } from "c3source";
import type { SidGenerator } from "./sidUtils.js";

export type { ScriptAction, IncludeEvent, CommentEvent } from "c3source";
export { hasActions, canHaveChildren };

/** Entry in the SID-based event index. */
export interface SidIndexEntry {
  node: EventSheetEvent;
  parentArray: EventSheetEvent[];
  indexInParent: number;
}

/** Map from SID to its index entry. Built once per file op execution. */
export type SidIndex = Map<number, SidIndexEntry>;

/**
 * Build a SID-based index for all events in a sheet.
 * Recursively walks events + children and maps each event's SID to its location.
 *
 * Scope: events with SIDs (block, function-block, custom-ace-block, group, variable).
 * Events without SIDs (include, comment) are skipped.
 *
 * @throws if duplicate SIDs are found
 */
export function buildSidIndex(sheet: EventSheet): SidIndex {
  const index: SidIndex = new Map();

  visitEvents(sheet.events, (event, ctx) => {
    if ("sid" in event && typeof event.sid === "number") {
      if (index.has(event.sid)) {
        throw new Error(`Duplicate SID ${event.sid} found in event sheet "${sheet.name}"`);
      }
      index.set(event.sid, { node: event, parentArray: ctx.parent, indexInParent: ctx.index });
    }
  });

  return index;
}

export interface StandardAction {
  id: string;
  objectClass: string;
  sid: number;
  parameters?: Record<string, string>;
  behaviorType?: string;
}

export interface FunctionCallAction {
  callFunction: string;
  sid: number;
  parameters?: string[];
}

export interface CustomAction {
  customAction: string;
  objectClass: string;
  sid: number;
  parameters?: unknown[];
}

export interface CommentAction {
  type: "comment";
  text: string;
}

export type C3Action =
  | ScriptAction
  | StandardAction
  | FunctionCallAction
  | CustomAction
  | CommentAction;

// --- Internal helpers ---

const PATH_SEGMENT_RE = /^(events|children)\[(\d+)\]$/;

export function resolveNode(sheet: EventSheet, jsonPath: string): EventSheetEvent {
  const segments = jsonPath.split(".");
  let current: EventSheetEvent[] = sheet.events;
  let node: EventSheetEvent | undefined;

  for (let i = 0; i < segments.length; i++) {
    const match = PATH_SEGMENT_RE.exec(segments[i]);
    if (!match) {
      throw new Error(`Invalid jsonPath: malformed segment "${segments[i]}" in "${jsonPath}"`);
    }
    const [, key, indexStr] = match;
    const index = Number(indexStr);

    if (i === 0 && key !== "events") {
      throw new Error(`Invalid jsonPath: path must start with "events[N]", got "${segments[i]}"`);
    }
    if (i > 0 && key !== "children") {
      throw new Error(`Invalid jsonPath: expected "children[N]" segment, got "${segments[i]}" in "${jsonPath}"`);
    }

    if (index < 0 || index >= current.length) {
      throw new Error(`Invalid jsonPath: index ${index} out of bounds (array length ${current.length}) in "${jsonPath}"`);
    }

    node = current[index];

    if (i < segments.length - 1) {
      if (!("children" in node) || !canHaveChildren(node)) {
        throw new Error(`Cannot get children of '${node.eventType}' event at "${segments.slice(0, i + 1).join(".")}" in "${jsonPath}"`);
      }
      if (!node.children) {
        node.children = [];
      }
      current = node.children;
    }
  }

  return node!;
}

function getEventsArray(sheet: EventSheet, jsonPath: string): EventSheetEvent[] {
  if (jsonPath === "") {
    return sheet.events;
  }

  const node = resolveNode(sheet, jsonPath);

  if (!canHaveChildren(node)) {
    throw new Error(
      `Cannot get children of '${node.eventType}' event — path must be a parent container (block/group/function-block), not a sibling node. For root-level insertions use path: "".`,
    );
  }

  if (!node.children) {
    (node as { children?: EventSheetEvent[] }).children = [];
  }

  return (node as { children: EventSheetEvent[] }).children;
}

// --- Mutation: Events ---

export function insertEvent(sheet: EventSheet, jsonPath: string, index: number, event: EventSheetEvent): EventSheet {
  const events = getEventsArray(sheet, jsonPath);
  const resolvedIndex = resolveInsertIndex(index, events.length, "events");
  events.splice(resolvedIndex, 0, event);
  return sheet;
}

export function removeEvent(sheet: EventSheet, jsonPath: string, index: number): EventSheetEvent {
  const events = getEventsArray(sheet, jsonPath);
  validateRemoveIndex(index, events.length, "events");
  return events.splice(index, 1)[0];
}

export function replaceEvent(sheet: EventSheet, jsonPath: string, index: number, event: EventSheetEvent): EventSheet {
  const events = getEventsArray(sheet, jsonPath);
  validateReplaceIndex(index, events.length, "events");
  events[index] = event;
  return sheet;
}

// --- Mutation: Actions ---

export function insertAction(sheet: EventSheet, jsonPath: string, index: number, action: C3Action): EventSheet {
  if (jsonPath === "") {
    throw new Error("jsonPath must not be empty for action operations");
  }
  const node = resolveNode(sheet, jsonPath);
  if (!hasActions(node)) {
    throw new Error(`Cannot access actions on '${node.eventType}' event`);
  }
  const actions = node.actions as C3Action[];
  const resolvedIndex = resolveInsertIndex(index, actions.length, "actions");
  actions.splice(resolvedIndex, 0, action);
  return sheet;
}

export function removeAction(sheet: EventSheet, jsonPath: string, index: number): C3Action {
  if (jsonPath === "") {
    throw new Error("jsonPath must not be empty for action operations");
  }
  const node = resolveNode(sheet, jsonPath);
  if (!hasActions(node)) {
    throw new Error(`Cannot access actions on '${node.eventType}' event`);
  }
  const actions = node.actions as C3Action[];
  validateRemoveIndex(index, actions.length, "actions");
  return actions.splice(index, 1)[0];
}

export function replaceAction(sheet: EventSheet, jsonPath: string, index: number, action: C3Action): EventSheet {
  if (jsonPath === "") {
    throw new Error("jsonPath must not be empty for action operations");
  }
  const node = resolveNode(sheet, jsonPath);
  if (!hasActions(node)) {
    throw new Error(`Cannot access actions on '${node.eventType}' event`);
  }
  const actions = node.actions as C3Action[];
  validateReplaceIndex(index, actions.length, "actions");
  actions[index] = action;
  return sheet;
}

// --- Mutation: Conditions ---

export function insertCondition(sheet: EventSheet, jsonPath: string, index: number, condition: Condition): EventSheet {
  if (jsonPath === "") {
    throw new Error("jsonPath must not be empty for condition operations");
  }
  const node = resolveNode(sheet, jsonPath);
  if (!hasConditions(node)) {
    throw new Error(`Cannot access conditions on '${node.eventType}' event`);
  }
  const resolvedIndex = resolveInsertIndex(index, node.conditions.length, "conditions");
  node.conditions.splice(resolvedIndex, 0, condition);
  return sheet;
}

export function removeCondition(sheet: EventSheet, jsonPath: string, index: number): Condition {
  if (jsonPath === "") {
    throw new Error("jsonPath must not be empty for condition operations");
  }
  const node = resolveNode(sheet, jsonPath);
  if (!hasConditions(node)) {
    throw new Error(`Cannot access conditions on '${node.eventType}' event`);
  }
  validateRemoveIndex(index, node.conditions.length, "conditions");
  return node.conditions.splice(index, 1)[0];
}

export function replaceCondition(sheet: EventSheet, jsonPath: string, index: number, condition: Condition): EventSheet {
  if (jsonPath === "") {
    throw new Error("jsonPath must not be empty for condition operations");
  }
  const node = resolveNode(sheet, jsonPath);
  if (!hasConditions(node)) {
    throw new Error(`Cannot access conditions on '${node.eventType}' event`);
  }
  validateReplaceIndex(index, node.conditions.length, "conditions");
  node.conditions[index] = condition;
  return sheet;
}

// --- Index validation helpers ---

function resolveInsertIndex(index: number, length: number, arrayName: string): number {
  if (index === -1) {
    return length;
  }
  if (index < 0) {
    throw new Error(`Invalid index ${index} for ${arrayName} insert: negative indices other than -1 are not allowed`);
  }
  if (index > length) {
    throw new Error(`Invalid index ${index} for ${arrayName} insert: out of bounds (array length ${length})`);
  }
  return index;
}

function validateRemoveIndex(index: number, length: number, arrayName: string): void {
  if (length === 0) {
    throw new Error(`Cannot remove from empty ${arrayName} array`);
  }
  if (index < 0 || index >= length) {
    throw new Error(`Invalid index ${index} for ${arrayName} remove: out of bounds (array length ${length})`);
  }
}

function validateReplaceIndex(index: number, length: number, arrayName: string): void {
  if (index < 0 || index >= length) {
    throw new Error(`Invalid index ${index} for ${arrayName} replace: out of bounds (array length ${length})`);
  }
}

// --- Builders ---

export function buildBlock(sidGen: SidGenerator, opts?: {
  conditions?: Condition[];
  actions?: C3Action[];
  children?: EventSheetEvent[];
  isOrBlock?: boolean;
}): BlockEvent {
  const block: BlockEvent = {
    eventType: "block",
    conditions: opts?.conditions ?? [],
    actions: (opts?.actions ?? []) as (ScriptAction | Record<string, unknown>)[],
    sid: sidGen(),
  };
  if (opts?.children) {
    block.children = opts.children;
  }
  if (opts?.isOrBlock) {
    (block as BlockEvent & { isOrBlock: boolean }).isOrBlock = true;
  }
  return block;
}

export function buildFunctionBlock(sidGen: SidGenerator, opts: {
  functionName: string;
  params?: Array<{ name: string; type: "string" | "number" | "boolean"; initialValue?: string }>;
  returnType?: string;
  isAsync?: boolean;
  description?: string;
  category?: string;
  copyPicked?: boolean;
  actions?: C3Action[];
  children?: EventSheetEvent[];
}): FunctionBlockEvent {
  const defaultInitialValue = (type: "string" | "number" | "boolean"): string => {
    switch (type) {
      case "string": return "";
      case "number": return "0";
      case "boolean": return "false";
    }
  };

  const functionParameters: FunctionParameter[] = (opts.params ?? []).map((p) => {
    return {
      name: p.name,
      type: p.type,
      initialValue: p.initialValue ?? defaultInitialValue(p.type),
      sid: sidGen(),
    };
  });

  const fb: FunctionBlockEvent = {
    eventType: "function-block",
    functionName: opts.functionName,
    functionDescription: opts.description ?? "",
    functionCategory: opts.category ?? "",
    functionReturnType: opts.returnType ?? "none",
    functionCopyPicked: opts.copyPicked ?? false,
    functionIsAsync: opts.isAsync ?? false,
    functionParameters,
    conditions: [],
    actions: (opts.actions ?? []) as (ScriptAction | Record<string, unknown>)[],
    sid: sidGen(),
  };
  if (opts.children) {
    fb.children = opts.children;
  }
  return fb;
}

export function buildCustomAceBlock(sidGen: SidGenerator, opts: {
  aceName: string;
  objectClass: string;
  aceType?: string;
  params?: Array<{ name: string; type: "string" | "number" | "boolean"; initialValue?: string }>;
  returnType?: string;
  isAsync?: boolean;
  description?: string;
  category?: string;
  copyPicked?: boolean;
  actions?: C3Action[];
  children?: EventSheetEvent[];
}): CustomAceBlockEvent {
  const defaultInitialValue = (type: "string" | "number" | "boolean"): string => {
    switch (type) {
      case "string": return "";
      case "number": return "0";
      case "boolean": return "false";
    }
  };

  const functionParameters: FunctionParameter[] = (opts.params ?? []).map((p) => {
    return {
      name: p.name,
      type: p.type,
      initialValue: p.initialValue ?? defaultInitialValue(p.type),
      sid: sidGen(),
    };
  });

  const cab: CustomAceBlockEvent = {
    eventType: "custom-ace-block",
    aceType: opts.aceType ?? "action",
    aceName: opts.aceName,
    objectClass: opts.objectClass,
    functionDescription: opts.description ?? "",
    functionCategory: opts.category ?? "",
    functionReturnType: opts.returnType ?? "none",
    functionCopyPicked: opts.copyPicked ?? false,
    functionIsAsync: opts.isAsync ?? false,
    functionParameters,
    conditions: [],
    actions: (opts.actions ?? []) as (ScriptAction | Record<string, unknown>)[],
    sid: sidGen(),
  };
  if (opts.children) {
    cab.children = opts.children;
  }
  return cab;
}

export function buildAction(sidGen: SidGenerator, opts: {
  id: string;
  objectClass: string;
  parameters?: Record<string, string>;
  behaviorType?: string;
}): StandardAction {
  const action: StandardAction = {
    id: opts.id,
    objectClass: opts.objectClass,
    sid: sidGen(),
  };
  if (opts.parameters) {
    action.parameters = opts.parameters;
  }
  if (opts.behaviorType) {
    action.behaviorType = opts.behaviorType;
  }
  return action;
}

export function buildCallAction(sidGen: SidGenerator, opts: {
  callFunction: string;
  parameters?: string[];
}): FunctionCallAction {
  const action: FunctionCallAction = {
    callFunction: opts.callFunction,
    sid: sidGen(),
  };
  if (opts.parameters) {
    action.parameters = opts.parameters;
  }
  return action;
}

export function buildScriptAction(opts: { script: string[] }): ScriptAction {
  return {
    type: "script",
    language: "typescript",
    script: opts.script,
  };
}

// --- Type aliases for external consumers ---

export type VariableEvent = EventSheetVariable;

// --- Builders (phase 2) ---

export function buildVariable(sidGen: SidGenerator, opts: {
  name: string;
  type: "string" | "number" | "boolean";
  value?: string;
  initialValue?: string;
  constant?: boolean;
  isConstant?: boolean;
  static?: boolean;
  isStatic?: boolean;
}): VariableEvent {
  // Validate that aliases are not used simultaneously with their shorthand equivalents
  if (opts.value !== undefined && opts.initialValue !== undefined) {
    throw new Error(
      `Variable "${opts.name}": cannot specify both "value" and "initialValue" — use one or the other`,
    );
  }
  if (opts.constant !== undefined && opts.isConstant !== undefined) {
    throw new Error(
      `Variable "${opts.name}": cannot specify both "constant" and "isConstant" — use one or the other`,
    );
  }
  if (opts.static !== undefined && opts.isStatic !== undefined) {
    throw new Error(
      `Variable "${opts.name}": cannot specify both "static" and "isStatic" — use one or the other`,
    );
  }

  const defaultValue = (type: "string" | "number" | "boolean"): string => {
    switch (type) {
      case "string":
        return "";
      case "number":
        return "0";
      case "boolean":
        return "false";
    }
  };

  const resolvedValue = opts.value ?? opts.initialValue ?? defaultValue(opts.type);
  const resolvedConstant = opts.constant ?? opts.isConstant ?? false;
  const resolvedStatic = opts.static ?? opts.isStatic ?? false;

  return {
    eventType: "variable",
    name: opts.name,
    type: opts.type,
    initialValue: resolvedValue,
    comment: "",
    isStatic: resolvedConstant ? true : resolvedStatic,
    isConstant: resolvedConstant,
    sid: sidGen(),
  };
}

export function buildCondition(sidGen: SidGenerator, opts: {
  id: string;
  objectClass: string;
  parameters?: Record<string, string | number | boolean>;
  isInverted?: boolean;
  behaviorType?: string;
}): Condition {
  const condition: Condition = {
    id: opts.id,
    objectClass: opts.objectClass,
    sid: sidGen(),
  };
  if (opts.parameters) {
    condition.parameters = opts.parameters;
  }
  if (opts.isInverted) {
    condition.isInverted = opts.isInverted;
  }
  if (opts.behaviorType) {
    condition.behaviorType = opts.behaviorType;
  }
  return condition;
}

export function buildGroup(sidGen: SidGenerator, opts: {
  title: string;
  children?: EventSheetEvent[];
  activeOnStart?: boolean;
  disabled?: boolean;
}): GroupEvent {
  return {
    eventType: "group",
    disabled: opts.disabled ?? false,
    title: opts.title,
    description: "",
    isActiveOnStart: opts.activeOnStart ?? true,
    children: opts.children ?? [],
    sid: sidGen(),
  };
}

export function buildInclude(name: string): IncludeEvent {
  return { eventType: "include" as const, includeSheet: name };
}

export function buildCommentEvent(text: string): CommentEvent {
  return { eventType: "comment" as const, text };
}

export function buildCommentAction(text: string): CommentAction {
  return { type: "comment" as const, text };
}

// --- Script walker ---

/**
 * Walk all script actions in an array of events (and their descendants),
 * returning mutable references. Traverses blocks, function-blocks,
 * custom-ace-blocks, and groups recursively. Use this to scope a script
 * rewrite to a single container's subtree.
 */
export function walkScriptActionsInArray(events: EventSheetEvent[]): ScriptAction[] {
  const results: ScriptAction[] = [];

  function traverse(nodes: EventSheetEvent[]): void {
    for (const event of nodes) {
      if (
        event.eventType === "variable" ||
        event.eventType === "comment" ||
        event.eventType === "include"
      ) {
        continue;
      }

      if (event.eventType === "group") {
        traverse(event.children ?? []);
        continue;
      }

      // block, function-block, custom-ace-block
      for (const action of event.actions) {
        if (isScriptAction(action)) {
          results.push(action);
        }
      }

      if (event.children) {
        traverse(event.children);
      }
    }
  }

  traverse(events);
  return results;
}

/**
 * Walk all script actions in an eventSheet, returning mutable references.
 * Traverses blocks, function-blocks, custom-ace-blocks, and groups recursively.
 */
export function walkScriptActions(sheet: EventSheet): ScriptAction[] {
  return walkScriptActionsInArray(sheet.events);
}

export function isStandardAction(action: C3Action): action is StandardAction {
  return "id" in action && "objectClass" in action && !("customAction" in action);
}

export function isFunctionCallAction(action: C3Action): action is FunctionCallAction {
  return "callFunction" in action;
}

export function isCustomAction(action: C3Action): action is CustomAction {
  return "customAction" in action;
}

export function isCommentAction(action: C3Action): action is CommentAction {
  return (action as CommentAction).type === "comment" && "text" in action && !("language" in action);
}

export function isParameterizedAction(
  action: C3Action,
): action is StandardAction | FunctionCallAction | CustomAction {
  return isStandardAction(action) || isFunctionCallAction(action) || isCustomAction(action);
}

/** Returns the action identifier used for matchAction targeting. */
export function getActionIdentifier(action: C3Action): string | undefined {
  if (isStandardAction(action)) return action.id;
  if (isFunctionCallAction(action)) return action.callFunction;
  if (isCustomAction(action)) return action.customAction;
  return undefined;
}

export function buildCustomAction(sidGen: SidGenerator, opts: {
  name: string;
  objectClass: string;
  parameters?: unknown[];
}): CustomAction {
  const action: CustomAction = {
    customAction: opts.name,
    objectClass: opts.objectClass,
    sid: sidGen(),
  };
  if (opts.parameters) {
    action.parameters = opts.parameters;
  }
  return action;
}
