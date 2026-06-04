import { z, type ZodType } from "zod";
import { loadProjectConfig, isMcpError } from "@genvid/mcp-utils";

export const ChefConfigSchema = z.object({
  extractedDir: z.string().default("extracted"),
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
    // malformed JSON / validation / containment escape -> safe default
    return ChefConfigSchema.parse({ ...(overrides ?? {}) });
  }
  return result;
}
