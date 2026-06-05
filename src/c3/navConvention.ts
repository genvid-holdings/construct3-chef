import type { ChefConfig } from "./chefConfig.js";

export interface NavConvention {
  targetRegexes: RegExp[];
  isDefinitionLine(line: string): boolean;
}

// Built-in C3 navigation, as rendered into the DSL by c3source formatAction:
//   System.go-to-layout(layout=<LayoutName>)
//   System.go-to-layout-by-name(layout="<expr>")
// See test/fixtures/construct3-chef-sample/extracted/eventSheets/Event sheet {1,2}.dsl.txt
const SYSTEM_GO_TO_LAYOUT = /System\.go-to-layout\(layout=([^,)]+)/;
const SYSTEM_GO_TO_LAYOUT_BY_NAME = /System\.go-to-layout-by-name\(layout="([^"]+)"/;

/**
 * Returns the default navigation convention: System action regexes for
 * go-to-layout and go-to-layout-by-name, with no definition-line markers.
 */
export function defaultNavConvention(): NavConvention {
  return {
    targetRegexes: [SYSTEM_GO_TO_LAYOUT, SYSTEM_GO_TO_LAYOUT_BY_NAME],
    isDefinitionLine: () => false,
  };
}

/**
 * Resolve the active NavConvention from a loaded ChefConfig.
 *
 * - If `config.navigation.targetPatterns` is a non-empty array, each string is
 *   compiled as a RegExp. Bad patterns are dropped with a console.warn (never
 *   throws). If all patterns are bad, falls back to defaultNavConvention().
 * - Otherwise uses defaultNavConvention().
 * - `isDefinitionLine` checks whether any of `config.navigation.definitionMarkers`
 *   appears in the line (default: no markers → always false).
 */
export function resolveNavConvention(config: ChefConfig): NavConvention {
  const nav = config.navigation;
  const markers = nav?.definitionMarkers ?? [];

  const isDefinitionLine = (line: string): boolean => markers.some((m) => line.includes(m));

  const rawPatterns = nav?.targetPatterns;
  if (rawPatterns && rawPatterns.length > 0) {
    const compiled: RegExp[] = [];
    for (const src of rawPatterns) {
      try {
        compiled.push(new RegExp(src));
      } catch {
        console.warn(`[navConvention] Dropping invalid targetPattern (bad regex): ${src}`);
      }
    }
    const targetRegexes = compiled.length > 0 ? compiled : defaultNavConvention().targetRegexes;
    return { targetRegexes, isDefinitionLine };
  }

  return { targetRegexes: defaultNavConvention().targetRegexes, isDefinitionLine };
}
