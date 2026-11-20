// R1, state desync: a rendered member written where no state decorator sees the write.
import type {
  ClassResolver,
  ComponentFact,
  Declaration,
  FieldFact,
  FileFacts,
  ObjectLiteralFact,
  PathSegment,
  TypeRef,
  WriteFact,
} from '../facts.js';
import {
  className,
  declarationOf,
  elementType,
  feedsRender,
  hierarchy,
  isCallSegment,
  isClassWith,
  isIndex,
  linkTypesOf,
  memberOf,
  nestedDepth,
  nonNull,
  own,
  renderingReads,
  sameDeclaration,
  scopedElementType,
  segmentText,
  typeFact,
} from '../queries.js';
import { type Candidate, fingerprint, type V2Gap } from './candidate.js';

const REACTIVE_V1 = new Set([
  '@State',
  '@Prop',
  '@Link',
  '@ObjectLink',
  '@Provide',
  '@Consume',
  '@StorageLink',
  '@StorageProp',
  '@LocalStorageLink',
  '@LocalStorageProp',
]);

/** V2 state the component itself initializes. */
const OWNED_V2 = new Set(['@Local']);

const REACTIVE_V2 = new Set(['@Local', '@Param', '@Provider', '@Consumer']);

// Fields that never hold renderable state.
const NON_STATE = new Set(['@BuilderParam', '@Event', '@Require']);

/** Types whose index writes and API calls V2 observes on an observed property, besides arrays. */
const V2_CONTAINERS = new Set(['Map', 'Set', 'Date', 'WeakMap', 'WeakSet']);

/** Named types that are plain objects whatever they hold. */
const PLAIN_TYPES = new Set(['Record', 'Object']);

function isReactive(f: FieldFact) {
  return f.decorators.some((d) => REACTIVE_V1.has(d) || REACTIVE_V2.has(d));
}

function isReactiveV1(f: FieldFact) {
  return f.decorators.some((d) => REACTIVE_V1.has(d));
}

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
  const owned = f.decorators.some((d) => OWNED_V2.has(d)) && f.literal !== undefined;
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
    if (f.decorators.some((d) => NON_STATE.has(d)) || f.disabledRules.includes('R1')) {
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
      out.push({
        rule: 'R1',
        kind: 'nested-write-unobserved',
        file: facts.file,
        component: c,
        field: f,
        line: nested[0].line,
        writes: nested,
        gaps,
        fingerprint: fingerprint(facts.file, subject, 'R1-nested'),
      });
    }
  }
  return out;
}
