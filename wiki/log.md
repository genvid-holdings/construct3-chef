# Wiki Log

Record of every `ingest` run: what changed, why, and which `raw/` source
drove it, grouped under `## YYYY-MM-DD` date headings (ISO 8601) with the
**newest date group first**. Entries are prose bullets, e.g. `* **Update**:
…`, `* **Creation**: …`, `* **Deprecation**: …` — the leading bold word is a
convention, not a requirement.

**Add newest first, never edit or remove a prior entry.** "Newest first"
means a new entry (and, if today isn't already the top group, a new
`## YYYY-MM-DD` heading) is *prepended* above everything else — the
insertion point moves from the bottom to the top, but prepending never
touches a prior entry's text, so the append-only guarantee holds exactly as
before. If a past entry itself needs correcting, add a new entry that says
so; never edit or remove the old one in place. See `wiki/wiki-schema.md` for
the full maintenance schema.

## 2026-09-11

* **Update**: `local-verification-practice.md` — added a false-**red** failure
  mode to `## Running the gate`: concurrent `npm test` invocations corrupt the
  fixture mid-read, because `pretest` re-materializes it via a recursive
  `cpSync` over the live tree before every run. Surfaced on
  [#217](https://github.com/GenvidTechnologies/construct3-chef/issues/217),
  where three back-to-back invocations produced four failures in
  fixture-dependent suites against a clean tree; a single run was green at 1730
  passing. Recorded because the page previously covered only the false-*green*
  direction, and a false red is the more expensive one — it sends you to "fix"
  code that was already correct. The page `description` was widened to match
  the new topic shape. Driven by session observation rather than a `raw/`
  capture: the mechanism is verifiable in-tree (`package.json`'s `pretest`,
  `scripts/prep-fixture.mjs`), so it carries no footnote.

## 2026-08-22

* **Creation**: `decisions/0029-flat-docs-alias-generated-into-the-tarball.md`
  — records the fix for [#198](https://github.com/GenvidTechnologies/construct3-chef/issues/198):
  the MCP `docs:///{name}` resource, emptied by the 2026-08-20 `docs/` →
  `wiki/` consolidation because upstream `exposeDocs` hardcodes a flat,
  non-recursive `<packageDir>/docs` scan, is restored by a new
  `scripts/gen-docs-alias.mjs` that regenerates a flat `docs/` from `wiki/`
  at `prepack`/`postpack` time only — gitignored, never committed, serving
  40 of the bundle's 45 tracked pages. Records the accepted
  no-link-rewriting and no-`TOC`-compat-alias trade-offs, the corrected
  41→40 served-count derivation, the `exposeDocs` non-enumerability
  limitation (confirmed non-structural against the installed MCP SDK), and
  the retirement condition (an upstream configurable/recursive/enumerable
  `exposeDocs`).
* **Update**: `decisions/0028-documentation-consolidated-into-the-wiki-tier.md`
  — one paragraph added to § Consequences recording the fifth
  hardcoded-`docs/` breakage the original enumeration missed: `exposeDocs`,
  reached via `src/mcp/server.ts`, lives in chef's own shipped runtime
  rather than in gvt-dev tooling, and the same commit's `package.json`
  change dropped `docs/` from the published tarball's `files` list without
  that consequence being recorded. Points at ADR 0029, which amends rather
  than reopens this decision — 0028's decision to retire `docs/` stands;
  only its impact enumeration was incomplete.

## 2026-08-20

* **Migration**: the entire `docs/` tree (38 files, ~440 KB) ingested into the
  wiki bundle and `docs/` retired — five reference manuals to
  `wiki/reference/`, two architecture/research notes to `wiki/architecture/`,
  two process docs to `wiki/process/`, and the 27 ADRs to `wiki/decisions/`,
  with `wiki-schema.md` moving to the bundle root. Driven by explicit owner
  direction ("migrate the documentation entirely, no docs residual"), recorded
  as ADR
  [0028](decisions/0028-documentation-consolidated-into-the-wiki-tier.md). This
  inverts the previous routing rule: the wiki is no longer the residual tier
  for knowledge with no other repo home, it is the *only* documentation tier.
* **Creation**: `decisions/0028-documentation-consolidated-into-the-wiki-tier.md`
  — records the consolidation, the narrowed routing rule ("exactly one page owns
  a given fact"), the two rejected alternatives, and the accepted plugin-contract
  breakages.
* **Fold**: `docs/TOC.md` merged into `index.md` rather than moved — two indexes
  of one corpus is the drift trap the routing rule exists to prevent. Every
  migrated page gained OKF v0.2 frontmatter carrying the one-line summary
  `TOC.md` held, and all five indexes are now *generated* from those
  `description` fields so index and page cannot diverge.
* **Update**: `wiki-schema.md` — routing rule rewritten for the single-tier
  layout; the settled-decision clause now points at `<wikiDir>/decisions/`; the
  `Related`/wiki-link examples switched from the escaping `../docs/<page>.md`
  form to bundle-absolute `/<page>.md`; and the out-of-bundle section rewritten,
  since this schema doc and every ADR moved *inside* the bundle and the only
  legitimate escaping targets left are repo-root files and `../raw/` captures.
* **Note**: the move exposed three hardcoded `docs/` assumptions in the
  `gvt-dev` plugin (inert `paths` overrides, hygiene scanners that now scan
  `CLAUDE.md` alone while still reporting clean, and `maintain-wiki`'s own
  hardcoded schema-doc path), filed as gvt-dev
  [#389](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/389)
  and
  [#390](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/390).
  Accepted rather than worked around; see ADR 0028 § Consequences.

## 2026-08-16

* **Creation**: local-verification-practice.md, driven by `raw/2026-08-16-agent-memory-local-verification.md` — first page of the wiki; captures local verification practice that lived only in machine-local agent auto-memory and was recorded nowhere in the repository.
