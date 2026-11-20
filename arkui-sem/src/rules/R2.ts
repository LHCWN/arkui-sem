// R2, ownership: callbacks a component calls that no parent passes (event-unwired).
import type { CallSites, ComponentFact, ComponentUse, FieldFact, FileFacts, StateMgmtVersion } from '../facts.js';
import { isNullable } from '../queries.js';
import { type Candidate, fingerprint, type UnsetEffect } from './candidate.js';

/**
 * A callback the component calls and only a parent can supply, with what the call does when none did. V2: an @Event; one
 * that isn't passed and has no default is an empty function (OpenHarmony @Event docs). V1: an undecorated field.
 * Undefined for anything else: a field the component assigns, @Require (the compiler enforces it), and a callback the
 * component lets a parent leave out (a default, `f?:`, a nullable type, a check around each call).
 */
export function unsetCallback(f: FieldFact, version: StateMgmtVersion): UnsetEffect | undefined {
  const supplied =
    version === 'V2' ? f.decorators.length === 1 && f.decorators[0] === '@Event' : f.decorators.length === 0;
  if (!supplied || f.calls.length === 0 || f.writes.length > 0 || f.hasInitializer) {
    return undefined;
  }
  const optional = f.optional || (f.typeRef !== undefined && isNullable(f.typeRef)) || f.calls.every((c) => c.checked);
  if (optional) {
    return undefined;
  }
  return version === 'V2' ? 'nothing' : 'throws';
}

/** The callbacks R2 asks the component's call sites about. */
function askedCallbacks(c: ComponentFact): { field: FieldFact; effect: UnsetEffect }[] {
  return c.fields.flatMap((field) => {
    const effect = field.disabledRules.includes('R2') ? undefined : unsetCallback(field, c.version);
    return effect ? [{ field, effect }] : [];
  });
}

export function hasUnsetCallbacks(c: ComponentFact): boolean {
  return askedCallbacks(c).length > 0;
}

/** The use is known to leave the field out. */
function omits(use: ComponentUse, f: FieldFact): boolean {
  return !use.opaqueArgs && !use.args.some((a) => a.field === f.name);
}

/** Whether a use of the component leaves out a callback R2 asks about: without one, this use rules out a candidate
 *  that needs every site to omit it, and adds no site to one that throws. */
export function omitsCallback(c: ComponentFact, use: ComponentUse): boolean {
  return askedCallbacks(c).some(({ field }) => omits(use, field));
}

/**
 * R2 event unwired: callbacks of a component that its call sites don't pass. A call that throws is reported for each
 * site that omits the callback. One that does nothing is reported only when no site passes it and every site is known:
 * a parent that leaves an event out on purpose is common when another passes it.
 */
export function unwiredCallbacks(c: ComponentFact, facts: FileFacts, callSites: CallSites): Candidate[] {
  const out: Candidate[] = [];
  for (const { field: f, effect } of askedCallbacks(c)) {
    const omitted = callSites.sites.filter((s) => omits(s, f));
    const everySiteKnown = callSites.unscanned === 0 && omitted.length === callSites.sites.length;
    if (omitted.length > 0 && (effect === 'throws' || everySiteKnown)) {
      out.push({
        rule: 'R2',
        kind: 'event-unwired',
        file: facts.file,
        component: c,
        field: f,
        line: f.line,
        unwired: {
          effect,
          omitted,
          sites: callSites.sites.length,
          opaque: callSites.sites.filter((s) => s.opaqueArgs).length,
        },
        fingerprint: fingerprint(facts.file, `${c.name}.${f.name}`, 'R2-unwired'),
      });
    }
  }
  return out;
}
