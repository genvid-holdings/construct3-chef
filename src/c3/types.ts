import type { Logger } from "@genvid/mcp-utils";

export interface ApplyOptions {
  dryRun?: boolean;
  preview?: boolean;
  regenerate?: boolean;
  log?: Logger;
}
