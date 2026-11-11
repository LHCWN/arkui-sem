# Decisions made

- **Judge fallback chain:** Jev → Clef-flash → Clef → DeepSeek flash as System One (2026-10-05).
  - The DeepSeek step uses structured output only (strict tool schema, then `json_object`). The logprobs mode was removed on 2026-10-07: the user found it doesn't make sense. Don't reintroduce it without asking.
  - DeepSeek only ever uses `deepseek-flash`, with thinking disabled.
  - Every record notes which backend and mode answered.
  - The chain is not implemented yet (planned in `src/judge.ts`, with `backend` allowed to be a list).
- **Evaluation scope:** masked-decorator-prediction (MDP) datasets. Each component field's real decorator is the label, and the model sees the component with that decorator and its clues masked. The datasets, their numbers and the runs are in the private bench (`bench/docs/decisions.md`).
- **Decorator prediction dropped** (2026-10-08): no decorator-choice model runs, no large-LLM comparison on that task; the MDP datasets now supply items for the judge questions R1–R3.
- **R1 nested write with `@ObjectLink`** (2026-10-13): a V1 write two or more levels deep is silent, not downgraded, when the
  class owning the written property is `@Observed`, a child takes that class as `@ObjectLink`, and the parent doesn't render
  the path itself. Same file first; cross-file children come with the cross-file facts.
- **R1 nested write, V2** (2026-10-19): a write is judged by the type that owns the written property. An index write or
  array call counts as a write to the array property, so it is judged by the array's holder. Plain classes are flagged, and
  so are plain objects: anything inside an object-literal initializer, inline object types and records. A property without
  `@Trace` on an `@ObservedV2` class is flagged too (the fix names the class that declares it; writes through a setter count
  as observed). Class and `@Trace` gaps need the property they name to be rendered (for a write into an array, the array, so
  `ForEach(this.store.items, …)` counts): an untraced property nothing renders is the point of per-property `@Trace`. Interface-typed objects are flagged only when known to be literals, since they may hold
  class instances. Writes into a container nested in another (`grid[i][j]`) are flagged. An object-literal initializer
  counts only for `@Local` (and class fields nothing reassigns), and only while every reassignment also assigns a literal.
  Owners not declared in the file are skipped; cross-file owners will come from ace-server (`definition` on the written
  property), not from a resolver of our own.
- **Disable comments** (2026-10-13): `// arkui-sem-disable-next-line <rules>` works above the field name, above its decorator
  lines, and above a single write (that write only, for nested-write findings); R1 and R3 share one parser.
- **Fact extractor on ohos-typescript** (2026-11-06): facts come from the syntax tree of OpenHarmony's TypeScript fork
  (Apache-2.0, maintained by Huawei engineers in OpenHarmony's `third_party_typescript`; the parser DevEco's ets-loader and
  ArkAnalyzer build on), replacing the regex extractor. Parser options come from the SDK when found (ets-loader options plus
  HMS components, as the compiler registers them), else from a bundled copy. Parser only for now; the type checker is a
  separate step, since a module's program takes seconds to build. Rules depend only on the `FactExtractor` interface:
  ours is the main extractor; another (ArkAnalyzer) could sit behind it if it proves suitable. Judge features are structured slice fields, not regexes
  over slice text. Bench comparison: `bench/docs/plans/ts-extractor.md`.
- **Repos: this repo is public, the bench is a private submodule** (2026-10-08).
  - GitHub's free organization plan gives branch protection (required reviews, rulesets) only to public repos, so the code lives in the public repo, where those gates work.
  - CI (2026-10-09): offline only (the `test` check: build and tests). No bench and no keys, so public CI never needs private access; live model calls and bench runs stay manual. The ruleset requires the check next to one approval.
  - `bench/` is the private repo `arkui-sem-bench`, a git submodule (relative URL `../arkui-sem-bench.git`). It holds the datasets, runs, results, the eval scripts and the evaluation docs. Public clones work without it.
  - The bench needs no gates of its own: it holds experiments, and code shared with the linter lives here.
  - Ignored here: `refs/`, and everything in `sandbox/` except the demo project `sandbox/demo/` (2026-10-08: one demo project with the R1 pages; the R3 fixture and the separate copies were dropped).
- **History** (2026-10-08): both repos start from one commit. Run records made earlier name commits from before that.
- **Docs layout** (2026-10-08): `AGENTS.md` is a short map; knowledge lives in `docs/` (design docs, exec plans), the
  bench's in `bench/docs/` (results, dataset plans, evaluation method, costs); the `jev_arkts_` file prefix was dropped.
- **Removed the `arkui_facts` tool and the `arkui-state-management` skill** (2026-11-10).
  - Why: no linting step used the tool, and nothing showed agents call it or act on it. The skill's only job beyond decorator guidance was to point the agent at the tool.
  - Consequence: the plugin has one agent tool, `arkui_check`. The evaluation's skill-only arm is gone: the control is the no-plugin arm (`docs/design-docs/agentic-plugin.md`).
  - Kept: the call-site edges in the project index (`ProjectIndex.callSites`), which R2 needs. A `facts` subcommand in the CLI for looking at extracted facts is possible later.
- **R2 event unwired, from facts alone** (2026-11-10; steps in `docs/exec-plans/completed/cross-file-facts.md`).
  - Done before the LSP work (PR 3): it needs only the call-site edges, and it gives `searchCallSites` its first user.
  - No judge call. The finding carries the backend `facts` and no probability.
  - V1 is included, not only the V2 `@Event`: an undecorated callback field is the same wiring, and most ArkUI code is V1.
  - Two findings, by what an unpassed callback does:
    - It does nothing and the child gives no default (a V2 `@Event` without an initializer): a finding, when no call site passes it.
    - It throws (V1, no default, called unchecked): a finding for each site that omits it, even when others pass it.
  - Not reported: a callback the child lets a parent leave out (a default, `onX?:`, a nullable type, a checked call), even when no call site passes it. Facts alone can't tell an oversight from an option nobody uses, and on real projects it was the only kind that fired. A judge for it is a later step (roadmap phase 4).
  - "No call site passes it" needs every site: at least one site, none with opaque arguments, `unscanned` 0. A parent that leaves an event out while another passes it is taken as intended.
  - Also skipped: a field the child assigns itself, `@Require` (the compiler enforces it), a struct with no call site (a page, or a library component).
  - The candidate is anchored on the child's field whichever file was checked, so a check of the child and one of the parent give one fingerprint, and the disable comment goes above the field.
  - Call sites: a search per struct for up to 8 structs, the shared scan above that. The scan pays off only when most of the project is being checked anyway.
  - The plugin waits for call sites 1 s after an edit and 10 s at the idle gate. Why: the search walks the project tree, which on a very large project takes most of a second, and the agent must not wait on it.
  - A dialog controller's `builder: Child({ … })` is a call site in any method, not only in field initializers: dialogs are often created in `aboutToAppear`, and missing those sites would make their callbacks look unwired.
- **Call sites of one struct from a text search** (2026-11-10; numbers in `docs/exec-plans/completed/cross-file-facts.md`, Result).
  - An API on the index, `ProjectIndex.searchCallSites(decl)`, and no plugin tool or CLI command: the plugin has no user of the edges until R2, and a tool was just removed for having none. The whole-project scan `callSites` stays as the reference, and tests and `scripts/compare-callsites.mjs` hold the two equal.
  - Search: ripgrep first (`ARKUI_SEM_RG`, `PATH`, then the binary opencode downloads for itself), else Node reading the files 64 at a time. ripgrep was about twice as fast warm and the fallback stays under about a second on 10,000 files, so no binary is bundled. A failed ripgrep run is repeated from Node, which also reports what it could not read.
  - No in-memory identifier index: no faster than ripgrep once built, and it stats every file on each check.
  - No disk cache: the search answers for one struct in about half a second without one. Whole-project runs parse everything.
  - The search lists the same files as the scan: no ignore files, the same skipped directories, links followed.
  - Results live for one check, keyed by struct. A new caller can only be seen by searching again, so nothing is reused across checks.
  - An import's local name is not an alias: only ArkTS that doesn't compile can import it from another file. This is the one place where the scan lists a site the search doesn't.
  - Asynchronous, unlike `callSites`: a refresh during the search is tolerated, not prevented.
- **No overlapping fact sources: call sites come from the index only** (2026-11-11). LSP `references` on a struct would only confirm what `searchCallSites` already finds (complete for the struct asked about), and on legacy ace-server it would need the open-files workaround. Cross-file-facts PR 3 keeps the LSP for what the index can't give: server lifecycle, dependency records at `initialize`, and later field writers and readers (phase 4).
- **The language server in the plugin: lifecycle only, no dependency records, no hvigor map** (2026-11-11, cross-file-facts PR 3; details in its Result).
  - One ace-server per project, started in the background on the project's first `.ets` edit, sent each edited file, stopped on dispose. A check never waits for it: an answer is asked for within a budget and a missing, starting, slow or dead server gives none.
  - Setting `lsp`: `auto` (default) or `off`. The server is found as before (`ARKUI_SEM_ACE_SERVER`, else DevEco Studio); no new path settings.
  - No dependency records at `initialize`. Tried on a two-module project with both servers (standard 26, legacy 6.1.1): with the `oh_modules` links of a synced project, `definition` and `references` cross modules with and without the records; without the links the records don't help, as the server resolves a package name through `oh_modules`. A record without `version` also stops the legacy server at `initialize`.
  - hvigor's dependency map is not read. By its own freshness rule it counts only when it lists the same modules and the same `oh-package.json5` content as the project's files, so it can't change an answer the index gives: a second source for the same fact.
  - The server's module list comes from the root `build-profile.json5` (the folder scan stays as the fallback for a folder without one), and the project root is the nearest build profile that lists modules: a module's own `build-profile.json5` was taken for the root before.
