/**
 * Pure functions for adding instance variables to C3 objectTypes, layouts, and TypeScript definitions.
 * No file I/O — all operations are in-memory transformations.
 */

import type { SidGenerator } from "./sidUtils.js";
import { escapeRegExp } from "@genvid/mcp-utils";

export interface InstVarDef {
  name: string;
  type: "string" | "number" | "boolean";
}

// ─── ObjectType JSON ───

interface ObjectTypeInstVar {
  name: string;
  type: string;
  desc: string;
  show: boolean;
  sid: number;
}

interface ObjectTypeJson {
  name: string;
  instanceVariables: ObjectTypeInstVar[];
  [key: string]: unknown;
}

/**
 * Add instance variables to an objectType JSON object.
 * Skips variables that already exist (by name). Returns the names of added variables.
 */
export function addInstVarsToObjectType(
  sidGen: SidGenerator,
  objectType: ObjectTypeJson,
  newVars: InstVarDef[],
): string[] {
  const existing = new Set(objectType.instanceVariables.map((v) => v.name));
  const added: string[] = [];

  for (const v of newVars) {
    if (existing.has(v.name)) {
      continue;
    }
    objectType.instanceVariables.push({
      name: v.name,
      type: v.type,
      desc: "",
      show: true,
      sid: sidGen(),
    });
    added.push(v.name);
  }

  return added;
}

// ─── Layout Instances ───

interface LayoutInstance {
  type: string;
  instanceVariables: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

interface LayoutLayer {
  instances?: LayoutInstance[];
  subLayers?: LayoutLayer[];
  [key: string]: unknown;
}

interface LayoutJson {
  layers?: LayoutLayer[];
  "nonworld-instances"?: LayoutInstance[];
  [key: string]: unknown;
}

function defaultValue(type: "string" | "number" | "boolean"): string | number | boolean {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

function addInstVarsToInstance(instance: LayoutInstance, newVars: InstVarDef[]): boolean {
  let changed = false;
  for (const v of newVars) {
    if (!(v.name in instance.instanceVariables)) {
      instance.instanceVariables[v.name] = defaultValue(v.type);
      changed = true;
    }
  }
  return changed;
}

function walkLayerInstances(layers: LayoutLayer[], typeName: string, newVars: InstVarDef[]): number {
  let count = 0;
  for (const layer of layers) {
    if (layer.instances) {
      for (const inst of layer.instances) {
        if (inst.type === typeName) {
          if (addInstVarsToInstance(inst, newVars)) count++;
        }
      }
    }
    if (layer.subLayers) {
      count += walkLayerInstances(layer.subLayers, typeName, newVars);
    }
  }
  return count;
}

/**
 * Add instance variables to all instances of a given type in a layout.
 * Scans both world instances (in layers) and nonworld instances.
 * Returns the number of instances updated.
 */
export function addInstVarsToLayout(layout: LayoutJson, typeName: string, newVars: InstVarDef[]): number {
  let count = 0;

  if (layout.layers) {
    count += walkLayerInstances(layout.layers, typeName, newVars);
  }

  if (layout["nonworld-instances"]) {
    for (const inst of layout["nonworld-instances"]) {
      if (inst.type === typeName) {
        if (addInstVarsToInstance(inst, newVars)) count++;
      }
    }
  }

  return count;
}

// ─── instanceTypes.d.ts ───

/**
 * Add instVars fields to an existing class in instanceTypes.d.ts.
 * If the class has no instVars block, creates one.
 * If it has one, appends new fields.
 * Returns null if the class was not found.
 */
export function addInstVarsToTypesDts(
  content: string,
  typeName: string,
  newVars: InstVarDef[],
): string | null {
  if (newVars.length === 0) return content;

  // Find the class declaration (C3-generated file with consistent indentation)
  const classPattern = new RegExp(`(\\tclass ${escapeRegExp(typeName)} extends \\w+[^{]*\\{)`);
  const classMatch = classPattern.exec(content);
  if (!classMatch) return null;

  const classStart = classMatch.index;
  const classDecl = classMatch[1];

  // Find the closing brace of this class
  // We need to find the matching `\t}` after the class opening
  const afterOpen = classStart + classDecl.length;
  const closeBraceIdx = content.indexOf("\n\t}", afterOpen);
  if (closeBraceIdx === -1) return null;

  const classBody = content.slice(afterOpen, closeBraceIdx);

  // Check if instVars block already exists
  const instVarsMatch = /\n\t\tinstVars: \{([^}]*)\}/.exec(classBody);

  const tsType = (t: "string" | "number" | "boolean") => t;
  const newFields = newVars.map((v) => `\t\t\t${v.name}: ${tsType(v.type)},`);

  if (instVarsMatch) {
    // Append to existing instVars block
    const existingFields = instVarsMatch[1];
    // Find existing field names to skip duplicates
    const existingNames = new Set(
      [...existingFields.matchAll(/(\w+):/g)].map((m) => m[1]),
    );
    const fieldsToAdd = newFields.filter((f) => {
      const name = f.trim().split(":")[0];
      return !existingNames.has(name);
    });
    if (fieldsToAdd.length === 0) return content;

    // Insert before the closing `}` of instVars
    const instVarsEnd = afterOpen + (instVarsMatch.index ?? 0) + instVarsMatch[0].lastIndexOf("}");
    return content.slice(0, instVarsEnd) + "\n" + fieldsToAdd.join("\n") + "\n\t\t" + content.slice(instVarsEnd);
  } else {
    // Create new instVars block
    const instVarsBlock = `\n\t\tinstVars: {\n${newFields.join("\n")}\n\t\t};`;
    // Insert after class opening brace
    return content.slice(0, afterOpen) + instVarsBlock + content.slice(afterOpen);
  }
}
