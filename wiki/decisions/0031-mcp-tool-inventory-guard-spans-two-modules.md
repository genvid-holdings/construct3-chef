---
type: decision-record
title: "0031. The MCP tool inventory guard spans two modules, anchored on quote style"
description: >-
  The README's `### Available MCP tools` inventory guard parses **two** source
  modules — `src/mcp/server.ts`'s `reg()` calls and `src/mcp/opsRegistry.ts`'s
  `registerTool()` calls — because `list-ops` is a static, unconditionally
  registered tool that lives outside `server.ts` and a single-module parse is
  structurally blind to it; the dynamic `op-<name>` tools are excluded by
  anchoring on a **double-quoted** string literal rather than by an exception
  list, since they register from a template literal
  ([#199](https://github.com/GenvidTechnologies/construct3-chef/issues/199),
  [#196](https://github.com/GenvidTechnologies/construct3-chef/issues/196))
tags: [decision, architecture, testing, mcp]
status: stable
generated: { by: process:plan-task, at: 2026-08-23T00:00:00Z }
---

# 0031. The MCP tool inventory guard spans two modules, anchored on quote style

- **Status:** Accepted
- **Date:** 2026-08-23
- **Issue:** [#199](https://github.com/GenvidTechnologies/construct3-chef/issues/199), [#196](https://github.com/GenvidTechnologies/construct3-chef/issues/196)

## Context

[#155](https://github.com/GenvidTechnologies/construct3-chef/issues/155) added
`test/readmeCommandInventory.test.ts`, asserting the README's **CLI** subcommand
inventory against `src/cli.ts`. It explicitly declined the **MCP tool tables**,
and its own docstring records why: the two surfaces share names but are different
things, and a file-wide row regex would conflate them.

The decline was sound for a file-wide match, but it left the MCP surface
unguarded, and it drifted. Measured against `main` at
`6e067a0`: **37** statically-registered MCP tools, **24** documented, **13**
undocumented — plus a factually wrong `regenerate` row claiming "all 5
generators" against a `GENERATORS` array of six.

The obvious guard — parse `src/mcp/server.ts` for its `reg()` calls, diff against
the README rows — is what #199 proposed. It is also **structurally incomplete**,
which is the decision this record exists to capture.

### `list-ops` is static but does not live in `server.ts`

`src/mcp/server.ts` registers tools through a local `reg()` wrapper that records
each handler and config into test-visible maps before delegating to
`server.registerTool`. Thirty-six tools register that way.

A thirty-seventh does not. `src/mcp/opsRegistry.ts`'s `registerListOps()` calls
`this.server.registerTool("list-ops", …)` directly. It is reached from `start()`,
which `startServer` calls unconditionally — and `registerListOps()` runs *before*
`reconcile()`, so `list-ops` is present whether or not an `ops/` directory exists
or contains anything.

`list-ops` is therefore **static, unconditional, and `READ_ONLY`** — categorically
unlike the `op-<name>` tools registered alongside it, which are genuinely dynamic
(loaded from the project's `ops/` dir, hot-reloaded on change, varying per
project). #199's finding 3 correctly identified that the dynamic tools must be
excluded from a static guard; the two were adjacent enough in the same module that
`list-ops` was swept into the same bucket.

A `server.ts`-only parse fails in **both** directions, and the more expensive
failure is the quiet one:

- It reports **green** while `list-ops` stays undocumented indefinitely — the
  guard's field of view is narrower than the surface it claims to assert over, so
  the one tool it cannot see is the one tool it can never protect.
- It reports a **false red** the day someone adds a `list-ops` README row, because
  the reverse assertion ("no documented tool is unregistered") would flag a row
  that is, in fact, correct.

The first is the scope-narrowing shape `CLAUDE.md` § "Conventions" already
warns about at length: a check that is green from the start never enters an
expected-red baseline, so nothing downstream re-tests it.

## Decision

**The guard parses two modules**: `src/mcp/server.ts` (`reg(` call sites) and
`src/mcp/opsRegistry.ts` (`registerTool(` call sites). Together these are the
complete static MCP tool surface.

**Dynamic tools are excluded by anchoring on a double-quoted string literal**, not
by an exception list. The two registration styles differ in quote character, and
that difference is not incidental — it is forced by the semantics:

| Registration | Literal | Static? |
|---|---|---|
| `reg("list-global-layers", …)` | `"…"` | yes |
| `registerTool("list-ops", …)` | `"…"` | yes |
| ``registerTool(`op-${op.name}`, …)`` | `` `…` `` | **no** — name is per-project |

A dynamically-named tool *cannot* be written as a static double-quoted literal,
because its name is not known until an op file is read. So the anchor does not
merely happen to exclude the dynamic tools today; it excludes them for the reason
they are dynamic.

**This property must be pinned by a test on the negative case.** A parser whose
exclusion rule is implicit in a regex is exactly the thing that regresses silently
the next time someone touches it — the guard would keep passing while quietly
narrowing. The test asserts that the parser returns `list-ops` and no `op-`
prefixed name from `opsRegistry.ts`.

**The placement assertion is total.** The README's three bold-labelled sub-tables
already *are* a rendering of the annotation classes (`READ_ONLY`, `MUTATE`,
`REGENERATE`). `generate-sids` carries a fourth, `NON_IDEMPOTENT_READ` — it reads
source only but mints fresh SIDs per call, so it is neither a plain read nor a
mutation. It gets its own `**Non-idempotent read tool**` sub-table, keeping the
class↔label mapping bijective so the guard asserts placement with **no per-tool
exception**.

## Consequences

- The complete static MCP tool surface is guarded. Adding a tool in either module
  without a README row fails the suite.
- A future third registration site would be invisible to the guard. The
  parser-sanity row (a plausible-count floor on both sides, mirroring the CLI
  half's existing row) is the backstop that catches a parse silently matching
  zero, but it cannot catch a *new* module. Registering static tools outside these
  two modules is therefore a decision that must come back here.
- Adding a fifth annotation preset requires a fifth sub-table, by construction.
  This is deliberate: the alternative is an exception list, which is where drift
  hides.
- The `README.md` `regenerate` row's generator count is now a documented fact with
  an oracle (`GENERATORS.length`), rather than prose nobody re-reads.

## Alternatives rejected

**1. Parse `src/mcp/server.ts` only, and document `list-ops` as a known
exclusion.** This is #199 as filed. Rejected because a documented exclusion is
still an unguarded tool, and because the reverse assertion would then be *wrong* —
it would reject a correct README row. Documenting a blind spot does not remove it.

**2. Parse `server.ts` generically and hard-code `list-ops` as an extra entry.**
Honest and obvious at the moment of writing, and it produces the same 37-tool set
today. Rejected because the hard-code encodes a count rather than a rule: it rots
silently the moment `opsRegistry` registers a second static tool, and it would rot
green — the new tool would be undocumented and unguarded, with nothing failing.
This is the count-versus-rule distinction `CLAUDE.md` § "Conventions" draws in its
fifth and seventh counting traps, applied to a test rather than to prose.

**3. Fold `generate-sids` into the Read tools table with a prose caveat.**
Semantically defensible — it mutates no source file. Rejected because it forces
the guard to carry an exception ("`generate-sids` may sit in Read tools despite its
annotation"), and a placement assertion with one exception is a placement
assertion that will acquire a second.
