// The rules run on one file's facts. R2 event-unwired needs call sites from the project and runs in the engine.
import type { ClassResolver, FileFacts } from '../facts.js';
import type { Candidate } from './candidate.js';
import { r1Candidates } from './R1.js';
import { r3Candidates } from './R3.js';

export type { Candidate, CandidateKind, RuleId, UnsetEffect, Unwired, V2Gap } from './candidate.js';
export { hasUnsetCallbacks, omitsCallback, unsetCallback, unwiredCallbacks } from './R2.js';

/** Rule candidates in one file, component by component; with a resolver, declarations in other files count too. */
export function candidates(facts: FileFacts, resolver?: ClassResolver): Candidate[] {
  return facts.components.flatMap((c) => [...r1Candidates(c, facts, resolver), ...r3Candidates(c, facts)]);
}
