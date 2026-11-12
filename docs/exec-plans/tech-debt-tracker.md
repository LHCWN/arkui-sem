# Tech debt and known gaps

- Cross-file lookups (project index) follow relative imports, project packages and `Index.ets` re-exports; not `oh_modules` packages or namespace imports (`import * as m`), so a class or `@ObjectLink` child reached that way is missed and a correct parent write is flagged. An imported child counts only when the parent file calls it.
- V2 nested writes are judged only when the owner of the written property (and each class it extends) is declared in the file; owners from other files or of unknown type are skipped, so a missing `@ObservedV2` or `@Trace` there goes unreported. Cross-file owners are planned through ace-server `definition` on the written property.
- V1 nested writes don't use the V2 owner logic: no inherited `@Observed`, and an owner of unknown type, or from another file the project index cannot resolve, is flagged, where V2 skips it.
- Plain objects are known only from initializers: arrays of literals (`User[] = [{…}]`) and literals assigned later are not detected, and an interface-typed value from a factory call is skipped (it may be a class instance).
- Type inference covers `new X(…)` and object-literal initializers only (not factory calls or `as` casts); an inline object type is followed one level deep; a type alias of a class (`type U = User`) is not resolved, so writes through it are skipped.
- Judge slices still describe the field's class from the edited file only (`type_is_observed_class`, `object_link_types_in_file`), even when the project index resolved it elsewhere.
- The direct-render check for `@ObjectLink` sees only `this.<field>.<path>` reads: not reads through a `ForEach` item variable or a local alias, and for an array call not `ForEach(this.<field>.<array>, …)` in the parent.
- The judge fallback chain is decided but not implemented (`docs/design-docs/decisions.md`).
- The fact extractor reads one file's syntax tree, with no type checker: types come from annotations and `new X(…)` initializers, and writes through an alias (`const self = this; self.x = …`) are missed. Typed values from the ohos-typescript checker are planned (`docs/exec-plans/completed/cross-file-facts.md`, PR 2b); aliasing needs dataflow.
- The project index caches facts by mtime only (an edit within the same mtime tick, or a tool that keeps mtimes, serves
  stale facts), and cached `FileFacts` are mutable and shared across checks; size + mtime keys and
  `readonly` fact types would close both.
- `analysis.ts` mixes the fact model, derived queries, file utilities and rules; splitting it would let `src/ets/` import
  only the model.
- The parser reads the SDK once per process (`defaultParser()`) and ignores the SDK passed to the LSP client. The plugin
  passes none, so both use the same lookup there; only `arkui-sem lsp --sdk` can differ.
- Struct getters and setters are not scanned: a write in `set v(x) { this.a = x }` and reads through a getter used in
  `build()` are not recorded.
  - `v2Gap` handles index writes (unknown container, nested container, container in a plain object, other calls) as separate branches; one rule (walk up to the nearest non-container owner, then classify it) would cover them.
- Only the undecorated-mutated-rendered kind of R1 is measured with a model; nested-write has only a small offline contract benchmark (`bench/docs/plans/r1-nested.md`).
- Writes inside functions in field initializers (arrow-function properties, listener objects) are not scanned.
- Comparing with DevEco's built-in `arkts_check` needs DevEco Studio 6.0+ and `DEVECO_HOME`, not installed yet (deferred).
- The language server in the plugin (`arkui-sem/src/lsp/warm.ts`):
  - No rule asks it anything: it is started, sent each edited file and stopped. `WarmLsp.ask` is the one way in for the
    facts planned for it (field writers and readers, V2 owners in other files); R3 releases in helpers and R4 writers
    across modules are still missing.
  - With `lsp: auto` it starts on the first edit whether or not anything will ask it; on a large project that is minutes
    of start-up and several GB (numbers: `bench/docs/RESULTS.md`).
  - One start per project and plugin lifetime: a server that failed to start or died is not started again.
  - A file is sent as it is on disk when the edit tool returns; files changed outside the agent's edit tools are not sent.
  - opencode ends the server through the plugin's `dispose`. A killed opencode process skips it, and whether the
    server then exits on its closed stdin was not checked.
- ace-server follows an import by package name through the `oh_modules` link that a DevEco sync or `ohpm install`
  creates, and we run neither. In a project without the links it stops at the import; with them it reaches the other
  module, with or without dependency records at `initialize` (both servers; decisions.md). The rules resolve such
  imports through the project index (`src/project.ts`).
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
- R2 event unwired (`unwiredCallbacks`):
  - Not measured: the bench has no positives for it (the removed-`onX` mutation, roadmap phase 5).
  - An optional callback (a default, `onX?:`, a nullable type, a checked call) is never reported, also when no call
    site passes it and the child renders the value it would report. A judge for it is planned (roadmap phase 4).
  - A lookup that outlasts the wait after an edit is dropped from that check; the idle gate repeats it.
  - Call sites are `Child({ … })` in UI code, field initializers and dialog-controller builders. A struct created some
    other way (a `builder` passed through a variable, a navigation or router destination) has no site there: with no
    site at all nothing is reported, but one such hidden site next to a visible one that omits the callback gives a
    false "no call site passes it".
  - A site in a file with syntax errors can list wrong arguments; a callback that throws is still reported for it.
  - A call is "checked" when it uses `?.` or its method reads the field anywhere else, not only in a test before the
    call, so a callback that can still throw on another path is skipped. An unchecked call of an optional callback is
    left to the compiler.
  - Only `this.onX(…)` counts as a call: a callback passed on (`.onClick(this.onX)`, `Grand({ onX: this.onX })`) or
    called through a local alias is not seen, so such a field is never asked about.
  - `@Preview` structs count as call sites.
  - The finding is anchored on the child's field, also when the parent was the edited file.
- Call sites of one struct from a text search (`ProjectIndex.searchCallSites`, `src/search.ts`):
  - Each lookup walks the project tree, and each struct runs its own search: a check that asks about several structs
    walks it several times at once. On a very large project one walk can take most of the plugin's 1 s wait after an
    edit.
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
- On legacy ace-server (DevEco 6.x) `references` and `callers` see usages in open files only (queried and edited ones), so
  usages in other files are missed; the standard server (DevEco 26+) searches the whole project.
- No licence yet: the owner picks one before the repo goes public.
