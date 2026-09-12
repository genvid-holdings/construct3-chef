---
type: practice-note
title: Local verification practice
description: How a change is verified locally in construct3-chef — bootstrap, the validate gate and its timing, fixture safety, and the failure modes where a green result proves nothing — or a red one proves only that two suite runs collided
tags: [verification, testing, fixtures, workflow]
status: stable
stale_after: 2027-02-16
generated: { by: process:maintain-wiki, at: 2026-08-16T18:24:29Z }
usage_window: { from: 2026-08-16, to: 2026-08-16 }
sources:
  - id: agent-memory
    resource: ../raw/2026-08-16-agent-memory-local-verification.md
    title: Capture of five construct3-chef agent auto-memory entries on local verification
    last_modified: 2026-08-16
  - id: agent-memory-origin
    resource: file:///C:/Users/FabienNinoles/.claude/projects/C--repos-construct3-chef/memory/
    title: Claude Code project-scoped auto-memory directory (machine-local origin of the capture)
    last_modified: 2026-08-16
---

# Local verification practice

This page records how a change to construct3-chef is actually checked locally
before it's considered done — the bootstrap step, the shape and timing of the
validate gate, how to smoke-test without corrupting a golden-tested fixture,
and, most importantly, two concrete ways a "green" result can still be
verifying nothing. None of this lived in the repository's own documentation
before this page: it was recorded only in a Claude Code agent's project-scoped
auto-memory, a machine-local store outside the repo that isn't visible to a
fresh clone or to other contributors[^agent-memory-origin].

## Bootstrap

A freshly created worktree starts with no `node_modules/`. The only bootstrap
step before running `npm run typecheck`, `npm test`, or `npm run lint` is
`npm install`[^agent-memory]. The repo uses npm with a committed
`package-lock.json`; CI runs `npm ci`. There used to be a second bootstrap
layer — a private-tarball fetch (`scripts/download-deps.mjs` plus a
`.packages-version` file and an `az login`/1Password step pulling
`c3source`/`genvid-mcp-utils` tarballs from Azure Blob into `.packages/*.tgz`)
— but it was retired once those two leaf packages went public on npm. That
script, the version file, and the `.packages/` directory no longer exist;
`npm install` resolves both packages from the registry like any other
dependency[^agent-memory].

## Running the gate

`npm run lint` (ESLint plus the Prettier `format:check` step, over both
`src/` and `test/`) and `npm test` (mocha + tsx, on the order of 1250 tests)
each take roughly one to two minutes[^agent-memory]. That exceeds the default
120-second timeout most tool-calling environments apply to a shell command, so
a bare invocation of either can time out and force a wasted re-run — this
actually happened during issue #98, where a `npm run lint` call timed out at
120 seconds and had to be re-run with a longer budget[^agent-memory]. Give the
gate an explicit timeout of at least 300000 ms, and prefer running `lint` and
`test` as separate calls rather than chaining them into one command that's
more likely to blow a shorter budget. `npm run typecheck` is comparatively
fast and doesn't need the same allowance.


**Run one suite at a time — concurrent invocations manufacture false failures.**
`package.json` wires `pretest: npm run fixture:prep` (and `pretest:file`
likewise), so **every** `npm test` re-materializes the fixture before mocha
starts, and `scripts/prep-fixture.mjs` does a recursive
`cpSync(source, dest)` straight over the live tree. A second `npm test`
launched while a first is still running therefore rewrites the very files the
first is reading. On issue
[#217](https://github.com/GenvidTechnologies/construct3-chef/issues/217) three
back-to-back invocations — a tail, a grep, and a filtered re-run of the same
command — produced four failures (`K1 fileSuffixes`, the `R6`/`R8` drift rows,
and a 5000 ms timeout in `serverHandlers.test.ts`) against a tree that was
clean; a single run immediately afterwards was green at 1730 passing. Every
failure sat in a fixture-dependent suite, which is the diagnostic signature.

This is the mirror of *Where a green result proves nothing* below, and the
more expensive direction: a false **red** sends you to "fix" code that was
already correct. So when fixture-dependent suites fail unexpectedly, do not
start debugging them — confirm no other suite run is in flight, run
`npm run fixture:verify` (its four assertions are the real oracle; `git status`
cannot see fixture drift, because the directory is gitignored except the
tracked overlay), and re-run once. Treat a failure that does not reproduce on
a clean single run as contention, not signal. Practically: capture output to a
file and read it afterwards, rather than re-running the suite to re-filter its
output.

## Smoke-testing without corrupting the fixture

`test/fixtures/construct3-chef-sample/` is real C3-export data that the
golden test (`test/c3/sampleProjectGolden.test.ts`) diffs byte-for-byte
against a committed golden. Never point a **mutating** command — `sync-project`,
`apply-recipe`, `clone-layout`, `generate`, or any of the workflow ops — at
that fixture as a smoke test[^agent-memory]. It can silently rewrite the
committed `project.c3proj` or `extracted/` output and break the golden diff,
or worse, corrupt the fixture outright if it wasn't already in sync; on issue
#52 a `sync-project` smoke test against the sample fixture happened to stay
clean only because the project was already in sync and `runSync` wrote
nothing[^agent-memory].

Prefer `validate-project`, the non-mutating dry-run variant of
`sync-project` — it shares the same `reportImageDrift`/`runSync(dryRun)` code
paths, so it exercises the read/report logic without writing anything. If the
write path itself needs exercising, `cpSync` the fixture to a temporary
directory first and mutate the copy. Either way, run `git status --
test/fixtures/` afterward to confirm nothing changed. A related trap: avoid
`cd`-ing into the fixture directory in a Bash tool call — the working
directory persists across calls, so a later `npx tsx src/cli.ts` invocation
that assumes the repo root as cwd gets silently stranded. Use absolute paths
instead[^agent-memory].

## Where a green result proves nothing

The most important part of this practice is knowing the specific shapes in
which "the suite passed" or "the reviewer found nothing" is not actually
evidence that the change is correct.

**A green golden can hide a red sibling.** Whenever the sample fixture is
touched at all — regenerating `extracted/` from it, or editing its source
JSON directly — the correct check is the *full* `npm test`, not just
`sampleProjectGolden.test.ts`[^agent-memory]. Other tests assert against the
fixture's generated DSL and its raw content, and they can break silently even
while the golden itself stays green. Two documented failure modes:

- *DSL line-number shift (#124).* Adding two behavior `do:` lines above Event
  sheet 1's go-to-layout call shifted that call's DSL line from 12 to 14.
  `sampleProjectGolden.test.ts` went green after regenerating, because the
  golden was regenerated to match — but `navigationGraph.test.ts`, which
  asserts the go-to-layout call's DSL `lineNumber` directly, stayed red and
  wasn't caught until two tasks later[^agent-memory].
- *Real-fixture content assertions (#125).* Adding `MyCompany_MyEffect`
  `effectTypes` entries to `Sprite2.json` and `TextFamily.json` broke four
  `deep.equal` assertions in `projectObjects.test.ts`, which an earlier task
  had hard-coded against the pre-edit `effectTypes` values read straight from
  the real fixture. The golden diff was **zero**, because `effectTypes` feeds
  no generator — so nothing about the read surface changed, and only the
  content assertions elsewhere broke[^agent-memory].

The zero-diff golden in the second case is the more deceptive of the two: a
line-number shift at least produces *some* signal (the golden had to be
regenerated), but a field that feeds no generator can change on disk while
the golden test reports perfect stability, leaving the raw-content assertions
as the only thing standing between the change and a silently broken sibling
test.

**A green suite and a clean reviewer can both miss an untested flag
combination.** On issue #145 (`sync-addon-metadata`), the result type carried
a single `dryRun` boolean that was overloaded to mean two different things:
"the caller asked for a preview" and "this direction structurally never
writes." The formatter emitted `Nothing written (dry run).` off that one flag,
so running `--direction package-from-manifest` *without* `--dry-run` told the
operator it was a dry run — implying a re-run without the flag would write —
when in fact chef has no `.c3addon` writer at all, in either
mode[^agent-memory]. Nothing caught it beforehand: every assertion touching
that output line happened to be scoped to the other direction
(`manifest-from-package`), so the suite passed all 1473 tests and the
`gvt-dev:code-reviewer` agent reported no critical findings. The defect lived
specifically in a direction-and-flag combination that no test exercised, and
it surfaced in about ten seconds of simply running the real binary[^agent-memory].

The general rule this points to: after wiring a CLI (or MCP) surface with
mode flags, run each mode/direction/flag combination once and read the output
as a user would — don't stop at a green suite. Watch in particular for a
single boolean encoding two distinct meanings; that's the shape that produces
wrong wording while every existing test stays green, because each test was
written against only one of the meanings.

[^agent-memory]: Capture of five construct3-chef agent auto-memory entries on local verification, `raw/2026-08-16-agent-memory-local-verification.md`.
[^agent-memory-origin]: Claude Code project-scoped auto-memory directory (machine-local origin of the capture).
