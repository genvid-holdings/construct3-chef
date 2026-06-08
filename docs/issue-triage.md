# Backlog Triage Conventions

> Project conventions consumed by `/genvid-dev:triage-issues`. construct3-chef has
> no separate bug tracker — its backlog is **GitHub issues**, predominantly
> `enhancement`s (features, refactors, upstream adoptions). This file therefore
> grooms the *enhancement backlog*: dedup, link dependencies, enrich, split
> overstuffed umbrellas, assign priority/area, and stamp `triaged`. The
> section headings are fixed — the skill and analyst locate guidance by heading.
>
> Companion **access mechanics** (fetch queries, label names) live in the
> `bugTracker` block of `.genvid-agent.json`.
>
> Tracker: **GitHub Issues via the `gh` CLI**.

## Types

The kind of work, via one of GitHub's default labels (exactly one per issue):

- `enhancement` — new feature, capability, refactor, or upstream-package adoption (default).
- `bug` — incorrect behavior in shipped functionality.
- `documentation` — docs-only work.

These are the repo's existing GitHub labels (no `type:` prefix). The triager sets
exactly one.

## Priorities

- `priority/P0` — blocks a release or breaks `main`/CI; do now.
- `priority/P1` — important capability or a blocker for other tracked work; this cycle.
- `priority/P2` — valuable but schedulable; the normal backlog default.
- `priority/P3` — nice-to-have, speculative, or far-horizon; someday.

Decision rule: pick by **impact + whether other issues depend on it**, not by how
interesting the work is. An item that unblocks several others ranks above an
isolated nicety. Blocked-on-upstream items that can't start yet are not P0/P1.

## Labels

- type — exactly one of `enhancement` / `bug` / `documentation` (see Types).
- `priority/*` — exactly one: `priority/P0` … `priority/P3`.
- `area:*` — one or more subsystem tags. Current set:
  - `area:recipe` — recipe interpreter/applier/workflow expansion, ops.
  - `area:layout` — layout mutator + composite layout workflows.
  - `area:mcp` — MCP server, tools, concurrency/state model.
  - `area:cli` — yargs CLI surface.
  - `area:generators` — `extracted/` read surface + the 6 generators.
  - `area:config` — configuration layer (`construct3-chef.config.json`, nav-convention, ops registry).
  - `area:c3source-adoption` — adopting upstream `@genvid/c3source` / `@genvid/mcp-utils` primitives.
  - `area:live-editor` — C3 live-editor integration (Playwright/addon bridge).
  - `area:testing` — golden test, fixtures, test infrastructure.
  - `area:docs` — documentation.
- `to refine` — the **needs-info** signal: issue needs research/brainstorming before
  it can be acted on (existing repo label). Cleared once scoped.
- `duplicate` — non-canonical member of a duplicate cluster.
- `triaged` — set **last**, by the skill, when triage of the issue is complete.

The triager sets type, `priority/*`, and `area:*`.

## Required fields

Every triaged issue must have: a clear problem statement / motivation (the *why*),
a proposed direction or acceptance criteria (even if rough), and at least one
`area:*` label. An issue that is still an open question (no actionable direction)
keeps/gets `to refine` instead — comment exactly what needs deciding.

## Splitting

Split when one issue bundles unrelated work, or when an umbrella tracks several
independently-shippable pieces. Prefer **sub-issues** (a task-list of checkboxes
referencing new issues) when the parent is a tracking umbrella; prefer **separate
issues** when the parts share no parent. Keep the original as the canonical/umbrella
and move each split-out piece's scope into its own issue. This repo has a history
of splitting umbrellas into fine-grained issues (#18–#29) for visibility — favor
that pattern.

## Duplicates

Policy: **link, do not auto-close.** For a duplicate cluster, choose the canonical
(usually the oldest, or the one with the clearest scope), add `duplicate` to the
others, and comment `Duplicate of #<canonical>` on each. Close a duplicate only
with explicit per-item approval. Note overlaps that aren't true duplicates as a
`Related to #<id>` comment instead.

## Dependencies

Express a dependency with a comment on the blocked issue: `Blocked by #<id>`
(optionally `Blocks #<id>` on the other). Several backlog items are blocked on
upstream c3source/mcp-utils releases — record those as `Blocked by` prose naming
the upstream release/issue when there's no local issue to link. For umbrellas, list
dependencies as a GitHub task-list under a `Depends on` heading.

## Mutation recipes

The exact commands the triage skill runs to apply **approved** changes. `{id}`,
`{type}`, `{p}`, `{a}`, `{text}`, `{canonical}`, `{other}`, `{title}`, `{body}`,
`{tmpfile}`, `{triagedLabel}`, and `{needsInfoLabel}` are substituted by the skill.

- Set type: `gh issue edit {id} --remove-label "enhancement,bug,documentation" --add-label "{type}"`
- Set priority: `gh issue edit {id} --remove-label "priority/P0,priority/P1,priority/P2,priority/P3" --add-label "priority/{p}"`
- Add area: `gh issue edit {id} --add-label "area:{a}"`
- Remove area: `gh issue edit {id} --remove-label "area:{a}"`
- Edit body (language fix / fill missing info): `gh issue edit {id} --body-file {tmpfile}` — the skill writes the approved new body to `{tmpfile}` first
- Comment: `gh issue comment {id} --body "{text}"`
- Flag needs-info: `gh issue edit {id} --add-label {needsInfoLabel}` (pair with a Comment saying what's missing) — here `{needsInfoLabel}` = `to refine`
- Mark duplicate: `gh issue edit {id} --add-label duplicate` then `gh issue comment {id} --body "Duplicate of #{canonical}"`
- Close duplicate (only with approval): `gh issue close {id} --reason "not planned" --comment "Duplicate of #{canonical}"`
- Create split issue: `gh issue create --title "{title}" --body "{body}" --label "{type},area:{a}"`
- Link dependency: `gh issue comment {id} --body "Blocked by #{other}"`
- Stamp triaged: `gh issue edit {id} --add-label {triagedLabel}`
