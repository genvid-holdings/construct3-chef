# Plan: Remove the `_usedSids` Singleton from `sidUtils.ts`

> **Status:** Designed, not started. Follow-up to PR adding `generate-sids` MCP tool — see [initiative.md § Recipe Gaps (`generateUniqueSid` exposure)](initiative.md#recipe-gaps-discovered) for the parent gap. This plan addresses the "altitude" finding from that PR's code review.

## Context

The PR that added the `generate-sids` MCP tool also added a stateless `mintUniqueSid(usedSids: Set<number>): number` to `src/c3/sidUtils.ts` and switched the new MCP tool to use it. But the module-level `_usedSids` singleton is still in place, with five legacy entry points (`initSidContext`, `initSidContextFromSet`, `resetSidContext`, the stateful `generateUniqueSid()`, plus the singleton variable itself) used by `recipeApplier.applyParsed` and ~13 builder functions in `eventSheetMutator.ts` / `instVarMutator.ts` / `recipeInterpreter.ts`. Tests rely on the singleton's init/reset lifecycle in their `beforeEach`/`afterEach` hooks (~125-155 test cases).

Three concrete pains from this leftover singleton:

1. **`recipeApplier.ts:35-40` imports `generateUniqueSid` twice** — once from `layoutScaffold.ts` (stateless, takes a Set) and once from `sidUtils.ts` (stateful, no args) aliased as `generateContextSid` to disambiguate the name. The alias is, in fact, **dead code** (imported but never referenced — only the `initSidContext`/`resetSidContext` pair from `sidUtils` is used in this file). This is direct evidence the two-API split is already painful.
2. **`layoutScaffold.generateUniqueSid` and `sidUtils.mintUniqueSid` are NOT equivalent** — `layoutScaffold`'s version draws from `[0, 1e15)` (can return SID 0, which the initiative documents as unsafe) and uses an **unbounded** do-while loop (hang risk on a saturated registry). `mintUniqueSid` is in `[1e14, 1e15)` with `MAX_ATTEMPTS=100`. Consolidating them is a latent bug fix, not just cleanup.
3. **Module-level state means every caller must remember the init/reset try/finally dance**, and the MCP `generate-sids` tool had to acquire the *write* lock just to mutate the singleton even though no source file changes. The stateless API makes this unnecessary.

**Intended outcome:** delete the singleton and the legacy entry points. Every SID-minting site takes an explicit `SidGenerator = () => number` callback. `recipeApplier.applyParsed` builds a single seed Set from `sid-registry.txt` (now layout-inclusive after the previous PR), creates one closure, and threads it through to every builder. Tests get a `freshSidGen()` helper that mints from a per-test empty Set.

## Scope summary

| Concern | Count |
|---|---|
| Source files touched | 5 (`sidUtils.ts`, `eventSheetMutator.ts`, `instVarMutator.ts`, `recipeInterpreter.ts`, `recipeApplier.ts`) |
| Function signatures changed | ~14 (10 builders in `eventSheetMutator`, 1 in `instVarMutator`, 2 in `recipeInterpreter`, plus `applyParsed` internals) |
| Test files touched | 4 (`sidUtils.test.ts`, `eventSheetMutator.test.ts`, `instVarMutator.test.ts`, `recipeInterpreter.test.ts`) |
| Test cases mechanically updated | ~125-155 (mostly setup/teardown + adding `sidGen` arg to builder calls) |
| New tests | A few targeted ones for `freshSidGen`, plus the cross-layout collision regression (see Phase 5) |
| Net lines | Probably net-negative once `_usedSids`/`init*`/`reset*` and their tests come out |

## Design

### `SidGenerator` type and `freshSidGen` helper

Add to `src/c3/sidUtils.ts`:

```ts
/** A function that mints a fresh unique SID each time it's called. */
export type SidGenerator = () => number;

/**
 * Build a generator that mints SIDs from a fresh empty Set. Each call to the
 * returned function adds to the same Set, so SIDs from one generator never
 * collide with each other.
 *
 * Production code should seed from sid-registry.txt:
 *   const used = readRegistryFile(registryPath);
 *   const sidGen: SidGenerator = () => mintUniqueSid(used);
 *
 * `freshSidGen()` is the test-helper shape — it creates an empty Set, so SIDs
 * won't collide within a single generator but may collide with on-disk SIDs.
 * That's fine for tests that don't read from disk.
 */
export function freshSidGen(): SidGenerator {
  const used = new Set<number>();
  return () => mintUniqueSid(used);
}
```

### Builder signature pattern

Every builder grows a required `sidGen: SidGenerator` parameter. Two shape choices:

- **Positional, before opts** — `buildBlock(sidGen, opts?)`. Matches `cloneLayout(sourceLayout, targetLayout, opts)`-style positional context.
- **In opts** — `buildBlock({ sidGen, conditions?, actions?, ... })`. Reads less awkwardly at call sites that already pass opts.

The codebase already uses the positional pattern for `cloneLayout` / `copyInstance` / `addReplica` callbacks. **Recommend positional**: `buildX(sidGen: SidGenerator, opts?: {...})`. Consistent with the rest of the layout op contract, keeps `opts` focused on shape data, and makes the call-site grep for "every builder call that needs a generator" trivial (just look for the second arg).

For builders that today take positional args instead of opts (e.g. `buildInclude(name: string)`), they don't call `generateUniqueSid()` and don't need the parameter at all — leave them alone.

### `recipeApplier.applyParsed` orchestration

```ts
export function applyParsed(rootDir: string, recipe: Recipe, opts: ApplyOptions = {}): void {
  const resolved: ApplyOptions = { ...opts };
  if (resolved.preview) resolved.dryRun = true;

  const registryPath = path.join(rootDir, "extracted", "sid-registry.txt");
  const used = readRegistryFile(registryPath);   // throws with the correct command name
  const sidGen: SidGenerator = () => mintUniqueSid(used);
  applyRecipeInner(rootDir, recipe, resolved, sidGen);
}
```

Note the disappearance of the `try { ... } finally { resetSidContext(); }` — no module state to clean up.

`applyRecipeInner` and all the op-execution functions it calls grow a `sidGen` parameter and thread it down to each builder invocation. The three layout-op callbacks (lines 651, 683, 709) switch from `() => generateUniqueSid(layoutSids)` (the unsafe `layoutScaffold` version) to using the same `sidGen` — `mintUniqueSid` is strictly safer, and the `used` Set already covers layout SIDs after the previous PR's `generateSidRegistry` fix.

If a layout op needs SIDs that don't collide with *other layouts' in-memory unsaved state*, that's handled naturally because `used` is mutated as SIDs are minted — they accumulate across the whole `applyParsed` run.

### Singleton functions to delete

From `src/c3/sidUtils.ts`:

- `_usedSids` (module variable)
- `initSidContext(registryPath)` — replaced by direct `readRegistryFile(registryPath)` at the one call site (`applyParsed`)
- `initSidContextFromSet(existingSids)` — only used in tests; replaced by `freshSidGen()` or explicit `() => mintUniqueSid(seed)`
- `resetSidContext()` — no-op once the singleton is gone
- The stateful `generateUniqueSid(): number` — every internal caller migrates to the `sidGen` parameter; external callers via the `./sid-utils` subpath are documented as a breaking change

Kept:

- `readRegistryFile(registryPath): Set<number>` — pure parser
- `mintUniqueSid(usedSids: Set<number>): number` — stateless mint
- `collectSids(json): Set<number>` — JSON walker
- New: `SidGenerator` type, `freshSidGen()` helper

### Consolidate `layoutScaffold.generateUniqueSid` (bug fix)

`src/c3/layoutScaffold.ts:6-13` defines a second `generateUniqueSid(existingSids: Set<number>): number` that:
- Draws from `[0, 1e15)` (the initiative explicitly bans SID 0 — see [Recipe Bugs § sid: 0 is not safe](initiative.md))
- Has an unbounded `do { ... } while (existingSids.has(sid))` retry

Delete it. The three callers in `recipeApplier.ts` (lines 651, 683, 709) switch to the shared `sidGen` thread (or, if a strictly per-layout Set is preferred for some reason, `() => mintUniqueSid(layoutSids)` — same shape).

Side effect: the dual-import block at `recipeApplier.ts:35-40` collapses to a single import from `sidUtils.ts`. The `generateContextSid` alias goes away.

### Subpath export change (breaking)

After the refactor, the `./sid-utils` subpath exposes:

- `mintUniqueSid`, `readRegistryFile`, `collectSids`, `SidGenerator`, `freshSidGen`

It no longer exposes `initSidContext`, `initSidContextFromSet`, `resetSidContext`, or the stateful `generateUniqueSid`. Since the subpath shipped only one PR ago and no downstream code is known to use the deleted symbols, document this as a breaking change in the initiative note and proceed — don't ship a backward-compat shim.

## Phases

Order matters because some steps cascade into others. Each phase is one commit.

### Phase 1 — Add `SidGenerator` type + `freshSidGen` helper

`src/c3/sidUtils.ts` — add the type and helper alongside the existing exports. Don't delete anything yet. Add a few tests for `freshSidGen` (`test/c3/sidUtils.test.ts`): it returns a SID in the valid range; back-to-back calls don't collide; two `freshSidGen()` instances are independent. This phase is purely additive — typecheck and tests should pass with no other changes.

### Phase 2 — Migrate builders in `eventSheetMutator.ts`

Add required `sidGen: SidGenerator` as the first positional arg to the 10 builders that mint SIDs (`buildBlock`, `buildFunctionBlock`, `buildCustomAceBlock`, `buildAction`, `buildCallAction`, `buildVariable`, `buildCondition`, `buildGroup`, `buildCustomAction` — exact list from exploration). Inside each, replace `generateUniqueSid()` with `sidGen()`.

Update `test/c3/eventSheetMutator.test.ts`:

- Replace `beforeEach(() => initSidContextFromSet(new Set()))` and `afterEach(() => resetSidContext())` with `let sidGen: SidGenerator; beforeEach(() => { sidGen = freshSidGen(); });`.
- Mechanical search-replace on builder call sites: `buildBlock({...})` → `buildBlock(sidGen, {...})`. Same for the other builders.

Don't touch `recipeApplier`/`recipeInterpreter` yet — they still call the bare `generateUniqueSid()` and rely on the singleton. That's intentional: Phase 2 ships a typecheck-failing tree if you stop here, so it's actually fused with Phase 3. Plan to land Phases 2-4 in one commit, or use a temporary parameter-default to keep the tree compiling between phases.

### Phase 3 — Migrate `instVarMutator.ts` and `recipeInterpreter.ts`

Same shape as Phase 2 — add `sidGen` to the 1 + 2 call sites in those files and to their tests. `instVarMutator.test.ts` and `recipeInterpreter.test.ts` get the same `beforeEach` swap.

### Phase 4 — Update `recipeApplier.applyParsed` + delete dead `generateContextSid` import

Replace the `initSidContext`/try/finally/`resetSidContext` block with the new `readRegistryFile` + `mintUniqueSid` + threaded `sidGen` shown above. Thread `sidGen` through `applyRecipeInner` → `executeFileOps` → wherever the eventSheet/instVar/recipeInterpreter builders are called. Delete the unused `generateContextSid` import.

After this phase, `pnpm typecheck` should pass with the singleton functions still in place but unused by source code (only tests still reference them).

### Phase 5 — Consolidate `layoutScaffold.generateUniqueSid` (bug fix)

Delete `layoutScaffold.generateUniqueSid` (lines ~6-13 of `layoutScaffold.ts`). Update its three callers in `recipeApplier.ts` (lines 651, 683, 709) to use the threaded `sidGen` (the call-site signature for `copyInstance`/`addReplica`/`moveInstance` already accepts a `sidGenerator: () => number` callback, so this is just changing what closure they pass).

Add a regression test covering the unsafe-SID-0 case: today, with enough collisions, `layoutScaffold.generateUniqueSid` could in principle return 0. With `mintUniqueSid`, that's impossible. The test can construct a `usedSids` Set seeded so the first random draw hits a collision, then assert the eventual return is `>= 1e14`.

### Phase 6 — Delete the singleton

`src/c3/sidUtils.ts`: delete `_usedSids`, `initSidContext`, `initSidContextFromSet`, `resetSidContext`, and the stateful `generateUniqueSid()`. Update the surrounding doc comments.

`test/c3/sidUtils.test.ts`: delete the `describe("generateUniqueSid()")`, `describe("initSidContextFromSet()")`, `describe("resetSidContext()")`, and `describe("initSidContext() with registry file")` blocks (the ones that exercise the singleton). Keep the `mintUniqueSid`, `readRegistryFile`, `freshSidGen`, and `collectSids` blocks.

Verify: `pnpm typecheck` should now fail in any other file that still imports the deleted symbols. Grep `src/` and `test/` for those names and clean up — should already be empty after Phases 2-4 except for documentation.

### Phase 7 — Initiative bookkeeping

Update [initiative.md](initiative.md):

- Strike through the altitude finding from the previous PR's code review (it currently lives in the closing-summary note of the `./sid-utils` strikethrough).
- Add a note that the subpath now exposes only stateless symbols.
- Tool count unchanged (still 28).

This plan file (`sid-singleton-removal-plan.md`) can stay in `initiatives/c3-mcp-server/` as a historical artifact, or move to `archive/` once the work ships.

## Verification

1. `pnpm typecheck` after each phase — Phase 1 should be additive-clean; Phases 2-4 may need to land together to keep the tree compiling.
2. `pnpm lint` — should remain at 0 warnings.
3. `pnpm test` — final test count should be roughly unchanged (~800-810). The ~125-155 mechanically-updated test cases stay; the deleted singleton tests (~15-20) go away; the Phase 1 and Phase 5 additions add ~5-10 new cases.
4. `pnpm build` — confirm `dist/c3/sidUtils.d.ts` no longer declares the deleted symbols. (Optional grep:`grep -E 'initSidContext|resetSidContext|_usedSids' dist/c3/sidUtils.d.ts` should return nothing.)
5. Subpath sanity: `pnpm exec node --input-type=module -e "import('construct3-chef/sid-utils').then(m => console.log(Object.keys(m).sort().join(', ')))"` should print `SidGenerator` is a type so won't appear; expect `collectSids, freshSidGen, mintUniqueSid, readRegistryFile`. (4 symbols, down from 7.)
6. End-to-end smoke: run `pnpm exec tsx src/cli.ts apply-recipe --project-dir <a real c3 project> --recipe <a known-good recipe>` and confirm the recipe applies and `extracted/` regenerates without errors. This exercises the new threaded `sidGen` path through the full pipeline.

## Risks and mitigations

- **Test churn is the biggest source of bugs.** 125-155 mechanical edits is enough that a stray missed call site will silently use the old singleton (and silently break once Phase 6 deletes it). Mitigation: do Phases 2-4 in a single commit (or carefully chained commits with intermediate `_usedSids = new Set()` shims), and let `pnpm typecheck` catch every missed call site before Phase 6 deletion.
- **`recipeApplier`'s layout ops behavior change** — moving from `layoutScaffold.generateUniqueSid` (range `[0, 1e15)`, can return 0) to `mintUniqueSid` (range `[1e14, 1e15)`) means the new SIDs minted into layout JSON are strictly larger. C3 doesn't care about SID magnitude (any positive integer below `Number.MAX_SAFE_INTEGER` works), but downstream tooling or diffs that grep for specific SIDs may notice. Document the range change in the initiative.
- **Subpath breaking change** — anyone who imported `initSidContext` etc. from `construct3-chef/sid-utils` between the previous PR landing and this refactor breaks. Since the subpath is one PR old and the gap-fix description explicitly highlighted `mintUniqueSid` as the preferred entry point, exposure should be near zero. If discovered, mitigation is a one-line restore of the deleted symbols as shims that throw with a clear migration message.

## Out of scope

- The C3 Addon Bridge, Playwright editor automation, user-defined ops, and the `extracted/` directory transition all remain on the "What's Next" table in `initiative.md` — none of them depend on or block this refactor.
- The `spriteScaffold.ts` local `generateUniqueSid` (per the exploration finding it exists at line 6) is technically a third copy of this pattern, but it's local-static, not exported, and only used within `spriteScaffold` itself. Worth a one-line follow-up to replace it with `mintUniqueSid` (purely a code-tidiness win — no API change), but not part of the singleton-removal critical path.
