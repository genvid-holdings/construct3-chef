import type { EventSheet, EventSheetEvent } from "@genvid/c3source";

function hasActionArrays(event: unknown): boolean {
  return event !== null && typeof event === "object" && Array.isArray((event as Record<string, unknown>).actions);
}

function hasChildren(event: unknown): boolean {
  return event !== null && typeof event === "object" && Array.isArray((event as Record<string, unknown>).children);
}

function isScript(action: Record<string, unknown>): boolean {
  return action.type === "script" && action.language === "typescript";
}

function getSid(event: EventSheetEvent): number | undefined {
  return "sid" in event ? (event as { sid: number }).sid : undefined;
}

export function diffEventsScripts(
  lines: string[],
  origEvents: EventSheetEvent[],
  modEvents: EventSheetEvent[],
  pathPrefix: string,
): void {
  // Build SID → event map for original events (skip SID 0 / undefined — those are inserted events)
  const origBySid = new Map<number, EventSheetEvent>();
  for (const event of origEvents) {
    const sid = getSid(event);
    if (sid !== undefined && sid !== 0) {
      origBySid.set(sid, event);
    }
  }

  // Iterate modified events using modified indices for path display
  for (let i = 0; i < modEvents.length; i++) {
    const mod = modEvents[i];
    const sid = getSid(mod);
    const orig = sid !== undefined && sid !== 0 ? origBySid.get(sid) : undefined;
    const eventPath = pathPrefix ? `${pathPrefix}.children[${i}]` : `events[${i}]`;

    if (!orig) continue; // New/inserted event — no original to diff against

    // Compare actions if both have them
    if (hasActionArrays(orig) && hasActionArrays(mod)) {
      const origActions = (orig as { actions: unknown[] }).actions;
      const modActions = (mod as { actions: unknown[] }).actions;
      const actionLen = Math.max(origActions.length, modActions.length);
      for (let j = 0; j < actionLen; j++) {
        const origAct = origActions[j] as Record<string, unknown> | undefined;
        const modAct = modActions[j] as Record<string, unknown> | undefined;
        if (origAct && modAct && isScript(origAct) && isScript(modAct)) {
          const origScript = (origAct as { script: string[] }).script;
          const modScript = (modAct as { script: string[] }).script;
          if (JSON.stringify(origScript) !== JSON.stringify(modScript)) {
            lines.push(`    ${eventPath} action[${j}]:`);
            for (const line of origScript) {
              if (!modScript.includes(line)) {
                lines.push(`      - ${line}`);
              }
            }
            for (const line of modScript) {
              if (!origScript.includes(line)) {
                lines.push(`      + ${line}`);
              }
            }
          }
        }
      }
    }

    // Recurse into children
    if (hasChildren(orig) && hasChildren(mod)) {
      diffEventsScripts(
        lines,
        (orig as { children: EventSheetEvent[] }).children,
        (mod as { children: EventSheetEvent[] }).children,
        eventPath,
      );
    }
  }
}

export function diffScripts(_filePath: string, original: EventSheet, modified: EventSheet): string[] {
  const lines: string[] = [];
  diffEventsScripts(lines, original.events, modified.events, "");
  return lines;
}
