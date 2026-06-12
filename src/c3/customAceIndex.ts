import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { EventSheet } from "@genvid/c3source";
import { extractFunctions, find_all_eventsheets_path, visitEvents } from "@genvid/c3source";
import type { C3Action } from "./eventSheetMutator.js";
import { isCustomAction } from "./eventSheetMutator.js";

// ─── Types ───

interface FamilyRecord {
  name: string;
  members: string[];
}

/** Index of custom ACEs defined across all event sheets, plus family membership. */
export interface CustomAceIndex {
  /**
   * Check whether a custom ACE `(objectClass, aceName)` is defined somewhere
   * in the project.
   */
  hasAce(objectClass: string, aceName: string): boolean;

  /**
   * Return the set of family names that `objectClass` belongs to
   * (may be empty when the object is not in any family).
   */
  familiesOf(objectClass: string): ReadonlySet<string>;

  /**
   * Return the set of member names belonging to family `familyName`
   * (may be empty when the family is not in the index).
   */
  membersOf(familyName: string): ReadonlySet<string>;
}

// ─── Builder ───

/**
 * Build a `CustomAceIndex` by scanning all event sheets under
 * `<rootDir>/eventSheets/` and all family files under `<rootDir>/families/`.
 *
 * Uses synchronous I/O to match the rest of the codebase (recipeApplier etc.).
 * If `<rootDir>/families/` does not exist, the membership maps are left empty.
 */
export function buildCustomAceIndex(rootDir: string): CustomAceIndex {
  // ── 1. Collect custom-ace definitions from every event sheet ──
  // Map: objectClass → Set<aceName>
  const aceMap = new Map<string, Set<string>>();

  const eventSheetsDir = path.join(rootDir, "eventSheets");
  const sheetPaths = find_all_eventsheets_path(eventSheetsDir);

  for (const absPath of sheetPaths) {
    let sheet: EventSheet;
    try {
      sheet = JSON.parse(readFileSync(absPath, "utf-8")) as EventSheet;
    } catch {
      // Skip unreadable/unparseable sheets rather than crashing the index build
      continue;
    }

    for (const fn of extractFunctions(sheet)) {
      if (fn.kind !== "custom-ace" || fn.objectClass == null) continue;
      let names = aceMap.get(fn.objectClass);
      if (!names) {
        names = new Set();
        aceMap.set(fn.objectClass, names);
      }
      names.add(fn.name);
    }
  }

  // ── 2. Collect family membership ──
  // Forward map:  familyName → Set<memberName>
  const familyToMembers = new Map<string, Set<string>>();
  // Reverse map:  memberName → Set<familyName>
  const memberToFamilies = new Map<string, Set<string>>();

  const familiesDir = path.join(rootDir, "families");
  if (existsSync(familiesDir)) {
    let entries: string[];
    try {
      entries = readdirSync(familiesDir);
    } catch {
      entries = [];
    }

    for (const filename of entries) {
      if (!filename.endsWith(".json")) continue;
      let record: FamilyRecord;
      try {
        record = JSON.parse(readFileSync(path.join(familiesDir, filename), "utf-8")) as FamilyRecord;
      } catch {
        continue;
      }

      const { name, members } = record;
      if (!name || !Array.isArray(members)) continue;

      let membersSet = familyToMembers.get(name);
      if (!membersSet) {
        membersSet = new Set();
        familyToMembers.set(name, membersSet);
      }

      for (const member of members) {
        membersSet.add(member);
        let familiesSet = memberToFamilies.get(member);
        if (!familiesSet) {
          familiesSet = new Set();
          memberToFamilies.set(member, familiesSet);
        }
        familiesSet.add(name);
      }
    }
  }

  // ── 3. Return the index object ──
  const emptySet: ReadonlySet<string> = new Set();

  return {
    hasAce(objectClass: string, aceName: string): boolean {
      return aceMap.get(objectClass)?.has(aceName) ?? false;
    },
    familiesOf(objectClass: string): ReadonlySet<string> {
      return memberToFamilies.get(objectClass) ?? emptySet;
    },
    membersOf(familyName: string): ReadonlySet<string> {
      return familyToMembers.get(familyName) ?? emptySet;
    },
  };
}

// ─── Pure validator ───

/** Collect the sids of all customAction actions present in an EventSheet. */
function collectCustomActionSids(sheet: EventSheet): Set<number> {
  const sids = new Set<number>();
  visitEvents(sheet.events, (event) => {
    if (!("actions" in event) || !Array.isArray((event as { actions?: unknown }).actions)) return;
    for (const action of (event as { actions: C3Action[] }).actions) {
      if (isCustomAction(action)) {
        sids.add(action.sid);
      }
    }
  });
  return sids;
}

/**
 * Validate custom-actions that were INSERTED (present in `modified` but absent
 * from `original`) against the project's custom-ACE definitions and family
 * membership.
 *
 * @returns Human-readable error strings; empty array means all insertions are valid.
 */
export function validateInsertedCustomActions(
  index: CustomAceIndex,
  original: EventSheet,
  modified: EventSheet,
): string[] {
  const originalSids = collectCustomActionSids(original);
  const errors: string[] = [];

  visitEvents(modified.events, (event) => {
    if (!("actions" in event) || !Array.isArray((event as { actions?: unknown }).actions)) return;
    for (const action of (event as { actions: C3Action[] }).actions) {
      if (!isCustomAction(action)) continue;
      // Only validate actions that are NEW (not in original)
      if (originalSids.has(action.sid)) continue;

      const { customAction: aceName, objectClass, customActionObjectClass: F } = action;

      if (F !== undefined) {
        // ── Case A: explicit family override ──
        if (!index.hasAce(F, aceName)) {
          errors.push(
            `custom-action "${aceName}" is not defined on family "${F}" — ` +
              `verify the family name and that the custom-ace-block exists in its event sheet.`,
          );
        } else if (!index.membersOf(F).has(objectClass)) {
          errors.push(`custom-action "${aceName}": "${objectClass}" is not a member of family "${F}".`);
        }
      } else {
        // ── Case B: no family override ──
        if (index.hasAce(objectClass, aceName)) {
          // Direct definition exists — OK
        } else {
          // Check whether a family that objectClass belongs to defines this ace
          let hintFamily: string | undefined;
          for (const family of index.familiesOf(objectClass)) {
            if (index.hasAce(family, aceName)) {
              hintFamily = family;
              break;
            }
          }

          if (hintFamily !== undefined) {
            errors.push(
              `custom-action "${aceName}" is provided by family "${hintFamily}", not by "${objectClass}" directly — ` +
                `set { "family": "${hintFamily}" } on the custom-action.`,
            );
          } else {
            errors.push(`custom-action "${aceName}" is not defined on "${objectClass}" or any family it belongs to.`);
          }
        }
      }
    }
  });

  return errors;
}
