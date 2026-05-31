import * as fs from "node:fs";
import * as path from "node:path";
import { OptimisticWatcher, type ExpectedChanges, type WatcherFactory, type Logger } from "@genvid/mcp-utils";

/** Source directories whose external edits invalidate extracted/ (mark it dirty). */
export const SOURCE_DIRS = ["eventSheets", "layouts", "objectTypes", "families", "scripts"] as const;

export interface SourceWatcherOptions {
  projectRoot: string;
  /** Shared ExpectedChanges registry; self-writes are registered via watcher.expect(). */
  expected: ExpectedChanges;
  /**
   * Invoked for an EXTERNAL change to a watched source directory (not
   * project.c3proj). The watcher has already bumped txId; this is where the
   * consumer marks extracted/ dirty. NOT called for project.c3proj edits, which
   * bump txId only.
   */
  onSourceChange?: (filePath: string) => void;
  /** Injectable watcher factory (tests pass a stub). Defaults to fs.watch. */
  watcherFactory?: WatcherFactory;
  logger?: Logger;
}

/**
 * Default factory: fs.watch each target, firing the **native** absolute path
 * (`path.resolve`, NOT toPosixPath). This matches `OptimisticWatcher.expect()`,
 * which stores `path.resolve(filePath)` — keeping Layer-2 suppression working on
 * Windows, where the library's built-in toPosixPath factory would mismatch the
 * native-separator key. Handles both directories (recursive) and a single file
 * (project.c3proj), which fs.watch reports with the basename as `filename`.
 */
const fsWatchFactory: WatcherFactory = (target, onEvent) => {
  const isFile = fs.statSync(target).isFile();
  const watcher = fs.watch(target, { recursive: !isFile }, (_event, filename) => {
    if (isFile) {
      onEvent(path.resolve(target));
      return;
    }
    if (filename == null) return;
    onEvent(path.resolve(target, filename.toString()));
  });
  return { close: () => watcher.close() };
};

/**
 * Build an OptimisticWatcher over the project's source dirs + project.c3proj.
 *
 * - External source-dir change  → txId bump (by the watcher) + onSourceChange.
 * - External project.c3proj change → txId bump only (no onSourceChange).
 * - Self-writes are suppressed via `suppress()` (Layer 1) / `expect()` (Layer 2).
 *
 * Only existing targets are watched (missing dirs are skipped, matching the old
 * setupWatchers behavior).
 */
export function createSourceWatcher(opts: SourceWatcherOptions): OptimisticWatcher {
  const c3projPath = path.resolve(opts.projectRoot, "project.c3proj");

  const watchDirs = SOURCE_DIRS.map((d) => path.join(opts.projectRoot, d)).filter((d) => fs.existsSync(d));
  if (fs.existsSync(c3projPath)) watchDirs.push(c3projPath);

  return new OptimisticWatcher({
    watchDirs,
    expected: opts.expected,
    watcherFactory: opts.watcherFactory ?? fsWatchFactory,
    logger: opts.logger,
    onExternalChange: (filePath) => {
      // project.c3proj bumps txId but does NOT mark extracted/ dirty.
      if (path.resolve(filePath) !== c3projPath) {
        opts.onSourceChange?.(filePath);
      }
    },
  });
}
