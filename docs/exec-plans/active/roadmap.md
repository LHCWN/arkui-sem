# Roadmap

The one forward plan: plugin status and roadmap, rule coverage and phases. Design background: `docs/design-docs/` (core beliefs, agentic plugin). Evaluation status, method and results are in the private bench: `bench/docs/RESULTS.md`, `bench/docs/evaluation-method.md`.

## Prototype (current state)

The linter lives in `arkui-sem/` (package `arkui-sem` 0.2.0); see `ARCHITECTURE.md` for the layout and `arkui-sem/README.md` for install and usage. Coverage by rule, and what is still missing, is tracked under Rule coverage below.

**Status:**
- Rules: R1 undecorated-mutated-rendered, R1 nested-write-unobserved (depth-aware, V1/V2), R3 unreleased-resource, R2 event-unwired (shape d, from facts alone, no judge call). The other R2 shapes have a judge slice (used by the bench) but are not emitted yet.
- Backends: Jev, Clef, Clef-flash (also through OpenRouter: `or-clef`, `or-clef-flash`), DeepSeek flash (structured output), heuristic, Laya. The fallback chain is not implemented.
- Tests: `npm test` (offline). The plugin and its `arkui_check` tool load in opencode 1.18.30 and in DevEco Code 0.1.12 (an opencode fork; plugin under `.deveco/`; 0.2.x refuses to run outside Mainland China).
- DevEco demo (2026-10-08, `sandbox/demo/DEMO.md`): Clef flagged the agent's nested write, the idle gate re-sent it for the old button, and the agent fixed both. The DevEco TUI hides tool output, so the demo prompt asks the agent to quote findings verbatim.
- Live opencode runs 1–4 (logs removed 2026-10-08; run 4 called DeepSeek and found the @Observed-only false negative that led to the depth-aware rule).

**Known limits:**
- **The language server is not used by any rule.** The plugin starts ace-server on the first `.ets` edit, keeps it in step with the edits and stops it on dispose (`lsp: auto | off`); the facts it is meant for (field writers and readers, V2 owners in other files) are phases 3–4.
- **Mostly single-file analysis.** No aliasing. Across files: class lookups for the V1 nested write, and call sites for R2 event-unwired; the parent-side facts the other R2 shapes need are missing.
- **The heuristic judge's probabilities are placeholders.**
- **The gate under `opencode run`.** The non-interactive run may exit at idle before the follow-up is processed [I]. Use the TUI or `opencode serve` + SDK for gate tests.
---

## Prototype roadmap

P-A2…P-A4 (intent tool, cross-file facts, LSP) are broken down further under Rule coverage below.

| Step | Deliverable | Effort | Exit criterion |
|---|---|---|---|
| **P-A1** ✓ | opencode plugin vertical slice: post-edit feedback, idle gate, `arkui_check`, installer, tests | done | tests pass; tool registered in opencode |
| **P-A2** | Label log (fixes, dismissals with reasons) + `arkui_explain(id)` + `arkui_ownership_intent(component, field)` tools | 1–2 d | Labels written for every gate/finding outcome in a session |
| **P-A3** | The fact extractor (behind `FactExtractor`: ours on the ohos-typescript tree, with checker types; ArkAnalyzer only if it proves suitable) kept warm in the plugin process; incremental updates on edit; cross-file, including across modules via a package index; parent→child edges → **R2** | 4–5 d | p95 ≤ 1.5 s per edit on the big project; E0 fact-precision ≥ 0.95 |
| **P-A4** | LSP channel: an `arkui-sem` LSP server registered via `opencode.json` `lsp` for `.ets`, optionally alongside the community ArkTS language server for L0 | 3 d | A/B vs the `tool.execute.after` channel; no duplicate reports |
| **P-A5** | Intent-aware slices: task text from the session's first user message (via `chat.message` / SDK), opt-in | 1 d | MDP / ArkState-200 lift with task context ≥ 5 pts [H] |
| **P-A6** | Real backends calibrated: Jev, Clef-flash, fine-tuned Laya (local HTTP sidecar; Laya is Python); the zero-shot Laya baseline is in the bench | 2–3 d | Per-rule ECE ≤ 0.10; τ_hi gives precision ≥ 0.9 on dev (the bench's dev-split tooling tunes it) |
| **P-A7** | Agent eval harness on `opencode serve` + `@opencode-ai/sdk` (`docs/design-docs/agentic-plugin.md` §6.3) | ~1 w | Variance estimate from a pilot of 20 tasks × 3 seeds |
| **P-A8** | Portability: MCP server wrapper for other agents, SARIF output, pre-commit | 2 d | Same findings via CLI, MCP and plugin on the fixtures |

The earlier offline prototypes keep their role as **gates that set thresholds before any live agent run**:
- P0.5 toolchain sweep;
- ArkState-200;
- ArkMut;
- masked-decorator prediction;
- ArkEval pairs.

The localizer (P5) becomes an `arkui_locate(issue_text)` tool.

---

## Rule coverage

Status as of 2026-11-10. Scope: ArkEval v1 category 1, "UI state desynchronization" (plus R3 for category 3).
Background: `docs/design-docs/core-beliefs.md` §3–§4 (rungs, rule families, architecture), `docs/design-docs/agentic-plugin.md`.

### Rules (RN)

| Rule | Name | Detects (facts) | Question for the judge or agent | Status |
|---|---|---|---|---|
| **R1** | Under-reactive state | A value rendered in `build()` and written after construction with no reactive path. Two kinds: an undecorated field, and a nested write the decorator can't see. | Q_R1: is it UI state or intentionally static? Verdict, severity. | Implemented, single file |
| **R2** | Ownership mismatch | A child field initialised from parent state, where the sync direction the code gives ≠ the direction needed. | Q_R2: `child_local_copy` / `shared_with_parent` / `parent_display_only`. The engine maps intent × V1/V2 → decorator. | Shape d (event unwired) implemented, facts only. Shapes a–c: Q_R2 slice + spec cards, evaluated in the bench (`bench/docs/RESULTS.md`), not emitted by the plugin |
| **R3** | Lifecycle obligation | A resource acquired with no release in `aboutToDisappear`. | Q_R3: app-lifetime? Released elsewhere? | Implemented (category 3): timers, listeners, constant-event `on`/`off`, register/subscribe pairs, helper-called releases. Evaluated in the bench (`bench/docs/RESULTS.md`) |
| **R4** | Over-reactive state | Decorated state never written after init, or a large `@State` mutated at high frequency. | Is reactivity needed? Perf severity. | Not started |
| **R5** | Issue → component mapping | Component list + summaries. | Which component owns the reported behaviour? (Rung 3) | Not started; not part of this plan |

#### R2 shapes

| Shape | Bug | Decided by |
|---|---|---|
| **a** R2-down | The parent changes `x` after init, but the child keeps an `@State` or undecorated copy, so the child shows a stale value. | Facts + judge: "is a snapshot intended?" |
| **b** R2-up | The child writes an `@Prop` (or a local copy), and the parent or a sibling reads `x`. The edit is lost. | Intent (judge or agent) |
| **c** R2-leak | A `@Link` used for a draft with cancel semantics, so edits leak to the parent. | Intent (judge or agent) |
| **d** Event unwired | The child calls `this.onX(v)`, but no call site passes `onX`: for a V2 `@Event` without a default the call does nothing. A V1 callback with no default, called unchecked, throws at each site that omits it. A callback the child makes optional is not reported. | Facts only (implemented) |
| **e** V2 `@Param` mutated in place | Only visible with `@ObservedV2` + `@Trace`, and it breaks one-way ownership. | Facts + intent for the fix |
| **f** Multiple parents | The same child gets different sync needs from different parents. | Facts; the fix choice needs a judgment |

The compiler already rejects writes to a V2 `@Param` and `@Link` without `$` (category 2), so the linter skips them.

### Coverage table

✅ done · ⚠️ partial · ❌ missing. The LSP column assumes the spike (phase 1) passes.

| Item | Today | With an LSP server | Left after LSP |
|---|---|---|---|
| R1 undecorated field, mutated and rendered (V1/V2) | ✅ Facts + Q_R1; MDP runs in the bench | – | Intent verdict (judge/agent) |
| R1 nested write, V1 (depth ≥ 2) | ✅ Across files (project index) | – | Aliasing (`const it = this.list[i]; it.x = …`): dataflow in the fact extractor |
| R1 nested write, V2 (class not `@ObservedV2`) | ⚠️ Same file; cross-file through ace-server (follow-up) | ✅ Cross-file class lookup | – |
| `@Trace` per property | ⚠️ Same file (mutated + rendered property, inherited `@Trace` included); cross-file through ace-server (follow-up) | ✅ Class (LSP) + property decorator (our parse) | Eval |
| `@Observed` / `@ObjectLink` children | ✅ Across files: imported children the parent calls (project index) | – | – |
| `@Track` | ❌ | Class lookup only | Rule design |
| R2 facts: call-site edges | ✅ Project index: a scan of the project, or a text search for one struct | – (index only, no second source) | – |
| R2-a | ❌ | ✅ Detected (`references` + `documentHighlight` write kinds) | Judge: snapshot intended? |
| R2-d | ✅ Call sites from the project index, V1 and V2 | – | Positives to measure it on (phase 5 mutations) |
| R2-f | ❌ | ✅ Facts | Fix choice |
| R2-b / R2-c | ❌ | Evidence (sibling readers, dialog-ness) | Intent: judge, or agent via `arkui_ownership_intent` |
| Read/write kind and context | Syntax tree (ohos-typescript) | Read/write kind: `documentHighlight` | Context (handler/`build`/lifecycle/async), reach via `@Builder`/`ForEach`: the fact extractor |
| String-keyed links: AppStorage/LocalStorage keys, `@Provide`/`@Consume` aliases, `@Watch` names, `@Monitor` paths | ❌ | ❌ | Own key index (grep-level) |
| Derived state: `@Watch`, `@Monitor`, `@Computed` | ❌ | Locating only | New rule + dataset (MDP doesn't cover them) |
| R3 unreleased resource | ✅ | Release in another file or owner object | Judge: app-lifetime or released elsewhere |
| R4 over-reactive | ❌ | "Never written" via `references` | Rule; perf judgment |
| Imports by package name across modules | ✅ Project index (`src/project.ts`): `oh-package.json5` local dependencies and `build-profile.json5` modules; `Index.ets` re-exports | Resolved by the server only in a synced project (`oh_modules` links); dependency records at `initialize` change nothing (decisions.md) | `oh_modules` packages, namespace imports (`import * as`) |

**LSP fit:** good for the per-edit plugin, where the server stays warm and runs a few queries per edit. Poor for bench scale (thousands of items and sequential `references` calls, warm-up nondeterminism), so the bench uses a one-pass index instead.

### Plan

Each phase starts only after an explicit go.

#### Phase 0: infrastructure already in place
- [x] R1 rules (undecorated, nested write) and R3 in `analysis.ts` / `engine.ts`
- [x] Judge backends: Clef, DeepSeek flash (structured), heuristic, Laya
- [x] MDP datasets and R1 recall/precision runs (bench)
- [ ] Judge fallback chain Jev → Clef-flash → Clef → DeepSeek flash (`backend` as a list)

#### Phase 1: LSP spike (decides how much LSP can do)
- [ ] Pick a headless ArkTS language server
- [ ] Probe on `sandbox/demo`:
  - [x] `references` on a struct: works, and `definition` works per call site (ace-server 26 and DevEco 6.1.1). Call hierarchy doesn't list struct calls in either direction, so call sites come from our own walk (cross-file-facts PR 2b) and stay there: the LSP doesn't add a second source for them
  - [ ] `references` on a child field: does it return the call-site property? (**decisive probe**)
  - [ ] `documentHighlight` Write kinds
  - [ ] `typeDefinition` across files
  - [ ] `references` on an `@Event`
- [ ] Time the probes on one module of a large real project
- [ ] Score against the E0 fact sample (fact extractor vs LSP; `bench/docs/evaluation-method.md`)
- [ ] Decide: LSP behind `FactExtractor` for the plugin, or grep for struct names + our parse

#### Phase 2: cross-file facts
- [x] Cross-file class resolution: a project index (`src/project.ts`) passed to the rules, in the plugin and the bench alike
- [x] Call-site edge index: parent, child, field, expression form (`this.x` / `$x` / `this.x.y` / literal / callback), from our own walk and the project index (no R2 candidate yet); for one struct without parsing the project: `searchCallSites` (text search, then a parse of the matching files)
- [ ] Parent-side facts: decorator of `x`, writes after init, readers (parent, siblings)
- [x] Child-side facts for R2-d: each call of a callback field or `@Event` (checked or not), `onX?:`, `export` on the struct; a dialog controller's builder counts as a call site in any method
- [ ] Child-side facts for R2-a/b/c: writes to `f` with context, `@CustomDialog`/controller
- [ ] String-key index: storage keys, `@Provide`/`@Consume` aliases, `@Watch`/`@Monitor` targets

#### Phase 3: rules from facts alone
- [ ] V2 nested write with cross-file `@ObservedV2` classes
- [ ] `@Trace` per property (mutated + rendered property without `@Trace`); evaluate on the bench's trace items (same-file rule done, rendered properties only)
- [x] `@Observed` / `@ObjectLink` recognition across files
- [x] R2-d event unwired (`unwiredCallbacks` in `analysis.ts`; the engine reports it without a judge call). In the plugin the call sites come from `searchCallSites`; a check that asks about more than 8 structs uses the shared scan
- [ ] R2-f multiple parents

#### Phase 4: R2 with intent
- [ ] Emit R2-a / R2-b / R2-c candidates with fact-summary slices (fit the Laya ~424-token limit); call sites in the plugin come from `searchCallSites` (steps: `cross-file-facts.md`, Next: R2 in the plugin)
- [ ] Judge for the optional case of R2-d, in its own PR: an optional callback no call site passes is not reported today, since facts alone can't tell an oversight from an unused option. Add a question and slice for "should a parent handle this callback?" (a rendered `@Prop value` with an unpassed `onValueChange` is likely a bug, an unpassed `onClose` often not), so the judge can report it as a question or a finding. Needs the removed-`onX` mutation positives (phase 5) first, to set thresholds
- [ ] Engine mapping intent × V1/V2 × current decorator → finding / question / silent (0.8 / 0.5)
- [ ] `arkui_ownership_intent(component, field, intent)` tool; intents stored as in-code annotations (`// arkui-sem: intent …`) or in a label log (choice open)
- [ ] Questions to the agent phrased as intent, not decorator; listed once at `session.idle`

#### Phase 5: R2 evaluation
- [x] MDP labels as intent proxies (only fields with a call-site edge); child-only vs + call site, evaluated in the bench (2026-10-08):
  - `@Link`, `@ObjectLink` with a write, `@Consume` → shared
  - `@Prop`/`@Param` with no child write → display-only
  - `@State` initialised from the parent, a written `@Prop`, `@Param @Once` + `@Local` → draft
- [ ] Mutation positives: `@Link` → `@Prop` on a child-written field (M3); a removed `onX` at a call site
- [x] R3 mutants (release line deleted) + real candidates, a labelled subset reviewed (bench)
- [ ] End to end: an opencode "edit dialog" run in `sandbox/demo` (does the agent declare intent; is the code correct)

#### Phase 6: left after LSP (later)
- [ ] Aliasing / dataflow in the fact extractor (ours; ArkAnalyzer only if it proves suitable)
- [ ] Derived-state rule (`@Watch` / `@Monitor` / `@Computed`) + dataset
- [ ] `@Track` rule
- [ ] R4 over-reactive state
- [ ] R5 issue → component mapping (Rung 3)
