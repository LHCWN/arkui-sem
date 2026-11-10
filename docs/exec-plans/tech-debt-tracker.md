# Tech debt and known gaps

- Cross-file lookups (project index) follow relative imports, project packages and `Index.ets` re-exports; not `oh_modules` packages or namespace imports (`import * as m`), so a class or `@ObjectLink` child reached that way is missed and a correct parent write is flagged. An imported child counts only when the parent file calls it.
- V2 nested writes are judged only when the owner of the written property (and each class it extends) is declared in the file; owners from other files or of unknown type are skipped, so a missing `@ObservedV2` or `@Trace` there goes unreported. Cross-file owners are planned through ace-server `definition` on the written property.
- V1 nested writes don't use the V2 owner logic: no inherited `@Observed`, and an owner of unknown type, or from another file the project index cannot resolve, is flagged, where V2 skips it.
- Plain objects are known only from initializers: arrays of literals (`User[] = [{…}]`) and literals assigned later are not detected, and an interface-typed value from a factory call is skipped (it may be a class instance).
- Type inference covers `new X(…)` and object-literal initializers only (not factory calls or `as` casts); an inline object type is followed one level deep; a type alias of a class (`type U = User`) is not resolved, so writes through it are skipped.
- Judge slices still describe the field's class from the edited file only (`type_is_observed_class`, `object_link_types_in_file`), even when the project index resolved it elsewhere.
- The direct-render check for `@ObjectLink` sees only `this.<field>.<path>` reads: not reads through a `ForEach` item variable or a local alias, and for an array call not `ForEach(this.<field>.<array>, …)` in the parent.
- The judge fallback chain is decided but not implemented (`docs/design-docs/decisions.md`).
- The fact extractor reads one file's syntax tree, with no type checker: types come from annotations and `new X(…)` initializers, and writes through an alias (`const self = this; self.x = …`) are missed. Typed values from the ohos-typescript checker are planned (`docs/exec-plans/active/cross-file-facts.md`, PR 2b); aliasing needs dataflow.
- The project index caches facts by mtime only (an edit within the same mtime tick, or a tool that keeps mtimes, serves
  stale facts), and cached `FileFacts` are mutable and shared across checks; size + mtime keys and
  `readonly` fact types would close both.
- `analysis.ts` mixes the fact model, derived queries, file utilities and rules; splitting it would let `src/ets/` import
  only the model.
- The parser reads the SDK once per process (`defaultParser()`) and ignores the SDK passed to the LSP client; one SDK
  choice should feed both (PR 3).
- Struct getters and setters are not scanned: a write in `set v(x) { this.a = x }` and reads through a getter used in
  `build()` are not recorded.
  - `v2Gap` handles index writes (unknown container, nested container, container in a plain object, other calls) as separate branches; one rule (walk up to the nearest non-container owner, then classify it) would cover them.
- Only the undecorated-mutated-rendered kind of R1 is measured with a model; nested-write has only a small offline contract benchmark (`bench/docs/plans/r1-nested.md`).
- Writes inside functions in field initializers (arrow-function properties, listener objects) are not scanned.
- Comparing with DevEco's built-in `arkts_check` needs DevEco Studio 6.0+ and `DEVECO_HOME`, not installed yet (deferred).
- LSP client (`arkui-sem/src/lsp/`) is not wired into the plugin: after the agent edits a file, the plugin must call
  `open(file)` with the new text before asking the server anything (the API supports it).
- The LSP client sends no package dependency records at `initialize`: modules come from a folder scan (up to four
  levels below the project root), so the server doesn't resolve imports by package name (listing modules from
  `oh-package.json5` alone was not enough, nor was the server's own `--projectPath` mode). The rules resolve them through
  the project index (`src/project.ts`); the LSP records come from the same lookup (cross-file-facts PR 3). R3 releases in
  helpers and R4 writers across modules are still missing.
- Call-site edges (`ProjectIndex.callSites`):
  - The time budget stops the scan between files, but listing the project can't be interrupted: on a cold OS file cache
    the listing alone can exceed the budget.
  - A scan cut short lists fewer sites and reports `unscanned`, so it can't support an absence claim. For one struct,
    `searchCallSites` gives complete edges without the scan (below).
  - A file with parser errors counts as `unscanned`. What the parser recovered is still listed, and sites may be missing
    or wrong: an unclosed object or string can swallow later calls as arguments, and a stray `}` can lose a builder. Some
    valid ArkTS reports an error too (`.attr()` after the closure of `Child() { … }`).
  - A module outside the build-profile root is tied to its project through the session's directory. Opened from anywhere
    else, the scan covers that module alone.
  - A directory link to a folder the listing also walks directly lists its files twice, so their sites appear twice. Only
    cycles are cut.
  - The budget is checked between files, so resolving one file's uses can overrun it by the files those imports parse.
  - No signal catches a half-typed line that still parses: `this.` above `Child()` reads as `this.Child()`, so the site is
    lost with no parser error.
- Call sites of one struct from a text search (`ProjectIndex.searchCallSites`, `src/search.ts`):
  - Nothing in the plugin calls it yet: R2 candidates are its first user.
  - The work follows how many files mention the name. A struct with a common name (`Index`, a word used in many files)
    parses all of them; `budgetMs` stops the parsing and counts the rest as `unscanned`.
  - Each check searches again (the result is kept for one check only), and a default export searches at least twice.
  - A default import is found by the file name, directory name or package name in its path, matched with the letter
    case of the file system entry. An import written in another case resolves on Windows and macOS, so the scan lists
    it and the search does not.
  - Package names come from the project's modules, their `oh-package.json5` names and the dependency keys of the
    modules and scanned roots. A key declared only in a nested package that is no module is not searched for.
  - The Node fallback lists the project synchronously before it reads files, so it blocks for the listing.
  - The ripgrep run has no timeout, and the budget does not cover the search itself.
  - A refresh while a search runs is not detected: files parsed after it are read in their newer state.
  - Sites are ordered by file path, the scan's by directory listing.
  - `declaration()` follows `import { X } from './G'` when `G` only imports `X` and doesn't export it, which ArkTS
    rejects. The scan lists such a site; the search doesn't look for `G`'s local names.
  - CI runs the ripgrep path only if the runner has `rg` on `PATH`; otherwise only the Node fallback is tested there.
- On legacy ace-server (DevEco 6.x) `references` and `callers` see usages in open files only (queried and edited ones), so
  usages in other files are missed; the standard server (DevEco 26+) searches the whole project.
- No licence yet: the owner picks one before the repo goes public.
