# Reference

How to drive the tool: every CLI subcommand, the recipe format and its
operations, the generator pipeline, and user-defined ops.

See the [wiki index](../index.md) for the other sections.

* [CLI Reference — Addon Tooling](cli-addons.md) -
  CLI flag documentation for the addon-tooling commands (`read-addon`,
  `validate-addons`, `list-addons`, `diff-addon-aces`, `scan-addon-usage`,
  `sync-addon-metadata`), split out of `cli.md` as that cluster grows
* [CLI Reference](cli.md) -
  Full CLI flag documentation for every subcommand except the addon-tooling
  cluster
* [Generators Reference](generators.md) -
  The 6 generators, `extracted/` output format, cross-referencing, localVars
  matching
* [User-Defined Ops](ops.md) -
  User-defined ops: op file format, param types, substitution rules, MCP
  (`list-ops` / `op-<projectId>_<opName>` / hot reload) and CLI (`list-ops` /
  `apply-op`) surfaces, and the `ops.dir` / `ops.watch` config keys
* [Recipe Reference](recipe-reference.md) -
  All event-sheet + layout + workflow recipe ops, SID addressing, builder
  shorthands, and the numbered recipe gotchas/bugs (read before touching the
  recipe interpreter/validator)
