# Plan: adopt c3source 1.1.0 in `includeTree.ts` + fix CLI `--version` (#51)

**Branch:** `adopt-c3source-1.1` (base: `main` @ 866adfc — c3source 1.0.0 adoption)

## Scope

Two independent threads, batched because both are small and one is the c3source bump the user flagged:

1. **c3source 1.1.0 adoption** — bump `^1.0.0 → ^1.1.0` and consume the two new primitives in `src/c3/includeTree.ts` (the only sensible consumer; used solely by the MCP `include-tree` tool):
   - **`extractIncludes(sheet)`** — replaces the resolver's **top-level-only** include walk (`for (const event of sheet.events) if "include"`). Fixes a latent gap: includes nested inside groups are currently **silently missed**. Also dedups traversal into c3source (adoption posture: push discovery/traversal upstream).
   - **enriched `extractFunctions` / `ExtractedFunction`** — now carries `params` + `returnType`. Render the include-tree function listing **with signatures** (`foo(x: number) -> none`) instead of bare names — the actual capability 1.1.0 unlocks.
2. **#51** — `construct3-chef --version` prints `unknown`; wire yargs `.version()` to `package.json`.

**Out of scope:** the #51 mention of `@genvid/c3-domain-manager` (different repo); image-drift #52 follow-ups; any signature-enrichment of the DSL/index generators (golden-affecting, separate decision).

## Constraints / facts established

- `includeTree.ts` **is in the public barrel** (`src/index.ts:9 export * from "./c3/includeTree.js"`). Keep the public signatures of `extractFunctions(events)` and `resolveIncludeTree(...)` **unchanged** to avoid a type-level semver break. The *content* of the emitted strings changes (cosmetic), which is not a type break.
- Local `extractFunctions` **name-collides** with upstream's → import upstream **aliased** (`extractFunctions as extractFunctionsUpstream`). Upstream takes a `sheet`; the local public fn takes `events` — wrap `{ events } as EventSheet` internally to delegate.
- No test asserts the top-level-only include limitation; the golden fixture has **no nested includes**; `resolveIncludeTree` is an MCP tool, **not** a generator → **golden test won't churn**.
- `formatFunctionParams` in `dslFormatter.ts` is module-private; exporting it would widen the public barrel, so include-tree renders its **own compact inline** `name: type` signature (the include-tree surface already differs from the DSL).
- #51 path: `new URL("../package.json", import.meta.url)` resolves correctly from **both** `dist/cli.js` (→ `dist/../package.json`) and `src/cli.ts` under tsx (→ `src/../package.json`).

## Tasks (one commit each; MMMSS)

### Prep
- Commit `plan.md`: `chore: plan c3source 1.1.0 adoption + CLI --version fix`

### Task 1 — fix CLI `--version` (#51) *(independent; do first)*
- `src/cli.ts`: read `version` from `package.json` via `JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"))` and add `.version(version)` to the yargs chain (near `.help()` at line ~373).
- **Verify:** `npx tsx src/cli.ts --version` → real semver; `npm run build && node dist/cli.js --version` → same.
- Commit: `fix: wire CLI --version to package.json version (#51)`

### Task 2 — bump c3source to ^1.1.0
- `package.json`: `@genvid/c3source` `^1.0.0 → ^1.1.0`; run `npm install` to refresh `package-lock.json`.
- **Verify:** `npm run typecheck` + `npm test` green (no consumer of the changed upstream `extractFunctions` yet, so no break expected).
- Commit: `chore: bump @genvid/c3source to ^1.1.0`

### Task 3 — adopt `extractIncludes` (fixes nested-include gap)
- `includeTree.ts`: import `extractIncludes` from `@genvid/c3source`; in `resolve()`, replace the top-level `for (const event of sheet.events) if "include"` loop with iteration over `extractIncludes(sheet)` (use `ref.includeSheet`).
- **Test:** add an `includeTree.test.ts` case — an `include` nested inside a `group` is discovered (currently would fail).
- **Verify:** `npm test -- test/c3/includeTree.test.ts`.
- Commit: `refactor: route include discovery through c3source extractIncludes`

### Task 4 — enrich include-tree function listing with signatures
- `includeTree.ts`: import `extractFunctions as extractFunctionsUpstream` (+ `FunctionParameter`/`ExtractedFunction` types) from c3source. Reimplement the local `extractFunctions(events)` to delegate to upstream (`extractFunctionsUpstream({ events } as EventSheet)`) and render each entry as a signature string:
  - function: `name(p1: type, …) -> returnType`
  - custom-ace: `ObjectClass.AceName(…) -> returnType`
  - compact inline param renderer (`name: type`), empty-param → `()`.
- Update `includeTree.test.ts` `extractFunctions` assertions (now signatures, not bare names); keep the "walks into groups" coverage.
- **Verify:** `npm test -- test/c3/includeTree.test.ts`.
- Commit: `feat: enrich include-tree function listing with signatures via c3source 1.1.0`

### Task 5 — docs + memory
- `CLAUDE.md`: bump the leaf-deps c3source version note (`^1.0.0 → ^1.1.0`); add a one-line adoption-posture note (extractIncludes + enriched extractFunctions adopted in includeTree; nested-include gap closed).
- Memory: update `public-genvid-packages.md` (c3source 1.1.0) and the c3source-adoption memory with what 1.1.0 delivered/adopted.
- Commit: `docs: note c3source 1.1.0 adoption (extractIncludes + enriched functions)`

## Verification gate (end)
- `npm run lint` (max-warnings 0), `npm run typecheck`, `npm test` all green.
- `npx tsx src/cli.ts --version` prints real semver.
- Spot-check the `include-tree` MCP tool output shows signatures + (manually) a nested include.
- `genvid-dev:code-reviewer` pass; offer `tech-writer` if doc gaps flagged.

## Risks
- **Public-API content change** (include-tree function strings now carry signatures) — not a type break; note in the Task 4 commit body.
- **Name collision** with upstream `extractFunctions` — handled via import alias.
- **`extractIncludes` ordering/dedup** — upstream returns canonical event order; the existing `visited`-set dedup in `resolve()` is unchanged, so diamond/cyclic handling is preserved.

## PR
- Title: `feat: adopt c3source 1.1.0 (include discovery + function signatures) + CLI --version (#51)`
- Body: `Closes #51`; describe the nested-include fix; note c3-domain-manager #51 part is a separate repo.
