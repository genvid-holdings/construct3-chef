import { describe, it } from "mocha";
import { assert } from "chai";
import { formatLayout, buildGlobalLayerMap, formatContainersFile } from "../../src/c3/layoutFormatter.js";
import type { Layout, Layer, Instance } from "@genvid/c3source";

let nextUid = 1;

/** Helper to create a minimal instance. */
function inst(
  type: string,
  vars?: Record<string, unknown>,
  opts?: {
    templateName?: string;
    templateMode?: "template" | "replica";
    sourceTemplateName?: string;
    tags?: string;
    uid?: number;
    sceneGraphData?: {
      "parent-uid": number | null;
      uid?: number;
      children?: Array<{ uid: number; flags?: Record<string, unknown> }>;
      flags?: Record<string, unknown>;
    };
  },
): Instance {
  const uid = opts?.uid ?? nextUid++;
  const mode = opts?.templateMode ?? "template";
  return {
    type,
    properties: {},
    uid,
    instanceVariables: vars,
    ...(opts?.tags != null ? { tags: opts.tags } : { tags: "" }),
    ...(opts?.templateName || opts?.templateMode === "replica"
      ? {
          template: {
            mode,
            templateName: opts?.templateName ?? "",
            sourceTemplateName: opts?.sourceTemplateName ?? "",
          },
        }
      : {}),
    ...(opts?.sceneGraphData
      ? { sceneGraphData: { ...opts.sceneGraphData, uid: opts.sceneGraphData.uid ?? uid } }
      : {}),
  } as Instance;
}

/** Helper to create a layer. */
function layer(
  name: string,
  instances: Instance[] = [],
  opts?: { global?: boolean; overriden?: 0 | 1; subLayers?: Layer[] },
): Layer {
  return {
    name,
    instances,
    global: opts?.global,
    overriden: opts?.overriden ?? 0,
    subLayers: opts?.subLayers ?? [],
  } as unknown as Layer;
}

/** Helper to create a layout. */
function layout(
  name: string,
  layers: Layer[],
  opts?: { eventSheet?: string; width?: number; height?: number },
): Layout {
  return {
    name,
    layers,
    ...(opts?.eventSheet ? { eventSheet: opts.eventSheet } : {}),
    ...(opts?.width != null ? { width: opts.width } : {}),
    ...(opts?.height != null ? { height: opts.height } : {}),
  } as Layout;
}

const emptyMap = new Map<string, string>();

describe("layoutFormatter", () => {
  describe("formatLayout", () => {
    it("should output header with name, source, eventSheet, and size", () => {
      const l = layout("TestLayout", [], {
        eventSheet: "TestEvents",
        width: 1080,
        height: 1920,
      });
      const result = formatLayout(l, "C:/project/layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "# TestLayout");
      assert.include(result, "# Source: layouts/TestLayout.json");
      assert.include(result, "# EventSheet: TestEvents");
      assert.include(result, "# Size: 1080 x 1920");
    });

    it("should omit eventSheet when not present", () => {
      const l = layout("TestLayout", [], { width: 100, height: 200 });
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.notInclude(result, "EventSheet");
    });

    it("should show normal layer with instances grouped by type and count", () => {
      const l = layout("TestLayout", [layer("Main", [inst("Sprite"), inst("Sprite"), inst("Text")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Main (3 instances)");
      assert.include(result, "  Sprite x2");
      assert.include(result, "  Text x1");
    });

    it("should show instance variable keys in brackets", () => {
      const l = layout("TestLayout", [layer("Main", [inst("Enemy", { EnemyType: "goblin", Health: 100 })])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Enemy x1 [EnemyType, Health]");
    });

    it("should show no brackets for empty instanceVariables {}", () => {
      const l = layout("TestLayout", [layer("Main", [inst("Sprite", {})])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Sprite x1");
      assert.notInclude(result, "[");
    });

    it("should show tags with # prefix", () => {
      const l = layout("TestLayout", [layer("Main", [inst("Enemy", undefined, { tags: "boss,flying" })])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Enemy x1 #boss #flying");
    });

    it("should merge tags from multiple instances of same type", () => {
      const l = layout("TestLayout", [
        layer("Main", [inst("Enemy", undefined, { tags: "boss" }), inst("Enemy", undefined, { tags: "flying" })]),
      ]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Enemy x2 #boss #flying");
    });

    it("should show global layer with content and (global) annotation", () => {
      const l = layout("TestLayout", [layer("HUD", [inst("PauseButton")], { global: true })]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "HUD (global, 1 instance)");
      assert.include(result, "  PauseButton x1");
    });

    it("should show overriden layer with reference and no content", () => {
      const globalMap = new Map([["HUD", "Level3Layout"]]);
      const l = layout("TestLayout", [layer("HUD", [], { global: true, overriden: 1 })]);
      const result = formatLayout(l, "layouts/TestLayout.json", globalMap, false);
      assert.include(result, "HUD (overriden) [\u2192 Level3Layout]");
      assert.notInclude(result, "PauseButton");
    });

    it("should show [→ ?] for unresolved overriden layer", () => {
      const l = layout("TestLayout", [layer("UnknownLayer", [], { global: true, overriden: 1 })]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "UnknownLayer (overriden) [\u2192 ?]");
    });

    it("should not recurse into sublayers of overriden layers", () => {
      const globalMap = new Map([["Pause Modal", "Level3Layout"]]);
      const l = layout("TestLayout", [
        layer("Pause Modal", [], {
          global: true,
          overriden: 1,
          subLayers: [layer("Pause Modal Base", [], { overriden: 1 })],
        }),
      ]);
      const result = formatLayout(l, "layouts/TestLayout.json", globalMap, false);
      assert.include(result, "Pause Modal (overriden)");
      assert.notInclude(result, "Pause Modal Base");
    });

    it("should format sublayers with Parent > Child naming", () => {
      const l = layout("TestLayout", [
        layer("HUD", [inst("Score")], {
          global: true,
          subLayers: [
            layer("HUD Buttons", [inst("PauseButton"), inst("SkillButton")], {
              global: true,
            }),
          ],
        }),
      ]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "HUD (global, 1 instance)");
      assert.include(result, "  HUD > HUD Buttons (global, 2 instances)");
      assert.include(result, "    PauseButton x1");
    });

    it("should show multiple instances of same type as TypeName xN", () => {
      const l = layout("TestLayout", [layer("Main", [inst("Collider"), inst("Collider"), inst("Collider")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Collider x3");
    });

    it("should show layer with zero instances (header only)", () => {
      const l = layout("TestLayout", [layer("EmptyLayer")]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "EmptyLayer");
      assert.notInclude(result, "instance");
    });

    it("should show template instance in regular layout with (template: name)", () => {
      const l = layout("TestLayout", [
        layer("Main", [inst("TiledBackground", { BossArenaEdge: "" }, { templateName: "level1MapTemplate" })]),
      ]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "TiledBackground x1 [BossArenaEdge] (template: level1MapTemplate)");
    });

    it("should use ## Templates header for TemplateHolder layouts", () => {
      const l = layout("GameComponentTemplatesLayout", [
        layer("Layer 0", [inst("HedgeGreen", { Health: 100 }, { templateName: "default" })]),
      ]);
      const result = formatLayout(l, "layouts/TemplateHolders/GameComponentTemplatesLayout.json", emptyMap, true);
      assert.include(result, "## Templates");
      assert.notInclude(result, "## Layers");
    });

    it("should show TemplateHolder instances with templateName as primary identifier", () => {
      const l = layout("GameComponentTemplatesLayout", [
        layer("Layer 0", [
          inst("Obstacle", { Health: 100 }, { templateName: "default" }),
          inst("Obstacle", { Health: 100 }, { templateName: "default" }),
          inst("Obstacle", {}, { templateName: "special" }),
        ]),
      ]);
      const result = formatLayout(l, "layouts/TemplateHolders/Test.json", emptyMap, true);
      assert.include(result, 'Obstacle "default" x2 [Health]');
      assert.include(result, 'Obstacle "special" x1');
    });

    it("should merge instanceVariable keys when grouping instances", () => {
      const l = layout("TestLayout", [
        layer("Main", [inst("Enemy", { EnemyType: "goblin" }), inst("Enemy", { EnemyType: "orc", SpawnDelay: 5 })]),
      ]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Enemy x2 [EnemyType, SpawnDelay]");
    });

    it("should produce full layout with mixed layer types", () => {
      const globalMap = new Map([["LoadingScreen", "Level3Layout"]]);
      const l = layout(
        "Level1Layout",
        [
          layer("Layer 0", [inst("TiledBackground", { BossArenaEdge: "" }, { templateName: "level1MapTemplate" })]),
          layer("HUD", [inst("Score")], {
            global: true,
            subLayers: [layer("HUD Buttons", [inst("PauseButton")], { global: true })],
          }),
          layer("LoadingScreen", [], { global: true, overriden: 1 }),
        ],
        { eventSheet: "UserCharacterEvents", width: 8192, height: 8192 },
      );
      const result = formatLayout(l, "layouts/Levels/Level1Layout.json", globalMap, false);
      assert.include(result, "# Level1Layout");
      assert.include(result, "# EventSheet: UserCharacterEvents");
      assert.include(result, "## Layers (3)");
      assert.include(result, "Layer 0 (1 instance)");
      assert.include(result, "(template: level1MapTemplate)");
      assert.include(result, "HUD (global, 1 instance)");
      assert.include(result, "HUD > HUD Buttons (global, 1 instance)");
      assert.include(result, "LoadingScreen (overriden) [\u2192 Level3Layout]");
    });

    // --- Hierarchy tests ---

    it("should nest child under parent with └─ and exclude child from flat list", () => {
      const parent = inst("UI_SecondaryButton", undefined, {
        uid: 100,
        sceneGraphData: {
          "parent-uid": null,
          children: [{ uid: 200, flags: { x: true, y: true } }],
        },
      });
      const child = inst("UI_SecondaryButtonText", undefined, {
        uid: 200,
        sceneGraphData: { "parent-uid": 100 },
      });
      const l = layout("TestLayout", [layer("Buttons", [parent, child])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "Buttons (2 instances)");
      assert.include(result, "  UI_SecondaryButton x1");
      assert.include(result, "    └─ UI_SecondaryButtonText");
      // Child should NOT appear as a separate flat entry
      assert.notInclude(result, "  UI_SecondaryButtonText x");
    });

    it("should nest multiple children under parent", () => {
      const parent = inst("EnemyCharacter", undefined, {
        uid: 300,
        sceneGraphData: {
          "parent-uid": null,
          children: [
            { uid: 301, flags: { x: true } },
            { uid: 302, flags: { x: true } },
          ],
        },
      });
      const child1 = inst("EnemyShadow", undefined, {
        uid: 301,
        sceneGraphData: { "parent-uid": 300 },
      });
      const child2 = inst("EnemyHealthBar", undefined, {
        uid: 302,
        sceneGraphData: { "parent-uid": 300 },
      });
      const l = layout("TestLayout", [layer("Battle", [parent, child1, child2])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "  EnemyCharacter x1");
      assert.include(result, "    └─ EnemyShadow");
      assert.include(result, "    └─ EnemyHealthBar");
    });

    it("should handle multi-level hierarchy (parent → child → grandchild)", () => {
      const parent = inst("EnemyCharacter", undefined, {
        uid: 400,
        sceneGraphData: {
          "parent-uid": null,
          children: [{ uid: 401 }],
        },
      });
      const child = inst("EnemyHealthBar", undefined, {
        uid: 401,
        sceneGraphData: {
          "parent-uid": 400,
          children: [{ uid: 402 }],
        },
      });
      const grandchild = inst("EnemyHealthBarFill", undefined, {
        uid: 402,
        sceneGraphData: { "parent-uid": 401 },
      });
      const l = layout("TestLayout", [layer("Battle", [parent, child, grandchild])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "  EnemyCharacter x1");
      assert.include(result, "    └─ EnemyHealthBar");
      assert.include(result, "      └─ EnemyHealthBarFill");
    });

    it("should deduplicate identical subtrees for same-type parents", () => {
      const parents: Instance[] = [];
      const children: Instance[] = [];
      for (let i = 0; i < 4; i++) {
        const pUid = 500 + i * 2;
        const cUid = 501 + i * 2;
        parents.push(
          inst("UI_PrimaryButton", undefined, {
            uid: pUid,
            sceneGraphData: {
              "parent-uid": null,
              children: [{ uid: cUid }],
            },
          }),
        );
        children.push(
          inst("UI_PrimaryButtonText", undefined, {
            uid: cUid,
            sceneGraphData: { "parent-uid": pUid },
          }),
        );
      }
      const l = layout("TestLayout", [layer("Buttons", [...parents, ...children])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "  UI_PrimaryButton x4");
      assert.include(result, "    └─ UI_PrimaryButtonText");
      // Should NOT list UI_PrimaryButtonText separately
      assert.notInclude(result, "  UI_PrimaryButtonText x");
    });

    it("should leave output unchanged when no hierarchy data present", () => {
      const l = layout("TestLayout", [layer("Main", [inst("Sprite"), inst("Text")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "  Sprite x1");
      assert.include(result, "  Text x1");
      assert.notInclude(result, "└─");
    });

    it("should not nest standalone sceneGraphData (parent-uid null, no children)", () => {
      const standalone = inst("Sprite", undefined, {
        uid: 600,
        sceneGraphData: { "parent-uid": null },
      });
      const l = layout("TestLayout", [layer("Main", [standalone, inst("Text")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "  Sprite x1");
      assert.include(result, "  Text x1");
      assert.notInclude(result, "└─");
    });

    it("should handle cross-layer hierarchy (child on different layer appears under parent)", () => {
      const parent = inst("UI_SecondaryButton", undefined, {
        uid: 700,
        sceneGraphData: {
          "parent-uid": null,
          children: [{ uid: 701 }],
        },
      });
      const child = inst("UI_SecondaryButtonText", undefined, {
        uid: 701,
        sceneGraphData: { "parent-uid": 700 },
      });
      const l = layout("TestLayout", [layer("Buttons", [parent]), layer("Text", [child])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      // Child appears under parent on parent's layer
      assert.include(result, "  UI_SecondaryButton x1");
      assert.include(result, "    └─ UI_SecondaryButtonText");
      // Text layer should NOT show the child (it was moved to parent's layer)
      const textLayerMatch = result.match(/Text \(.*?\)\n([\s\S]*?)(?=\n\n|\n$)/);
      if (textLayerMatch) {
        assert.notInclude(textLayerMatch[1], "UI_SecondaryButtonText");
      }
    });

    it("should show non-world instances in a separate section after layers", () => {
      const l = {
        ...layout("TestLayout", [layer("Main", [inst("Sprite")])]),
        "nonworld-instances": [inst("TitleData", {}), inst("LevelData", { ParsingKey: "" })],
      } as Layout;
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.include(result, "## Non-world Instances (2)");
      assert.include(result, "  TitleData x1");
      assert.include(result, "  LevelData x1 [ParsingKey]");
      // Section should appear after the Layers section
      const layersIdx = result.indexOf("## Layers");
      const nwIdx = result.indexOf("## Non-world Instances");
      assert.isAbove(nwIdx, layersIdx);
    });

    it("should omit non-world section when layout has no nonworld-instances", () => {
      const l = layout("TestLayout", [layer("Main", [inst("Sprite")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.notInclude(result, "Non-world");
    });

    it("should skip hierarchy for template replicas (mode: replica)", () => {
      const parent = inst("UI_SecondaryButton", undefined, {
        uid: 800,
        templateMode: "replica",
        sourceTemplateName: "myTemplate",
        sceneGraphData: {
          "parent-uid": null,
          children: [{ uid: 801 }],
        },
      });
      const child = inst("UI_SecondaryButtonText", undefined, {
        uid: 801,
        templateMode: "replica",
        sourceTemplateName: "myTemplate",
        sceneGraphData: { "parent-uid": 800 },
      });
      const l = layout("TestLayout", [layer("Buttons", [parent, child])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      // Replicas should NOT show hierarchy nesting
      assert.notInclude(result, "└─");
    });

    it("should show full hierarchy for template definitions in TemplateHolder layouts", () => {
      const parent = inst("UI_SecondaryButton", undefined, {
        uid: 900,
        templateName: "myTemplate",
        sceneGraphData: {
          "parent-uid": null,
          children: [{ uid: 901 }],
        },
      });
      const child = inst("UI_SecondaryButtonText", undefined, {
        uid: 901,
        templateName: "myTemplate",
        sceneGraphData: { "parent-uid": 900 },
      });
      const l = layout("TemplateLayout", [layer("Templates", [parent, child])]);
      // isTemplateHolder = true, and path includes TemplateHolders/
      const result = formatLayout(l, "layouts/TemplateHolders/TemplateLayout.json", emptyMap, true);
      // TemplateHolder should show hierarchy for template definitions
      assert.include(result, "└─ UI_SecondaryButtonText");
    });
  });

  // --- Container tests ---

  describe("container annotations", () => {
    const playerGroup = ["UserCharacter", "shield", "HeroInvincibility", "XPSpriteCollision"];

    function containerMap(...groups: string[][]): Map<string, string[]> {
      const map = new Map<string, string[]>();
      for (const group of groups) {
        for (const member of group) {
          map.set(member, group);
        }
      }
      return map;
    }

    it("should show container group with presence markers", () => {
      const cMap = containerMap(playerGroup);
      const l = layout("TestLayout", [layer("Main", [inst("UserCharacter"), inst("shield"), inst("EnemyCharacter")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false, cMap);
      // UserCharacter and shield are in layout, others are not (~prefix)
      assert.include(result, "(container: {UserCharacter, shield, ~HeroInvincibility, ~XPSpriteCollision})");
      assert.notInclude(result, "EnemyCharacter x1 (container");
      assert.include(result, "EnemyCharacter x1");
    });

    it("should not show container when containerMap is not provided", () => {
      const l = layout("TestLayout", [layer("Main", [inst("UserCharacter")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false);
      assert.notInclude(result, "(container");
    });

    it("should combine container annotation with other annotations", () => {
      const enemyGroup = ["Enemy", "EnemyShadow"];
      const cMap = containerMap(enemyGroup);
      const l = layout("TestLayout", [layer("Main", [inst("Enemy", { EnemyType: "goblin" }, { tags: "boss" })])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false, cMap);
      assert.include(result, "Enemy x1 [EnemyType] #boss (container: {Enemy, ~EnemyShadow})");
    });

    it("should mark all members present when all are in layout", () => {
      const smallGroup = ["ButtonA", "ButtonB"];
      const cMap = containerMap(smallGroup);
      const l = layout("TestLayout", [layer("Main", [inst("ButtonA"), inst("ButtonB")])]);
      const result = formatLayout(l, "layouts/TestLayout.json", emptyMap, false, cMap);
      // All present — no ~ prefix on any member
      assert.include(result, "(container: {ButtonA, ButtonB})");
    });
  });

  describe("formatContainersFile", () => {
    it("should format container groups with header", () => {
      const groups = [
        ["EquipLevelUpButton", "EquipLevelUpText"],
        ["UserCharacter", "shield", "HeroInvincibility"],
      ];
      const result = formatContainersFile(groups);
      assert.include(result, "# C3 Containers");
      assert.include(result, "# Source: project.c3proj");
      assert.include(result, "# All members of a container are created together at runtime.");
      assert.include(result, "{EquipLevelUpButton, EquipLevelUpText}");
      assert.include(result, "{UserCharacter, shield, HeroInvincibility}");
    });

    it("should produce minimal output for empty containers array", () => {
      const result = formatContainersFile([]);
      assert.include(result, "# C3 Containers");
      assert.notInclude(result, "{");
    });
  });

  describe("buildGlobalLayerMap", () => {
    it("should map global layer names to source layout names", () => {
      const layouts = [
        {
          layout: layout("Level1Layout", [
            layer("HUD", [inst("Score")], { global: true }),
            layer("LoadingScreen", [inst("Spinner")], { global: true }),
          ]),
        },
        {
          layout: layout("Level2Layout", [
            layer("HUD", [], { global: true, overriden: 1 }),
            layer("LoadingScreen", [], { global: true, overriden: 1 }),
          ]),
        },
      ];
      const map = buildGlobalLayerMap(layouts);
      assert.equal(map.get("HUD"), "Level1Layout");
      assert.equal(map.get("LoadingScreen"), "Level1Layout");
      assert.equal(map.size, 2);
    });

    it("should not include overriden layers as sources", () => {
      const layouts = [
        {
          layout: layout("Layout1", [layer("HUD", [], { global: true, overriden: 1 })]),
        },
      ];
      const map = buildGlobalLayerMap(layouts);
      assert.equal(map.size, 0);
    });

    it("should not include layers without instances as sources", () => {
      const layouts = [
        {
          layout: layout("Layout1", [layer("EmptyGlobal", [], { global: true })]),
        },
      ];
      const map = buildGlobalLayerMap(layouts);
      assert.equal(map.size, 0);
    });
  });
});
