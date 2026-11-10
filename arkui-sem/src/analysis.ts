// .ets source → program facts → rule candidates. Deterministic; no model calls.
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

// --- Facts ---

export type StateMgmtVersion = 'V1' | 'V2';

export type WriteContext = 'build-closure' | 'async-callback' | 'lifecycle' | 'method';

/** A type annotation's structure. */
export type TypeRef =
  | { kind: 'name'; name: string; args: TypeRef[] } // Item, Array<X>, Map<K, V>, Record<K, V>, a type parameter
  | { kind: 'array'; element: TypeRef } // X[]
  | { kind: 'union'; members: TypeRef[] }
  | { kind: 'object' } // an inline object type
  | { kind: 'keyword'; name: string } // number, string, boolean, object, null, undefined, …
  | { kind: 'function' }
  | { kind: 'other' }; // tuples, literal types, …

/** One step below a field: a property, or an index as written ('' for the container a mutating call such as push
 *  changes); optional for `?.`. */
export type PathSegment = ({ prop: string } | { index: string }) & { optional?: true };

/** An object literal: a plain object, whatever its declared type. */
export interface ObjectLiteralFact {
  props: Record<string, LiteralValue>;
}

export type LiteralValue =
  | { kind: 'object'; literal: ObjectLiteralFact }
  | { kind: 'new'; type: TypeRef }
  | { kind: 'other' };

export interface WriteFact {
  line: number;
  context: WriteContext;
  method: string;
  /** Path below the field for in-place mutation (see pathText); absent for reassignment. */
  path?: PathSegment[];
  /** For an assignment (`=`, compound or update), what the assigned value is. */
  value?: 'object-literal' | 'new' | 'other';
  /** The writing method is reached neither from build()/@Builder nor from lifecycle hooks: other code calls it. */
  external?: boolean;
  disabledRules: string[];
}

export interface FieldFact {
  name: string;
  line: number;
  decorators: string[];
  /** The declared type as written, else the class of a `new X(…)` initializer; for display, typeRef for rules. */
  type?: string;
  typeRef?: TypeRef;
  hasInitializer: boolean;
  /** An object-literal initializer. */
  literal?: ObjectLiteralFact;
  buildReads: BuildRead[];
  writes: WriteFact[];
  /** The component calls the field as a function (`this.f(…)`): a callback it invokes. */
  invoked: boolean;
  /** timer: the initializer or an assigned value is a timer id (`setTimeout(…)`, `setInterval(…)`); clock: one reads a
   *  clock (`Date.now()`, `performance.now()`, `new Date()`) or starts a timer inside a larger expression. */
  timeValue?: 'timer' | 'clock';
  disabledRules: string[];
}

/** A read of the field in build()/@Builder. */
export interface BuildRead {
  line: number;
  /** The path below the field. */
  path: PathSegment[];
  /** The attribute method whose arguments hold the read (`.visibility(this.f ? … : …)` → "visibility"). */
  attribute?: string;
  /** The read sits in the arguments of ForEach, LazyForEach or Repeat. */
  inForEach: boolean;
}

export interface ResourceFact {
  kind: 'listener' | 'timer' | 'subscription';
  /** "emitter.on:refresh", "timer:this.pollId", "Mgr.getInstance().registerFoo", … */
  key: string;
  acquireLine: number;
  acquireIn: string;
  released: boolean;
  /** The matching release call, for the fix text. */
  release: string;
  /** Identifiers in the expression the resource is acquired on (`AppStorage`, `globalThis`, `this`, `bus`, …). */
  targetNames: string[];
  disabledRules: string[];
}

export interface ComponentFact {
  name: string;
  file: string;
  line: number;
  version: StateMgmtVersion;
  fields: FieldFact[];
  resources: ResourceFact[];
}

/** A class, an interface or an object type alias (`type T = { … }`) declared in the file. */
export interface TypeFact {
  kind: 'class' | 'interface' | 'object-alias';
  decorators: string[];
  /** What it extends, other than Array. */
  parents: string[];
  /** It extends Array<element>; params are its own type parameters. */
  arrayOf?: { element: TypeRef; params: string[] };
  members: Record<string, ClassMember>;
}

export interface ClassMember {
  decorators: string[];
  setter: boolean;
  /** Fields: as for FieldFact. */
  typeRef?: TypeRef;
  literal?: ObjectLiteralFact;
}

export interface FileFacts {
  file: string;
  components: ComponentFact[];
  types: Record<string, TypeFact>;
  imports: ImportFact[];
  /** `export { a as b } from 's'` (source set) and `export { a as b }` of a local or imported name (no source). */
  reexports: ReexportFact[];
  /** Sources of `export * from 's'`. */
  exportAll: string[];
  /** Name of the class or struct behind `export default`. */
  defaultExport?: string;
  componentUses: ComponentUse[];
  /** The parser reported syntax errors; some valid ArkTS does too (`.attr()` after the closure of `Child() { … }`). */
  parseErrors: boolean;
  lines: string[];
}

/**
 * How an argument's value is written, after casts, parentheses and `!`. `this.x.y`: a deeper property or index path.
 * `this.x!!` is V2 two-way binding: the child can write the parent's state, like `$x` in V1.
 */
export type ArgumentForm = 'this.x' | 'this.x!!' | '$x' | 'this.x.y' | 'literal' | 'callback' | 'other';

export interface ComponentArgument {
  field: string;
  line: number;
  form: ArgumentForm;
  /** The expression as written, on one line. */
  text: string;
}

/** `Child({ … })` in a build(), @Builder or @LocalBuilder body, or a field initializer (a dialog controller's builder). */
export interface ComponentUse {
  /** As written in the file, an alias included. */
  child: string;
  /** Absent in a file-level @Builder. */
  parent?: string;
  /** `build`, a builder's or field's name, or `@Builder foo` for a file-level builder. */
  method: string;
  line: number;
  args: ComponentArgument[];
  /** `Child(opts)` or a spread: fields may be passed that args doesn't list. */
  opaqueArgs?: boolean;
}

/** A component use, resolved to the struct it instantiates. */
export interface CallSite extends ComponentUse {
  file: string;
}

export interface CallSites {
  sites: CallSite[];
  /**
   * Files whose sites may be missing or wrong: left when the budget ran out, unreadable, or with syntax errors. A
   * directory the listing can't read counts as one.
   */
  unscanned: number;
}

export interface ImportFact {
  local: string;
  /** Name in the source module; "default" for a default import. */
  imported: string;
  source: string;
}

export interface ReexportFact {
  exported: string;
  imported: string;
  source?: string;
}

/** A class or struct and the file that declares it. */
export interface Declaration {
  facts: FileFacts;
  name: string;
}

/** Finds where a name used in a file is declared, across files; the project index implements it. */
export interface ClassResolver {
  declaration(name: string, from: FileFacts): Declaration | undefined;
}

/** A project's files: the facts of each, by normalized path (`resolve`), and where the names they use are declared. */
export interface Project extends ClassResolver {
  /** Called once per check, before any lookup: drop what may have changed since the last one. */
  refresh(): void;
  /** Throws when the file can't be read or parsed. */
  facts(file: string): FileFacts;
}

export interface FactExtractor {
  readonly name: string;
  extract(file: string, text: string): FileFacts;
}

// --- Derived facts ---

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function isIndex(s: PathSegment): s is { index: string } & { optional?: true } {
  return 'index' in s;
}

/** A path as written: `.title`, `?.items[]` (a mutating call), `[i].title`; '' for none. */
export function pathText(path?: PathSegment[]): string {
  return (path ?? [])
    .map((s) => (isIndex(s) ? `${s.optional ? '?.' : ''}[${s.index}]` : `${s.optional ? '?.' : '.'}${s.prop}`))
    .join('');
}

/** The lines build()/@Builder reads the field on, each once, in source order. */
export function readLines(f: FieldFact): number[] {
  return [...new Set(f.buildReads.map((r) => r.line))];
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

// --- Files ---

export const SKIP_DIRS = new Set(['node_modules', 'oh_modules', 'build', 'dist']);

export function absolute(p: string, base: string) {
  return isAbsolute(p) ? p : resolve(base, p);
}

/**
 * followed: real paths of the listing's root and of directories behind links, each listed once so link cycles end.
 * unreadable: when given, a path the listing can't read is added to it and skipped; otherwise the error is thrown.
 */
export function etsFiles(path: string, followed = new Set<string>(), unreadable?: string[]): string[] {
  try {
    if (!existsSync(path)) {
      return [];
    }
    if (statSync(path).isFile()) {
      return path.endsWith('.ets') ? [path] : [];
    }
    const real = realpathSync(path);
    if (followed.has(real)) {
      return [];
    }
    followed.add(real);
    return etsFilesIn(path, followed, unreadable);
  } catch (e) {
    return skipped(path, e, unreadable);
  }
}

function skipped<T>(path: string, e: unknown, unreadable?: string[]): T[] {
  if (!unreadable) {
    throw e;
  }
  unreadable.push(path);
  return [];
}

/** Empty when the directory has gone since its parent was listed. */
function entriesOf(dir: string, unreadable?: string[]): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }
    return skipped(dir, e, unreadable);
  }
}

/** Directory entries carry their type, so only links and entries of unknown type cost a stat. */
export function etsFilesIn(dir: string, followed = new Set<string>(), unreadable?: string[]): string[] {
  return entriesOf(dir, unreadable).flatMap((e) => {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) {
      return [];
    }
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      return etsFilesIn(path, followed, unreadable);
    }
    if (e.isFile()) {
      return e.name.endsWith('.ets') ? [path] : [];
    }
    return etsFiles(path, followed, unreadable);
  });
}

export function editedFiles(args: unknown, directory: string): string[] {
  const a = (args ?? {}) as { filePath?: unknown; patchText?: unknown };
  if (typeof a.filePath === 'string') {
    return [absolute(a.filePath, directory)];
  }
  if (typeof a.patchText === 'string') {
    return [...a.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) =>
      absolute((m[1] ?? m[2]).trim(), directory),
    );
  }
  return [];
}

// --- Rules ---

export type RuleId = 'R1' | 'R2' | 'R3';

export type CandidateKind =
  | 'undecorated-mutated-rendered' // R1: plain member written after init and read in build()
  | 'nested-write-unobserved' // R1: in-place write deeper than the state decorator observes
  | 'ownership-intent' // R2: passed-in field; candidates() does not emit it (callers build it)
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
  /** Stable across runs: dedupe, cache, dismissals. */
  fingerprint: string;
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

/** The container a mutating call changes (see PathSegment). */
function isCallSegment(s: PathSegment | undefined): boolean {
  return s !== undefined && isIndex(s) && s.index === '';
}

/** The property name of a segment, or the index as written (`[i]`). */
function segmentText(s: PathSegment): string {
  return isIndex(s) ? `[${s.index}]` : s.prop;
}

/** Levels below the field a write reaches: .title → 1, .address.city → 2, [i].title → 2, [] (array call) → 1. */
export function nestedDepth(path?: PathSegment[]) {
  return path?.length ?? 0;
}

function nonNull(t: TypeRef): TypeRef {
  if (t.kind !== 'union') {
    return t;
  }
  const kept = t.members.filter((m) => !(m.kind === 'keyword' && (m.name === 'null' || m.name === 'undefined')));
  return kept.length === 1 ? kept[0] : { kind: 'union', members: kept };
}

/** The name a type refers to, without null or undefined; undefined for anything but a named type. */
function className(t: TypeRef): string | undefined {
  const held = nonNull(t);
  return held.kind === 'name' ? held.name : undefined;
}

/** The class an @ObjectLink of type t binds: the element class for an array. */
export function heldClass(t: TypeRef): string | undefined {
  const held = nonNull(t);
  return className(held.kind === 'array' ? held.element : held);
}

/** Whether the file itself declares `name`: a class, an interface or object type alias, or a component. */
export function declares(facts: FileFacts, name: string): boolean {
  return own(facts.types, name) !== undefined || facts.components.some((c) => c.name === name);
}

/** Where `name`, as written in `scope`, is declared: in `scope` itself, else through the resolver. */
function declarationOf(name: string | undefined, scope: FileFacts, resolver?: ClassResolver): Declaration | undefined {
  if (name === undefined) {
    return undefined;
  }
  return declares(scope, name) ? { facts: scope, name } : resolver?.declaration(name, scope);
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

function sameDeclaration(a: Declaration | undefined, b: Declaration) {
  return a !== undefined && a.name === b.name && samePath(a.facts.file, b.facts.file);
}

/** A type and the file it is written in, which resolves the names in it. */
interface ScopedType {
  type: TypeRef;
  scope: FileFacts;
}

/** The class a field of type t holds: the element class for an array, without null or undefined; undefined for
 *  anything but a named type. */
export function typeClass(t: TypeRef, facts: FileFacts): string | undefined {
  const held = nonNull(t);
  return className(elementType(held, facts) ?? held);
}

function elementType(t: TypeRef, facts: FileFacts): TypeRef | undefined {
  return scopedElementType(t, facts)?.type;
}

/** Element type of X[], Array<X>, or a class extending Array<…> (its type parameters bound from t's arguments). */
function scopedElementType(t: TypeRef, scope: FileFacts, resolver?: ClassResolver): ScopedType | undefined {
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
function hierarchy(decl: Declaration, resolver?: ClassResolver): { chain: Declaration[]; complete: boolean } {
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
function memberOf(chain: Declaration[], property: string): { member: ClassMember; declaring: Declaration } | undefined {
  for (const d of chain) {
    const member = own(typeFact(d)?.members ?? {}, property);
    if (member) {
      return { member, declaring: d };
    }
  }
  return undefined;
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

/** Whether build() or a @Builder reads this.<field><path> or deeper; any index matches any index. For an array call
 *  (path ending in the call segment) only reads of the contents count, so passing the array itself to a child does not. */
function rendersPath(f: FieldFact, path: PathSegment[]): boolean {
  const arrayCall = isCallSegment(path.at(-1));
  const prefix = arrayCall ? path.slice(0, -1) : path;
  const minLength = prefix.length + (arrayCall ? 1 : 0);
  return f.buildReads.some(
    ({ path: read }) => read.length >= minLength && prefix.every((s, i) => sameSegment(s, read[i])),
  );
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

function linkTypesOf(c: ComponentFact, scope: FileFacts): { name: string; scope: FileFacts }[] {
  return c.fields.flatMap((f) => {
    const name = f.decorators.includes('@ObjectLink') && f.typeRef ? heldClass(f.typeRef) : undefined;
    return name === undefined ? [] : [{ name, scope }];
  });
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

/** Rule candidates in one file; with a resolver, V1 classes and @ObjectLink children declared in other files count too. */
export function candidates(facts: FileFacts, resolver?: ClassResolver): Candidate[] {
  const out: Candidate[] = [];
  for (const c of facts.components) {
    for (const f of c.fields) {
      if (f.decorators.some((d) => NON_STATE.has(d))) {
        continue;
      }
      const rendered = f.buildReads.length > 0;

      if (!isReactive(f) && rendered && f.writes.length > 0 && !f.disabledRules.includes('R1')) {
        out.push({
          rule: 'R1',
          kind: 'undecorated-mutated-rendered',
          file: facts.file,
          component: c,
          field: f,
          line: f.line,
          fingerprint: `${facts.file}#${c.name}.${f.name}#R1-undecorated`,
        });
      }

      const { writes: nested, gaps } = isReactive(f) ? unobservedWrites(f, facts, resolver) : { writes: [] };
      if (nested.length > 0 && rendered && !f.disabledRules.includes('R1')) {
        out.push({
          rule: 'R1',
          kind: 'nested-write-unobserved',
          file: facts.file,
          component: c,
          field: f,
          line: nested[0].line,
          writes: nested,
          gaps,
          fingerprint: `${facts.file}#${c.name}.${f.name}#R1-nested`,
        });
      }
    }
    for (const r of c.resources) {
      if (r.released || r.disabledRules.includes('R3')) {
        continue;
      }
      out.push({
        rule: 'R3',
        kind: 'unreleased-resource',
        file: facts.file,
        component: c,
        resource: r,
        line: r.acquireLine,
        fingerprint: `${facts.file}#${c.name}#R3-${r.key}`,
      });
    }
  }
  return out;
}
