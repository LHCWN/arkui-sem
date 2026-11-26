// The fact model: what an extractor reads from an .ets file, and the cross-file lookups over those facts.

export type StateMgmtVersion = 'V1' | 'V2';

/** render: only while build() draws, in build(), a @Builder or a helper only they call, outside handlers;
 *  build-closure: in a handler inside build() or a @Builder. */
export type WriteContext = 'render' | 'build-closure' | 'async-callback' | 'lifecycle' | 'method';

/** A type annotation's structure. */
export type TypeRef =
  | { kind: 'name'; name: string; args: TypeRef[] } // Item, Array<X>, Map<K, V>, Record<K, V>, a type parameter
  | { kind: 'array'; element: TypeRef } // X[]
  | { kind: 'union'; members: TypeRef[] }
  | { kind: 'object' } // an inline object type
  | { kind: 'keyword'; name: string } // number, string, boolean, object, null, undefined, …
  | { kind: 'function' }
  | { kind: 'other' }; // tuples, literal types, …

/** One step below a field: a property, or an index as written ('' for the container a mutating call such as push
 *  changes); optional for `?.`. */
export type PathSegment = ({ prop: string } | { index: string }) & { optional?: true };

/** An object literal: a plain object, whatever its declared type. */
export interface ObjectLiteralFact {
  props: Record<string, LiteralValue>;
}

export type LiteralValue =
  | { kind: 'object'; literal: ObjectLiteralFact }
  | { kind: 'new'; type: TypeRef }
  | { kind: 'other' };

export interface WriteFact {
  line: number;
  context: WriteContext;
  method: string;
  /** Path below the field for in-place mutation (see pathText); absent for reassignment. */
  path?: PathSegment[];
  /** For an assignment (`=`, compound or update), what the assigned value is. constant: a string, number or boolean
   *  literal, `null` or `undefined` (a reset such as `this.query = ''`). */
  value?: 'object-literal' | 'new' | 'constant' | 'other';
  /** The new value depends on the old one: `++`, `+=`, `this.f = g(this.f)`, a mutating call. */
  accumulates?: true;
  /** The method a mutating call runs (`push`, `splice`); absent for an assignment or update. */
  call?: string;
  /** An assignment that puts no other item at an existing position: an append (`[...this.F, x]`, `this.F.concat(x)`), a
   *  clear (`[]`) or a cut from the start (`this.F.slice(0, n)`). */
  keepsPositions?: true;
  /** Of those, one that keeps the same items (`copy`: `[...this.F]`, `this.F.slice()`, `this.F.concat()`) or none
   *  (`clear`: `[]`, `this.F.slice(0, 0)`). Even a sorted or reversed view of the array shows the same item at each
   *  position, or no rows. */
  keepsItems?: 'copy' | 'clear';
  /** The writing method is reached neither from build()/@Builder nor from lifecycle hooks: other code calls it. */
  external?: boolean;
  /** The write loads what the component starts with: in aboutToAppear or a helper only it calls, outside callbacks
   *  other than promise continuations, before or after an await. */
  initialLoad?: true;
  /** The `if` arms of build() the write runs in, outermost first: through the @Builders and methods that reach it from
   *  build() (handlers included), then those in its own method. Absent when its method is not known to run only from
   *  build() (a lifecycle hook, other code). */
  branches?: Branch[];
  /** The write runs before the first build(): in aboutToAppear before any await, or in a helper only that calls. */
  beforeFirstRender?: true;
  /** The write assigns the same call as the field's initializer (`this.c = Store.getInstance()`): for a singleton or a
   *  shared lookup, the same object. */
  repeatsInitializer?: true;
  /** The new objects the write puts where elements of the field were (absent when none). */
  rebuilt?: RebuiltElement[];
  disabledRules: string[];
}

/**
 * A new object put at an existing element's position. map: `this.F = this.F.map(cb)`. loop: a loop over this.F pushes
 * it into the array then assigned to this.F. copy-index: `copy[i] = obj` on a copy of this.F then assigned to it.
 * index: `this.F[i] = obj`. splice: `this.F.splice(i, n, obj)`.
 */
export interface RebuiltElement {
  line: number;
  form: 'map' | 'loop' | 'copy-index' | 'index' | 'splice';
  /** new: a `new T(…)`, whose properties are unknown (kept and changed stay empty). */
  value: 'object-literal' | 'new';
  /** Paths below the element that keep its value: `p` for `p: e.p` or for `p: X` under a guard `e.p === X`, `cell.id`
   *  for `cell: { id: e.cell.id, … }`. */
  kept: string[];
  /** What else the literal sets, as paths below the element: `liked`, or `cell.title` for a nested literal over the
   *  element's own property (`cell: { ...e.cell, title: … }`). */
  changed: string[];
  /** The literal spreads the element (`{ ...e, … }`, `Object.assign({}, e, …)`): properties it doesn't set are kept. */
  keepsRest: boolean;
}

export interface FieldFact {
  name: string;
  line: number;
  decorators: string[];
  /** The declared type as written, else the class of a `new X(…)` initializer; for display, typeRef for rules. */
  type?: string;
  typeRef?: TypeRef;
  hasInitializer: boolean;
  /** Declared `f?: T`. */
  optional?: true;
  /** An object-literal initializer. */
  literal?: ObjectLiteralFact;
  buildReads: BuildRead[];
  /** Every read in the component's code: any method, getter or handler, another field's initializer, and two-way
   *  bindings (`$$this.f`). */
  reads: FieldRead[];
  writes: WriteFact[];
  /** Lines where a component or child is bound two-way to the field or a path below it (`$$this.f`, `this.f!!`): it
   *  may write the field, though no code here does. */
  boundTwoWay: number[];
  /** Lines of writes in callbacks another field's initializer sets up (`new Options().onChange((i) => { this.f = i })`),
   *  which `writes` leaves out; `reads` lists them too. */
  initializerWrites: number[];
  /** Where the component calls the field as a function (`this.f(…)`): a callback it invokes. */
  calls: CallbackCall[];
  /** timer: the initializer or an assigned value is a timer id (`setTimeout(…)`, `setInterval(…)`); clock: one reads a
   *  clock (`Date.now()`, `performance.now()`, `new Date()`) or starts a timer inside a larger expression. */
  timeValue?: 'timer' | 'clock';
  disabledRules: string[];
}

export interface FieldRead {
  line: number;
  /** The method, getter or handler; for a field initializer, that field's name. */
  method: string;
}

export interface CallbackCall {
  line: number;
  /** Called through `?.`, or the calling method also reads the field without calling it (a test of it). */
  checked: boolean;
}

/** A read of the field in build()/@Builder. */
export interface BuildRead {
  line: number;
  /** The path below the field. */
  path: PathSegment[];
  /** The attribute method whose arguments hold the read (`.visibility(this.f ? … : …)` → "visibility"). */
  attribute?: string;
  /** The read sits in the arguments of ForEach, LazyForEach or Repeat. */
  inForEach: boolean;
  /** A function holding the read is an event handler (an `on…` call's argument or a child's `on…` property, except
   *  `onDragStart`), an `animateTo` body or a deferred callback (timer, promise, `.on(…)`, `subscribe`): it runs on input
   *  or later and draws nothing. */
  inHandler: boolean;
  /** The read sits in a helper that build() or a @Builder calls or reads (`this.calcWidth()`, `this.label` for a getter),
   *  possibly through other helpers. */
  via?: string;
}

export interface ResourceFact {
  kind: 'listener' | 'timer' | 'subscription';
  /** "emitter.on:refresh", "timer:this.pollId", "Mgr.getInstance().registerFoo", … */
  key: string;
  acquireLine: number;
  acquireIn: string;
  released: boolean;
  /** The matching release call, for the fix text. */
  release: string;
  /** Identifiers in the expression the resource is acquired on (`AppStorage`, `globalThis`, `this`, `bus`, …). */
  targetNames: string[];
  disabledRules: string[];
}

export interface ComponentFact {
  name: string;
  file: string;
  line: number;
  /** Declared with `export`; an export list or `export default X` is in the file's facts instead. */
  exported?: true;
  version: StateMgmtVersion;
  fields: FieldFact[];
  resources: ResourceFact[];
  /** ForEach and LazyForEach calls in the methods that draw the UI, in source order. */
  loops: LoopFact[];
  /** The struct's @Builder and @LocalBuilder methods. */
  builders: BuilderFact[];
  /** Text inputs in the methods that draw the UI, in source order. */
  inputs: InputFact[];
  /** The code uses `this` as a value (`save(this)`, `const { a } = this`, `this['a']`), so it may read any field without
   *  a `this.f` access; `getContext(this)` and `f.bind(this)` don't count. */
  thisEscapes?: true;
}

/** A TextInput, TextArea or Search call: `TextInput({ text: this.name }).onChange((value) => { this.name = value })`. */
export interface InputFact {
  kind: 'TextInput' | 'TextArea' | 'Search';
  line: number;
  method: string;
  /** The text option (`value` for Search). none: absent. field: `this.f`, `$$this.f` or `this.f!!` (twoWay). other:
   *  any other expression, or options that can't be read (`TextInput(this.options)`, a spread). */
  binding: { kind: 'none' } | { kind: 'field'; field: string; twoWay: boolean } | { kind: 'other' };
  /** Whole-field assignments of the typed text, possibly normalized (`this.f = value`, `this.f = value.trim()`, not
   *  `this.valid = value.length > 0`), in its onChange, or in a component method the onChange hands the text to
   *  (`this.setName(value)`) or passes (`.onChange(this.setName)`) that nothing else uses. */
  writes: { field: string; line: number }[];
  /** The onChange does more than store the typed text: a statement other than those writes, calls that hand the text
   *  to a handler method and `console` calls; a handler method that does more, hands the text on again or that other
   *  code uses; a handler that can't be read. */
  effects: boolean;
  disabledRules: string[];
}

/** A ForEach or LazyForEach call: `ForEach(source, (item, index) => row, (item, index) => key)`. */
export interface LoopFact {
  kind: 'ForEach' | 'LazyForEach';
  line: number;
  /** The line the source argument starts on: the call's line unless the call spans lines. */
  sourceLine: number;
  method: string;
  /** Absent when the item generator is not a function written in place or its parameter is destructured. */
  itemParam?: string;
  indexParam?: string;
  /** The item generator declares an index parameter: with a key generator that declares none, ForEach joins the index
   *  to the key. */
  itemDeclaresIndex: boolean;
  source: LoopSource;
  key: LoopKey;
  /** What the row does with the item outside handlers. */
  row: ValueUses;
  /** The components the row creates outside handlers (`TextInput`, `Child`), by name. */
  creates: string[];
  /** Equality tests in the row, outside handlers, of a field against the item, a path below it or the index. */
  comparisons: LoopComparison[];
  /** The `if` arms of build() the loop runs in, through the @Builders that reach it, outermost first: switching arms
   *  recreates the loop. */
  branches: Branch[];
  disabledRules: string[];
}

/** `this.F === index`, `item.id !== this.F` (any of `===`, `!==`, `==`, `!=`). */
export interface LoopComparison {
  field: string;
  line: number;
  against: 'item' | 'index';
  /** The item or index side, without parentheses or casts (`index`, `item.id`), on one line. */
  operand: string;
  /** The comparison as written, on one line. */
  text: string;
}

/** One arm of an `if` statement; `at` is the statement's offset in the file. */
export interface Branch {
  at: number;
  arm: 'then' | 'else';
}

/**
 * The loop's data source. field: `this.F`. derived: an expression over fields (`this.F.filter(…)`, `this.F[i].p`,
 * `X[this.S].p`). call: a method call or a getter of the component (`this.visible()`, `this.visible`). new: a `new`
 * expression (a LazyForEach data source).
 */
export interface LoopSource {
  text: string;
  shape: 'field' | 'derived' | 'call' | 'new' | 'other';
  /** The field the source starts from (`F` in `this.F`, `this.F.filter(…)`, `this.F[i].p`); for a conditional, the
   *  field each arm that shows an array starts from (`this.ready ? this.F : []`). */
  root?: string;
  /** The field whose own elements are the items: `this.F`, or this.F through calls that keep its elements
   *  (`this.F.filter(…)`, `.slice(…)`, `.sort(…)`). */
  itemsOf?: string;
  /** The item properties the filters in that chain test as flags (`s.liked`, `!s.hidden`): a change to one moves the
   *  element into the items or out of them. */
  filteredBy?: string[];
  /** For a call: the method or getter (`shown` in `this.shown`, `(this.shown)!`, `this.shown(true)`). */
  helper?: string;
  /** For a call: the field every value the method or getter returns is, as is (`return this.F`). */
  returns?: string;
  /** The source, or what the method or getter it calls returns, sorts or reverses an array or cuts it from the end
   *  (`.reverse()`, `.slice(-n)`): an append moves the items at a position too. */
  reorders?: true;
  /** For a call: the field every value the method or getter returns starts from (`return this.F.filter(…)`), whose
   *  own array it shows. */
  returnsFrom?: string;
  /** Fields the source, or the method or getter it calls, reads only as the end of a `.slice(0, n)` followed by
   *  calls that keep the items in place (`this.F.slice(0, this.n)`), not in a condition or guard; or any field but
   *  F when every array it may show is F or its start (`this.showAll ? this.F : this.F.slice(0, 3)`): a change shows
   *  more or fewer items at the end, the same ones at each position. */
  windowEnds?: string[];
  /** The component's fields the source accesses, through the methods and getters it calls (outside their handlers),
   *  transitively. */
  fields: string[];
}

/**
 * The key generator. default: none given (ForEach: index and JSON of the item; LazyForEach: view id and index). index:
 * reads only the index. props: reads properties of the item (`item.id`). whole: reads the item itself
 * (`JSON.stringify(item)`, a primitive item). other: anything else (a method of the item, nothing of the loop).
 */
export interface LoopKey {
  kind: 'default' | 'index' | 'props' | 'whole' | 'other';
  /** The key generator as written, on one line. */
  text?: string;
  /** The item properties a props key reads, dotted down to the first index or method call (`album.id`). */
  props?: string[];
  /** The final key includes the index: the default key, a generator reading it, or the ForEach join rule. */
  withIndex: boolean;
}

/** What a function does with one value (a loop item, a builder parameter) outside handlers. */
export interface ValueUses {
  /** The value or a path below it read where it draws (`Text(item.name)`, `.opacity(item.on ? 1 : 0)`), or passed to
   *  anything that is neither a builder nor a child's argument. */
  reads: ValueRead[];
  /** Passed to a builder: `this.B(item)` for a builder method, `B(item.p)` for a function, possibly imported. */
  builders: BuilderPass[];
  /** Passed to a component: `Child({ f: item })`, `Child({ f: item.p })`. */
  children: ChildPass[];
}

export interface ValueRead {
  line: number;
  /** Below the value. */
  path: PathSegment[];
  /** As for BuildRead. */
  attribute?: string;
}

export interface BuilderPass {
  line: number;
  builder: string;
  /** Called as `this.B(…)`: a builder method of the component; else a builder function. */
  method: boolean;
  /** The parameter's position. */
  argument: number;
  /** The path below the value that is passed. */
  path: PathSegment[];
  /** As for BuildRead: kept for a builder that can't be found, whose pass then counts as a read. */
  attribute?: string;
}

export interface ChildPass {
  line: number;
  /** As written in the file, an alias included. */
  child: string;
  field: string;
  /** The path below the value that is passed. */
  path: PathSegment[];
  /** As for BuilderPass. */
  attribute?: string;
}

/** A @Builder or @LocalBuilder method, or a file-level @Builder function. */
export interface BuilderFact {
  name: string;
  line: number;
  /** In declaration order; a destructured parameter is unnamed and its uses are empty. */
  params: { name?: string; uses: ValueUses }[];
  /** The components it creates outside handlers, by name. */
  creates: string[];
}

/** A class, an interface or an object type alias (`type T = { … }`) declared in the file. */
export interface TypeFact {
  kind: 'class' | 'interface' | 'object-alias';
  decorators: string[];
  /** What it extends, other than Array. */
  parents: string[];
  /** It extends Array<element>; params are its own type parameters. */
  arrayOf?: { element: TypeRef; params: string[] };
  members: Record<string, ClassMember>;
}

export interface ClassMember {
  decorators: string[];
  setter: boolean;
  /** Fields: as for FieldFact. */
  typeRef?: TypeRef;
  literal?: ObjectLiteralFact;
}

export interface FileFacts {
  file: string;
  components: ComponentFact[];
  types: Record<string, TypeFact>;
  imports: ImportFact[];
  /** `export { a as b } from 's'` (source set) and `export { a as b }` of a local or imported name (no source). */
  reexports: ReexportFact[];
  /** Sources of `export * from 's'`. */
  exportAll: string[];
  /** Name of the class or struct behind `export default`. */
  defaultExport?: string;
  componentUses: ComponentUse[];
  /** File-level @Builder functions. */
  builders: BuilderFact[];
  /** The parser reported syntax errors; some valid ArkTS does too (`.attr()` after the closure of `Child() { … }`). */
  parseErrors: boolean;
  lines: string[];
}

/**
 * How an argument's value is written, after casts, parentheses and `!`. `this.x.y`: a deeper property or index path.
 * `this.x!!` is V2 two-way binding: the child can write the parent's state, like `$x` in V1.
 */
export type ArgumentForm = 'this.x' | 'this.x!!' | '$x' | 'this.x.y' | 'literal' | 'callback' | 'other';

export interface ComponentArgument {
  field: string;
  line: number;
  form: ArgumentForm;
  /** The expression as written, on one line. */
  text: string;
  /** The parent's field passed as a whole (`F` in `$F`, `this.F`, `this.F!!`). */
  source?: string;
}

/** `Child({ … })` in a build(), @Builder or @LocalBuilder body or a field initializer, and a dialog controller's
 *  `builder: Child({ … })` in any method. */
export interface ComponentUse {
  /** As written in the file, an alias included. */
  child: string;
  /** Absent in a file-level @Builder. */
  parent?: string;
  /** `build`, a builder's or field's name, or `@Builder foo` for a file-level builder. */
  method: string;
  line: number;
  args: ComponentArgument[];
  /** `Child(opts)` or a spread: fields may be passed that args doesn't list. */
  opaqueArgs?: boolean;
}

/** A component use, resolved to the struct it instantiates. */
export interface CallSite extends ComponentUse {
  file: string;
}

export interface CallSites {
  sites: CallSite[];
  /**
   * Files whose sites may be missing or wrong: left when the budget ran out, unreadable, or with syntax errors. A
   * directory the listing can't read counts as one.
   */
  unscanned: number;
}

export interface ImportFact {
  local: string;
  /** Name in the source module; "default" for a default import. */
  imported: string;
  source: string;
}

export interface ReexportFact {
  exported: string;
  imported: string;
  source?: string;
}

/** A class or struct and the file that declares it. */
export interface Declaration {
  facts: FileFacts;
  name: string;
}

/** Finds where a name used in a file is declared, across files; the project index implements it. */
export interface ClassResolver {
  declaration(name: string, from: FileFacts): Declaration | undefined;
}

export interface CallSiteOptions {
  /** Stops parsing when it runs out; the files left count as unscanned. */
  budgetMs?: number;
  /** The directory the agent works in: ties a module outside the project root to its project. */
  workspace?: string;
}

/** Where a struct is instantiated. Undefined when its file belongs to no project, so nothing was looked at. */
export interface CallSiteIndex {
  /** From one pass over the whole project, shared by the calls of a check. */
  callSites(decl: Declaration, options?: CallSiteOptions): CallSites | undefined;
  /** For one struct, from a text search: the work follows how many files mention it. */
  searchCallSites(decl: Declaration, options?: CallSiteOptions): Promise<CallSites | undefined>;
}

/** A project's files: the facts of each, by normalized path (`resolve`), and where the names they use are declared. */
export interface Project extends ClassResolver, CallSiteIndex {
  /** Called once per check, before any lookup: drop what may have changed since the last one. */
  refresh(): void;
  /** Throws when the file can't be read or parsed. */
  facts(file: string): FileFacts;
}

export interface FactExtractor {
  readonly name: string;
  extract(file: string, text: string): FileFacts;
}
