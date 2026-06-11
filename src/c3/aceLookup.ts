import { loadReferenceCache, type AceEntry, type ChunkEntry } from "./c3Reference.js";
import { buildAddonAceRegistry } from "./aceRegistry.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum query length — mirrors search.ts's 500-char ReDoS mitigation cap. */
const MAX_QUERY_LENGTH = 500;

// ── Public types ──────────────────────────────────────────────────────────────

export interface LookupOptions {
  /** Free-text query. Tokens are matched literally (NOT as a regex). */
  query?: string;
  /** Filter by objectClass (ACEs) or chunk title substring. Case-insensitive. */
  object?: string;
  /** Filter by ACE id (exact, case-insensitive). ACE-only — excludes chunks when set. */
  id?: string;
  /** Filter by ACE param name (substring, case-insensitive). ACE-only — excludes chunks when set. */
  param?: string;
  /**
   * Maximum results returned per array (aces and chunks independently).
   * Limit is applied to each array independently so a high-ACE result doesn't starve chunks.
   * Default: 50.
   */
  limit?: number;
}

export interface LookupResult {
  aces: AceEntry[];
  chunks: ChunkEntry[];
  /** True when a c3-reference cache was found and loaded from extractedDir. */
  cachePresent: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Source priority for ranking: addon first, then manual, then builtin. */
const SOURCE_PRIORITY: Record<AceEntry["source"], number> = {
  addon: 0,
  manual: 1,
  builtin: 2,
};

/**
 * Split a (pre-lowercased, capped) query into non-empty tokens.
 */
function tokenize(query: string): string[] {
  return query.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Count how many tokens from `tokens` appear as substrings in `text`.
 * Both `tokens` and `text` are expected to be already lowercased.
 */
function scoreTokens(tokens: string[], text: string): number {
  let score = 0;
  for (const t of tokens) {
    if (text.includes(t)) score++;
  }
  return score;
}

/** Build the searchable text for an ACE entry. */
function aceSearchText(ace: AceEntry): string {
  return `${ace.id} ${ace.objectClass} ${ace.scriptName ?? ""} ${ace.description ?? ""}`.toLowerCase();
}

/** Build the searchable text for a chunk entry. */
function chunkSearchText(chunk: ChunkEntry): string {
  return `${chunk.title} ${chunk.text}`.toLowerCase();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up ACEs and reference-cache chunks from all sources (addon ACEs from the
 * project's installed addons + builtin/manual ACEs and prose chunks from the
 * c3-reference cache in extractedDir).
 *
 * Filters are AND-combined; an undefined filter is a no-op.
 *
 * `id` and `param` are ACE-only filters: when either is set, chunks are excluded
 * from the result because they cannot carry an ACE id or param (prose chunks are
 * noise for exact ACE lookups).
 *
 * Never throws — the underlying helpers swallow I/O errors; lookup adds no new
 * throw sites.
 */
export function lookup(projectRoot: string, extractedDir: string, options: LookupOptions): LookupResult {
  const limit = options.limit ?? 50;

  // ── Load sources ────────────────────────────────────────────────────────────

  const cache = loadReferenceCache(extractedDir);
  const cachePresent = cache !== null;

  const allAces: AceEntry[] = [...buildAddonAceRegistry(projectRoot), ...(cache?.aces ?? [])];
  const allChunks: ChunkEntry[] = cache?.chunks ?? [];

  // ── Determine which filters are active ─────────────────────────────────────

  const hasId = options.id !== undefined;
  const hasParam = options.param !== undefined;
  const hasObject = options.object !== undefined;
  const hasQuery = options.query !== undefined;

  // ACE-only filters: when id or param is set, chunks are excluded.
  const aceOnlyFilterActive = hasId || hasParam;

  // ── Prepare query tokens ────────────────────────────────────────────────────

  let queryTokens: string[] = [];
  if (hasQuery) {
    // Cap query length to mitigate pathological inputs (mirrors search.ts behaviour).
    const rawQuery = options.query!.slice(0, MAX_QUERY_LENGTH).toLowerCase();
    queryTokens = tokenize(rawQuery);
  }

  const idLower = hasId ? options.id!.toLowerCase() : "";
  const paramLower = hasParam ? options.param!.toLowerCase() : "";
  const objectLower = hasObject ? options.object!.toLowerCase() : "";

  // ── Filter & score ACEs ─────────────────────────────────────────────────────

  type ScoredAce = { ace: AceEntry; score: number };
  const scoredAces: ScoredAce[] = [];

  for (const ace of allAces) {
    // object: exact match on objectClass (case-insensitive)
    if (hasObject && ace.objectClass.toLowerCase() !== objectLower) continue;

    // id: exact match (case-insensitive)
    if (hasId && ace.id.toLowerCase() !== idLower) continue;

    // param: any param name contains the substring (case-insensitive)
    if (hasParam && !ace.params.some((p) => p.name.toLowerCase().includes(paramLower))) continue;

    // query: score token matches; exclude if score is zero and query is active
    let score = 0;
    if (hasQuery) {
      if (queryTokens.length > 0) {
        score = scoreTokens(queryTokens, aceSearchText(ace));
        if (score === 0) continue;
      }
      // If all tokens were empty (edge case), skip nothing — score stays 0.
    }

    scoredAces.push({ ace, score });
  }

  // Sort ACEs: by score desc → source priority asc → stable insertion order
  scoredAces.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return SOURCE_PRIORITY[a.ace.source] - SOURCE_PRIORITY[b.ace.source];
  });

  const aces = scoredAces.slice(0, limit).map((s) => s.ace);

  // ── Filter & score chunks ───────────────────────────────────────────────────

  // When an ACE-only filter (id or param) is active, exclude all chunks.
  let chunks: ChunkEntry[] = [];

  if (!aceOnlyFilterActive) {
    type ScoredChunk = { chunk: ChunkEntry; score: number };
    const scoredChunks: ScoredChunk[] = [];

    for (const chunk of allChunks) {
      // object: chunk title contains the substring (case-insensitive)
      if (hasObject && !chunk.title.toLowerCase().includes(objectLower)) continue;

      // query: score token matches; exclude if score is zero and query is active
      let score = 0;
      if (hasQuery) {
        if (queryTokens.length > 0) {
          score = scoreTokens(queryTokens, chunkSearchText(chunk));
          if (score === 0) continue;
        }
      }

      scoredChunks.push({ chunk, score });
    }

    // Sort chunks: by score desc → stable insertion order
    scoredChunks.sort((a, b) => b.score - a.score);

    chunks = scoredChunks.slice(0, limit).map((s) => s.chunk);
  }

  return { aces, chunks, cachePresent };
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/**
 * Render a `LookupResult` to plain text — the body shared by the CLI and MCP
 * `search-docs` handler. Output is the same regardless of invocation surface.
 *
 * Format:
 * - Header: `<n> ACE(s), <m> doc chunk(s)`
 * - No-cache note when `!cachePresent`
 * - ACE lines: `[<source> <kind>] <objectClass>.<id>(<param names>)[…]`
 * - Blank separator, then chunk lines: `[<category>] <title> — <text…200>  [url?]`
 * - "No results found." (plus no-cache note) when both arrays are empty
 */
export function formatLookupResult(result: LookupResult): string {
  const { aces, chunks, cachePresent } = result;

  const noCacheNote =
    "\n(no c3-reference cache — only custom-addon ACEs available; run the genvid-c3 build-reference skill for built-in/layout/scripting/expression coverage)";

  if (aces.length === 0 && chunks.length === 0) {
    return `No results found.${cachePresent ? "" : noCacheNote}`;
  }

  const lines: string[] = [`${aces.length} ACE(s), ${chunks.length} doc chunk(s)`];
  if (!cachePresent) {
    lines.push(noCacheNote.trimStart());
  }

  for (const ace of aces) {
    const paramNames = ace.params.map((p) => p.name).join(", ");
    let line = `[${ace.source} ${ace.kind}] ${ace.objectClass}.${ace.id}(${paramNames})`;
    if (ace.scriptName) line += ` — script:${ace.scriptName}`;
    if (ace.description) line += ` — ${ace.description}`;
    if (ace.canonicalUrl) line += `  [${ace.canonicalUrl}]`;
    lines.push(line);
  }

  if (chunks.length > 0) {
    lines.push("");
    for (const chunk of chunks) {
      const truncated = chunk.text.replace(/\r?\n/g, " ").slice(0, 200);
      let line = `[${chunk.category}] ${chunk.title} — ${truncated}`;
      if (chunk.canonicalUrl) line += `  [${chunk.canonicalUrl}]`;
      lines.push(line);
    }
  }

  return lines.join("\n");
}
