---
type: decision-record
title: "0036. The project-id guard is upstream's wire-format rule, not a local one"
description: >-
  `ProjectRegistry.add` guarded only `:`, so chef minted project ids that
  `@genvidtech/mcp-utils`' `parseTxToken` rejects — leaving a chef-minted txId
  unparseable by the wire format's other named consumer. The guard now routes
  through upstream's `isValidProjectId`, a strict superset of the old check.
  Adopting upstream's txToken *codec* is deliberately deferred, gated on
  mcp-utils#25, because it would collapse eight distinct parse diagnostics into
  a bare `null`
  ([#217](https://github.com/GenvidTechnologies/construct3-chef/issues/217))
tags: [decision, architecture, mcp, upstream-adoption]
status: stable
generated: { by: process:plan-task, at: 2026-09-02T00:00:00Z }
---

# 0036. The project-id guard is upstream's wire-format rule, not a local one

- **Status:** Accepted
- **Date:** 2026-09-02
- **Issue:** [#217](https://github.com/GenvidTechnologies/construct3-chef/issues/217) (partial — this record covers the half that shipped)

## Context

ADR [0034](0034-mcp-server-multi-project-support.md) introduced the composite
`<projectId>:<counter>` txId wire format and gave `src/mcp/txToken.ts` its
codec. Days later `@genvidtech/mcp-utils@0.9.0` shipped a `txToken` module of
its own whose docstring names **construct3-chef** and **c3-domain-manager** as
its two intended consumers, citing chef's own ADR
[0005](0005-mcp-server-optimistic-concurrency-model.md) and describing `:` as a fixed wire
contract. Two implementations of one cross-repo wire format is exactly the drift
trap `CLAUDE.md` § "Leaf dependencies" warns about, so #217 was filed to
reconcile them.

Reconciling surfaced a defect that is **independent of the reconciliation
decision**. `ProjectRegistry.add` validated only that an id contained no `:`.
Measured against the pre-change tree:

| `add(id)` | before this change | upstream `isValidProjectId` |
|---|---|---|
| `"al pha"` | **accepted** | rejects |
| `"a\tb"` | **accepted** | rejects |
| `""` | **accepted** | rejects |
| `"al:pha"` | rejects | rejects |
| `"al/pha"` | **accepted** | **accepts** |

An id reaches `add` unsanitized only through the explicit `<id>=<path>` launch
form: `deriveProjectId` returns `explicitId` verbatim, and only the bare-path
branch runs `sanitize()` (`[^a-z0-9-]+ → "-"`, which is always upstream-valid).
So `--project-dir "al pha=/tmp/x"` yielded project id `al pha`, and every txId
chef minted for that project — `al pha:0`, `al pha:1` — is rejected by
`parseTxToken` in any consumer applying the shared rule. The token round-trips
within chef and nowhere else.

## Decision

**`ProjectRegistry.add` validates ids with `@genvidtech/mcp-utils`'
`isValidProjectId` rather than a local predicate.**

The rule belongs to whoever owns the parser that must read these tokens back. A
locally re-rolled predicate drifts from that parser silently, at whatever patch
release changes the accept set — no version signal, no failing test.

### This is a superset, not a trade — the two enforcement points are distinct

The tempting objection is that upstream's rule *permits* `/`, `\`, and `=`,
which chef excludes, so adopting it loosens the guard. **It does not**, and the
reasoning error is worth recording because it is easy to repeat: those
characters are excluded by `EXPLICIT_ID_RE` inside `splitSpec`, which constrains
what the explicit branch can **produce**. `add` validates whatever it is
**handed**, and never checked them — the table above shows `add("al/pha")`
accepted before this change, and upstream accepts it too. Nothing is loosened;
`:` stays rejected and two holes close.

That distinction cost a full correction cycle during planning: the ambiguity was
first flagged as a blocker, then the flag itself proved wrong once both sites
were measured rather than read.

### DECLINE — adopting upstream's txToken codec now

Deferred, gated on
[mcp-utils#25](https://github.com/GenvidTechnologies/mcp-utils/issues/25).

chef's `parseTxToken` returns a discriminated `{error: string}` and produces
**eight** distinct messages, which `compareTxToken` renders straight into the
`mcpError` a client sees — whether the counter was malformed, the project id was
empty, or the separator was missing entirely. Upstream returns bare `null` for
all eight, discarding the reason.

Re-deriving that classification locally would mean reimplementing the accept set
this module exists to own — the first-colon split, the canonical-integer shape,
`isValidProjectId` — in every consumer, and it fails silently the moment
upstream tightens or loosens the set. So the gap was filed upstream rather than
worked around locally, following ADR
[0006](0006-upstream-ownership-boundary-and-adoption-posture.md)'s
"request the right shape, wait" precedent.

Note what this decline does *not* claim: the codec adoption is still the right
end state. Only its timing is deferred, and only on the diagnostics axis.

### DECLINE — a non-throwing local `format` wrapper, for now

Upstream's `formatTxToken` **throws** `TypeError` on an invalid id, the
deliberate exception to that module's never-throw contract. Under the deferred
codec swap that would crash the *emission* path (`txIdLine`, `get-state`) for
any project whose id fails validation — which, before this ADR's change, was a
reachable launch configuration.

Tightening the guard removes the reachable cause, so the wrapper has nothing
left to defend against today and would be untestable defensive code. It ships
with the codec adoption, where a throw becomes possible again.

## Consequences

- **Breaking, with negligible blast radius.** Launching
  `--project-dir "my id=/path"` now fails at startup with a message naming the
  constraint, instead of silently producing cross-repo-unparseable tokens. The
  id is a wire-format identifier, not a display name.
- **`src/mcp/projectRegistry.ts` now imports `isValidProjectId`.** That is the
  point: a shared rule that cannot drift beats a re-derived one.
- **The empty-id hole closed as a side effect.** `add("")` was accepted before;
  no code path produced it, but nothing prevented one.
- **#217 stays open** with `blocked:upstream` until mcp-utils#25 resolves. ADR
  0034's txId section is deliberately **untouched** — it still describes chef
  owning the codec, which remains accurate until the deferred half lands.
- **The pre-existing `:` assertion was mutation-proved.** It was green before
  this change and would therefore have been unfalsifiable under revert-confirm;
  neutering the guard in production code takes it red along with the four new
  rows.

## Related

- ADR [0034](0034-mcp-server-multi-project-support.md) — introduced the composite
  txId format and `txToken.ts`. Its txId section will need a superseding note
  **when the codec swap lands**, not before.
- ADR [0005](0005-mcp-server-optimistic-concurrency-model.md) — the optimistic-concurrency
  check the token serves.
- ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) — the
  upstream-ownership boundary, and the "request the right shape, wait" precedent
  this record's first decline follows.
- [`wiki/process/leaf-dependency-ledger.md`](../process/leaf-dependency-ledger.md)
  — the 0.9.0 entry, which records the codec decline and its next-bump check.
