import { readFileSync } from "node:fs";
import { type Layer, type Layout, find_all_layouts_path } from "@genvid/c3source";

function getSubLayers(layer: Layer): Layer[] {
  const raw = (layer as Record<string, unknown>).subLayers;
  return Array.isArray(raw) ? (raw as Layer[]) : [];
}

function collectTemplatesFromLayers(
  layers: Layer[],
  results: Array<{ layout: string; type: string }>,
  layoutName: string,
): void {
  for (const layer of layers) {
    const instances = layer.instances ?? [];
    for (const inst of instances) {
      const template = (inst as Record<string, unknown>).template as
        | { mode?: string }
        | undefined;
      if (template?.mode === "template") {
        results.push({ layout: layoutName, type: inst.type });
      }
    }
    const subLayers = getSubLayers(layer);
    if (subLayers.length > 0) {
      collectTemplatesFromLayers(subLayers, results, layoutName);
    }
  }
}

export function findTemplates(layoutsDir: string): Array<{ layout: string; type: string }> {
  const layoutPaths = find_all_layouts_path(layoutsDir);
  const results: Array<{ layout: string; type: string }> = [];

  for (const layoutPath of layoutPaths) {
    const content = readFileSync(layoutPath, "utf-8");
    const layout: Layout = JSON.parse(content);
    collectTemplatesFromLayers(layout.layers, results, layout.name);
  }

  results.sort((a, b) => {
    const layoutCmp = a.layout.localeCompare(b.layout);
    if (layoutCmp !== 0) return layoutCmp;
    return a.type.localeCompare(b.type);
  });

  return results;
}
