import { readFileSync } from "node:fs";
import { type Layout, find_all_layouts_path, visitLayers } from "@genvid/c3source";

export function findTemplates(layoutsDir: string): Array<{ layout: string; type: string }> {
  const layoutPaths = find_all_layouts_path(layoutsDir);
  const results: Array<{ layout: string; type: string }> = [];

  for (const layoutPath of layoutPaths) {
    const content = readFileSync(layoutPath, "utf-8");
    const layout: Layout = JSON.parse(content);
    // visitLayers walks every layer (recursively through subLayers); the
    // LayerVisitor's numeric return is the mutation-count contract, unused here.
    visitLayers(layout.layers, (layer) => {
      for (const inst of layer.instances ?? []) {
        const template = (inst as Record<string, unknown>).template as { mode?: string } | undefined;
        if (template?.mode === "template") {
          results.push({ layout: layout.name, type: inst.type });
        }
      }
      return 0;
    });
  }

  results.sort((a, b) => {
    const layoutCmp = a.layout.localeCompare(b.layout);
    if (layoutCmp !== 0) return layoutCmp;
    return a.type.localeCompare(b.type);
  });

  return results;
}
