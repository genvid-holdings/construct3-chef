import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type Recipe, validateRecipe } from "./recipeInterpreter.js";

// ─── Schemas / Types ───────────────────────────────────────────────────────────

const OpParamSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  required: z.boolean().default(true),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const OpDefinitionSchema = z.object({
  description: z.string(),
  params: z.array(OpParamSchema).default([]),
  recipe: z.unknown(), // shape-validated as a Recipe AFTER substitution
});

export type OpParam = z.infer<typeof OpParamSchema>;
export type OpDefinition = z.infer<typeof OpDefinitionSchema>;

export interface LoadedOp {
  name: string; // derived from filename, sans ".json"
  filePath: string; // absolute
  def: OpDefinition;
}

export interface OpLoadError {
  file: string;
  message: string;
}

// ─── Op Name Validation ────────────────────────────────────────────────────────

const OP_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

// ─── loadOpsFromDir ────────────────────────────────────────────────────────────

/**
 * Load all op definitions from a directory. Synchronous, errors-as-values (never throws).
 * An absent or non-directory `dir` is treated as empty (ops are optional).
 */
export function loadOpsFromDir(dir: string): { ops: LoadedOp[]; errors: OpLoadError[] } {
  const ops: LoadedOp[] = [];
  const errors: OpLoadError[] = [];

  // Absent / non-directory dir is not an error — ops are optional.
  let entries: string[];
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      return { ops, errors };
    }
    entries = fs.readdirSync(dir);
  } catch {
    return { ops, errors };
  }

  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();

  for (const file of jsonFiles) {
    const absPath = path.join(dir, file);
    const base = path.basename(file, ".json");

    // Validate op name derived from filename.
    if (!OP_NAME_RE.test(base)) {
      errors.push({
        file,
        message: `op name "${base}" is invalid — must match /^[a-z0-9][a-z0-9-]*$/i so the derived MCP tool id "op-${base}" is a valid identifier`,
      });
      continue;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch (e) {
      errors.push({ file, message: `failed to read file: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push({ file, message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const result = OpDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      errors.push({ file, message: `schema validation failed: ${issues}` });
      continue;
    }

    ops.push({ name: base, filePath: absPath, def: result.data });
  }

  return { ops, errors };
}

// ─── opToInputSchema ───────────────────────────────────────────────────────────

/**
 * Build a zod raw-shape map keyed by param name, for use as an MCP/CLI inputSchema.
 */
export function opToInputSchema(def: OpDefinition): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of def.params) {
    // Base type
    let base: z.ZodTypeAny;
    switch (param.type) {
      case "string":
        base = z.string();
        break;
      case "number":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
    }

    // Apply description
    if (param.description !== undefined) {
      base = base.describe(param.description);
    }

    // Required vs optional/default
    if (!param.required) {
      if (param.default !== undefined) {
        // ZodDefault requires the right type — param.default is already validated
        // to match the param type by OpParamSchema; cast through any to satisfy TS.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        base = (base as any).default(param.default);
      } else {
        base = base.optional();
      }
    }

    shape[param.name] = base;
  }

  return shape;
}

// ─── substituteOp ─────────────────────────────────────────────────────────────

const TOKEN_RE = /\{\{(\w+)\}\}/g;

/**
 * Deep-substitute `{{PARAM}}` tokens in the op's recipe template,
 * validate the result, and return the ready-to-apply `Recipe`.
 *
 * Throws a single Error aggregating all validation problems (missing required
 * params, unknown args, leftover placeholders, recipe validity).
 */
export function substituteOp(def: OpDefinition, args: Record<string, unknown>): Recipe {
  const paramMap = new Map<string, OpParam>(def.params.map((p) => [p.name, p]));
  const knownNames = new Set(paramMap.keys());

  // ── Resolve effective args: defaults first, then overlay args ──────────────
  const effective: Record<string, unknown> = {};
  for (const param of def.params) {
    if (param.default !== undefined) {
      effective[param.name] = param.default;
    }
  }
  for (const [k, v] of Object.entries(args)) {
    effective[k] = v;
  }

  // ── Aggregate all problems before throwing ─────────────────────────────────
  const problems: string[] = [];

  // Missing required params (no arg and no default in effective)
  for (const param of def.params) {
    if (param.required && effective[param.name] === undefined) {
      problems.push(`missing required param "${param.name}"`);
    }
  }

  // Unknown args: keys in args that aren't declared params
  for (const key of Object.keys(args)) {
    if (!knownNames.has(key)) {
      problems.push(`unknown arg "${key}" (not declared in op params)`);
    }
  }

  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }

  // ── Deep clone + recursive substitution ───────────────────────────────────
  const cloned = JSON.parse(JSON.stringify(def.recipe));
  const substituted = substituteNode(cloned, effective, knownNames);

  // ── Leftover-placeholder guard ─────────────────────────────────────────────
  const serialized = JSON.stringify(substituted);
  const leftover: string[] = [];
  let m: RegExpExecArray | null;
  const leftoverRe = /\{\{[^}]+\}\}/g;
  while ((m = leftoverRe.exec(serialized)) !== null) {
    if (!leftover.includes(m[0])) leftover.push(m[0]);
  }
  if (leftover.length > 0) {
    throw new Error(`unresolved placeholder(s) after substitution: ${leftover.join(", ")}`);
  }

  // ── Recipe validity ────────────────────────────────────────────────────────
  const recipe = substituted as Recipe;
  const recipeErrors = validateRecipe(recipe);
  if (recipeErrors.length > 0) {
    throw new Error(`recipe invalid after substitution: ${recipeErrors.join("; ")}`);
  }

  return recipe;
}

function substituteNode(node: unknown, effective: Record<string, unknown>, knownNames: Set<string>): unknown {
  if (typeof node === "string") {
    return substituteString(node, effective, knownNames);
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteNode(item, effective, knownNames));
  }
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // Interpolate object keys as text (keys are always strings)
      const substitutedKey = substituteStringAsText(key, effective);
      result[substitutedKey] = substituteNode(value, effective, knownNames);
    }
    return result;
  }
  // Primitives (number, boolean, null) pass through unchanged
  return node;
}

/**
 * Substitute a string node:
 * - If the ENTIRE string is exactly `{{NAME}}` where NAME is a known param →
 *   replace with the typed value (real number / boolean / string).
 * - Otherwise, replace each `{{NAME}}` occurrence (NAME a known param) with
 *   String(value) (text interpolation; the node stays a string).
 * - Unknown `{{...}}` tokens are left untouched.
 */
function substituteString(str: string, effective: Record<string, unknown>, knownNames: Set<string>): unknown {
  // Whole-value typed substitution: exactly "{{NAME}}"
  const wholeMatch = /^\{\{(\w+)\}\}$/.exec(str);
  if (wholeMatch) {
    const name = wholeMatch[1];
    if (knownNames.has(name) && effective[name] !== undefined) {
      return effective[name];
    }
    // Unknown token or missing value: leave untouched as a string
    return str;
  }

  // Text interpolation: replace each known {{NAME}} with String(value)
  return str.replace(TOKEN_RE, (match, name: string) => {
    if (knownNames.has(name) && effective[name] !== undefined) {
      return String(effective[name]);
    }
    return match; // leave unknown tokens untouched
  });
}

/**
 * Substitute a key string (always text interpolation — keys are always strings).
 */
function substituteStringAsText(str: string, effective: Record<string, unknown>): string {
  return str.replace(TOKEN_RE, (match, name: string) => {
    if (name in effective && effective[name] !== undefined) {
      return String(effective[name]);
    }
    return match;
  });
}

// ─── coerceArgs ───────────────────────────────────────────────────────────────

/**
 * Coerce raw CLI/file args to the declared param types for a given op.
 *
 * - String inputs for `number` params are converted via `Number()` — throws if
 *   the result is NaN.
 * - String inputs for `boolean` params accept only `"true"` / `"false"` —
 *   throws on anything else.
 * - `string` params are left as-is.
 * - Values that are already the correct JS type (e.g. from a parsed JSON file)
 *   are passed through unchanged.
 * - Keys that do NOT match any declared param are passed through unchanged so
 *   that `substituteOp` can reject them as unknown args.
 */
export function coerceArgs(def: OpDefinition, raw: Record<string, unknown>): Record<string, unknown> {
  const paramMap = new Map<string, OpParam>(def.params.map((p) => [p.name, p]));
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const param = paramMap.get(key);
    if (param === undefined) {
      // Unknown param — pass through; substituteOp will reject it.
      result[key] = value;
      continue;
    }

    if (param.type === "number") {
      if (typeof value === "number") {
        result[key] = value;
      } else if (typeof value === "string") {
        const n = Number(value);
        if (Number.isNaN(n)) {
          throw new Error(`param "${key}" expects a number but got "${value}"`);
        }
        result[key] = n;
      } else {
        result[key] = value;
      }
    } else if (param.type === "boolean") {
      if (typeof value === "boolean") {
        result[key] = value;
      } else if (typeof value === "string") {
        if (value === "true") {
          result[key] = true;
        } else if (value === "false") {
          result[key] = false;
        } else {
          throw new Error(`param "${key}" expects a boolean ("true" or "false") but got "${value}"`);
        }
      } else {
        result[key] = value;
      }
    } else {
      // string — keep as-is
      result[key] = value;
    }
  }

  return result;
}

// ─── formatOpsList ─────────────────────────────────────────────────────────────

/**
 * Pure formatter — used by BOTH the CLI `list-ops` command and the MCP `list-ops`
 * tool so their output is byte-identical.
 */
export function formatOpsList(ops: LoadedOp[], errors?: OpLoadError[]): string {
  const lines: string[] = [];

  if (ops.length === 0) {
    lines.push("No ops found.");
  } else {
    for (const op of ops) {
      lines.push(`op: ${op.name}`);
      lines.push(`  ${op.def.description}`);
      if (op.def.params.length > 0) {
        lines.push("  params:");
        for (const param of op.def.params) {
          const qualifier = !param.required
            ? param.default !== undefined
              ? `(default: ${JSON.stringify(param.default)})`
              : "(optional)"
            : "(required)";
          const descSuffix = param.description !== undefined ? ` — ${param.description}` : "";
          lines.push(`    ${param.name} [${param.type}] ${qualifier}${descSuffix}`);
        }
      } else {
        lines.push("  params: none");
      }
    }
  }

  if (errors && errors.length > 0) {
    lines.push("");
    lines.push("load errors:");
    for (const err of errors) {
      lines.push(`  ${err.file}: ${err.message}`);
    }
  }

  return lines.join("\n");
}
