# Plan: #54 — Enforce Prettier in lint + conform the 21 non-conforming `.ts` files

**Branch:** `build/enforce-prettier` (off `main`)
**Closes:** #54

## Scope (confirmed by investigation)
- **Exactly 21 non-fixture files**: 10 `src/c3/*.ts` (incl. the `projectSync.ts` tabs offender) + 11 `test/**/*.ts`.
- **Prettier is not a devDependency** — must be pinned for CI gating.
- **`.prettierignore` excludes all of `test/fixtures/`** — real C3 export `ts-defs/` + fixture scripts (`main.ts`/`importsForEvents.ts`) + generated `extracted/` read-surface in two fixtures (`sample-project`, `search`). Broader than the issue's `ts-defs/`-only proposal (which would wrongly reflow the fixture scripts + `test/fixtures/search/extracted/.../TestSheet.ts`).
- CI gates via `npm run lint` (shared `genvid-public-ci` recipe), so composing Prettier into `lint` auto-gates it.

## Tasks (one commit each, bisectable; gate wired last so every commit is green-or-expected)

- **prep** — commit `plan.md`.
- **T1 `build:`** — add pinned `prettier` (`^3`) devDependency; add `.prettierignore` (`test/fixtures/`, `dist/`); add `format` (`--write`) + `format:check` (`--check`) scripts targeting `"src/**/*.ts" "test/**/*.ts"`. No reformatting, no lint change yet.
- **T2 `style:`** — run `npm run format` → whitespace-only reflow of the 21 files (`projectSync.ts` tabs→spaces is the big one). Verify: `git diff` is formatting-only; no CRLF/LF whole-file churn; `npm run typecheck` + full `npm test` (golden must stay byte-identical) + `eslint` all pass.
- **T3 `build:`** — append `&& npm run format:check` to the `lint` script. Verify: `npm run lint` passes green.
- **T4 `docs:`** — rewrite the stale CLAUDE.md § Conventions note ("Formatting is NOT gated…") to reflect that Prettier is now gated and the repo conforms; drop the `projectSync.ts` hazard framing (keep the `.json`-tabs / no-reformat-fixtures facts).

## Verification gate (after T2 and final)
`npm run typecheck` · `npm test` (golden byte-identical) · `npm run lint` (now incl. `format:check`) · `npx prettier --check` exits clean.

## Risks / watch-items
- **Golden byte-identity** — reformatting only touches generator code, not fixture inputs/outputs (fixtures ignored); the golden test is the guard. Re-run it explicitly.
- **CRLF churn** (Windows) — Prettier default `endOfLine: lf`; verify the `style:` diff isn't whole-file line-ending normalization.
- **CI lever** — confirm the shared gate invokes `npm run lint`; Prettier rides along automatically.
- **Memory housekeeping** — `projectsync-tabs-not-spaces.md` becomes outdated post-merge (update it, not a commit).
