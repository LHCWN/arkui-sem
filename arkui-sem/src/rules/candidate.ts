// What a rule reports before judging: a candidate, its kind and its fingerprint.
import type {
  CallSite,
  ComponentFact,
  FieldFact,
  InputFact,
  LoopFact,
  RebuiltElement,
  ResourceFact,
  WriteFact,
} from '../facts.js';
import type { RowRead } from '../queries.js';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4';

/** A candidate of each kind, keyed by kind: the facts its rule found. */
export type Candidate =
  | FieldCandidateBase<'R1', 'undecorated-mutated-rendered'> // plain member written after init and read in build()
  | NestedWriteCandidate
  | ForEachKeyStaleCandidate
  | ForEachIndexKeyCandidate
  | FieldCandidateBase<'R2', 'ownership-intent'> // passed-in field; candidates() does not emit it (callers build it)
  | EventUnwiredCandidate
  | ResourceCandidate
  | InputUnboundCandidate
  | InputNeverReadCandidate;

export type CandidateKind = Candidate['kind'];
export type CandidateOf<K extends CandidateKind> = Extract<Candidate, { kind: K }>;
/** A candidate about one field of the component: every kind but R3's. */
export type FieldCandidate = Extract<Candidate, { field: FieldFact }>;

interface CandidateBase<R extends RuleId, K extends string> {
  rule: R;
  kind: K;
  file: string;
  component: ComponentFact;
  line: number;
  /** Stable across runs: dedupe, cache, dismissals. */
  fingerprint: string;
}

interface FieldCandidateBase<R extends RuleId, K extends string> extends CandidateBase<R, K> {
  field: FieldFact;
}

/** R1: in-place writes deeper than the state decorator observes. */
export interface NestedWriteCandidate extends FieldCandidateBase<'R1', 'nested-write-unobserved'> {
  /** Every unobserved write, in source order. */
  writes: WriteFact[];
  /** V2: why V2 misses the writes, one entry per distinct gap. */
  gaps?: V2Gap[];
  /** V1: a keyed ForEach loop over the field, when a write is below an element: replacing the element instead keeps the
   *  row under the same key. */
  loop?: LoopFact;
}

/** R1: a write puts new objects where a ForEach's items were, under the same key, and the row renders a property they
 *  change: ForEach keeps the row of an existing key. */
export interface ForEachKeyStaleCandidate extends FieldCandidateBase<'R1', 'foreach-key-stale'> {
  loop: LoopFact;
  /** In source order. */
  rebuilds: KeyStaleRebuild[];
  /** Every rebuilt object is a `new T(…)`, whose properties are unknown. */
  opaque: boolean;
  /** The row's reads of the properties the rebuilds change. */
  staleReads: RowRead[];
  /** Rebuilding the row would reset state it holds: the fix leads with @ObjectLink. */
  statefulRow: boolean;
}

/** R1: a ForEach keyed by position whose items at a position change: ForEach keeps the row of an existing key. */
export interface ForEachIndexKeyCandidate extends FieldCandidateBase<'R1', 'foreach-index-key'> {
  loop: LoopFact;
  /** The writes that change which item sits at a position, in source order; `field` is the first one's. */
  shifts: IndexShift[];
  /** The only shifts are moves of the source's own array in methods, not in handlers in build(). */
  methodMovesOnly: boolean;
  /** The row's reads of the item. */
  reads: RowRead[];
}

/** select: a write of a field the source reads besides its array (`this.sel` in `this.items[this.sel].tags`).
 *  move: a write of that array that puts other items at existing positions (a reassignment, sort, splice). */
export interface IndexShift {
  field: FieldFact;
  write: WriteFact;
  how: 'select' | 'move';
}

export interface KeyStaleRebuild {
  write: WriteFact;
  element: RebuiltElement;
  /** The properties the row renders that the new object changes. */
  stale: string[];
}

/** R2: a callback the component calls and its call sites don't pass (unwiredCallbacks). */
export interface EventUnwiredCandidate extends FieldCandidateBase<'R2', 'event-unwired'> {
  unwired: Unwired;
}

/** R3: acquired in a lifecycle hook, no matching release. */
export interface ResourceCandidate extends CandidateBase<'R3', 'unreleased-resource'> {
  resource: ResourceFact;
}

/** R4: a field typing writes, which code also sets to a value, shown by no input: the input never shows that value. */
export interface InputUnboundCandidate extends FieldCandidateBase<'R4', 'input-unbound'> {
  /** The unbound inputs whose onChange writes the field. */
  inputs: InputFact[];
  /** The writes that set another value, in source order. */
  sets: WriteFact[];
}

/** R4: a field typing writes that nothing reads: the input has no effect. */
export interface InputNeverReadCandidate extends FieldCandidateBase<'R4', 'input-never-read'> {
  /** The inputs whose onChange writes the field. */
  inputs: InputFact[];
}

/** Why V2 misses a write: its owner is a plain class, a plain object type (interface or object type alias), an object
 *  literal, an @ObservedV2 class whose property lacks @Trace, or a container nested in another. owner is the class that
 *  declares the property, or for an object literal or nested container the path that holds it. */
export interface V2Gap {
  kind: 'class' | 'object-type' | 'object-literal' | 'untraced' | 'nested-container';
  owner: string;
  property: string;
}

export interface Unwired {
  effect: UnsetEffect;
  /** The call sites that don't pass the callback. */
  omitted: CallSite[];
  /** How many call sites create the component. */
  sites: number;
  /** How many of them pass arguments that can't be read, so may pass the callback. */
  opaque: number;
}

/** What calling a callback does when no parent passed it. throws: the field is undefined and called unchecked.
 *  nothing: a V2 @Event without a default, which is an empty function. */
export type UnsetEffect = 'throws' | 'nothing';

/** Stable across runs and edits elsewhere in the file: `<file>#<subject>#<tag>`, e.g. `…/Index.ets#Page.count#R1-nested`. */
export function fingerprint(file: string, subject: string, tag: string): string {
  return `${file}#${subject}#${tag}`;
}
