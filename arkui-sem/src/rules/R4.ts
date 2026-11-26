// R4, state that doesn't do its job: a text input wired to its field in one direction only (input-unbound,
// input-never-read), a selection the rows compare against that nothing sets (selection-never-written).
import type { ClassResolver, ComponentFact, FieldFact, FileFacts, InputFact, WriteFact } from '../facts.js';
import { childField, renderingReads } from '../queries.js';
import { type Candidate, fingerprint } from './candidate.js';

export function r4Candidates(c: ComponentFact, facts: FileFacts, resolver?: ClassResolver): Candidate[] {
  return [...inputCandidates(c, facts), ...selectionCandidates(c, facts, resolver)];
}

/** Inputs write the field on each change while no input shows it. Owned V1 state only: a @Link or @Prop field is
 *  shown or read by its parent, and a @Watch callback runs on every write. */
function inputCandidates(c: ComponentFact, facts: FileFacts): Candidate[] {
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

/** Rows compare the field with their item or index, and nothing ever sets it: no write in any method, hook or
 *  handler, no two-way binding, no child that may write it, no `this` the code hands on. Owned V1 state only. */
function selectionCandidates(c: ComponentFact, facts: FileFacts, resolver: ClassResolver | undefined): Candidate[] {
  if (c.version !== 'V1' || c.thisEscapes) {
    return [];
  }
  return c.fields.flatMap((field): Candidate[] => {
    const comparisons = c.loops.flatMap((loop) => loop.comparisons.filter((cmp) => cmp.field === field.name));
    if (
      comparisons.length === 0 ||
      !isOwnedState(field) ||
      field.disabledRules.includes('R4') ||
      field.writes.length > 0 ||
      field.initializerWrites.length > 0 ||
      field.boundTwoWay.length > 0 ||
      childMayWrite(field, c, facts, resolver)
    ) {
      return [];
    }
    return [
      {
        rule: 'R4',
        kind: 'selection-never-written',
        file: facts.file,
        component: c,
        field,
        line: field.line,
        comparisons,
        fingerprint: fingerprint(facts.file, `${c.name}.${field.name}`, 'R4-selection-never-written'),
      },
    ];
  });
}

/** The component passes the field to a child that may write it: `$f`, or `this.f` to a @Link; a child that can't be
 *  found counts as one. `this.f!!` is in boundTwoWay. */
function childMayWrite(
  field: FieldFact,
  c: ComponentFact,
  facts: FileFacts,
  resolver: ClassResolver | undefined,
): boolean {
  return facts.componentUses.some(
    (use) =>
      use.parent === c.name &&
      use.args.some((arg) => {
        if (arg.source !== field.name) {
          return false;
        }
        if (arg.form !== 'this.x') {
          return arg.form === '$x';
        }
        const target = childField(use.child, arg.field, facts, resolver);
        return target === undefined || target.decorators.includes('@Link');
      }),
  );
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

/** Typing changes nothing: the onChange only stores the text, in owned fields that are never read (a write to a
 *  @Link reaches the parent, one to a @Watch field runs its callback). */
function hasNoEffect(input: InputFact, c: ComponentFact, facts: FileFacts): boolean {
  return (
    !input.effects &&
    input.writes.every((w) => {
      const stored = c.fields.find((f) => f.name === w.field);
      return stored !== undefined && isOwnedState(stored) && neverRead(stored, c, facts);
    })
  );
}

/** No read in the component's code, no `$f` to a child, and no `this` the code hands on. */
function neverRead(field: FieldFact, c: ComponentFact, facts: FileFacts): boolean {
  const passed = facts.componentUses.some(
    (use) => use.parent === c.name && use.args.some((arg) => arg.form === '$x' && arg.source === field.name),
  );
  return field.reads.length === 0 && !passed && !c.thisEscapes;
}
