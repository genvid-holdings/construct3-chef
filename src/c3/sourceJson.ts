import { writeFileSync } from "node:fs";

/**
 * Writes a C3 **source** JSON file (`eventSheets/`, `layouts/`,
 * `objectTypes/`) in the project's canonical on-disk form: tab-indented,
 * with no trailing newline. Every file in the canonical fixture
 * (`test/fixtures/construct3-sample/project`) ends at its closing `}`/`]` —
 * this helper encodes that ground truth so no call site has to.
 *
 * Not for `project.c3proj` — that manifest is written separately via
 * c3source's `writeProjectManifest`/`serializeProjectManifest`, which
 * already emits no trailing newline in its own, different way.
 *
 * Deliberately synchronous: call sites in `src/mcp/server.ts` write inside
 * a `watcher.suppress(async () => { … })` window and rely on the write
 * completing before that window closes.
 *
 * Off-barrel deliberately: not re-exported from `src/index.ts` (repo is at
 * 1.0.0, and a barrel export is a permanent public-API commitment). This is
 * an internal write helper, not published API — see `src/c3/addonValidator.ts`
 * / `src/c3/editorLocal.ts` for the same pattern.
 */
export function writeSourceJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, "\t"));
}
