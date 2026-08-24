---
type: process-note
title: "Backlog Triage Conventions"
description: >-
  Backlog-grooming conventions consumed by `/gvt-dev:triage-issues` (types, `priority/*` + `area:*` labels, required fields, split/duplicate/dependency policy, `gh` mutation recipes); pairs with the `bugTracker` block in `.gvt-agent.json`
tags: [process, triage, backlog]
status: stable
stale_after: 2027-02-20
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# Backlog Triage Conventions

> Project conventions consumed by `/gvt-dev:triage-issues`. construct3-chef has
> no separate bug tracker — its backlog is **GitHub issues**, predominantly
> `enhancement`s (features, refactors, upstream adoptions). This file therefore
> grooms the *enhancement backlog*: dedup, link dependencies, enrich, split
> overstuffed umbrellas, assign priority/area, and stamp `triaged`. The
> section headings are fixed — the skill and analyst locate guidance by heading.
>
> Companion **access mechanics** (fetch queries, label names) live in the
> `bugTracker` block of `.gvt-agent.json`.
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
  - `area:c3source-adoption` — adopting upstream `@genvidtech/c3source` / `@genvidtech/mcp-utils` primitives.
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

## What `triaged` does and does not assert

`triaged` means the fields above are present and the issue has been deduplicated,
linked, and prioritized. It does **not** mean the issue's **causal claims about the
code** were verified — triage is a metadata pass over the whole backlog and
deliberately does not read consumer chains or the installed dependency surface.
Verifying premises belongs to planning (`gvt-dev:plan-task` treats an issue's
concrete assertions as claims to diff against the artifact they describe).

State it explicitly because the label reads as more assurance than it carries, and
the gap has bitten: **#152** was triaged and carried three wrong premises — a
severity direction that was *inverted* (the defect emitted false-positive
rejections of valid recipes rather than letting bad ones through), a failure
mechanism attributed to the wrong guard, and a "genuine fork, to be decided at plan
time" whose upstream primitive already shipped in the pinned dependency. **#149**
had already been corrected at triage once and *still* carried a stale line-number
citation and an overstated failure mechanism — so a visible correction pass is not
evidence the rest was checked.

The fix is **not** to make triage verify code; that duplicates planning at
backlog-wide cost. It is to keep the boundary legible in both directions:

- **Triaging** — when you assert a mechanism or severity you have not checked,
  write it as a hypothesis ("appears to…", "if so, then…"), not as a finding. A
  confident wrong premise is more expensive than an admitted unknown, because the
  planner may adopt it via the "issue is already a full proposal" shortcut.
- **Planning** — read the artifact before adopting any premise, and reconcile the
  issue body in the same PR when it turns out wrong, so the correction is inherited
  rather than rediscovered.

Two further shapes, both from **#159** (2026-08-10):

- **Your own correction pass is not verification.** #159 was corrected at triage —
  four real defects fixed (wrong `area:` label, a miscounted call-site list, a CLI
  framing for a surface that isn't on the CLI, a stale "last one outstanding"). That
  pass raised confidence *without adding verification*: the issue's central mechanism
  claim — that the walk covered the entire project root — was carried forward into
  planning as a "verified premise" and was **false** (`search()` guards the `json`
  type so `path` is mandatory and prefixed, making that branch unreachable). Fixing N
  defects in a body produces the felt sense of having audited it. When you correct the
  periphery, **re-derive the central mechanism explicitly** — that is exactly when you
  are least likely to.
- **A cross-repo issue's *discouraging* claim fails silently.** `mcp-utils#10` asserted
  that a predicate could not fix an `EISDIR` crash "because `walkFiles` decides
  file-vs-directory before the predicate runs." A probe disproved it, and believing it
  would have shipped #159 while leaving a live crash. Note the asymmetry against the
  prescription case above: acting on a wrong *prescription* fails loudly (a test
  breaks), while acting on a wrong *discouragement* produces no failing test at all —
  nothing ever surfaces it. So a claim about what your code **cannot** do deserves
  more scrutiny than one about what it should. When you disprove one, comment the
  evidence on the upstream issue so the next reader doesn't inherit it.

Two more, from **#169** and **#172** (2026-08-12) — both filed by the maintainer
and *untriaged*, so neither had a `triaged` label to over-trust. The gap this
section describes is not created by the label; the label only hides it:

- **An issue offering two alternative fixes makes a third claim — that either one
  works.** #169's *primary* proposed fix was correct. Its *alternative* ("ADR
  0016's **two** walk declines") was wrong: ADR 0016 has **three** DECLINE
  sections, and `wiki/index.md` and `CLAUDE.md` both already say three, so adopting
  it would have created a fresh count inconsistency across three documents — the
  exact drift class the issue existed to fix. The body presented both as
  equivalent ("Either fix closes the defect"). Under planning's *"issue is already
  a full proposal"* shortcut either may be adopted, so **verify each alternative
  independently, and treat "either works" as itself a premise.** Note this is the
  inverse of the usual worry: the *headline* claim was sound and the *escape
  hatch* was defective, which is the half a confident reader skims.
- **A cited commit can be impossible.** #172 anchored a table of measurements to a
  SHA whose content *predates the edit being measured* — it cannot have produced
  the quoted figures, which were evidently taken from a dirty working tree. A SHA
  reads as evidence and buys the surrounding numbers unearned credibility, so when
  an issue reports figures *with* a commit, spend the one command that checks it
  (`git show <sha>:<file> | wc -c`). Here the headline (29%) survived and only a
  supporting figure was wrong — which is the reason to say so explicitly when
  correcting it, or the correction reads as though it undermined the issue.

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

### Blocked-by vs. retired-by — an upstream release can end an issue two ways

An issue waiting on upstream has **two** possible resolutions, and they call for
**opposite** actions:

- **Blocked by** — upstream ships a *prerequisite*; you then **build** the thing.
  The issue's scope survives intact.
- **Retired by** — upstream ships *the capability itself*; you then **close** the
  issue unbuilt and **delete** whatever local workaround stood in for it. The
  scope evaporates and is replaced by a much smaller deletion.

Reading a retired-by issue as blocked-by produces a confident, wrong plan: you
set out to implement the very thing that just became unnecessary.

**The labels cannot carry this.** `blocked` / `blocked:upstream` have no
retired-by counterpart, so a correctly-triaged retired-by issue carries **neither
label** — which is indistinguishable at a glance from an untriaged one. State the
relationship in the body, under a heading a skimmer will hit, and prefer the verb
"retire" explicitly.

**Precedent — [#200](https://github.com/GenvidTechnologies/construct3-chef/issues/200).**
It proposed owning the MCP docs resource locally (~80 LOC) to work around an
upstream limitation, and recorded its own ending: *"What would retire this issue
instead: mcp-utils#15 shipping … If it ships, close this and delete the
flattener."* When that landed, the real work was a dependency bump, two options at
one call site, and deleting a 203-line generator plus its 220-line test —
**net −230 lines instead of +80**, and #200 closed unbuilt via
[#207](https://github.com/GenvidTechnologies/construct3-chef/issues/207).

**Triage action:** for any issue naming an upstream request, ask *if upstream
ships this, do we build something or delete something?* and record the answer in
the body. Grep the body for "retire", "supersede", "close this", "delete the
workaround" before assuming blocked-by.

**The corollary belongs to whoever writes the workaround, not to triage:** a
local workaround for an upstream gap should **record its own deletion condition**
when it is written. ADR
[`0029`](../decisions/0029-flat-docs-alias-generated-into-the-tarball.md) did,
which is the only reason its retirement was mechanical rather than a judgement
call months later. See ADR
[`0033`](../decisions/0033-mcp-docs-resource-serves-wiki-directly.md) for how it
collected.

⚠️ A **closed** upstream issue is not proof the capability shipped as needed —
read the published `dist`, not the issue title.

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
