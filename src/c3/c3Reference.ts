import * as fs from "node:fs";
import { z } from "zod";
import { resolveWithin } from "@genvid/mcp-utils";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const AceEntrySchema = z.object({
  source: z.enum(["builtin", "addon", "manual"]),
  objectClass: z.string(),
  kind: z.enum(["action", "condition", "expression"]),
  id: z.string(),
  scriptName: z.string().optional(),
  params: z.array(z.object({ name: z.string(), type: z.string() })),
  description: z.string().optional(),
  canonicalUrl: z.string().optional(),
});

export const ChunkEntrySchema = z.object({
  title: z.string(),
  text: z.string(),
  canonicalUrl: z.string(),
  category: z.enum(["layout", "scripting", "expression", "plugin"]),
});

export const ReferenceIndexSchema = z.object({
  schemaVersion: z.number(),
  manualVersion: z.string(),
  generatedAt: z.string(),
  aces: z.array(AceEntrySchema).optional(),
  chunks: z.array(ChunkEntrySchema).optional(),
});

// ── Types ────────────────────────────────────────────────────────────────────

export type AceEntry = z.infer<typeof AceEntrySchema>;
export type ChunkEntry = z.infer<typeof ChunkEntrySchema>;
export type ReferenceIndex = z.infer<typeof ReferenceIndexSchema>;

// ── Reader ───────────────────────────────────────────────────────────────────

/**
 * Load the c3-reference cache from `<extractedDir>/c3-reference/index.json`.
 * Returns `{ aces, chunks }` (arrays, normalized from optional to `[]`) on
 * success, or `null` if the file is absent, unreadable, or fails validation.
 * Never throws.
 *
 * Invariant: the returned `aces` array never contains `source:"addon"` entries.
 * Addon ACEs are always sourced live from the project's `addons/` directory
 * (via `buildAddonAceRegistry`), so any cached addon entry is ignored and
 * filtered out here at the reader boundary.
 */
export function loadReferenceCache(extractedDir: string): { aces: AceEntry[]; chunks: ChunkEntry[] } | null {
  try {
    const cachePath = resolveWithin(extractedDir, "c3-reference/index.json");
    if (cachePath === null) return null;
    if (!fs.existsSync(cachePath)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    } catch {
      return null;
    }

    const result = ReferenceIndexSchema.safeParse(parsed);
    if (!result.success) return null;

    return {
      aces: (result.data.aces ?? []).filter((a) => a.source !== "addon"),
      chunks: result.data.chunks ?? [],
    };
  } catch {
    return null;
  }
}
