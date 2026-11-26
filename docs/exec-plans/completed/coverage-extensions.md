# Coverage extensions: list rendering and input wiring (exec plan)

Goal: catch the state bugs agents write that R1–R3 miss today. Most are in list rendering (`ForEach`, `LazyForEach`)
and in how inputs and selections are wired to state. Each kind below is decided by facts alone (p null, like R2
event-unwired) and comes with fixtures written from scratch. The working plan with its evidence, per-case analysis and
evaluation steps is private: `bench/docs/plans/coverage-extensions.md`.

## Kinds

| Kind | Rule | Bug | Band |
|---|---|---|---|
| nested-write fix text aware of ForEach keys | R1 (text only) | The nested-write fix tells the agent to rebuild the element; done under an unchanged ForEach key, that is the next bug. | unchanged |
| `foreach-key-stale` | R1 | Elements replaced with new objects under an unchanged ForEach key, while the row renders a changed property: ForEach keeps the old row. | finding |
| `foreach-index-key` | R1 | ForEach keyed by position while the items at a position can change: rows keep their old content. | finding (question for some writers) |
| `lazyforeach-source-rebuilt` | R1 | A LazyForEach data source created while drawing, or reassigned: LazyForEach updates only through its listener. | finding or question |
| `input-unbound` | R4 | A text input whose state is written by code but not bound to the input, so the input never shows it. | finding |
| `input-never-read` | R4 | State an input writes that nothing renders or reads. | question |
| `selection-never-written` | R4 | A selection the rows compare against that nothing sets. | question |

R4 is widened from "over-reactive state" to "state that doesn't do its job": wiring gaps plus the original
over-reactive cases. All the new kinds are V1-only until ForEach and LazyForEach under V2 are checked.

## Result

Every kind above landed, one PR per step, each with offline tests and fixtures; the bench evaluated each on its
committed tree (private: `bench/docs/plans/coverage-extensions.md`).

| Step | PR |
|---|---|
| Refactor: fact model, derived queries, one module per rule, one engine entry per kind | #32 |
| Loop fact and `@Builder` parameter reads (no new rule) | #33 |
| `foreach-key-stale` and the ForEach-aware nested-write fix text | #34 |
| R4 widened, `input-unbound`, `input-never-read`; demo page `Notes.ets` | #36 |
| `foreach-index-key`; compacted in #41 (rare source shapes cut, listed in the tech-debt tracker) | #37 |
| `lazyforeach-source-rebuilt` | #38 |
| `selection-never-written` | #39 |
| Cleanup: `knip` and `tsc --noUnusedLocals --noUnusedParameters` found no dead code, unused file or dependency; the duplicated walks and the cleanup-only tracker items were too small to refactor, so the code is unchanged; stale docs fixed | no PR of its own |

Limits of each kind are in `docs/exec-plans/tech-debt-tracker.md`; coverage by rule is in
`docs/exec-plans/active/roadmap.md`.
