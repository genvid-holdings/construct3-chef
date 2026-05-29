import path from "node:path";
import {
  formatCondition,
  formatAction,
  normalizeLineEndings,
  generateFunctionName,
} from "c3source";
import type {
  EventSheetEvent,
  EventSheet,
  BlockEvent,
  FunctionBlockEvent,
  CustomAceBlockEvent,
  GroupEvent,
  FunctionParameter,
  ScriptAction,
  Condition,
} from "c3source";

/**
 * Mutable counter object passed by reference so child events correctly
 * increment the event index across recursion (same pattern as
 * extractScriptsFromSheet).
 */
export interface EventCounter {
  value: number;
}

/** One row of the DSL coordinate index. */
export interface DslIndexEntry {
  /** Positive integer for counter-incrementing events, `null` for non-counting (variable, comment, include). */
  eventNumber: number | null;
  /** JSON path from the event sheet root, e.g. `events[0]` or `events[1].children[2]`. */
  jsonPath: string;
  /** 1-indexed DSL line number where this event starts. */
  dslLineNumber: number;
  /** Short description stripped of indentation. */
  description: string;
  /** 0-based action index within the parent event's actions array. Present only for action-level entries. */
  actionIndex?: number;
  /** SID of the event. Present for block/function-block/custom-ace-block/group/variable events. Absent for include, comment, and action-level entries. */
  sid?: number;
}

/** Return type for formatEventSheet — DSL text plus coordinate index. */
export interface DslResult {
  dsl: string;
  index: DslIndexEntry[];
}

/**
 * Format a single event into DSL lines.
 *
 * @param event - The event to format
 * @param indent - Current indentation string (e.g. "" or "  ")
 * @param sheetName - Name of the containing event sheet (for script cross-refs)
 * @param counter - Mutable event counter for C3 coordinate tracking
 * @param jsonPath - JSON path for this event (e.g. "events[0]" or "events[1].children[2]")
 * @param startLine - 1-indexed DSL line number where this event begins
 * @param indexEntries - Mutable array collecting index entries
 * @returns Array of DSL lines (without trailing newline)
 */
export function formatEvent(
  event: EventSheetEvent,
  indent: string,
  sheetName: string,
  counter: EventCounter,
  jsonPath: string,
  startLine: number,
  indexEntries: DslIndexEntry[],
): string[] {
  switch (event.eventType) {
    case "include":
      indexEntries.push({
        eventNumber: null,
        jsonPath,
        dslLineNumber: startLine,
        description: `include ${event.includeSheet}`,
      });
      return [`${indent}include ${event.includeSheet}`];

    case "comment": {
      const commentLines = normalizeLineEndings(event.text).split("\n");
      const firstLine = commentLines[0];
      const desc = commentLines.length > 1 ? `// ${firstLine}...` : `// ${firstLine}`;
      indexEntries.push({
        eventNumber: null,
        jsonPath,
        dslLineNumber: startLine,
        description: desc,
      });
      return commentLines.map((line) => `${indent}// ${line}`);
    }

    case "variable":
      indexEntries.push({
        eventNumber: null,
        jsonPath,
        dslLineNumber: startLine,
        description: formatVariableDescription(event),
        sid: event.sid,
      });
      return [formatVariable(event, indent)];

    case "group":
      return formatGroup(event, indent, sheetName, counter, jsonPath, startLine, indexEntries);

    case "block":
      return formatBlock(event, indent, sheetName, counter, jsonPath, startLine, indexEntries);

    case "function-block":
      return formatFunctionBlock(event, indent, sheetName, counter, jsonPath, startLine, indexEntries);

    case "custom-ace-block":
      return formatCustomAceBlock(event, indent, sheetName, counter, jsonPath, startLine, indexEntries);
  }
}

export function formatVariableDescription(event: EventSheetEvent & { eventType: "variable" }): string {
  const keyword = event.isConstant ? "const" : event.isStatic ? "static" : "var";
  const value = normalizeLineEndings(String(event.initialValue));
  return `${keyword} ${event.name}: ${event.type} = ${value}`;
}

function formatVariable(
  event: EventSheetEvent & { eventType: "variable" },
  indent: string,
): string {
  return `${indent}${formatVariableDescription(event)}`;
}

function formatGroup(
  event: GroupEvent,
  indent: string,
  sheetName: string,
  counter: EventCounter,
  jsonPath: string,
  startLine: number,
  indexEntries: DslIndexEntry[],
): string[] {
  counter.value++;

  indexEntries.push({
    eventNumber: counter.value,
    jsonPath,
    dslLineNumber: startLine,
    description: `group "${event.title}"`,
    sid: event.sid,
  });

  const activeLabel = event.isActiveOnStart ? "active" : "inactive";
  const disabledFlag = event.disabled ? " [DISABLED]" : "";
  const lines: string[] = [];
  lines.push(`${indent}group "${event.title}"${disabledFlag} (${activeLabel})`);

  if (event.children) {
    let currentLine = startLine + lines.length;

    for (let i = 0; i < event.children.length; i++) {
      const child = event.children[i];
      const childPath = `${jsonPath}.children[${i}]`;
      const childLines = formatEvent(
        child, indent + "  ", sheetName, counter, childPath, currentLine, indexEntries,
      );
      lines.push(...childLines);
      currentLine += childLines.length;
      // Add blank line between sibling children (but not after the last one)
      if (i < event.children.length - 1) {
        lines.push("");
        currentLine += 1;
      }
    }
  }

  return lines;
}

/**
 * Format a condition, prefixing `[DISABLED] ` when the condition has `disabled: true`
 * in source JSON. Mirrors the prefix convention already used by `formatAction` from
 * c3source for disabled actions. The `Condition` type in c3source does not declare a
 * `disabled` field even though C3 stores it at runtime, so the check is structural.
 */
export function formatConditionWithDisabled(cond: Condition): string {
  const disabled =
    "disabled" in cond && (cond as Record<string, unknown>).disabled === true;
  const condStr = formatCondition(cond);
  return disabled ? `[DISABLED] ${condStr}` : condStr;
}

/**
 * Return a brief description of an action for the DSL coordinate index.
 * Much shorter than `formatAction` — just enough to identify the action type.
 */
export function describeAction(
  action: ScriptAction | Record<string, unknown>,
  sheetName: string,
  eventIndex: number,
  actionNumber: number,
): string {
  // Comment action
  if ("type" in action && action.type === "comment") {
    const text = normalizeLineEndings(String((action as Record<string, unknown>).text ?? ""));
    const firstLine = text.split("\n")[0];
    const truncated = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
    return `// ${truncated}`;
  }

  // Script action
  if (
    (action as ScriptAction).type === "script" &&
    (action as ScriptAction).language === "typescript"
  ) {
    const lines = (action as ScriptAction).script;
    if (lines.length > 1) {
      const funcName = generateFunctionName(sheetName, eventIndex, actionNumber);
      return `script \u2192 ${funcName}`;
    }
    // Single-line: truncate
    const oneLiner = normalizeLineEndings(lines[0]);
    const truncated = oneLiner.length > 60 ? oneLiner.slice(0, 57) + "..." : oneLiner;
    return `script { ${truncated} }`;
  }

  // Function call action
  if ("callFunction" in action) {
    return `call ${action.callFunction as string}()`;
  }

  // Custom ACE action
  if ("customAction" in action) {
    return `ace ${action.objectClass as string}.${action.customAction as string}()`;
  }

  // Standard action (has id + objectClass)
  if ("id" in action && "objectClass" in action) {
    return `${action.objectClass as string}.${action.id as string}()`;
  }

  return "[unknown action]";
}

function formatBlockLike(
  event: BlockEvent | FunctionBlockEvent | CustomAceBlockEvent,
  headerLine: string,
  indent: string,
  sheetName: string,
  counter: EventCounter,
  jsonPath: string,
  startLine: number,
  indexEntries: DslIndexEntry[],
): string[] {
  const currentEventIndex = counter.value;
  const lines: string[] = [];
  lines.push(headerLine);

  // Format conditions
  for (const cond of event.conditions) {
    lines.push(`${indent}  when: ${formatConditionWithDisabled(cond)}`);
  }

  // Format actions
  for (let i = 0; i < event.actions.length; i++) {
    const action = event.actions[i];
    const isComment = "type" in action && action.type === "comment";
    const actionStr = formatAction(action, sheetName, currentEventIndex, i + 1);

    if (isComment) {
      // Comments use // text format, no "do:" prefix.
      for (const commentLine of actionStr.split("\n")) {
        lines.push(`${indent}  ${commentLine}`);
      }
    } else {
      // Multi-line script actions need indentation on each line
      const actionLines = actionStr.split("\n");
      lines.push(`${indent}  do: ${actionLines[0]}`);
      for (let j = 1; j < actionLines.length; j++) {
        lines.push(`${indent}  ${actionLines[j]}`);
      }
    }

    // Push action-level index entry
    indexEntries.push({
      eventNumber: null,
      jsonPath,
      dslLineNumber: 0,
      description: describeAction(action, sheetName, currentEventIndex, i + 1),
      actionIndex: i,
    });
  }

  // Format children
  if (event.children && event.children.length > 0) {
    // Blank line between parent actions/conditions and children,
    // but only if parent had actions or conditions
    if (event.actions.length > 0 || event.conditions.length > 0) {
      lines.push("");
    }

    let currentLine = startLine + lines.length;

    for (let i = 0; i < event.children.length; i++) {
      const child = event.children[i];
      const childPath = `${jsonPath}.children[${i}]`;
      const childLines = formatEvent(
        child, indent + "  ", sheetName, counter, childPath, currentLine, indexEntries,
      );
      lines.push(...childLines);
      currentLine += childLines.length;
      if (i < event.children.length - 1) {
        lines.push("");
        currentLine += 1;
      }
    }
  }

  return lines;
}

function formatBlock(
  event: BlockEvent,
  indent: string,
  sheetName: string,
  counter: EventCounter,
  jsonPath: string,
  startLine: number,
  indexEntries: DslIndexEntry[],
): string[] {
  counter.value++;

  const flags: string[] = [];
  if ("isOrBlock" in event && (event as Record<string, unknown>).isOrBlock === true) {
    flags.push("OR");
  }
  if ("disabled" in event && (event as Record<string, unknown>).disabled === true) {
    flags.push("DISABLED");
  }
  const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  const headerLine = `${indent}block${flagStr}`;

  indexEntries.push({
    eventNumber: counter.value,
    jsonPath,
    dslLineNumber: startLine,
    description: `block${flagStr}`,
    sid: event.sid,
  });

  return formatBlockLike(event, headerLine, indent, sheetName, counter, jsonPath, startLine, indexEntries);
}

function formatFunctionParams(params: FunctionParameter[]): string {
  return params
    .map((p) => `${p.name}: ${p.type} = ${p.initialValue}`)
    .join(", ");
}

function formatFunctionBlock(
  event: FunctionBlockEvent,
  indent: string,
  sheetName: string,
  counter: EventCounter,
  jsonPath: string,
  startLine: number,
  indexEntries: DslIndexEntry[],
): string[] {
  counter.value++;

  const asyncPrefix = event.functionIsAsync ? "async " : "";
  const paramsStr = formatFunctionParams(event.functionParameters);
  const copyPicked = event.functionCopyPicked ? " [copy-picked]" : "";
  const category = event.functionCategory ? ` [category: ${event.functionCategory}]` : "";
  const description = event.functionDescription ? ` -- ${event.functionDescription}` : "";
  const headerLine = `${indent}${asyncPrefix}function ${event.functionName}(${paramsStr}) -> ${event.functionReturnType}${copyPicked}${category}${description}`;

  indexEntries.push({
    eventNumber: counter.value,
    jsonPath,
    dslLineNumber: startLine,
    description: `function ${event.functionName}()`,
    sid: event.sid,
  });

  return formatBlockLike(event, headerLine, indent, sheetName, counter, jsonPath, startLine, indexEntries);
}

function formatCustomAceBlock(
  event: CustomAceBlockEvent,
  indent: string,
  sheetName: string,
  counter: EventCounter,
  jsonPath: string,
  startLine: number,
  indexEntries: DslIndexEntry[],
): string[] {
  counter.value++;

  const paramsStr = formatFunctionParams(event.functionParameters);
  const copyPicked = event.functionCopyPicked ? " [copy-picked]" : "";
  const category = event.functionCategory ? ` [category: ${event.functionCategory}]` : "";
  const description = event.functionDescription ? ` -- ${event.functionDescription}` : "";
  const headerLine = `${indent}ace ${event.objectClass}.${event.aceName}(${paramsStr}) -> ${event.functionReturnType}${copyPicked}${category}${description}`;

  indexEntries.push({
    eventNumber: counter.value,
    jsonPath,
    dslLineNumber: startLine,
    description: `ace ${event.objectClass}.${event.aceName}()`,
    sid: event.sid,
  });

  return formatBlockLike(event, headerLine, indent, sheetName, counter, jsonPath, startLine, indexEntries);
}

/**
 * Format an entire event sheet into a DSL string with coordinate index.
 *
 * @param sheet - Parsed EventSheet object
 * @param sourcePath - Full filesystem path to the source JSON file
 * @returns DSL string and coordinate index entries
 */
export function formatEventSheet(sheet: EventSheet, sourcePath: string): DslResult {
  // Convert to relative path from project root (parent of eventSheets/)
  const eventSheetsIndex = sourcePath.replace(/\\/g, "/").indexOf("eventSheets/");
  let relPath: string;
  if (eventSheetsIndex >= 0) {
    relPath = sourcePath.replace(/\\/g, "/").slice(eventSheetsIndex);
  } else {
    // Fallback: use path.relative from a guessed root
    relPath = path.basename(sourcePath);
  }

  const lines: string[] = [];
  lines.push(`# ${sheet.name}`);
  lines.push(`# Source: ${relPath}`);
  lines.push("");

  const counter: EventCounter = { value: 0 };
  const indexEntries: DslIndexEntry[] = [];
  // Header is 3 lines (name, source, blank), events start at line 4
  let currentLine = 4;

  for (let i = 0; i < sheet.events.length; i++) {
    const event = sheet.events[i];
    const jsonPath = `events[${i}]`;
    const eventLines = formatEvent(
      event, "", sheet.name, counter, jsonPath, currentLine, indexEntries,
    );
    lines.push(...eventLines);
    currentLine += eventLines.length;
    // Add blank line between top-level events (but not after the last one)
    if (i < sheet.events.length - 1) {
      lines.push("");
      currentLine += 1;
    }
  }

  // Ensure trailing newline
  lines.push("");

  return {
    dsl: lines.join("\n"),
    index: indexEntries,
  };
}

/**
 * Format coordinate index entries into a `.dsl.idx.txt` file content string.
 */
export function formatIndex(sheetName: string, entries: DslIndexEntry[]): string {
  const lines: string[] = [];
  lines.push(`# ${sheetName} \u2014 DSL Coordinate Index`);
  lines.push(`# Regenerate: npm run generate-dsl`);
  lines.push(`#`);

  // Compute column widths (minimum widths match header labels)
  // For action entries, the path column shows "  action[N]" (2-space indent + action[N])
  const SID_COL_WIDTH = 16; // "§XXXXXXXXXXXXXXX" = 16 chars
  const eventW = Math.max(5, ...entries.map((e) => (e.eventNumber !== null ? String(e.eventNumber).length : 1)));
  const pathW = Math.max(
    9,
    ...entries.map((e) =>
      e.actionIndex !== undefined ? `  action[${e.actionIndex}]`.length : e.jsonPath.length,
    ),
  );
  const sidW = Math.max(3, SID_COL_WIDTH); // "SID" header vs "§XXXXXXXXXXXXXXX"
  const lineW = Math.max(8, ...entries.map((e) => String(e.dslLineNumber).length));

  // Header
  lines.push(
    `# ${"Event".padEnd(eventW)} | ${"JSON Path".padEnd(pathW)} | ${"SID".padEnd(sidW)} | ${"DSL Line".padEnd(lineW)} | Description`,
  );

  // Separator
  lines.push(
    `#${"-".repeat(eventW + 2)}|${"-".repeat(pathW + 2)}|${"-".repeat(sidW + 2)}|${"-".repeat(lineW + 2)}|${"-".repeat(11)}`,
  );

  // Data rows
  for (const entry of entries) {
    const sidStr =
      entry.sid !== undefined
        ? `\u00a7${String(entry.sid).padStart(15, "0")}`.padEnd(sidW)
        : " ".repeat(sidW);

    if (entry.actionIndex !== undefined) {
      // Action-level row: empty event, indented action path, empty SID, empty DSL line
      const eventStr = " ".repeat(eventW);
      const pathStr = `  action[${entry.actionIndex}]`.padEnd(pathW);
      const lineStr = " ".repeat(lineW);
      lines.push(`  ${eventStr} | ${pathStr} | ${sidStr} | ${lineStr} | ${entry.description}`);
    } else {
      // Event-level row
      const eventStr = (entry.eventNumber !== null ? String(entry.eventNumber) : "-").padEnd(eventW);
      const pathStr = entry.jsonPath.padEnd(pathW);
      const lineStr = String(entry.dslLineNumber).padEnd(lineW);
      lines.push(`  ${eventStr} | ${pathStr} | ${sidStr} | ${lineStr} | ${entry.description}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** One row of the shallow SID map (from source JSON, no DSL generation needed). */
export interface SidMapEntry {
  /** JSON path from the event sheet root, e.g. `events[0]` or `events[1].children[2]`. */
  jsonPath: string;
  /** SID of the event. Undefined for include and comment events. */
  sid: number | undefined;
  /** Short description (same format as DslIndexEntry.description). Display field. */
  description: string;
  /**
   * Concatenated summary of the event's own conditions and actions, intended for grep
   * filtering — never displayed. Empty for event types without conditions/actions
   * (`variable`, `include`, `comment`, `group`).
   */
  searchText: string;
}

/**
 * Build a shallow SID map from an event sheet's parsed JSON.
 * Walks the event tree recursively, collecting jsonPath/sid/description for each node.
 * Does NOT generate DSL text or line numbers — this is a fast lookup for recipe targeting.
 */
export function buildShallowSidMap(sheet: EventSheet): SidMapEntry[] {
  const entries: SidMapEntry[] = [];
  // Shared counter incremented in walk() for every counter-bearing eventType
  // (group, block, function-block, custom-ace-block) — mirrors formatBlockLike's
  // EventCounter so the synthetic script function name embedded by formatAction
  // (e.g. `Sheet_Event2_Act1`) matches what extractScriptsFromSheet emits.
  const counter: EventCounter = { value: 0 };

  function summarize(event: BlockEvent | FunctionBlockEvent | CustomAceBlockEvent): string {
    const parts: string[] = [];
    // Defensive `?? []`: c3source types both arrays as required, but read-event-sids
    // parses untrusted source JSON without runtime validation — a hand-edited or
    // legacy sheet with a missing array previously fell through here harmlessly
    // because the shallow map didn't touch them.
    for (const cond of event.conditions ?? []) {
      parts.push(formatConditionWithDisabled(cond));
    }
    const actions = event.actions ?? [];
    for (let i = 0; i < actions.length; i++) {
      // Use formatAction (not describeAction) so searchText includes parameter
      // values, [DISABLED] prefix, [behaviorType] segment, and full (untruncated)
      // comment/script text — the original gap report's `grep=BattleLayout` query
      // is an action parameter value and would silently fail with describeAction.
      parts.push(formatAction(actions[i], sheet.name, counter.value, i + 1));
    }
    // Newline keeps tokens from fusing across boundaries; searchText is grep-only
    // (never displayed) so the separator choice is purely a regex concern.
    return parts.join("\n");
  }

  function walk(events: EventSheet["events"], basePath: string): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const jsonPath = `${basePath}[${i}]`;

      switch (event.eventType) {
        case "include":
          entries.push({
            jsonPath,
            sid: undefined,
            description: `include ${event.includeSheet}`,
            searchText: "",
          });
          break;

        case "comment": {
          const commentLines = normalizeLineEndings(event.text).split("\n");
          const firstLine = commentLines[0];
          const desc = commentLines.length > 1 ? `// ${firstLine}...` : `// ${firstLine}`;
          entries.push({ jsonPath, sid: undefined, description: desc, searchText: "" });
          break;
        }

        case "variable":
          entries.push({
            jsonPath,
            sid: event.sid,
            description: formatVariableDescription(event),
            searchText: "",
          });
          break;

        case "group": {
          // formatGroup increments the counter; mirror so summarize's
          // sibling block sees the same eventIndex the DSL extractor uses.
          counter.value++;
          entries.push({
            jsonPath,
            sid: event.sid,
            description: `group "${event.title}"`,
            searchText: "",
          });
          if (event.children) {
            walk(event.children, `${jsonPath}.children`);
          }
          break;
        }

        case "block": {
          counter.value++; // mirror formatBlock
          const flags: string[] = [];
          if ("isOrBlock" in event && (event as Record<string, unknown>).isOrBlock === true) {
            flags.push("OR");
          }
          if ("disabled" in event && (event as Record<string, unknown>).disabled === true) {
            flags.push("DISABLED");
          }
          const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
          entries.push({
            jsonPath,
            sid: event.sid,
            description: `block${flagStr}`,
            searchText: summarize(event),
          });
          if (event.children && event.children.length > 0) {
            walk(event.children, `${jsonPath}.children`);
          }
          break;
        }

        case "function-block":
          counter.value++; // mirror formatFunctionBlock
          entries.push({
            jsonPath,
            sid: event.sid,
            description: `function "${event.functionName}"`,
            searchText: summarize(event),
          });
          if (event.children && event.children.length > 0) {
            walk(event.children, `${jsonPath}.children`);
          }
          break;

        case "custom-ace-block":
          counter.value++; // mirror formatCustomAceBlock
          entries.push({
            jsonPath,
            sid: event.sid,
            description: `ace "${event.objectClass}.${event.aceName}"`,
            searchText: summarize(event),
          });
          if (event.children && event.children.length > 0) {
            walk(event.children, `${jsonPath}.children`);
          }
          break;
      }
    }
  }

  walk(sheet.events, "events");
  return entries;
}

/**
 * Filter a DSL index text by a regex pattern, preserving header lines.
 * Header lines (starting with `#`) are always kept. Data rows are kept
 * only if they match the pattern. Returns headers + "No matches" note if
 * no data rows match.
 */
export function filterIndex(text: string, pattern: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    const headers = text
      .split("\n")
      .filter((l) => l.startsWith("#"));
    return [...headers, "", `Invalid regex pattern: ${pattern}`, ""].join("\n");
  }
  const lines = text.split("\n");
  const headers: string[] = [];
  const matchingRows: string[] = [];

  for (const line of lines) {
    if (line.startsWith("#")) {
      headers.push(line);
    } else if (line.trim() !== "" && regex.test(line)) {
      matchingRows.push(line);
    }
  }

  if (matchingRows.length === 0) {
    return [...headers, "", `No matches for pattern: ${pattern}`, ""].join("\n");
  }

  return [...headers, ...matchingRows, ""].join("\n");
}
