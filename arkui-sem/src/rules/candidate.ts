// What a rule reports before judging: a candidate, its kind and its fingerprint.
import type { CallSite, ComponentFact, FieldFact, ResourceFact, WriteFact } from '../facts.js';

export type RuleId = 'R1' | 'R2' | 'R3';

/** A candidate of each kind, keyed by kind: the facts its rule found. */
export type Candidate =
  | FieldCandidateBase<'R1', 'undecorated-mutated-rendered'> // plain member written after init and read in build()
  | NestedWriteCandidate
  | FieldCandidateBase<'R2', 'ownership-intent'> // passed-in field; candidates() does not emit it (callers build it)
  | EventUnwiredCandidate
  | ResourceCandidate;

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
}

/** R2: a callback the component calls and its call sites don't pass (unwiredCallbacks). */
export interface EventUnwiredCandidate extends FieldCandidateBase<'R2', 'event-unwired'> {
  unwired: Unwired;
}

/** R3: acquired in a lifecycle hook, no matching release. */
export interface ResourceCandidate extends CandidateBase<'R3', 'unreleased-resource'> {
  resource: ResourceFact;
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
