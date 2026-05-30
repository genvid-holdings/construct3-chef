import * as fs from "fs";
import * as path from "path";
import { walkFiles, toPosixPath } from "genvid-mcp-utils";

/** File category for search operations. */
export type SearchType = "dsl" | "ts" | "layout" | "md" | "json" | "idx";

export interface SearchOptions {
  /** Regex pattern to search for. */
  pattern: string;
  /** File category. Default: "dsl". */
  type?: SearchType;
  /** Single file path or directory prefix to restrict scope. */
  path?: string;
  /** Context lines around matches (grep -C behavior). */
  context?: number;
}

export interface SearchConfig {
  projectRoot: string;
  extractedDir: string;
  maxMatches?: number; // default 1000
  maxPatternLength?: number; // default 500
}

export interface SearchResult {
  lines: string[];
  truncated: boolean;
  /** True when search targeted extracted/ files (stale warning applies). */
  isExtracted: boolean;
}

interface TypeEntry {
  baseDir: "extracted" | "project";
  subDir: string;
  ext: string;
}

const TYPE_MAP: Record<SearchType, TypeEntry> = {
  dsl: { baseDir: "extracted", subDir: "eventSheets", ext: ".dsl.txt" },
  ts: { baseDir: "extracted", subDir: "eventSheets", ext: ".ts" },
  layout: { baseDir: "extracted", subDir: "layouts", ext: ".layout.txt" },
  md: { baseDir: "extracted", subDir: "domain-index", ext: ".md" },
  idx: { baseDir: "extracted", subDir: "eventSheets", ext: ".dsl.idx.txt" },
  json: { baseDir: "project", subDir: "", ext: ".json" },
};


/**
 * Format a set of line windows (with context) for a single file.
 * Returns an array of output lines, with "--" separators between non-adjacent groups.
 */
function formatWithContext(
  filePath: string,
  fileLines: string[],
  matchIndices: number[],
  contextSize: number
): string[] {
  if (matchIndices.length === 0) return [];

  // Build windows [start, end] (inclusive, 0-based)
  const windows: Array<{ start: number; end: number }> = matchIndices.map((idx) => ({
    start: Math.max(0, idx - contextSize),
    end: Math.min(fileLines.length - 1, idx + contextSize),
  }));

  // Merge overlapping or adjacent windows
  const merged: Array<{ start: number; end: number }> = [];
  for (const win of windows) {
    if (merged.length === 0 || win.start > merged[merged.length - 1].end + 1) {
      merged.push({ start: win.start, end: win.end });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, win.end);
    }
  }

  // Format output lines with separators between non-adjacent groups
  const output: string[] = [];
  for (let g = 0; g < merged.length; g++) {
    if (g > 0) {
      output.push("--");
    }
    const { start, end } = merged[g];
    for (let i = start; i <= end; i++) {
      output.push(`${filePath}:${i + 1}: ${fileLines[i]}`);
    }
  }

  return output;
}

/**
 * Search files according to the provided options and config.
 * Throws on invalid input (path traversal, pattern too long, json missing prefix).
 */
export function search(config: SearchConfig, options: SearchOptions): SearchResult {
  const maxMatches = config.maxMatches ?? 1000;
  const maxPatternLength = config.maxPatternLength ?? 500;
  const searchType = options.type ?? "dsl";
  const contextSize = options.context ?? 0;

  // Validate pattern length
  if (options.pattern.length > maxPatternLength) {
    throw new Error(
      `Pattern too long (${options.pattern.length} chars, max ${maxPatternLength})`
    );
  }

  // Path traversal check
  if (options.path !== undefined) {
    if (options.path.includes("..")) {
      throw new Error(`Invalid path '${options.path}' — path traversal with '..' is not allowed`);
    }
  }

  const typeEntry = TYPE_MAP[searchType];
  const isExtracted = typeEntry.baseDir === "extracted";
  const baseRoot = isExtracted ? config.extractedDir : config.projectRoot;

  // json type validation: path must start with eventSheets/ or layouts/
  if (searchType === "json") {
    if (options.path === undefined) {
      throw new Error(
        "path is required for json type — must include 'eventSheets/' or 'layouts/' prefix"
      );
    }
    const normalized = toPosixPath(options.path);
    if (!normalized.startsWith("eventSheets/") && !normalized.startsWith("layouts/")) {
      throw new Error(
        `json type path must start with 'eventSheets/' or 'layouts/', got: '${options.path}'`
      );
    }
  }

  // Compile regex
  const regex = new RegExp(options.pattern);

  // Resolve file(s) to search
  let filesToSearch: string[];

  if (options.path !== undefined) {
    const typeSubDir = typeEntry.subDir;
    // Candidate: treat path as a file stem (join with subDir if applicable)
    // For json, path already includes eventSheets/ or layouts/ prefix — join directly with baseRoot
    let candidatePath: string;
    if (searchType === "json") {
      candidatePath = path.join(baseRoot, options.path + typeEntry.ext);
    } else if (typeSubDir) {
      // For extracted types with a subDir, path is relative to subDir
      // First try: path relative to subDir as a direct file
      const inSubDir = path.join(baseRoot, typeSubDir, options.path + typeEntry.ext);
      const asDir = path.join(baseRoot, typeSubDir, options.path);
      if (fs.existsSync(inSubDir)) {
        filesToSearch = [inSubDir];
      } else if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
        filesToSearch = walkFiles(asDir, typeEntry.ext);
      } else {
        // Fallback: treat path as directory prefix within subDir
        filesToSearch = walkFiles(asDir, typeEntry.ext);
      }
      // Early assignment done above in if/else, skip normal candidatePath logic
      candidatePath = "";
    } else {
      candidatePath = path.join(baseRoot, options.path + typeEntry.ext);
    }

    // If we haven't assigned filesToSearch yet (json case and non-subDir case)
    if (!filesToSearch!) {
      if (candidatePath && fs.existsSync(candidatePath)) {
        filesToSearch = [candidatePath];
      } else {
        // Treat path as directory prefix
        const dirPath = path.join(baseRoot, typeEntry.subDir, options.path);
        filesToSearch = walkFiles(dirPath, typeEntry.ext);
      }
    }
  } else {
    // No path: walk entire subDir
    const searchRoot = path.join(baseRoot, typeEntry.subDir);
    filesToSearch = walkFiles(searchRoot, typeEntry.ext);
  }

  // Perform search
  const outputLines: string[] = [];
  let truncated = false;
  let matchCount = 0;

  for (const filePath of filesToSearch) {
    if (truncated) break;

    const content = fs.readFileSync(filePath, "utf-8").split("\n");
    const relPath = toPosixPath(
      isExtracted
        ? path.relative(config.extractedDir, filePath)
        : path.relative(config.projectRoot, filePath)
    );

    if (contextSize > 0) {
      // Collect matching line indices
      const matchIndices: number[] = [];
      for (let i = 0; i < content.length; i++) {
        if (regex.test(content[i])) {
          matchIndices.push(i);
          matchCount++;
          if (matchCount >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }

      if (matchIndices.length > 0) {
        const contextLines = formatWithContext(relPath, content, matchIndices, contextSize);
        outputLines.push(...contextLines);
      }
    } else {
      // No context: simple line matching
      for (let i = 0; i < content.length; i++) {
        if (regex.test(content[i])) {
          outputLines.push(`${relPath}:${i + 1}: ${content[i]}`);
          matchCount++;
          if (matchCount >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }
    }
  }

  return { lines: outputLines, truncated, isExtracted };
}
