---
type: decision-record
title: "0032. Retired-org link targets are repointed; retired-org tokens in prose are not"
description: >-
  A GitHub link pointing through a retired org is repointed to the current
  org wherever it appears in tracked Markdown — including inside `wiki/decisions/`,
  which the retired-token hygiene exclusion otherwise protects — because a link
  *target* is a pointer that must resolve, while a retired token in *prose* is a
  historical fact that must not be rewritten. Guarded locally by
  `test/retiredOrgLinks.test.ts` scoped to the URL form, since the upstream
  retired-token scanner cannot see this class for two independent reasons
  ([#203](https://github.com/GenvidTechnologies/construct3-chef/issues/203))
tags: [decision, documentation, testing, hygiene]
status: stable
generated: { by: process:plan-task, at: 2026-08-23T00:00:00Z }
---

# 0032. Retired-org link targets are repointed; retired-org tokens in prose are not

- **Status:** Accepted
- **Date:** 2026-08-23
- **Issue:** [#203](https://github.com/GenvidTechnologies/construct3-chef/issues/203)

## Context

Twenty GitHub issue links across seven `wiki/` pages pointed through the retired
`genvid-holdings` org. They resolve today — GitHub honours the rename redirect,
confirmed against the authenticated API — but a redirect is a courtesy with no
guarantee, and the prose misstates where the repo lives regardless.

`/gvt-dev:audit-conventions` reported the repo **clean** for the entire time these
accumulated. There are **two** independent reasons, and this matters because
either one alone is sufficient:

1. The upstream retired-token scanner opens its per-line loop with
   `if (line.includes('http')) return;`, commented *"provenance/issue URLs are
   correct-as-history"*. Every one of these hits **is** a URL, so the scanner
   structurally cannot see them. Tracked upstream as gvt-dev#232.
2. Its default deny-list is `['genvid:', 'genvid-dev:', 'genvid-c3']`, which does
   not contain `genvid-holdings` at all, and this repo sets no
   `hygiene.retiredTokens` override.

`#203` attributed the miss solely to (1). Fixing (1) upstream would still leave
(2), which is the decisive argument for a local guard rather than waiting.

### The tension this record resolves

`CLAUDE.md` § "Conventions" and `.gvt-agent.json`'s
`hygiene.excludePaths: ["wiki/decisions/"]` both say retired-token hits inside
ADRs are **deliberately excluded** — an ADR is a historical record, and rewriting
its prose falsifies it.

Five of the twenty links lived in `wiki/decisions/`. Read literally, the exclusion
forbids touching them.

## Decision

**Repoint the link target; never rewrite the prose.** These are different objects
and the exclusion only ever meant the second:

| Form | Example | Treatment |
|---|---|---|
| A **link target** | the URL inside `[#94](…)` | **Repointed.** A pointer exists to resolve; a stale one serves nobody, and the decision text is unchanged by fixing where it points. |
| A **token in prose** | ``formerly `genvid-holdings/genvid-public-ci` `` | **Untouched.** This is a statement about the past. Rewriting it would make the sentence false. |

So an ADR's link targets are in scope while its decision text is not — the record
stays historical either way, because *where a citation points* was never part of
what the record asserts.

`CLAUDE.md`'s two `genvid-holdings` mentions are both prose under this rule: one
is the `formerly …` provenance, the other is the rule bullet that *names* the
token as excluded — the self-example trap, where a rule quoting the form it
forbids becomes a false positive in every later sweep.

**The guard matches the URL form, not the bare token.** That single choice is what
makes the exclusion list **empty**: prose mentions carry no `github.com/<org>/`
prefix, so they fall outside structurally rather than through a line-number
allow-list that would rot the moment the file is edited. The guard is the exact
complement of the upstream scanner — that one skips every line containing `http`;
this one reads only those lines.

## Consequences

- The class is now detectable here. Adding a retired-org link to tracked Markdown
  fails the suite.
- `raw/` is excluded, and the exclusion is **pinned by a negative-case row**: a
  planted retired link under `raw/` must leave the guard green. Without that row,
  "excluded" and "the walk found nothing there" are indistinguishable.
- Any document *about* this decision — this record included — must name the
  retired org as a **code span or bare prose**, never as a live URL, or it trips
  the guard it describes. That is not an accident of the rule; it is the rule
  working, and it is why this ADR contains no such URL.
- A future org rename adds an entry to `RETIRED_ORGS` and nothing else.
- A link to a **different repo** under the same rename keeps its own repo name
  (`c3source` stays `c3source`). Assuming one path shape would produce a
  wrong-but-live link, which is worse than a dead one because nothing detects it.

## Alternatives rejected

**1. Honour `hygiene.excludePaths` literally and leave the five ADR links.**
Rejected once the prose/target distinction was drawn: the exclusion protects the
record's *claims*, and where a citation points is not one of them. Leaving five
known-stale pointers in place to satisfy a rule aimed at something else is
cargo-cult compliance.

**2. Add `genvid-holdings` to `hygiene.retiredTokens`.** The obvious-looking
config fix, and it would have made things worse. That key **replaces** the default
deny-list rather than extending it, so the entry would have to be restated in
full; reason (1) above still hides all twenty URLs from the scanner; and the only
hits it *could* surface are `CLAUDE.md`'s two deliberate prose mentions — pure
false positives. It is a knob that cannot reach the defect and can only
manufacture noise.

**3. Wait for gvt-dev#232 to widen the upstream scanner.** It would fix reason (1)
for every consuming repo, which is genuinely better than a local guard. But
reason (2) would remain, so the hits would *still* be invisible here; and the
upstream comment (*"provenance/issue URLs are correct-as-history"*) suggests the
current behaviour may be considered correct, making the wait open-ended.
Not mutually exclusive — if #232 lands, this guard becomes redundant for reason
(1) and can be re-evaluated then.
