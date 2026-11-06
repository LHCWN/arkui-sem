# Tech debt and known gaps

- Cross-file lookups (project index) follow relative imports, project packages and `Index.ets` re-exports; not `oh_modules` packages or namespace imports (`import * as m`), so a class or `@ObjectLink` child reached that way is missed and a correct parent write is flagged. An imported child counts only when the parent file calls it.
- V2 nested write checks only the field's own class for `@ObservedV2`. It should require the owner class of each written property: `this.a.b.c = …` needs `b`'s class to be `@ObservedV2`.
- Judge slices still describe the field's class from the edited file only (`type_is_observed_class`, `object_link_types_in_file`), even when the project index resolved it elsewhere.
- The direct-render check for `@ObjectLink` sees only `this.<field>.<path>` reads: not reads through a `ForEach` item variable or a local alias, and for an array call not `ForEach(this.<field>.<array>, …)` in the parent.
- The judge fallback chain is decided but not implemented (`docs/design-docs/decisions.md`).
- The fact extractor is naive (regex-level); ArkAnalyzer behind `FactExtractor` is planned.
- Only the undecorated-mutated-rendered kind of R1 is measured with a model; nested-write has only a small offline contract benchmark (`bench/docs/plans/r1-nested.md`).
- Writes inside functions in field initializers (arrow-function properties, listener objects) are not scanned.
- Comparing with DevEco's built-in `arkts_check` needs DevEco Studio 6.0+ and `DEVECO_HOME`, not installed yet (deferred).
- LSP client (`arkui-sem/src/lsp/`) is not wired into the plugin: after the agent edits a file, the plugin must call
  `open(file)` with the new text before asking the server anything (the API supports it).
- The LSP client sends no package dependency records at `initialize`: modules come from a folder scan (up to four
  levels below the project root), so the server doesn't resolve imports by package name (listing modules from
  `oh-package.json5` alone was not enough, nor was the server's own `--projectPath` mode). The rules resolve them through
  the project index (`src/project.ts`); the LSP records come from the same lookup (cross-file-facts PR 3). R2 call sites,
  R3 releases in helpers and R4 writers across modules are still missing.
- On legacy ace-server (DevEco 6.x) `references` and `callers` see usages in open files only (queried and edited ones), so
  usages in other files are missed; the standard server (DevEco 26+) searches the whole project.
- No licence yet: the owner picks one before the repo goes public.
