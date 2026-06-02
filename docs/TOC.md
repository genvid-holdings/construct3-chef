# Documentation Index

<!--
Genvid plugin skills consult this index to find this project's docs.
Each entry is a one-line description. See CLAUDE.md for the high-level
map (§ "Where to read more").
-->

## This tool's usage

- `recipe-reference.md` — all event-sheet + layout + workflow recipe ops, SID addressing, builder shorthands, and the numbered recipe gotchas/bugs (read before touching the recipe interpreter/validator)
- `generators.md` — the 6 generators, `extracted/` output format, cross-referencing, localVars matching
- `cli.md` — full CLI flag documentation for every subcommand

## Architecture & design rationale

- `mcp-architecture.md` — MCP server design (stdio transport, file-based model, txId/extractedDirty/watcher concurrency, Logger/ReadWriteLock decisions, security posture, SDK research, prior-art comparison)
- `prior-art-construct3-mcp.md` — imported reference/design record from the originating monorepo

## C3 platform reference (the *why* behind the gotchas)

C3 platform reference (event-sheet & layout JSON structure, the scripting API,
the TS async/concurrency model) now lives in the **genvid-c3** Claude Code
plugin at `${CLAUDE_PLUGIN_ROOT}/docs/c3/*`. construct3-chef owns the *tooling*
docs above; the plugin owns the *platform* knowledge.
