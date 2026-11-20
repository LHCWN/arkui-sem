// What a rule reports before judging: a candidate, its kind and its fingerprint.
import type { CallSite, ComponentFact, FieldFact, ResourceFact, WriteFact } from '../facts.js';

export type RuleId = 'R1' | 'R2' | 'R3';

export type CandidateKind =
  | 'undecorated-mutated-rendered' // R1: plain member written after init and read in build()
  | 'nested-write-unobserved' // R1: in-place write deeper than the state decorator observes
  | 'ownership-intent' // R2: passed-in field; candidates() does not emit it (callers build it)
  | 'event-unwired' // R2: a callback the component calls and its call sites don't pass (unwiredCallbacks)
  | 'unreleased-resource'; // R3: acquired in a lifecycle hook, no matching release

/** A field candidate (R1, R2) or a resource candidate (R3). */
export type Candidate = CandidateBase &
  ({ field: FieldFact; resource?: never } | { resource: ResourceFact; field?: never });

/** Why V2 misses a write: its owner is a plain class, a plain object type (interface or object type alias), an object
 *  literal, an @ObservedV2 class whose property lacks @Trace, or a container nested in another. owner is the class that
 *  declares the property, or for an object literal or nested container the path that holds it. */
export interface V2Gap {
  kind: 'class' | 'object-type' | 'object-literal' | 'untraced' | 'nested-container';
  owner: string;
  property: string;
}

interface CandidateBase {
  rule: RuleId;
  kind: CandidateKind;
  file: string;
  component: ComponentFact;
  line: number;
  /** Nested-write: every unobserved write, in source order. */
  writes?: WriteFact[];
  /** V2 nested-write: why V2 misses the writes, one entry per distinct gap. */
  gaps?: V2Gap[];
  /** Event-unwired: what the call sites show. */
  unwired?: Unwired;
  /** Stable across runs: dedupe, cache, dismissals. */
  fingerprint: string;
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
