import { mcpError } from "@genvidtech/mcp-utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectContext } from "./projectContext.js";

/**
 * Composite `<projectId>:<counter>` txId codec (#95, ADR `wiki/decisions/0034`).
 * Under single-project MCP the txId
 * was a bare integer; under multi-project two projects sitting at the same
 * counter value is the common case, not a coincidence (both start at 0 and
 * increment per mutation), so a bare integer from project alpha would be
 * silently accepted against project beta. This module makes the token
 * self-describing so a cross-project token is a detectable error rather
 * than a silent accept.
 *
 * Off-barrel deliberately: not re-exported from `src/index.ts` — this is
 * server-internal wire format, not library API (repo is at 1.0.0, and a
 * barrel export is a permanent public-API commitment).
 *
 * `server.ts` routes every txId site through this module: 10 accepting
 * schemas, 6 comparisons, and both emissions (`txIdLine` and `get-state`'s
 * inline one). That conversion landed while the registry still held exactly
 * one project, which is what made it atomic by construction — one context
 * means one counter, so no intermediate state could misattribute a token.
 */

/** Project ids may not contain `:` or whitespace, and may not be empty —
 * enforced at `ProjectRegistry.add` through `@genvidtech/mcp-utils`'
 * `isValidProjectId`, the same rule this wire format's other consumers apply
 * (#217). The `:` half is what makes splitting at the last `:` unambiguous. */
export function formatTxToken(id: string, counter: number): string {
  return `${id}:${counter}`;
}

/**
 * Parse a `<projectId>:<counter>` token. Returns a discriminated result
 * rather than throwing, and never NaN-propagates a malformed counter —
 * `Number(...)` on a non-numeric or empty string is rejected explicitly
 * rather than returned as `NaN` for a caller to compare against.
 *
 * Splits at the LAST `:` (ids may not contain `:`, but this is robust even
 * if that invariant were ever violated upstream — the counter is always the
 * suffix after the final separator).
 *
 * Malformed-input table (`s` -> result):
 * - `"alpha:5"`  -> `{ id: "alpha", counter: 5 }` (well-formed)
 * - `"alpha"`    -> error (no `:` — `lastIndexOf` returns -1)
 * - `"alpha:"`   -> error (empty counter segment)
 * - `"alpha:xyz"` -> error (non-numeric counter)
 * - `":5"`       -> error (empty id segment)
 * - `""`         -> error (no `:`)
 * - `"alpha:5:6"` -> `{ id: "alpha:5", counter: 6 }` — split at the LAST `:`;
 *   this is a malformed id per the enforced invariant, but parsing is a pure
 *   function that doesn't re-validate that invariant, so it's accepted here
 *   and would be caught downstream by an id lookup miss, not by the parser.
 */
export function parseTxToken(s: string): { id: string; counter: number } | { error: string } {
  const idx = s.lastIndexOf(":");
  if (idx === -1) {
    return { error: `Invalid txId '${s}' — expected format '<projectId>:<counter>'` };
  }
  const id = s.slice(0, idx);
  const counterText = s.slice(idx + 1);
  if (id === "") {
    return { error: `Invalid txId '${s}' — missing project id before ':'` };
  }
  if (counterText === "" || !/^\d+$/.test(counterText)) {
    return { error: `Invalid txId '${s}' — counter '${counterText}' is not a non-negative integer` };
  }
  return { id, counter: Number(counterText) };
}

/**
 * Compare a caller-supplied txId token against a project context's current
 * state, for the optimistic-concurrency check `apply-recipe`/`sync-project`/
 * etc. already perform (see ADR `wiki/decisions/0005`).
 *
 * - `token === undefined` -> `null` (pass). The check is OPT-IN today — a
 *   caller that omits `txId` proceeds unconditionally. Preserving that
 *   exactly is what keeps this change scoped to the token's FORMAT, not its
 *   optionality.
 * - malformed token (fails {@link parseTxToken}) -> error naming the token
 *   and the expected shape.
 * - `token`'s id !== `ctx.id` -> error naming BOTH ids (the id this token
 *   was minted for, and the project this call actually targets) — this is
 *   what T-X4 grades: a token minted for one project must be
 *   rejected against another, even at an identical counter value.
 * - id matches but the counter has moved -> the existing "State changed"
 *   wording server.ts already uses today, updated to carry composite tokens
 *   on both sides. `server.ts` varies its trailing clause per call site
 *   (`— re-validate before applying` / `before syncing` / `before
 *   scaffolding`, 2 sites each, 6 total), and that verb is worth keeping:
 *   it tells the caller which operation to redo. Pass it as `action`
 *   ("applying" / "syncing" / "scaffolding") and each site reproduces its
 *   message byte-identically. Omitting `action` yields the bare
 *   `— re-validate`, so the token format is the only observable change.
 * - otherwise -> `null` (pass).
 */
export function compareTxToken(ctx: ProjectContext, token?: string, action?: string): CallToolResult | null {
  if (token === undefined) {
    return null;
  }
  // Every rejection carries the CURRENT token as a footer, matching what each
  // call site did by hand before this codec existed (`{ extraLines: [txIdLine(ctx)] }`).
  // It is what lets a client re-validate immediately instead of issuing a
  // second call just to learn the value it was already being rejected against.
  const current = formatTxToken(ctx.id, ctx.watcher.txId);
  const footer = { extraLines: [`txId: ${current}`] };

  const parsed = parseTxToken(token);
  if ("error" in parsed) {
    return mcpError(parsed.error, footer);
  }
  if (parsed.id !== ctx.id) {
    return mcpError(`txId '${token}' is for project '${parsed.id}' but this call targets project '${ctx.id}'`, footer);
  }
  if (parsed.counter !== ctx.watcher.txId) {
    const suffix = action === undefined ? "" : ` before ${action}`;
    return mcpError(`State changed (expected ${token}, got ${current}) — re-validate${suffix}`, footer);
  }
  return null;
}
