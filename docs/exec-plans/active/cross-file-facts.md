# Handoff: cross-file facts in the plugin

Roadmap phase 2, plus two items of phase 3 (`docs/exec-plans/active/roadmap.md`, Plan). One branch per PR, from `main`.

**Status:** PR 1 merged (#18: project index, cross-file R1 nested write, bench re-run: `bench/docs/plans/r1-nested.md`, Result). PR 2 is split: 2a (facts from the ohos-typescript syntax tree, judge features as slice fields; `bench/docs/plans/ts-extractor.md`) merged (#19); 2b (call-site edges, index only: `ProjectIndex.callSites`) merged (#22; scan timings and comparison: `bench/docs/plans/index-baseline.md`); typed values from the checker are a separate later item. Lazy call sites done (`ProjectIndex.searchCallSites`; see its Result below). PR 3 open. Project index performance fixes merged (#21).

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
   - No R2 candidate is emitted (phase 4).
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
   tests.
3. **LSP in the plugin.** Goal item 4: lifecycle, `open` before query, fallback, the `lsp` switch, `references` adding to
   PR 2's edges (with the legacy open-files workaround), hvigor's dependency map as the module source when fresh (see Goal 1), dependency records at
   `initialize` from that lookup, the timing
   check. Moves this plan to `completed/`.

## Order after 2b

2b, then lazy call sites (done), then PR 3, then checker types and R2 candidates. The disk cache is dropped (Result below). A scan cut short can't support an absence claim ("no call site passes `onX`"), so R2 takes its edges from the lazy path, which is complete for the struct asked about.

**In 2b** (whole-project scan, index only):

- `callSites(decl)` takes its files from one function: all project files here, which the bench keeps.
- A file is parsed for the scan only if it has a word-bounded `struct` or `@Builder` (a substring match also catches `constructor`). A call is recorded only if its name is declared or imported in that file.
- Edges are reused while no file has changed.
- A time budget stops the scan early and reports the files left as `unscanned`. The bench runs without a budget, so its results stay deterministic.
- Directory link cycles end the listing instead of recursing.

**Lazy call sites** (done, plugin path only). Work follows how often the asked-about struct is used, not project size:

1. Search the project text for the struct's name, word-bounded, in the directories the scan covers.
2. Parse only the matching files, through the file cache.
3. Follow aliases until none are new: a candidate's `export { Child as Kid }` adds `Kid`; for a default export, also search import paths for the declaring file's name, and for the package name when a package entry re-exports it.
4. Resolve each call with `declaration()`, so a name that only matches as text is dropped.

Results are kept per struct for one check. Parents further up are found by repeating this on demand. The search is asynchronous; only the parse step blocks. Whole-project runs (`arkui_check .`, the bench) still parse everything.

**Result (lazy call sites).** `ProjectIndex.searchCallSites(decl)` next to `callSites(decl)`, which stays as the reference; `src/search.ts` holds the search. Decisions and their reasons: `docs/design-docs/decisions.md`; gaps: the tracker.

- Exit criterion: met. `arkui-sem/scripts/compare-callsites.mjs` compares the two on a project or on one it generates. On a generated project of 10,020 files the 200 sampled structs (400 sites) were equal with ripgrep, and 100 of them from Node. The project tests that list a struct's sites compare both paths.
- Search, generated project, Windows 11, 12 threads, SSD (one word, median of the warm runs):

  | | warm | file data dropped from the OS cache |
  |---|---|---|
  | ripgrep | 0.38 s | 0.67 s |
  | Node, files read 64 at a time | 0.77 s | 0.87–1.06 s |
  | Node, files read one by one | 0.90 s | 2.96 s |
  | Node, capitalized identifiers kept in memory | 0.45 s after a 1.5 s first pass | not measured |

  A fully cold cache (directory entries too) needs administrator rights on Windows and was not measured.
- One struct end to end, on a fresh index: median 0.51 s, p95 1.0 s with ripgrep; median 0.82 s, p95 1.6 s from Node. The whole-project scan took 21–22 s.
- Chosen: ripgrep, with Node reading the files 64 at a time as the fallback. The in-memory identifier index was dropped: no faster than ripgrep, it still stats every file per check and holds every identifier.
- Disk cache: not needed for this path. The scan is left to whole-project runs, which parse everything anyway.
- Differs from the plan: an import's local name is not searched as an alias (step 3). `declaration()` follows `import { X } from './G'` when `G` only imports `X`, which ArkTS rejects; following it cost every aliased import a second search.

**R2 event unwired** (done, ahead of PR 3; roadmap phase 3). The first user of `searchCallSites`. Decisions: `docs/design-docs/decisions.md`; gaps: the tracker.

- Child side: a checked file that declares a struct with a callback only a parent can supply asks for that struct's call sites.
- Parent side: a checked file that creates such a struct asks only when its own call leaves a callback out. A call that passes them all rules the candidate out, so most parent edits need no lookup.
- A struct its file doesn't export is used in that file alone and is looked up without a search.
- Absence claims ("no call site passes `onX`") only when `unscanned` is 0. A callback that throws needs no absence claim: each site that omits it is reported.
- Per struct or per check: up to 8 structs are searched for one by one, more use the shared scan. A scan left incomplete by an unusable file elsewhere falls back to a search for the structs it holds back.
- Timing: the search is almost all of a lookup; parsing the matching files is small next to it. The plugin waits 1 s for call sites after an edit and 10 s at the idle gate; a lookup that takes longer is dropped from that check and logged.

**Next: the other R2 shapes in the plugin** (roadmap phase 4; not part of this handoff), after PR 3 and the checker types:

- Parent-side facts: the decorator of the passed field, its writes after init, its readers.
- Slice: pass the call-site facts into the judge slice and emit the R2-a/b/c candidates.

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
- Call-site edges are covered by `test/callsites.test.ts`.
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
