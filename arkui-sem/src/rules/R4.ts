// R4, state that doesn't do its job: a text input wired to its field in one direction only (input-unbound,
// input-never-read).
import type { ComponentFact, FieldFact, FileFacts, InputFact, WriteFact } from '../facts.js';
import { renderingReads } from '../queries.js';
import { type Candidate, fingerprint } from './candidate.js';

/** Inputs write the field on each change while no input shows it. Owned V1 state only: a @Link or @Prop field is
 *  shown or read by its parent, and a @Watch callback runs on every write. */
export function r4Candidates(c: ComponentFact, facts: FileFacts): Candidate[] {
  if (c.version !== 'V1') {
    return [];
  }
  return c.fields.flatMap((field): Candidate[] => {
    if (!isOwnedState(field) || field.disabledRules.includes('R4')) {
      return [];
    }
    const writing = c.inputs.filter((input) => input.writes.some((w) => w.field === field.name));
    const shown = c.inputs.some((input) => input.binding.kind === 'field' && input.binding.field === field.name);
    // An input that shows something else, or a disable comment above one, leaves the field alone.
    const unbound = writing.every((input) => input.binding.kind === 'none' && !input.disabledRules.includes('R4'));
    if (writing.length === 0 || shown || !unbound) {
      return [];
    }
    const typed = new Set(
      writing.flatMap((input) => input.writes.flatMap((w) => (w.field === field.name ? [w.line] : []))),
    );
    const others = field.writes.filter((w) => !typed.has(w.line));
    const base = { rule: 'R4' as const, file: facts.file, component: c, field, line: writing[0].line, inputs: writing };
    const subject = `${c.name}.${field.name}`;
    if (others.every(isReset) && writing.every((input) => hasNoEffect(input, c, facts))) {
      return [
        {
          ...base,
          kind: 'input-never-read',
          // The field is what does nothing: the fix uses it or removes it.
          line: field.line,
          fingerprint: fingerprint(facts.file, subject, 'R4-input-never-read'),
        },
      ];
    }
    const sets = others.filter(setsValue);
    if (sets.length === 0 || renderingReads(field).length > 0) {
      return [];
    }
    return [
      { ...base, kind: 'input-unbound', sets, fingerprint: fingerprint(facts.file, subject, 'R4-input-unbound') },
    ];
  });
}

function isOwnedState(field: FieldFact): boolean {
  return field.decorators.includes('@State') && !field.decorators.includes('@Watch');
}

/** `this.f = ''`: puts the field back, shows nothing new. */
function isReset(w: WriteFact): boolean {
  return w.path === undefined && w.value === 'constant';
}

/** A write that gives the field a value the input should show: a whole-field assignment of something other than a
 *  constant, not built on the old value (`this.f = this.f.trim()`), outside drawing. */
function setsValue(w: WriteFact): boolean {
  return (
    w.path === undefined &&
    w.value !== 'constant' &&
    !w.accumulates &&
    w.context !== 'render' &&
    !w.disabledRules.includes('R4')
  );
}

/** Typing changes nothing: the onChange only stores the text, in fields that are never read. */
function hasNoEffect(input: InputFact, c: ComponentFact, facts: FileFacts): boolean {
  return (
    !input.effects &&
    input.writes.every((w) => {
      const stored = c.fields.find((f) => f.name === w.field);
      return stored !== undefined && neverRead(stored, c, facts);
    })
  );
}

/** No read in the component's code, no `$f` to a child, and no `this` the code hands on. */
function neverRead(field: FieldFact, c: ComponentFact, facts: FileFacts): boolean {
  const passed = facts.componentUses.some(
    (use) => use.parent === c.name && use.args.some((arg) => arg.form === '$x' && arg.text === `$${field.name}`),
  );
  return field.reads.length === 0 && !passed && !c.thisEscapes;
}
