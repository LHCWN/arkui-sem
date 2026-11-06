# Handoff: cross-file facts in the plugin

Roadmap phase 2, plus two items of phase 3 (`docs/exec-plans/active/roadmap.md`, Plan). One branch per PR, from `main`.

**Status:** PR 1 merged (#18: project index, cross-file R1 nested write, bench re-run: `bench/docs/plans/r1-nested.md`, Result). PR 2 is split: 2a (facts from the ohos-typescript syntax tree, judge features as slice fields; `bench/docs/plans/ts-extractor.md`) on `feat/ts-extractor`; 2b (call-site edges, typed values from the checker) and PR 3 open.

## Goal

Rules today see one file. Give them facts from the files a component imports, and the call sites that use it:

1. **Project index** (no LSP). Resolve an imported name to the file that declares it:
   - relative imports (`./model/Item`);
   - imports by package name: the importing module's local dependency in `oh-package.json5` (`file:../x` or `../x`), else a project module from
     the root `build-profile.json5` (by module name or `oh-package.json5` `name`);
   - hvigor's dependency map (`.hvigor/dependencyMap/dependencyMap.json5`, written by sync; we never run `hvigor`) moves to
     PR 3. Its module list must match `build-profile.json5` to count as fresh, so it changes no resolution today; PR 3
     needs it for the dependency records at `initialize`. Format and staleness rule, checked on a synced DevEco 6.1.1
     project: `basePath` is the map file's absolute path and `srcPath`s (Windows separators) resolve against it; the
     `oh-package.json5` copies are verbatim, and sync rewrites only those whose content changed, so its mtime is not a sync
     time. The map is stale when `basePath` is not where it sits, its modules differ from the root `build-profile.json5`,
     or a copy differs from its source (compared only when the source is newer than the copy);
   - then `Index.ets` re-exports (`export { X } from './src/...'`, `export * from`) to reach the declaring file;
   - `oh_modules` packages are out (see Out of scope).

   Parse resolved files with the fact extractor and cache them by path + mtime.
2. **Cross-file R1 nested write** (phase 3):
   - V1: `@Observed` classes and `@ObjectLink` children declared in other files count for `seenByObjectLink` and the depth check;
   - V2: owners declared in other files stay skipped (#12); they are to be resolved through ace-server `definition` (#14).
3. **Call-site edges** (phase 2): for each struct, its call sites (`Child({ f: <expr> })`), with parent, child, field and the expression form (`this.x` / `$x` / `this.x.y` / literal / callback).
   - Index first: scan the project for the struct name, then our parse of the object literal.
   - LSP `references` on the struct when a server is running, to confirm or add sites.
   - Exposed in `arkui_facts`. No R2 candidate is emitted (phase 4).
4. **LSP in the plugin.** Start ace-server lazily on the first `.ets` edit, keep it warm for the session, stop it on dispose.
   After each edit call `open(file, text)` before any query (tech-debt tracker). A missing server, a start failure or a
   timeout falls back to the index silently: post-edit feedback must never wait on the LSP beyond a small budget.

## Design notes

- Keep `FileFacts` per file. Add a project-level layer (for example `ProjectFacts` / a resolver passed to `candidates()`),
  not a bigger `FileFacts`. The bench uses the same index without an LSP (roadmap: LSP fit).
- Class lookup goes through the index, not the LSP: it is deterministic and works at bench scale. The LSP adds
  `references` (call sites, writers), which imports alone can't give.
- Legacy ace-server (DevEco 6.x) sees references in open files only. On legacy, open the files the index lists as
  candidate callers before asking, or rely on the index alone. Measure which.
- Server lookup stays as in `src/lsp/server.ts`: `--ace-server`, then `ARKUI_SEM_ACE_SERVER`, then DevEco. No
  machine-specific search in code. Config gets an `lsp` switch (`auto` default, `off`).
- The same package lookup also builds the module dependency records sent to ace-server at `initialize` (PR 3), so
  the LSP resolves imports by package name too. Today none are sent (tech-debt tracker).

## Tests (offline, `npm test`)

- Fixtures: a two-module project under `test/fixtures/` (a class in module B exported through `Index.ets`, imported by package name in A; an `@ObjectLink` child in its own file; a struct used from two parents).
- Package lookup: a `file:` dependency and a project module both resolve through `Index.ets`; with the map (PR 3), the same
  import resolves with a map and without one, and a stale map loses to the parser.
- Rule tests: the cross-file `@ObjectLink` case is silent; the cross-file non-`@Observed` nested write is flagged; V2 with
  an owner in another file is skipped, as on `main`.
- Plugin test with `test/fixtures/fake-ace-server.mjs`: `open` before query, fallback on a dead or slow server, stop on dispose.

## PRs

Three PRs, in order. Each adds one visible change, is testable on its own and updates its own roadmap boxes and tracker lines.

1. **Project index + cross-file R1 nested write.** Goal items 1–2: the index (package lookup from `oh-package.json5`
   and `build-profile.json5`), file cache, the rule changes, their fixtures and tests, the bench re-run below.
2. **Call-site edges, index only.** Goal item 3 without the LSP: struct-name scan, object-literal parse, expression forms,
   `arkui_facts` output.
3. **LSP in the plugin.** Goal item 4: lifecycle, `open` before query, fallback, the `lsp` switch, `references` adding to
   PR 2's edges (with the legacy open-files workaround), hvigor's dependency map as the module source when fresh (see Goal 1), dependency records at
   `initialize` from that lookup, the timing
   check. Moves this plan to `completed/`.

## Bench

- Re-run the R1 nested-write plan (`bench/docs/plans/r1-nested.md`) on its test split with the index, offline (heuristic backend).
- Commit the linter first so the run names a real `tree:` hash. Run, report and the `bench/docs/RESULTS.md` line go in the bench.
- Time the per-edit path with the LSP warm on one module of a large real project. Exit criterion from the roadmap
  (P-A3): p95 ≤ 1.5 s per edit.

## Budget and backends

- Offline: heuristic backend, `ARKUI_SEM_CONFIG` pointing at a nonexistent file.
- Live: at most 100 Clef calls, only to check that the cross-file slices still read well. No DeepSeek or Laya runs.
- LSP: the local servers in the user's setup (standard 26 build through `ARKUI_SEM_ACE_SERVER`; DevEco 6.1.1 legacy). Test both.

## Done when

- The three rule tests above pass, and the plugin test passes with the fake server.
- `arkui_facts` shows call-site edges for the demo project (`sandbox/demo`).
- The bench re-run is reported, with the cross-file cases from that plan's Result section accounted for.
- Docs: roadmap phase 2 boxes and the two phase 3 items updated; the tracker lines on single-file `@ObjectLink`, the
  unwired LSP client and package imports updated or removed; `ARCHITECTURE.md` lists new files; this plan moves to
  `completed/` with a Result section.

## Out of scope

- Emitting R2 candidates, intents and R2 evaluation (phases 4–5).
- The string-key index (storage keys, `@Provide`/`@Consume`, `@Watch`/`@Monitor`), `@Trace` per property, `@Track`.
- `oh_modules` / third-party packages, aliasing and dataflow (fact extractor, phase 6).
- LSP diagnostics, hover and completion.

## Working rules

- Plan first: post the plan with open decisions, wait for a go.
- Don't push or open the PR until the user has reviewed the work.
