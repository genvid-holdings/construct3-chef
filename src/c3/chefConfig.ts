import { z, type ZodType } from "zod";
import { loadProjectConfig, isMcpError } from "@genvid/mcp-utils";

export const ChefConfigSchema = z.object({
  extractedDir: z.string().default("extracted"),
  navigation: z
    .object({
      targetPatterns: z.string().array().optional(),
      definitionMarkers: z.string().array().optional(),
    })
    .optional(),
});
export type ChefConfig = z.infer<typeof ChefConfigSchema>;

const CONFIG_FILE = "construct3-chef.config.json";

/**
 * Load construct3-chef.config.json from projectRoot. Missing file => defaults.
 * Malformed / invalid / path-escaping config falls back to a safe default
 * (errors-as-values; never throws). `overrides` win over the file.
 */
export async function loadChefConfig(projectRoot: string, overrides?: Partial<ChefConfig>): Promise<ChefConfig> {
  const result = await loadProjectConfig<ChefConfig>(
    projectRoot,
    CONFIG_FILE,
    ChefConfigSchema as ZodType<ChefConfig>,
    overrides,
    { containedPaths: ["extractedDir"], optional: true },
  );
  if (isMcpError(result)) {
    // File-driven error (malformed JSON / schema violation / containment
    // escape) -> safe default. Honor a string override, else fall back to
    // the schema default. Kept branch-local so this never throws.
    const override = overrides?.extractedDir;
    const navOverride = overrides?.navigation;
    return {
      extractedDir: typeof override === "string" ? override : "extracted",
      ...(navOverride !== undefined ? { navigation: navOverride } : {}),
    };
  }
  return result;
}
