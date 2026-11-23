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
| `input-unbound` | R4 | A text input whose state is written by code but not bound to the input, so the input never shows it. | question |
| `input-never-read` | R4 | State an input writes that nothing renders or reads. | question |
| `selection-never-written` | R4 | A selection the rows compare against that nothing sets. | question |

R4 is widened from "over-reactive state" to "state that doesn't do its job" when its first kinds land: wiring gaps
plus the original over-reactive cases. All new kinds are V1-only until ForEach and LazyForEach under V2 are checked.

## Sequence

One branch and PR per step, each after an explicit go.

1. **Refactor (no behaviour change).** Fact model, derived queries and one module per rule; one per-kind entry in
   the engine; disable comments that attach to a statement.
2. **Loop fact and `@Builder` parameter reads** (no new rule): one fact per `ForEach`/`LazyForEach` call in a drawing
   method (source, key, what the row renders, disable comment above the call).
3. **`foreach-key-stale`** and the ForEach-aware nested-write fix text.
4. **R4 widened**, `input-unbound`, `input-never-read` (needs an input fact; can run in parallel with 2–3).
5. **`foreach-index-key`** and **`lazyforeach-source-rebuilt`**.
6. **`selection-never-written`** (needs 2 and 4).

Each PR: offline tests and fixtures; no change in the existing kinds' findings unless the PR is about them. The bench
evaluates each PR on its committed tree (regression over recorded agent sessions, noise over open-source corpora).

## Status

- Step 1: done (#32).
- Step 2: done (#33).
- Step 3: done (#N).
- Steps 4–6: not started.

## Open decisions

- Whether `input-unbound` moves from question to finding (after the noise check).
