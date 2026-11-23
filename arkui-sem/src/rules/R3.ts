// R3, leaks: a resource acquired in a lifecycle hook and never released.
import type { ComponentFact, FileFacts } from '../facts.js';
import { type Candidate, fingerprint } from './candidate.js';

export function r3Candidates(c: ComponentFact, facts: FileFacts): Candidate[] {
  return c.resources
    .filter((r) => !r.released && !r.disabledRules.includes('R3'))
    .map((r) => ({
      rule: 'R3',
      kind: 'unreleased-resource',
      file: facts.file,
      component: c,
      resource: r,
      line: r.acquireLine,
      fingerprint: fingerprint(facts.file, c.name, `R3-${r.key}`),
    }));
}
