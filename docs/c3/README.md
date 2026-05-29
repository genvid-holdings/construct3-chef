# C3 Platform Reference

Background reference on **Construct 3 itself** — the on-disk JSON formats and runtime semantics that construct3-chef reads, mutates, and extracts. This is distinct from the tool-usage docs one level up (`../recipe-reference.md`, `../generators.md`, `../cli.md`), which document construct3-chef's own commands and recipe format.

These notes were adapted from a production C3 project; project-specific (game) content has been removed, leaving the platform mechanics that apply to any Construct 3 project. Example object, layer, and function names in code samples are illustrative only.

| Doc | Covers |
| --- | ------ |
| [event-sheet-architecture.md](event-sheet-architecture.md) | Event sheet JSON structure (`events`/`children`, blocks, the five event types, the five action shapes), include composition and trigger ordering, and the expression-vs-enum parameter rule that drives many recipe gotchas |
| [layout-reference.md](layout-reference.md) | Layout/layer JSON structure, layer render order, the template/replica system and `"o"` per-instance overrides, global layers and override mechanics, the `subLayers` casing gotcha, and UID/SID uniqueness constraints |
| [scripting-reference.md](scripting-reference.md) | Construct 3 scripting API quick reference — `IRuntime`, object/layout interfaces, system expressions and iteration conditions, with links to the official manual |
| [typescript-integration.md](typescript-integration.md) | C3 TypeScript scripting: runtime object access, the block concurrency / async-script model, `wait-for-previous-actions`, `functionIsAsync`, function return-type call conventions, local-variable scoping, and JSON-plugin iteration |

## Why this lives here

construct3-chef operates directly on C3 project JSON. Understanding *why* the tool behaves as it does — why SIDs matter, why string-expression parameters need escaped quotes, why script actions race within a block — requires knowing the platform. These docs are that knowledge base; the recipe gotchas and bugs catalogued in [recipe-reference.md](../recipe-reference.md) are downstream consequences of the mechanics described here. For the tool's own architecture and design rationale, see [mcp-architecture.md](../mcp-architecture.md).
