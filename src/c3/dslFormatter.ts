import path from "node:path";
import { formatCondition, formatAction, normalizeLineEndings, visitEvents } from "@genvid/c3source";
import type {
  EventSheetEvent,
  EventSheet,
  BlockEvent,
  FunctionBlockEvent,
  CustomAceBlockEvent,
  FunctionParameter,
} from "@genvid/c3source";

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
  /**
   * Grep-only search tail — present only on block/function-block/custom-ace-block rows.
   * Contains the full condition + action text (parameter values included) so that
   * `filterIndex` can match hidden content (e.g. `grep=BattleLayout`).
   * Never displayed; stripped by `parseIndexText` in anchorResolver.
   */
  searchText?: string;
}

/**
 * In-band sentinel that separates the visible Description from the hidden grep tail
 * in `.dsl.idx.txt` block rows.
 * `⟪` = U+27EA, `⟫` = U+27EB — not present in normal C3 identifiers or strings.
 */
export const SEARCH_SENTINEL = " ⟪search⟫ ";

/** Return type for formatEventSheet — DSL text plus coordinate index. */
export interface DslResult {
  dsl: string;
  index: DslIndexEntry[];
}

export function formatVariableDescription(event: EventSheetEvent & { eventType: "variable" }): string {
  const keyword = event.isConstant ? "const" : event.isStatic ? "static" : "var";
  const value = normalizeLineEndings(String(event.initialValue));
  return `${keyword} ${event.name}: ${event.type} = ${value}`;
}

function formatVariable(event: EventSheetEvent & { eventType: "variable" }, indent: string): string {
  return `${indent}${formatVariableDescription(event)}`;
}

/**
 * Return the node's OWN DSL lines only — no children, no inter-node blank lines.
 *
 * For block/function-block/custom-ace-block this is the header line plus the
 * `when:` condition lines and the `do:`/comment action lines.  For group it is
 * the single group header line.  For include/comment/variable it renders the
 * single DSL line for that event type.
 *
 * @param event       - The event to render.
 * @param indent      - Current indentation string (e.g. "" or "  ").
 * @param sheetName   - Name of the containing event sheet (for script cross-refs).
 * @param eventNumber - The post-increment counter value for this event (ignored for
 *                      non-counting types).
 */
export function renderNodeSelf(
  event: EventSheetEvent,
  indent: string,
  sheetName: string,
  eventNumber: number,
): string[] {
  switch (event.eventType) {
    case "include":
      return [`${indent}include ${event.includeSheet}`];

    case "comment": {
      const commentLines = normalizeLineEndings(event.text).split("\n");
      return commentLines.map((line) => `${indent}// ${line}`);
    }

    case "variable":
      return [formatVariable(event, indent)];

    case "group": {
      const activeLabel = event.isActiveOnStart ? "active" : "inactive";
      const disabledFlag = event.disabled ? " [DISABLED]" : "";
      return [`${indent}group "${event.title}"${disabledFlag} (${activeLabel})`];
    }

    case "block": {
      const flags: string[] = [];
      if (event.isOrBlock === true) flags.push("OR");
      if (event.disabled === true) flags.push("DISABLED");
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      const headerLine = `${indent}block${flagStr}`;
      return buildBlockLikeSelfLines(event, headerLine, indent, sheetName, eventNumber);
    }

    case "function-block": {
      const asyncPrefix = event.functionIsAsync ? "async " : "";
      const paramsStr = formatFunctionParams(event.functionParameters);
      const copyPicked = event.functionCopyPicked ? " [copy-picked]" : "";
      const category = event.functionCategory ? ` [category: ${event.functionCategory}]` : "";
      const description = event.functionDescription ? ` -- ${event.functionDescription}` : "";
      const headerLine = `${indent}${asyncPrefix}function ${event.functionName}(${paramsStr}) -> ${event.functionReturnType}${copyPicked}${category}${description}`;
      return buildBlockLikeSelfLines(event, headerLine, indent, sheetName, eventNumber);
    }

    case "custom-ace-block": {
      const paramsStr = formatFunctionParams(event.functionParameters);
      const copyPicked = event.functionCopyPicked ? " [copy-picked]" : "";
      const category = event.functionCategory ? ` [category: ${event.functionCategory}]` : "";
      const description = event.functionDescription ? ` -- ${event.functionDescription}` : "";
      const headerLine = `${indent}ace ${event.objectClass}.${event.aceName}(${paramsStr}) -> ${event.functionReturnType}${copyPicked}${category}${description}`;
      return buildBlockLikeSelfLines(event, headerLine, indent, sheetName, eventNumber);
    }
  }
}

/**
 * Shared helper for block/function-block/custom-ace-block self-lines:
 * header + when: conditions + do:/comment actions. No children.
 */
function buildBlockLikeSelfLines(
  event: BlockEvent | FunctionBlockEvent | CustomAceBlockEvent,
  headerLine: string,
  indent: string,
  sheetName: string,
  eventNumber: number,
): string[] {
  const lines: string[] = [];
  lines.push(headerLine);

  // Format conditions
  for (const cond of event.conditions) {
    lines.push(`${indent}  when: ${formatCondition(cond)}`);
  }

  // Format actions
  for (let i = 0; i < event.actions.length; i++) {
    const action = event.actions[i];
    const isComment = "type" in action && action.type === "comment";
    const actionStr = formatAction(action, sheetName, eventNumber, i + 1);

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
  }

  return lines;
}

function formatFunctionParams(params: FunctionParameter[]): string {
  return params.map((p) => `${p.name}: ${p.type} = ${p.initialValue}`).join(", ");
}

/**
 * Build a DslIndexEntry for a single event from visitEvents context.
 */
function buildIndexEntry(
  event: EventSheetEvent,
  jsonPath: string,
  dslLineNumber: number,
  eventNumber: number | null,
  sheetName: string,
): DslIndexEntry {
  switch (event.eventType) {
    case "include":
      return {
        eventNumber: null,
        jsonPath,
        dslLineNumber,
        description: `include ${event.includeSheet}`,
      };

    case "comment": {
      const commentLines = normalizeLineEndings(event.text).split("\n");
      const firstLine = commentLines[0];
      const description = commentLines.length > 1 ? `// ${firstLine}...` : `// ${firstLine}`;
      return {
        eventNumber: null,
        jsonPath,
        dslLineNumber,
        description,
      };
    }

    case "variable":
      return {
        eventNumber: null,
        jsonPath,
        dslLineNumber,
        description: formatVariableDescription(event),
        sid: event.sid,
      };

    case "group":
      return {
        eventNumber,
        jsonPath,
        dslLineNumber,
        description: `group "${event.title}"`,
        sid: event.sid,
      };

    case "block": {
      const flags: string[] = [];
      if (event.isOrBlock === true) flags.push("OR");
      if (event.disabled === true) flags.push("DISABLED");
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      return {
        eventNumber,
        jsonPath,
        dslLineNumber,
        description: `block${flagStr}`,
        sid: event.sid,
        searchText: buildBlockSearchText(event, { name: sheetName } as EventSheet, eventNumber ?? 0),
      };
    }

    case "function-block":
      return {
        eventNumber,
        jsonPath,
        dslLineNumber,
        description: `function ${event.functionName}()`,
        sid: event.sid,
        searchText: buildBlockSearchText(event, { name: sheetName } as EventSheet, eventNumber ?? 0),
      };

    case "custom-ace-block":
      return {
        eventNumber,
        jsonPath,
        dslLineNumber,
        description: `ace ${event.objectClass}.${event.aceName}()`,
        sid: event.sid,
        searchText: buildBlockSearchText(event, { name: sheetName } as EventSheet, eventNumber ?? 0),
      };
  }
}

/**
 * Drive a visitEvents pass over `events`, pushing rendered DSL lines into
 * `output` (mutated in place) and collecting DslIndexEntry objects.
 *
 * @param events    - The event array to walk.
 * @param sheetName - Name of the containing event sheet.
 * @param output    - Accumulator array; may be pre-seeded (e.g. with sheet headers).
 * @param baseLine  - The 1-indexed line number to treat as offset 0 of `output`
 *                    at the point this function is called.  A node's dslLineNumber
 *                    = baseLine + output.length (captured before pushing its lines).
 */
function renderEventsInto(
  events: EventSheetEvent[],
  sheetName: string,
  output: string[],
  baseLine: number,
): DslIndexEntry[] {
  const index: DslIndexEntry[] = [];
  // depth-keyed flag: does this depth's first child need a leading blank line?
  const parentNeedsChildSeparator: boolean[] = [];

  visitEvents(events, (event, ctx) => {
    // Blank-line rules (mutually exclusive):
    // 1. Blank between siblings at any depth (ctx.index > 0)
    // 2. Blank between a parent's actions/conditions and its first child
    if (ctx.index > 0) {
      output.push(""); // blank between siblings
    } else if (ctx.depth > 0 && parentNeedsChildSeparator[ctx.depth]) {
      output.push(""); // blank before first child of a block-like with content
    }

    // Capture dslLineNumber AFTER blanks, BEFORE this node's own lines
    const dslLineNumber = baseLine + output.length;
    const eventNumber = ctx.eventNumber;

    // Render this node's own lines (no children, no blanks)
    output.push(...renderNodeSelf(event, "  ".repeat(ctx.depth), sheetName, eventNumber ?? 0));

    // Build index entry
    index.push(buildIndexEntry(event, ctx.jsonPath, dslLineNumber, eventNumber, sheetName));

    // Set flag for this node's first child:
    // block-like nodes need a separator iff they have actions or conditions
    const t = event.eventType;
    if (t === "block" || t === "function-block" || t === "custom-ace-block") {
      const blockLike = event as BlockEvent | FunctionBlockEvent | CustomAceBlockEvent;
      parentNeedsChildSeparator[ctx.depth + 1] = blockLike.actions.length > 0 || blockLike.conditions.length > 0;
    } else {
      // groups and non-counting nodes never separate before their first child
      parentNeedsChildSeparator[ctx.depth + 1] = false;
    }
  });

  return index;
}

/**
 * Render a subtree of events into DSL lines plus index entries.
 *
 * Drives a visitEvents pass starting at `startLine`, producing the same lines
 * and index entries that `formatEventSheet` would for these top-level events.
 * Blank lines between siblings are inserted exactly as in the top-level loop,
 * with no trailing blank pushed.
 *
 * @param events    - The top-level event array to render.
 * @param sheetName - Name of the containing event sheet.
 * @param startLine - 1-indexed DSL line where the first event begins.
 */
export function renderSubtree(
  events: EventSheetEvent[],
  sheetName: string,
  startLine: number,
): { lines: string[]; index: DslIndexEntry[] } {
  const output: string[] = [];
  const index = renderEventsInto(events, sheetName, output, startLine);
  return { lines: output, index };
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

  // Header is 3 lines (name, source, blank), events start at line 4.
  // Pass baseLine=1 so that the first event's dslLineNumber = 1 + lines.length = 1 + 3 = 4.
  const indexEntries = renderEventsInto(sheet.events, sheet.name, lines, 1);

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
  lines.push(`# ${sheetName} — DSL Coordinate Index`);
  lines.push(`# Regenerate: npm run generate-dsl`);
  lines.push(`#`);

  // Compute column widths (minimum widths match header labels)
  const SID_COL_WIDTH = 16; // "§XXXXXXXXXXXXXXX" = 16 chars
  const eventW = Math.max(5, ...entries.map((e) => (e.eventNumber !== null ? String(e.eventNumber).length : 1)));
  const pathW = Math.max(
    9,
    ...entries.map((e) => (e.actionIndex !== undefined ? `  action[${e.actionIndex}]`.length : e.jsonPath.length)),
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

  // Data rows (no action-level rows — those were removed in favour of searchText)
  for (const entry of entries) {
    const sidStr = entry.sid !== undefined ? `§${String(entry.sid).padStart(15, "0")}`.padEnd(sidW) : " ".repeat(sidW);

    // Event-level row
    const eventStr = (entry.eventNumber !== null ? String(entry.eventNumber) : "-").padEnd(eventW);
    const pathStr = entry.jsonPath.padEnd(pathW);
    const lineStr = String(entry.dslLineNumber).padEnd(lineW);
    const descStr = entry.searchText
      ? `${entry.description}${SEARCH_SENTINEL}${entry.searchText.replace(/\n/g, " ")}`
      : entry.description;
    lines.push(`  ${eventStr} | ${pathStr} | ${sidStr} | ${lineStr} | ${descStr}`);
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
 * Build a grep-friendly search string for a block-like event (block, function-block,
 * or custom-ace-block). Concatenates all condition summaries and action summaries,
 * newline-separated.
 *
 * This is a pure function: same inputs always produce the same output.
 * The result is intended for grep filtering only — it is never displayed directly.
 */
export function buildBlockSearchText(
  event: BlockEvent | FunctionBlockEvent | CustomAceBlockEvent,
  sheet: EventSheet,
  eventNumber: number,
): string {
  const parts: string[] = [];
  // Defensive `?? []`: c3source types both arrays as required, but read-event-sids
  // parses untrusted source JSON without runtime validation — a hand-edited or
  // legacy sheet with a missing array previously fell through here harmlessly
  // because the shallow map didn't touch them.
  for (const cond of event.conditions ?? []) {
    parts.push(formatCondition(cond));
  }
  const actions = event.actions ?? [];
  for (let i = 0; i < actions.length; i++) {
    // Use formatAction (not describeAction) so searchText includes parameter
    // values, [DISABLED] prefix, [behaviorType] segment, and full (untruncated)
    // comment/script text — the original gap report's `grep=BattleLayout` query
    // is an action parameter value and would silently fail with describeAction.
    parts.push(formatAction(actions[i], sheet.name, eventNumber, i + 1));
  }
  // Newline keeps tokens from fusing across boundaries; searchText is grep-only
  // (never displayed) so the separator choice is purely a regex concern.
  return parts.join("\n");
}

/**
 * Build a shallow SID map from an event sheet's parsed JSON.
 * Walks the event tree recursively, collecting jsonPath/sid/description for each node.
 * Does NOT generate DSL text or line numbers — this is a fast lookup for recipe targeting.
 */
export function buildShallowSidMap(sheet: EventSheet): SidMapEntry[] {
  const entries: SidMapEntry[] = [];

  // visitEvents assigns each counting event (group / block / function-block /
  // custom-ace-block) the same 1-based eventNumber extractScriptsFromSheet uses,
  // so the synthetic script function name embedded by formatAction (e.g.
  // `Sheet_Event2_Act1`) matches what the DSL extractor emits.

  visitEvents(sheet.events, (event, ctx) => {
    const { jsonPath } = ctx;

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

      case "group":
        entries.push({
          jsonPath,
          sid: event.sid,
          description: `group "${event.title}"`,
          searchText: "",
        });
        break;

      case "block": {
        const flags: string[] = [];
        if (event.isOrBlock === true) {
          flags.push("OR");
        }
        if (event.disabled === true) {
          flags.push("DISABLED");
        }
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        entries.push({
          jsonPath,
          sid: event.sid,
          description: `block${flagStr}`,
          searchText: buildBlockSearchText(event, sheet, ctx.eventNumber ?? 0),
        });
        break;
      }

      case "function-block":
        entries.push({
          jsonPath,
          sid: event.sid,
          description: `function "${event.functionName}"`,
          searchText: buildBlockSearchText(event, sheet, ctx.eventNumber ?? 0),
        });
        break;

      case "custom-ace-block":
        entries.push({
          jsonPath,
          sid: event.sid,
          description: `ace "${event.objectClass}.${event.aceName}"`,
          searchText: buildBlockSearchText(event, sheet, ctx.eventNumber ?? 0),
        });
        break;
    }
  });
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
    const headers = text.split("\n").filter((l) => l.startsWith("#"));
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
