// Queries derived from the facts: paths, rendering reads, declared types and class hierarchies.
import { relative } from 'node:path';
import type {
  BuilderFact,
  BuildRead,
  ClassMember,
  ClassResolver,
  ComponentFact,
  Declaration,
  FieldFact,
  FileFacts,
  LoopFact,
  PathSegment,
  TypeFact,
  TypeRef,
  ValueUses,
  WriteFact,
} from './facts.js';

/** A write that runs only while build() draws and builds on the old value (a render counter): as state the field would
 *  re-render in a loop, so it is no reason for a state decorator. */
export function feedsRender(w: WriteFact): boolean {
  return w.context === 'render' && w.accumulates === true;
}

/** The reads that draw the UI: build()/@Builder reads outside event handlers, direct reads first, then reads in helpers. */
export function renderingReads(f: FieldFact): BuildRead[] {
  const reads = f.buildReads.filter((r) => !r.inHandler);
  return [...reads.filter((r) => r.via === undefined), ...reads.filter((r) => r.via !== undefined)];
}

/** A read of a loop item that draws its row, followed into the builders and children the row passes the item to. */
export interface RowRead {
  file: string;
  line: number;
  /** Below the item. */
  path: PathSegment[];
  attribute?: string;
  /** Where the read sits: in the item generator, in a builder it calls (the first one), or in a child's build reads of
   *  the field the item initializes. */
  via:
    | { kind: 'inline' }
    | { kind: 'builder'; name: string }
    | { kind: 'child'; child: string; field: string; decorators: string[] };
}

/** What a loop's row renders of the item. A builder or child that can't be found counts as a read of what it is passed. */
export function rowReads(
  loop: LoopFact,
  component: ComponentFact,
  facts: FileFacts,
  resolver?: ClassResolver,
): RowRead[] {
  return valueReads(loop.row, [], { facts, component }, { kind: 'inline' }, resolver, new Set());
}

/** Where a value's uses sit: builder methods resolve in the component, builder functions in the file. */
interface UseScope {
  facts: FileFacts;
  component?: ComponentFact;
}

function valueReads(
  uses: ValueUses,
  prefix: PathSegment[],
  scope: UseScope,
  via: RowRead['via'],
  resolver: ClassResolver | undefined,
  seen: Set<string>,
): RowRead[] {
  const out: RowRead[] = [];
  const read = (line: number, path: PathSegment[], attribute?: string) =>
    out.push({
      file: scope.facts.file,
      line,
      path: [...prefix, ...path],
      ...(attribute === undefined ? {} : { attribute }),
      via,
    });
  for (const use of uses.reads) {
    read(use.line, use.path, use.attribute);
  }
  for (const pass of uses.builders) {
    const found = builderOf(pass.builder, pass.method, scope, resolver);
    const param = found?.builder.params[pass.argument];
    if (!found || !param) {
      read(pass.line, pass.path, pass.attribute);
      continue;
    }
    // A builder that passes the value back to itself adds nothing more.
    const key = `${found.scope.facts.file}#${pass.method ? 'this.' : ''}${found.builder.name}`;
    if (!seen.has(key)) {
      const next: RowRead['via'] = via.kind === 'inline' ? { kind: 'builder', name: pass.builder } : via;
      out.push(
        ...valueReads(param.uses, [...prefix, ...pass.path], found.scope, next, resolver, new Set([...seen, key])),
      );
    }
  }
  for (const pass of uses.children) {
    const decl = declarationOf(pass.child, scope.facts, resolver);
    const field = decl?.facts.components.find((c) => c.name === decl.name)?.fields.find((f) => f.name === pass.field);
    if (!decl || !field) {
      read(pass.line, pass.path, pass.attribute);
      continue;
    }
    for (const childRead of renderingReads(field)) {
      out.push({
        file: decl.facts.file,
        line: childRead.line,
        path: [...prefix, ...pass.path, ...childRead.path],
        ...(childRead.attribute === undefined ? {} : { attribute: childRead.attribute }),
        via: { kind: 'child', child: decl.name, field: field.name, decorators: field.decorators },
      });
    }
  }
  return out;
}

/** Built-in components that hold what the user did in them (text, a choice, a position) or play something. */
const STATEFUL_COMPONENTS = new Set([
  'TextInput',
  'TextArea',
  'Search',
  'RichEditor',
  'Toggle',
  'Checkbox',
  'CheckboxGroup',
  'Radio',
  'Slider',
  'Rating',
  'Select',
  'DatePicker',
  'TimePicker',
  'TextPicker',
  'Counter',
  'Swiper',
  'Tabs',
  'List',
  'Grid',
  'Scroll',
  'Video',
  'Web',
]);
const OWN_STATE = ['@State', '@Local', '@Provide', '@Provider'];

/** A loop's row holds state of its own, which rebuilding the row resets: it creates a built-in component that holds
 *  some (STATEFUL_COMPONENTS) or a component with its own state fields, directly or in a builder it passes the item to. */
export function rowHoldsState(loop: LoopFact, c: ComponentFact, facts: FileFacts, resolver?: ClassResolver): boolean {
  const holds = (creates: string[], uses: ValueUses, scope: UseScope, seen: Set<string>): boolean =>
    creates.some((name) => STATEFUL_COMPONENTS.has(name) || ownsState(name, scope.facts, resolver)) ||
    uses.builders.some((pass) => {
      const found = builderOf(pass.builder, pass.method, scope, resolver);
      const key = found && `${found.scope.facts.file}#${pass.method ? 'this.' : ''}${found.builder.name}`;
      const param = found?.builder.params[pass.argument];
      return (
        found !== undefined &&
        key !== undefined &&
        param !== undefined &&
        !seen.has(key) &&
        holds(found.builder.creates, param.uses, found.scope, new Set([...seen, key]))
      );
    });
  return holds(loop.creates, loop.row, { facts, component: c }, new Set());
}

function ownsState(name: string, facts: FileFacts, resolver?: ClassResolver): boolean {
  const decl = declarationOf(name, facts, resolver);
  const child = decl?.facts.components.find((x) => x.name === decl.name);
  return child?.fields.some((f) => f.decorators.some((d) => OWN_STATE.includes(d))) ?? false;
}

function builderOf(
  name: string,
  method: boolean,
  scope: UseScope,
  resolver: ClassResolver | undefined,
): { builder: BuilderFact; scope: UseScope } | undefined {
  if (method) {
    const builder = scope.component?.builders.find((b) => b.name === name);
    return builder && { builder, scope };
  }
  const decl = declarationOf(name, scope.facts, resolver);
  const builder = decl?.facts.builders.find((b) => b.name === decl.name);
  return decl && builder && { builder, scope: { facts: decl.facts } };
}

export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function isIndex(s: PathSegment): s is { index: string } & { optional?: true } {
  return 'index' in s;
}

/** A path as written: `.title`, `?.items[]` (a mutating call), `[i].title`; '' for none. */
export function pathText(path?: PathSegment[]): string {
  return (path ?? [])
    .map((s) => (isIndex(s) ? `${s.optional ? '?.' : ''}[${s.index}]` : `${s.optional ? '?.' : '.'}${s.prop}`))
    .join('');
}

/** The lines build()/@Builder renders the field on, each once: direct reads, then reads in helpers, each in source order. */
export function readLines(f: FieldFact): number[] {
  return [...new Set(renderingReads(f).map((r) => r.line))];
}

/** The type declared in decl's file under its name, when it is a class, interface or object type alias. */
export function typeFact(decl: Declaration): TypeFact | undefined {
  return own(decl.facts.types, decl.name);
}

/** Classes in the file decorated with `decorator` (`@Observed`, `@ObservedV2`). */
export function classesWith(facts: FileFacts, decorator: string): string[] {
  return Object.entries(facts.types)
    .filter(([, t]) => t.kind === 'class' && t.decorators.includes(decorator))
    .map(([name]) => name);
}

/** Whether the file declares a class `name` decorated with `decorator`. */
export function isClassWith(facts: FileFacts, name: string, decorator: string): boolean {
  const t = own(facts.types, name);
  return t?.kind === 'class' && t.decorators.includes(decorator);
}

export function declaresClass(facts: FileFacts, name: string): boolean {
  return own(facts.types, name)?.kind === 'class';
}

/** The classes the file's components take as @ObjectLink. */
export function objectLinkTypes(facts: FileFacts): string[] {
  return facts.components.flatMap((c) => linkTypesOf(c, facts).map((t) => t.name));
}

/** The container a mutating call changes (see PathSegment). */
export function isCallSegment(s: PathSegment | undefined): boolean {
  return s !== undefined && isIndex(s) && s.index === '';
}

/** The property name of a segment, or the index as written (`[i]`). */
export function segmentText(s: PathSegment): string {
  return isIndex(s) ? `[${s.index}]` : s.prop;
}

/** Levels below the field a write reaches: .title → 1, .address.city → 2, [i].title → 2, [] (array call) → 1. */
export function nestedDepth(path?: PathSegment[]) {
  return path?.length ?? 0;
}

function isNullType(t: TypeRef): boolean {
  return t.kind === 'keyword' && (t.name === 'null' || t.name === 'undefined');
}

export function nonNull(t: TypeRef): TypeRef {
  if (t.kind !== 'union') {
    return t;
  }
  const kept = t.members.filter((m) => !isNullType(m));
  return kept.length === 1 ? kept[0] : { kind: 'union', members: kept };
}

export function isNullable(t: TypeRef): boolean {
  return t.kind === 'union' && t.members.some(isNullType);
}

/** The name a type refers to, without null or undefined; undefined for anything but a named type. */
export function className(t: TypeRef): string | undefined {
  const held = nonNull(t);
  return held.kind === 'name' ? held.name : undefined;
}

/** The class an @ObjectLink of type t binds: the element class for an array. */
export function heldClass(t: TypeRef): string | undefined {
  const held = nonNull(t);
  return className(held.kind === 'array' ? held.element : held);
}

/** Whether the file itself declares `name`: a class, an interface or object type alias, a component, or a builder
 *  function. */
export function declares(facts: FileFacts, name: string): boolean {
  return (
    own(facts.types, name) !== undefined ||
    facts.components.some((c) => c.name === name) ||
    facts.builders.some((b) => b.name === name)
  );
}

/** Where `name`, as written in `scope`, is declared: in `scope` itself, else through the resolver. */
export function declarationOf(
  name: string | undefined,
  scope: FileFacts,
  resolver?: ClassResolver,
): Declaration | undefined {
  if (name === undefined) {
    return undefined;
  }
  return declares(scope, name) ? { facts: scope, name } : resolver?.declaration(name, scope);
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

export function sameDeclaration(a: Declaration | undefined, b: Declaration) {
  return a !== undefined && a.name === b.name && samePath(a.facts.file, b.facts.file);
}

/** A type and the file it is written in, which resolves the names in it. */
export interface ScopedType {
  type: TypeRef;
  scope: FileFacts;
}

/** The class a field of type t holds: the element class for an array, without null or undefined; undefined for
 *  anything but a named type. */
export function typeClass(t: TypeRef, facts: FileFacts): string | undefined {
  const held = nonNull(t);
  return className(elementType(held, facts) ?? held);
}

export function elementType(t: TypeRef, facts: FileFacts): TypeRef | undefined {
  return scopedElementType(t, facts)?.type;
}

/** Element type of X[], Array<X>, or a class extending Array<…> (its type parameters bound from t's arguments). */
export function scopedElementType(t: TypeRef, scope: FileFacts, resolver?: ClassResolver): ScopedType | undefined {
  if (t.kind === 'array') {
    return { type: t.element, scope };
  }
  if (t.kind !== 'name') {
    return undefined;
  }
  if (t.name === 'Array' && t.args.length === 1) {
    return { type: t.args[0], scope };
  }
  const decl = declarationOf(t.name, scope, resolver);
  const arrayOf = decl && typeFact(decl)?.arrayOf;
  if (!decl || !arrayOf) {
    return undefined;
  }
  const { element, params } = arrayOf;
  const param = element.kind === 'name' && element.args.length === 0 ? params.indexOf(element.name) : -1;
  if (param < 0) {
    return { type: element, scope: decl.facts };
  }
  const arg = t.args[param];
  return arg ? { type: arg, scope } : undefined;
}

/** decl, then the declarations it extends, nearest first; each parent name resolves from its child's file (without a
 *  resolver, only within it). complete: every parent was found. */
export function hierarchy(decl: Declaration, resolver?: ClassResolver): { chain: Declaration[]; complete: boolean } {
  const chain = [decl];
  let complete = true;
  for (let i = 0; i < chain.length; i++) {
    for (const p of typeFact(chain[i])?.parents ?? []) {
      const parent = declarationOf(p, chain[i].facts, resolver);
      if (!parent) {
        complete = false;
      } else if (!chain.some((c) => sameDeclaration(c, parent))) {
        chain.push(parent);
      }
    }
  }
  return { chain, complete };
}

/** The nearest declaration in chain with member `property`, and the file its type is written in. */
export function memberOf(
  chain: Declaration[],
  property: string,
): { member: ClassMember; declaring: Declaration } | undefined {
  for (const d of chain) {
    const member = own(typeFact(d)?.members ?? {}, property);
    if (member) {
      return { member, declaring: d };
    }
  }
  return undefined;
}

/** Coarse kind of a field's type for the judge: a controller or scroller class, a primitive, an array, another class. */
export function typeKind(
  t: TypeRef,
  facts: FileFacts,
): 'controller' | 'boolean' | 'number' | 'string' | 'array' | 'class' | 'other' {
  const held = nonNull(t);
  const cls = typeClass(held, facts)?.toLowerCase() ?? '';
  if (cls.includes('controller') || cls.includes('scroller')) {
    return 'controller';
  }
  if (held.kind === 'keyword' && (held.name === 'boolean' || held.name === 'number' || held.name === 'string')) {
    return held.name;
  }
  if (elementType(held, facts) !== undefined) {
    return 'array';
  }
  return held.kind === 'name' ? 'class' : 'other';
}

/** The type is, or wraps (`T | undefined`, `Nullable<() => void>`), a function type. */
export function holdsFunction(t: TypeRef): boolean {
  switch (t.kind) {
    case 'function':
      return true;
    case 'union':
      return t.members.some(holdsFunction);
    case 'name':
      return t.args.some(holdsFunction);
    default:
      return false;
  }
}

export function linkTypesOf(c: ComponentFact, scope: FileFacts): { name: string; scope: FileFacts }[] {
  return c.fields.flatMap((f) => {
    const name = f.decorators.includes('@ObjectLink') && f.typeRef ? heldClass(f.typeRef) : undefined;
    return name === undefined ? [] : [{ name, scope }];
  });
}

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

const OWNED_V2 = new Set(['@Local']);

const REACTIVE_V2 = new Set(['@Local', '@Param', '@Provider', '@Consumer']);

/** Fields that never hold renderable state. */
const NON_STATE = new Set(['@BuilderParam', '@Event', '@Require']);

export function isReactive(f: FieldFact): boolean {
  return f.decorators.some((d) => REACTIVE_V1.has(d) || REACTIVE_V2.has(d));
}

export function isReactiveV1(f: FieldFact): boolean {
  return f.decorators.some((d) => REACTIVE_V1.has(d));
}

/** V2 state the component itself initializes. */
export function isOwnedV2(f: FieldFact): boolean {
  return f.decorators.some((d) => OWNED_V2.has(d));
}

export function isNonState(f: FieldFact): boolean {
  return f.decorators.some((d) => NON_STATE.has(d));
}
