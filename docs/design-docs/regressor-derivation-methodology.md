# Methodology and Architecture of the ArkUI AST Logistic Regressor

**Status:** Current  
**Scope:** Static linting of ArkUI declarative state desynchronization (ArkEval Category 1, Rule R1) in `arkui-sem`.

---

## 1. Introduction and Problem Statement

In the ArkUI declarative framework (OpenHarmony / HarmonyOS), UI reactivity is strictly governed by state decorators:
- **V1 State Management:** `@State`, `@Link`, `@Prop`, `@Provide`, `@Consume`, `@StorageLink`.
- **V2 State Management:** `@Local`, `@Param`, `@Event`, `@Provider`, `@Consumer`.

If a component member variable is mutated during user interactions but lacks a state decorator, its underlying value updates in memory while the rendering engine never schedules a re-render for dependent UI components. This silent failure mode is known as **Under-reactive UI state / State Desynchronization**.

### The Limits of Naive Static Rules

A naive static heuristic flagging all unadorned fields:

$$\text{reads\_in\_build} > 0 \land \text{writes} > 0 \land \text{decorators} = \emptyset \implies \text{Flag Desync Bug}$$

exhibits an unacceptably high false alarm rate. In production codebases, many non-reactive fields are legitimately read in `build()` and mutated:
- One-time initialization in lifecycle hooks (e.g., `aboutToAppear()`).
- Internal UI controllers (e.g., `Scroller`, `WebviewController`).
- Temporary computation values and rendering caches.

Flagging all such fields causes developer fatigue and linter abandonment.

---

## 2. Dense Code Embeddings vs. Structural Facts

Early experiments evaluated whether local dense vector embeddings (e.g., code bi-encoders) combined with k-NN exemplar matching or linear probing could classify reactivity intent without cloud LLM dependencies.

### Cosine Similarity Collapse

Dense bi-encoders compute vector representations by pooling token embeddings across entire code blocks. In realistic ArkTS components, a decorator keyword (like `@State`) represents less than 0.5% of the total token count. Layout elements (`Column`, `Row`, `Text`, `Button`) and styling attributes dominate the embedding space.

Consequently, components differing solely by the presence or absence of a state decorator exhibit near-identical cosine similarities ($\cos(v_A, v_B) \approx 0.98\text{--}0.99$). Token-level dense encoders lack sensitivity to fine-grained declarative state semantics.

---

## 3. Mathematical Formulation of the AST Logistic Regressor

Instead of embedding raw tokens, `arkui-sem` extracts structured facts from the ohos-typescript syntax tree (`EtsExtractor`), passes them in the slice as typed fields, and applies a continuous logistic scoring model in `HeuristicBackend`.

### Formulation

For each candidate field, an AST feature vector $X = (x_1, x_2, \dots, x_m)$ is evaluated. The model computes logit $z$:

$$z = w_0 + \sum_{i=1}^{m} w_i x_i$$

The probability of a desynchronization bug is given by the standard logistic sigmoid:

$$P(\text{desync\_bug} \mid X) = \sigma(z) = \frac{1}{1 + e^{-z}}$$

To prevent extreme overconfidence on noisy edge cases, the probability is clamped within $[0.05, 0.95]$.

---

## 4. Name-Free AST Feature Engineering

Rather than relying on brittle naming conventions (such as `on*` or `init*` prefixes that fail to generalize across differing codebases and teams), the feature model relies purely on structural syntax and call-graph reachability:

### 1. Handle Gate: Controllers, Scrollers and Timer Ids
Certain values are handles passed to UI components or APIs, not reactive state:
- Framework controllers: a field whose class (or array element class) is named `…Controller` or `…Scroller` (slice `type_kind: "controller"`).
- Timer ids: a field initialized with or assigned a `setTimeout(…)` / `setInterval(…)` result (slice `time_value: "timer"`).
- Unconditionally gated to a minimal prior ($P = 0.05$).

### 2. Structural External-Method Reachability
To identify event handlers, callbacks, and listener targets without matching method names, the extractor builds an intra-component reachability call graph (methods and handler fields holding arrow functions):
- **Roots:**
  - `build()` and `@Builder` methods (traversing direct calls and method references such as `.onClick(this.handleClick)`).
  - Lifecycle hooks (`aboutToAppear`, `aboutToDisappear`, `onPageShow`, `onPageHide`, etc.).
- **External Methods:** Any component method not reachable from `build()`, `@Builder`, or lifecycle hooks is marked as an external entry point (`external: true`). These are methods called by external listeners, async callbacks, or other classes.
- Writes occurring inside markup closures (`build-closure`) or in `external` methods indicate interactive mutations that require reactive re-rendering.

### 3. Lifecycle-Only Mutation Penalty
Mutations confined strictly to lifecycle hooks (`contexts.every(c => c === "lifecycle")`) are typical of one-time setup and reduce the desynchronization logit.

### 4. Deep Nested Mutation Penalty
ArkUI V1 `@State` only observes first-level property reassignments. In-place mutations two or more levels deep (`this.a.b.c = ...`) do not trigger re-render on the parent component unless using `@Observed` / `@ObjectLink`. Fields with nested writes are penalized to avoid false positives on unobserved nested paths.

### 5. Type Kind
Primitive types exhibit different likelihoods of being reactive state (slice `type_kind`, from the annotation without `null` / `undefined`):
- `boolean` and `number`: typically represent toggle flags, counters, or indices (+0.7).
- `string`: often used for static labels or identifiers (-0.6).
- Arrays (`X[]`, `Array<X>`, classes extending `Array`): (-0.4).

### 6. Render Contexts in `build()`
Each read of the field in `build()` / `@Builder` records where it sits (slice `render_contexts`):
- Inside the arguments of `ForEach`, `LazyForEach` or `Repeat` (+1.8).
- In the arguments of a visual state attribute: `.visibility()`, `.opacity()` (+1.4).
- Animations / transformations: `.scale()`, `.rotate()`, `.translate()` (+0.6).
- Styling / interaction state: `.color()`, `.backgroundColor()`, `.fontColor()`, `.enabled()` (+0.6).

Reads inside a callback (an event handler such as `.onClick(() => …)`) name no attribute.

### 7. Time / Performance Bookkeeping Suppression
Fields whose initializer or an assigned value reads `Date.now()`, `performance.now()` or `new Date()`, or starts a timer inside a larger expression, represent internal measurement or scheduling and are penalized (slice `time_value: "clock"`, -1.4). A value that is itself a timer id gates the field (section 1).

---

## 5. Calibrated Logit Weights

The calibrated feature weights in `HeuristicBackend` operate as follows:

- Base logit: $z_0 = 1.05$
- Type adjustments:
  - `type_kind` boolean or number: $+0.7$
  - `type_kind` string: $-0.6$
  - `type_kind` array: $-0.4$
- Event / Reachability:
  - `hasEventHandler` (`build-closure` or `external` method): $+1.6$
  - `onlyLifecycle`: $-1.8$
  - `hasNestedMutation`: $-0.7$
  - Multiple writes: $>1$ write ($+0.3$), $>3$ writes ($+0.7$)
- Render contexts:
  - `for_each`: $+1.8$
  - `visibility` / `opacity`: $+1.4$
  - `scale` / `rotate` / `translate`: $+0.6$
  - `color` / `backgroundColor` / `fontColor` / `enabled`: $+0.6$
- `time_value` clock: $-1.4$

---

## 6. Evaluation and Verification

All quantitative benchmark evaluations, cross-application datasets, run records, and comparative metrics are maintained separately in the private benchmark repository.

For evaluation methodology, metric definitions, and benchmark results, see:
- `bench/docs/evaluation-method.md`
- `bench/docs/RESULTS.md`
