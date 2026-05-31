# Documentation Index

<!--
Genvid plugin skills consult this index to find this project's docs.
Each entry is a one-line description. See CLAUDE.md for the high-level
map (§ "Where to read more").
-->

## This tool's usage

- `recipe-reference.md` — all event-sheet + layout + workflow recipe ops, SID addressing, builder shorthands, and the numbered recipe gotchas/bugs (read before touching the recipe interpreter/validator)
- `generators.md` — the 5 generators, `extracted/` output format, cross-referencing, localVars matching
- `cli.md` — full CLI flag documentation for every subcommand

## Architecture & design rationale

- `mcp-architecture.md` — MCP server design (stdio transport, file-based model, txId/extractedDirty/watcher concurrency, Logger/ReadWriteLock decisions, security posture, SDK research, prior-art comparison)
- `prior-art-construct3-mcp.md` — imported reference/design record from the originating monorepo

## C3 platform reference (the *why* behind the gotchas)

- `c3/README.md` — index of the C3 platform reference set
- `c3/event-sheet-architecture.md` — event sheet JSON structure
- `c3/layout-reference.md` — layout JSON structure (layers, instances, scene graph)
- `c3/scripting-reference.md` — C3 scripting API
- `c3/typescript-integration.md` — TS defs, the async/concurrency model
