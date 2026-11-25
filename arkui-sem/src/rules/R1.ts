// R1, state desync: a rendered member written where no state decorator sees the write.
import type {
  ClassResolver,
  ComponentFact,
  Declaration,
  FieldFact,
  FileFacts,
  LoopFact,
  LoopKey,
  ObjectLiteralFact,
  PathSegment,
  RebuiltElement,
  TypeRef,
  WriteFact,
} from '../facts.js';
import {
  afterFirstLoad,
  className,
  declarationOf,
  elementType,
  exclusiveArms,
  feedsRender,
  hierarchy,
  isCallSegment,
  isClassWith,
  isIndex,
  isNonState,
  isOwnedV2,
  isReactive,
  isReactiveV1,
  linkTypesOf,
  memberOf,
  moves,
  nestedDepth,
  nonNull,
  own,
  renderingReads,
  rowHoldsState,
  rowReads,
  sameDeclaration,
  scopedElementType,
  segmentText,
  typeFact,
} from '../queries.js';
import {
  type Candidate,
  type FieldWrite,
  fingerprint,
  type IndexShift,
  type KeyStaleRebuild,
  type LazySourceRebuiltCandidate,
  type V2Gap,
} from './candidate.js';

/** Types whose index writes and API calls V2 observes on an observed property, besides arrays. */
const V2_CONTAINERS = new Set(['Map', 'Set', 'Date', 'WeakMap', 'WeakSet']);

/** Named types that are plain objects whatever they hold. */
const PLAIN_TYPES = new Set(['Record', 'Object']);

interface Step {
  type?: TypeRef;
  /** The object literal the object here comes from: a plain object. */
  literal?: ObjectLiteralFact;
  /** The file the type is written in. */
  scope: FileFacts;
  /** The file the literal is written in, which can differ from the type's. */
  literalScope?: FileFacts;
}

/** The object at each prefix of this.<field><segs> (segs.length + 1 steps). Inside a literal, a property's own value
 *  decides: `{…}` stays plain, `new X(…)` is an X, anything else takes the declared type and is not known to be plain. A
 *  property at a path in replaced (normalPath) is assigned elsewhere, so no initializer decides its value. With a
 *  resolver, types declared in other files are followed there. */
function walk(
  fieldType: TypeRef | undefined,
  literal: ObjectLiteralFact | undefined,
  segs: PathSegment[],
  facts: FileFacts,
  replaced = new Set<string>(),
  resolver?: ClassResolver,
): Step[] {
  const steps: Step[] = [{ type: fieldType && nonNull(fieldType), literal, scope: facts, literalScope: facts }];
  for (const [i, s] of segs.entries()) {
    const prev = steps[steps.length - 1];
    let next: Step;
    if (isIndex(s)) {
      const element = prev.type === undefined ? undefined : scopedElementType(prev.type, prev.scope, resolver);
      next = element ?? { type: prev.type && recordValue(prev.type), scope: prev.scope };
    } else {
      const decl = prev.type ? declarationOf(className(prev.type), prev.scope, resolver) : undefined;
      const declared = decl && memberOf(hierarchy(decl, resolver).chain, s.prop);
      const type = declared?.member.typeRef;
      const scope = declared?.declaring.facts ?? prev.scope;
      if (replaced.has(normalPath(segs.slice(0, i + 1)))) {
        next = { type, scope }; // assigned elsewhere: its initializer is no longer the value
      } else if (prev.literal === undefined) {
        next = { type, literal: declared?.member.literal, scope, literalScope: scope };
      } else {
        const value = own(prev.literal.props, s.prop);
        const literalScope = prev.literalScope ?? prev.scope;
        next =
          value?.kind === 'object'
            ? { type, literal: value.literal, scope, literalScope }
            : value?.kind === 'new'
              ? { type: value.type, scope: literalScope }
              : { type, scope };
      }
    }
    steps.push({ ...next, type: next.type && nonNull(next.type) });
  }
  return steps;
}

/** Segments with every index as [] and no ?., so writes through different indexes share one path. */
function normalPath(segs: PathSegment[]): string {
  return segs.map((s) => (isIndex(s) ? '[]' : `.${s.prop}`)).join('');
}

/** What a field's writes share when judged: the field's literal value (see v2Gap) and the paths it assigns. */
interface FieldContext {
  literal?: ObjectLiteralFact;
  replaced: Set<string>;
}

function fieldContext(f: FieldFact): FieldContext {
  // The initializer's literal is the value only for state the component alone sets (a @Param, @Consumer or @Provider can
  // get its value from elsewhere), and only until a reassignment: one that assigns literals keeps the object plain, with
  // its contents unknown.
  const reassignments = f.writes.filter((x) => x.path === undefined);
  const owned = isOwnedV2(f) && f.literal !== undefined;
  const literal = !owned
    ? undefined
    : reassignments.length === 0
      ? f.literal
      : reassignments.every((x) => x.value === 'object-literal')
        ? { props: {} }
        : undefined;
  const replaced = new Set(
    f.writes
      .filter((x) => x.path !== undefined && x.value !== undefined && x.value !== 'object-literal')
      .map((x) => normalPath(x.path ?? [])),
  );
  return { literal, replaced };
}

/** The value type of Record<K, V>. */
function recordValue(t: TypeRef): TypeRef | undefined {
  return t.kind === 'name' && t.name === 'Record' ? t.args[1] : undefined;
}

/** Inline object types and records: plain objects whatever they hold. */
function isPlainType(t: TypeRef): boolean {
  return (
    t.kind === 'object' ||
    (t.kind === 'keyword' && t.name === 'object') ||
    (t.kind === 'name' && PLAIN_TYPES.has(t.name))
  );
}

/** Types whose index writes and API calls V2 observes on an observed property. */
function isContainer(t: TypeRef, facts: FileFacts): boolean {
  return elementType(t, facts) !== undefined || V2_CONTAINERS.has(className(t) ?? '');
}

function sameSegment(a: PathSegment, b: PathSegment): boolean {
  return isIndex(a) ? isIndex(b) : !isIndex(b) && a.prop === b.prop;
}

/** Whether build() or a @Builder renders this.<field><path> or deeper; any index matches any index. For an array call
 *  (path ending in the call segment) only reads of the contents count, so passing the array itself to a child does not. */
function rendersPath(f: FieldFact, path: PathSegment[]): boolean {
  const arrayCall = isCallSegment(path.at(-1));
  const prefix = arrayCall ? path.slice(0, -1) : path;
  const minLength = prefix.length + (arrayCall ? 1 : 0);
  return renderingReads(f).some(
    ({ path: read }) => read.length >= minLength && prefix.every((s, i) => sameSegment(s, read[i])),
  );
}

/** @ObjectLink field classes of the file's components and of the imported components it calls, each with the file
 *  that names it. */
function linkTypesInScope(facts: FileFacts, resolver?: ClassResolver): { name: string; scope: FileFacts }[] {
  const local = facts.components.flatMap((c) => linkTypesOf(c, facts));
  if (!resolver) {
    return local;
  }
  const used = new Set(facts.componentUses.map((u) => u.child));
  const imported = facts.imports
    .filter((i) => used.has(i.local))
    .flatMap((i) => {
      const decl = resolver.declaration(i.local, facts);
      const child = decl?.facts.components.find((c) => c.name === decl.name);
      return decl && child ? linkTypesOf(child, decl.facts) : [];
    });
  return [...local, ...imported];
}

/** V1: a property change on an @Observed object reaches every @ObjectLink bound to that object (OpenHarmony @Observed/@ObjectLink
 *  docs), so a deep write is seen when a child in the file, or an imported child the file calls, takes the owning class as
 *  @ObjectLink, unless the parent renders the path itself. */
function seenByObjectLink(f: FieldFact, path: PathSegment[], facts: FileFacts, resolver?: ClassResolver): boolean {
  const owner = walk(f.typeRef, undefined, path.slice(0, -1), facts, undefined, resolver).at(-1);
  const decl = owner?.type === undefined ? undefined : declarationOf(className(owner.type), owner.scope, resolver);
  if (!decl || !isClassWith(decl.facts, decl.name, '@Observed')) {
    return false;
  }
  return (
    linkTypesInScope(facts, resolver).some((t) => sameDeclaration(declarationOf(t.name, t.scope, resolver), decl)) &&
    !rendersPath(f, path)
  );
}

/** OpenHarmony docs (@Local, @ObservedV2 and @Trace): V2 sees an array's index writes and API calls (also Map, Set, Date)
 *  when the container itself is observed, and a property write only when the property is @Trace (or a setter) on an
 *  @ObservedV2 class, inherited ones included; plain objects are never observed. Undefined when V2 sees the write, or when it
 *  can't be judged: the owner type is unknown, declared elsewhere, or an interface whose object may be a class instance. A
 *  container inside another container (`grid[i]`) is not proxied: its writes are missed. */
function v2Gap(f: FieldFact, w: WriteFact, facts: FileFacts, field: FieldContext): V2Gap | undefined {
  const segs = w.path ?? [];
  const steps = walk(f.typeRef, field.literal, segs.slice(0, -1), facts, field.replaced);
  let ownerSegs = segs.slice(0, -1);
  let last = segs.at(-1);
  if (last === undefined) {
    return undefined;
  }
  if (isIndex(last)) {
    const { type: containerType, literal: containerLiteral } = steps[ownerSegs.length];
    const unknown = containerType === undefined && containerLiteral === undefined;
    if (unknown || (containerType !== undefined && isContainer(containerType, facts))) {
      // The write changes the container (an unknown type is taken for one) held by the property before it.
      const holder = ownerSegs.at(-1);
      if (holder === undefined) {
        return undefined;
      }
      if (isIndex(holder)) {
        if (unknown) {
          return undefined; // an element of unknown type may be any object
        }
        const outer = steps[ownerSegs.length - 1];
        if (outer.literal !== undefined || (outer.type !== undefined && isPlainType(outer.type))) {
          // The container sits in a plain object (a record): the object is what V2 misses.
          return {
            kind: 'object-literal',
            owner: ownerPath(f, ownerSegs.slice(0, -1)),
            property: segmentText(holder),
          };
        }
        return { kind: 'nested-container', owner: ownerPath(f, ownerSegs), property: '' };
      }
      last = holder;
      ownerSegs = ownerSegs.slice(0, -1);
    } else if (isCallSegment(last)) {
      return undefined; // a call named like a container mutation on some other object: not judged
    }
  }
  const { type: owner, literal } = steps[ownerSegs.length];
  if (owner !== undefined && elementType(owner, facts) !== undefined) {
    return undefined;
  }
  const property = segmentText(last);
  const cls = owner && className(owner);
  const decl = declarationOf(cls, facts); // V2 judges owners declared in the file only
  const kind = decl && typeFact(decl)?.kind;
  const objectType = kind === 'interface' || kind === 'object-alias';
  if (literal !== undefined || (owner !== undefined && isPlainType(owner))) {
    if (cls !== undefined && objectType) {
      return { kind: 'object-type', owner: cls, property };
    }
    return { kind: 'object-literal', owner: ownerPath(f, ownerSegs), property };
  }
  if (!decl || objectType || isIndex(last)) {
    return undefined; // an unknown owner, or a computed key on a class instance, names no known member
  }
  const { chain, complete } = hierarchy(decl);
  const declared = memberOf(chain, property);
  const allClasses = complete && chain.every((d) => typeFact(d)?.kind === 'class');
  if (!declared && !allClasses) {
    return undefined;
  }
  const isV2 = (d: Declaration) => isClassWith(d.facts, d.name, '@ObservedV2');
  const traced = declared?.member.setter || declared?.member.decorators.includes('@Trace');
  if ((traced && chain.some(isV2)) || !rendersPath(f, [...ownerSegs, last])) {
    return undefined; // observed, or a property nothing renders: leaving it untraced is the point of per-property @Trace
  }
  // @Trace compiles only inside an @ObservedV2 class.
  const declaring = declared?.declaring ?? decl;
  return { kind: isV2(declaring) ? 'untraced' : 'class', owner: declaring.name, property };
}

/** this.<field><segs> as a normalPath, so writes through different indexes share one owner. */
function ownerPath(f: FieldFact, segs: PathSegment[]): string {
  return `this.${f.name}${normalPath(segs)}`;
}

/** Writes the decorator can't see, minus writes under a disable comment. V1: deeper than the first layer, even with @Observed
 *  classes, unless an @ObjectLink child sees them. V2: see v2Gap, whose distinct gaps come back too. */
function unobservedWrites(
  f: FieldFact,
  facts: FileFacts,
  resolver?: ClassResolver,
): { writes: WriteFact[]; gaps?: V2Gap[] } {
  const writes = f.writes.filter((w) => !w.disabledRules.includes('R1'));
  if (isReactiveV1(f)) {
    return {
      writes: writes.filter(
        (w) => w.path !== undefined && nestedDepth(w.path) >= 2 && !seenByObjectLink(f, w.path, facts, resolver),
      ),
    };
  }
  const field = fieldContext(f);
  const unseen: WriteFact[] = [];
  const gaps = new Map<string, V2Gap>();
  for (const w of writes) {
    const gap = w.path === undefined ? undefined : v2Gap(f, w, facts, field);
    if (gap) {
      unseen.push(w);
      gaps.set(`${gap.kind} ${gap.owner} ${gap.kind === 'untraced' ? gap.property : ''}`, {
        ...gap,
      });
    }
  }
  return { writes: unseen, gaps: [...gaps.values()] };
}

/** R1 candidates for one component; with a resolver, V1 classes and @ObjectLink children declared in other files count
 *  too. */
export function r1Candidates(c: ComponentFact, facts: FileFacts, resolver?: ClassResolver): Candidate[] {
  const out: Candidate[] = [];
  for (const f of c.fields) {
    if (isNonState(f) || f.disabledRules.includes('R1')) {
      continue;
    }
    const rendered = renderingReads(f).length > 0;
    const subject = `${c.name}.${f.name}`;

    const writtenLater = f.writes.some((w) => !feedsRender(w));
    if (!isReactive(f) && rendered && writtenLater) {
      out.push({
        rule: 'R1',
        kind: 'undecorated-mutated-rendered',
        file: facts.file,
        component: c,
        field: f,
        line: f.line,
        fingerprint: fingerprint(facts.file, subject, 'R1-undecorated'),
      });
    }

    const { writes: nested, gaps } = isReactive(f) ? unobservedWrites(f, facts, resolver) : { writes: [] };
    if (nested.length > 0 && rendered) {
      // A property of an element, not an element of a nested array (`this.grid[i][j]`).
      const belowElement = nested.some((write) => {
        const [first, second] = write.path ?? [];
        return first !== undefined && isIndex(first) && second !== undefined && !isIndex(second);
      });
      const [loop] = c.version === 'V1' && belowElement ? keyedLoops(c, f) : [];
      out.push({
        rule: 'R1',
        kind: 'nested-write-unobserved',
        file: facts.file,
        component: c,
        field: f,
        line: nested[0].line,
        writes: nested,
        gaps,
        ...(loop ? { loop } : {}),
        fingerprint: fingerprint(facts.file, subject, 'R1-nested'),
      });
    }

    if (c.version === 'V1' && isReactive(f)) {
      out.push(...keyStaleCandidates(c, f, facts, resolver));
    }
  }
  if (c.version === 'V1') {
    const stale = new Set(out.flatMap((candidate) => (candidate.kind === 'foreach-key-stale' ? [candidate.loop] : [])));
    out.push(...indexKeyCandidates(c, facts, stale, resolver));
    const lazy = lazySourceCandidates(c, facts);
    // Declaring a reassigned source @State doesn't make LazyForEach follow it: the lazy kind replaces that advice, or
    // the reassignment needs none (a singleton fetched again, a first load the loop waits for, a disable comment),
    // unless build() also draws the field outside the loop's source (`Text(this.source.totalCount())`), which it does
    // redraw.
    const sourceOnly = (field: FieldFact) => {
      const loops = c.loops.filter(
        (loop) =>
          loop.kind === 'LazyForEach' &&
          (loop.source.shape === 'field' ? loop.source.root : loop.source.returns) === field.name,
      );
      return (
        loops.length > 0 &&
        field.writes.some((write) => write.path === undefined) &&
        renderingReads(field).every(
          (read) =>
            read.inForEach &&
            loops.some((loop) =>
              read.via === undefined ? loop.sourceLine === read.line : loop.source.text === read.via,
            ),
        )
      );
    };
    const kept = out.filter(
      (candidate) => !(candidate.kind === 'undecorated-mutated-rendered' && sourceOnly(candidate.field)),
    );
    return [...kept, ...lazy];
  }
  return out;
}

/** ForEach keeps the row of an existing key (OpenHarmony ForEach docs, 渲染结果非预期): under a key from the index
 *  alone, other items at a position leave the old rows there. One candidate per such loop whose row renders the item and
 *  whose items at a position change after the first render; loops foreach-key-stale reports are left to it. The
 *  fingerprint names the source as written, plus a counter when two loops share it. */
function indexKeyCandidates(
  component: ComponentFact,
  facts: FileFacts,
  stale: Set<LoopFact>,
  resolver?: ClassResolver,
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Map<string, number>();
  for (const loop of component.loops) {
    if (loop.kind !== 'ForEach' || loop.key.kind !== 'index') {
      continue;
    }
    const source = sourceTag(loop, seen);
    if (loop.disabledRules.includes('R1') || stale.has(loop)) {
      continue;
    }
    const shifts = loop.source.fields.flatMap((name) => shiftsOf(component, loop, name));
    const reads = shifts.length ? rowReads(loop, component, facts, resolver) : [];
    if (reads.length === 0) {
      continue;
    }
    const [first] = shifts;
    out.push({
      rule: 'R1',
      kind: 'foreach-index-key',
      file: facts.file,
      component,
      field: first.field,
      line: loop.line,
      loop,
      shifts,
      // A handler in build() or a @Builder is one even after an await.
      methodMovesOnly: shifts.every(
        ({ how, write }) =>
          how === 'move' &&
          write.context !== 'build-closure' &&
          write.method !== 'build' &&
          !component.builders.some((builder) => builder.name === write.method),
      ),
      reads,
      fingerprint: fingerprint(
        facts.file,
        `${component.name}.${loop.source.root ?? loop.source.returnsFrom ?? loop.source.fields[0]}`,
        `R1-foreach-index@${source}`,
      ),
    });
  }
  return out;
}

/** The writes of a state field the loop's source reads that change which item sits at a position after the first
 *  render. Of the source's own array only writes that move items count, and through a method or getter none that
 *  keeps the positions of an array it may return (an append), unless the source reorders that array and the write
 *  adds or removes items; none in the other arm of an `if` that holds the loop, which runs while the loop is not
 *  shown, and switching back recreates it. The array a method or getter returns moves like the source's own. */
function shiftsOf(component: ComponentFact, loop: LoopFact, name: string): IndexShift[] {
  const field = observedField(component, name);
  if (!field || loop.source.windowEnds?.includes(name)) {
    return [];
  }
  const how = name === (loop.source.root ?? loop.source.returnsFrom) ? 'move' : 'select';
  // An array write that keeps positions: an append, a clear, a cut from the end. Under a source that reorders the
  // array (`.reverse()`, `.slice(-n)`) one that adds or removes items moves those shown at a position all the same; a
  // copy or a clear does not.
  const keepsArray = (write: WriteFact) =>
    !moves(write) && (write.path?.length ?? 0) <= 1 && (write.path === undefined || isIndex(write.path[0]));
  const slides = (write: WriteFact) => loop.source.reorders === true && keepsArray(write) && !write.keepsItems;
  const changes = (write: WriteFact) =>
    how === 'move'
      ? moves(write) || slides(write)
      : (write.path?.length ?? 0) <= 1 && !(loop.source.shape === 'call' && keepsArray(write) && !slides(write));
  const writes = field.writes.filter(
    (write) =>
      write.context !== 'render' &&
      afterFirstLoad(write) &&
      !write.disabledRules.includes('R1') &&
      !exclusiveArms(write.branches ?? [], loop.branches) &&
      changes(write),
  );
  return writes.map((write) => ({ field, write, how }));
}

/** The loop's source as written, for a fingerprint, plus a counter when an earlier loop in `seen` shares it. */
function sourceTag(loop: LoopFact, seen: Map<string, number>): string {
  const source = loop.source.text.replace(/\s+/g, ' ');
  const count = (seen.get(source) ?? 0) + 1;
  seen.set(source, count);
  return count > 1 ? `${source}~${count}` : source;
}

/** One candidate per LazyForEach whose source is created while drawing (a `new` expression, a method or a getter) or is
 *  a field reassigned after the first render to another object (not the initializer's call again); a method or getter
 *  that returns a field as is counts as that field. */
function lazySourceCandidates(component: ComponentFact, facts: FileFacts): LazySourceRebuiltCandidate[] {
  const out: LazySourceRebuiltCandidate[] = [];
  const seen = new Map<string, number>();
  for (const loop of component.loops) {
    if (loop.kind !== 'LazyForEach') {
      continue;
    }
    const source = sourceTag(loop, seen);
    if (loop.disabledRules.includes('R1')) {
      continue;
    }
    const { shape, root, returns, fields } = loop.source;
    const name = shape === 'field' ? root : returns;
    const holder = component.fields.find((f) => f.name === name);
    if (holder === undefined && shape !== 'new' && shape !== 'call') {
      continue;
    }
    const reassigns =
      holder === undefined || holder.disabledRules.includes('R1')
        ? []
        : holder.writes.filter(
            (write) => write.path === undefined && !write.repeatsInitializer && laterWrite(write, loop),
          );
    if (holder !== undefined && reassigns.length === 0) {
      continue;
    }
    out.push({
      rule: 'R1',
      kind: 'lazyforeach-source-rebuilt',
      file: facts.file,
      component,
      line: loop.line,
      loop,
      holder,
      reassigns,
      changes: fields.filter((f) => f !== name).flatMap((f) => redraws(component, loop, f)),
      fingerprint: fingerprint(
        facts.file,
        `${component.name}.${holder?.name ?? fields[0] ?? 'LazyForEach'}`,
        `R1-lazy-source@${source}`,
      ),
    });
  }
  return out;
}

/** After the first render, R1 not disabled, and not only in the other arm of an `if` that holds the loop (switching
 *  arms recreates it). A first load after an await or in a promise continuation lands after the first build, so
 *  LazyForEach keeps the source it had; it counts only for a loop outside any `if`, whose arm may open only once the
 *  load is done (a loading flag). */
function laterWrite(write: WriteFact, loop: LoopFact): boolean {
  return (
    !write.beforeFirstRender &&
    !(write.initialLoad && loop.branches.length > 0) &&
    !write.disabledRules.includes('R1') &&
    !exclusiveArms(write.branches ?? [], loop.branches)
  );
}

/** The writes of a state field V1 observes, so redraw what reads it. */
function redraws(component: ComponentFact, loop: LoopFact, name: string): FieldWrite[] {
  const field = observedField(component, name);
  return (field?.writes ?? [])
    .filter((write) => write.context !== 'render' && (write.path?.length ?? 0) <= 1 && laterWrite(write, loop))
    .flatMap((write) => (field ? [{ field, write }] : []));
}

/** A V1 state field of the component, R1 not disabled. */
function observedField(component: ComponentFact, name: string): FieldFact | undefined {
  const field = component.fields.find((f) => f.name === name);
  return field && !isNonState(field) && isReactive(field) && !field.disabledRules.includes('R1') ? field : undefined;
}

/** The ForEach loops over the field's own elements whose key stays with an element: item properties or the index. */
function keyedLoops(component: ComponentFact, field: FieldFact): LoopFact[] {
  return component.loops.filter(
    (loop) =>
      loop.kind === 'ForEach' &&
      loop.source.itemsOf === field.name &&
      (loop.key.kind === 'props' || loop.key.kind === 'index'),
  );
}

/** ForEach keeps the row of an existing key and does not pass it the new item (OpenHarmony ForEach docs, 数据变化不渲染):
 *  one candidate per keyed loop over the field whose row renders a property that new objects under its key change. The
 *  fingerprint names the key as written, plus a counter when the field has two loops with the same key. */
function keyStaleCandidates(
  component: ComponentFact,
  field: FieldFact,
  facts: FileFacts,
  resolver?: ClassResolver,
): Candidate[] {
  const writes = field.writes.filter(
    (write) => write.rebuilt && !feedsRender(write) && !write.beforeFirstRender && !write.disabledRules.includes('R1'),
  );
  if (writes.length === 0) {
    return [];
  }
  const out: Candidate[] = [];
  const seen = new Map<string, number>();
  for (const loop of keyedLoops(component, field)) {
    const keyText = loop.key.text ?? loop.key.kind;
    const count = (seen.get(keyText) ?? 0) + 1;
    seen.set(keyText, count);
    if (loop.disabledRules.includes('R1')) {
      continue;
    }
    const reads = rowReads(loop, component, facts, resolver);
    const rendered = new Set(reads.flatMap((read) => propPath(read.path) ?? []));
    // A key property is the same under a kept key; a filter flag moves the element instead of leaving it stale.
    const fixed = [...(loop.key.props ?? []), ...(loop.source.filteredBy ?? [])];
    const rebuilds: KeyStaleRebuild[] = writes.flatMap((write) =>
      (write.rebuilt ?? []).flatMap((element) => {
        const stale = keepsKey(element, loop.key)
          ? [...rendered].filter((path) => !fixed.some((prop) => within(path, prop)) && changes(element, path))
          : [];
        return stale.length ? [{ write, element, stale }] : [];
      }),
    );
    if (rebuilds.length === 0) {
      continue;
    }
    const stale = new Set(rebuilds.flatMap((rebuild) => rebuild.stale));
    out.push({
      rule: 'R1',
      kind: 'foreach-key-stale',
      file: facts.file,
      component,
      field,
      line: loop.line,
      loop,
      rebuilds,
      opaque: rebuilds.every((rebuild) => rebuild.element.value === 'new'),
      staleReads: reads.filter((read) => stale.has(propPath(read.path) ?? '')),
      statefulRow: rowHoldsState(loop, component, facts, resolver),
      fingerprint: fingerprint(
        facts.file,
        `${component.name}.${field.name}`,
        `R1-foreach-key@${keyText}${count > 1 ? `~${count}` : ''}`,
      ),
    });
  }
  return out;
}

/** The properties a read path starts with, dotted (`cell.views`), up to the first index. */
function propPath(path: PathSegment[]): string | undefined {
  const end = path.findIndex(isIndex);
  const props = (end < 0 ? path : path.slice(0, end)).map((segment) => ('prop' in segment ? segment.prop : ''));
  return props.length ? props.join('.') : undefined;
}

/** The new object gives the row the same key: an index key, or every key property kept. A `new T(…)`, whose
 *  properties are unknown, is taken to. */
function keepsKey(element: RebuiltElement, key: LoopKey): boolean {
  return key.kind === 'index' || element.value === 'new' || (key.props ?? []).every((p) => keeps(element, p));
}

/** The new object holds the element's value of the property path: it keeps the path or a property above it, or keeps
 *  the rest and changes nothing at, below or above the path; never known for a `new T(…)`. */
function keeps(element: RebuiltElement, prop: string): boolean {
  return (
    element.kept.some((path) => within(prop, path)) ||
    (element.keepsRest && !element.changed.some((path) => within(path, prop) || within(prop, path)))
  );
}

/** The new object may show something else at a read path: it changes the path, something below it or above it, or
 *  drops its top property; a `new T(…)` may change anything. */
function changes(element: RebuiltElement, read: string): boolean {
  const top = read.split('.')[0];
  if (element.kept.some((path) => within(read, path))) {
    return false;
  }
  return (
    element.value === 'new' ||
    element.changed.some((path) => within(path, read) || within(read, path)) ||
    (!element.keepsRest && !element.kept.includes(top) && !element.changed.some((path) => within(path, top)))
  );
}

/** path is prop or below it: `cell.title` is within `cell`. */
function within(path: string, prop: string): boolean {
  return path === prop || path.startsWith(`${prop}.`);
}
