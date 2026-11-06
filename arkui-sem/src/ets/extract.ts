// .ets source → FileFacts, from the ohos-typescript syntax tree of one file (no type checker).
import {
  type BuildRead,
  type ClassMember,
  type ComponentFact,
  type FactExtractor,
  type FieldFact,
  type FileFacts,
  heldClass,
  type ImportFact,
  type LiteralValue,
  type ObjectLiteralFact,
  type PathSegment,
  type ReexportFact,
  type ResourceFact,
  type TypeRef,
  type WriteContext,
  type WriteFact,
} from '../analysis.js';
import { defaultParser, type EtsParser, ts } from './parse.js';

const LIFECYCLE = new Set([
  'aboutToAppear',
  'aboutToDisappear',
  'onPageShow',
  'onPageHide',
  'onBackPress',
  'aboutToReuse',
  'aboutToRecycle',
  'onDidBuild',
]);
const ACQUIRE_HOOKS = new Set(['aboutToAppear', 'onPageShow', 'aboutToReuse', 'onDidBuild']);
const RELEASE_HOOKS = new Set(['aboutToDisappear', 'onPageHide', 'aboutToRecycle']);
const MUTATING_CALLS = new Set([
  'push',
  'pop',
  'splice',
  'shift',
  'unshift',
  'sort',
  'reverse',
  'fill',
  'set',
  'delete',
  'clear',
]);
/** Calls whose function arguments run later, after the calling code has returned. */
const DEFERRING_CALLS = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'on', 'subscribe']);
/** Method names that acquire a subscription; the release is `un<name>` or, for add…, `remove…`. */
const REGISTRATION = /^(?:register\w*|subscribe\w*|add\w*(?:Listener|Observer|Callback))$/;
const DISABLE_DIRECTIVE = 'arkui-sem-disable-next-line';
const DISABLE = /arkui-sem-disable-next-line\s+([\w\s,]+)/;

const KEYWORD_TYPES = new Set([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NeverKeyword,
]);

/** A struct method, or a field holding a function (a handler), whose body the component runs. */
interface Method {
  name: string;
  decorators: string[];
  body: ts.Node;
}

export class EtsExtractor implements FactExtractor {
  readonly name = 'ets';

  constructor(private readonly parser: EtsParser = defaultParser()) {}

  extract(file: string, text: string): FileFacts {
    return new FileScan(file, text, this.parser).facts();
  }
}

// --- Syntax helpers ---

function decoratorNames(n: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(n) ? ts.getDecorators(n) : undefined;
  return (decorators ?? []).flatMap((d) => {
    const e = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return ts.isIdentifier(e) ? [`@${e.text}`] : [];
  });
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === kind)) || false;
}

function memberName(name: ts.PropertyName | undefined): string | undefined {
  return name &&
    (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    ? name.text
    : undefined;
}

function entityName(n: ts.EntityName): string {
  return ts.isIdentifier(n) ? n.text : `${entityName(n.left)}.${n.right.text}`;
}

/** `X`, `a.b.X` or `this.x` as written in an expression; undefined for anything else. */
function expressionName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) {
    return e.text;
  }
  if (e.kind === ts.SyntaxKind.ThisKeyword) {
    return 'this';
  }
  if (ts.isPropertyAccessExpression(e)) {
    const left = expressionName(e.expression);
    return left === undefined ? undefined : `${left}.${e.name.text}`;
  }
  return undefined;
}

/** The expression under parentheses, `as`/`satisfies` casts and non-null assertions. */
function unwrap(e: ts.Expression): ts.Expression {
  while (isWrapper(e)) {
    e = e.expression;
  }
  return e;
}

/** Parentheses, a cast or a non-null assertion: a value passed through unchanged. */
function isWrapper(
  n: ts.Node,
): n is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion {
  return (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  );
}

function isThis(e: ts.Expression): boolean {
  // `$$this.x` is ArkTS two-way binding syntax for `this.x`.
  return e.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(e) && e.text === '$$this');
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
}

function isFunction(n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

export function typeRef(t: ts.TypeNode): TypeRef {
  if (ts.isParenthesizedTypeNode(t)) {
    return typeRef(t.type);
  }
  if (ts.isTypeOperatorNode(t) && t.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return typeRef(t.type);
  }
  if (ts.isArrayTypeNode(t)) {
    return { kind: 'array', element: typeRef(t.elementType) };
  }
  if (ts.isUnionTypeNode(t)) {
    return { kind: 'union', members: t.types.map(typeRef) };
  }
  if (ts.isFunctionTypeNode(t) || ts.isConstructorTypeNode(t)) {
    return { kind: 'function' };
  }
  if (ts.isTypeLiteralNode(t)) {
    return { kind: 'object' };
  }
  if (ts.isTypeReferenceNode(t)) {
    return { kind: 'name', name: entityName(t.typeName), args: (t.typeArguments ?? []).map(typeRef) };
  }
  if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: 'keyword', name: 'null' };
  }
  if (KEYWORD_TYPES.has(t.kind)) {
    return { kind: 'keyword', name: ts.tokenToString(t.kind) ?? 'unknown' };
  }
  return { kind: 'other' };
}

function objectLiteral(e: ts.Expression | undefined): ObjectLiteralFact | undefined {
  const o = e && unwrap(e);
  if (!o || !ts.isObjectLiteralExpression(o)) {
    return undefined;
  }
  const props: Record<string, LiteralValue> = {};
  for (const p of o.properties) {
    const name = ts.isSpreadAssignment(p) ? undefined : memberName(p.name);
    if (name !== undefined) {
      props[name] = ts.isPropertyAssignment(p) ? literalValue(p.initializer) : { kind: 'other' };
    }
  }
  return { props };
}

function literalValue(e: ts.Expression): LiteralValue {
  const nested = objectLiteral(e);
  if (nested) {
    return { kind: 'object', literal: nested };
  }
  const created = createdType(e);
  return created ? { kind: 'new', type: created.typeRef } : { kind: 'other' };
}

/** The type a `new X<A>(…)` expression creates, with its text. */
function createdType(e: ts.Expression, sf?: ts.SourceFile): { type: string; typeRef: TypeRef } | undefined {
  const n = unwrap(e);
  const name = ts.isNewExpression(n) ? expressionName(n.expression) : undefined;
  if (!ts.isNewExpression(n) || name === undefined) {
    return undefined;
  }
  const args = n.typeArguments ?? [];
  return {
    type: args.length ? `${name}<${args.map((a) => oneLine(a.getText(sf))).join(', ')}>` : name,
    typeRef: { kind: 'name', name, args: args.map(typeRef) },
  };
}

const CLOCKS = new Set(['Date.now', 'performance.now']);
const TIMERS = new Set(['setTimeout', 'setInterval']);
const LOOPS = new Set(['ForEach', 'LazyForEach', 'Repeat']);

/** What time value an initializer or assigned value holds (see FieldFact.timeValue). */
function timeValue(e: ts.Expression | undefined): FieldFact['timeValue'] {
  if (!e) {
    return undefined;
  }
  const v = unwrap(e);
  if (ts.isCallExpression(v) && TIMERS.has(expressionName(v.expression) ?? '')) {
    return 'timer';
  }
  return readsTime(v) ? 'clock' : undefined;
}

function readsTime(e: ts.Node): boolean {
  if (ts.isCallExpression(e)) {
    const name = expressionName(e.expression);
    if (name !== undefined && (CLOCKS.has(name) || TIMERS.has(name))) {
      return true;
    }
  }
  if (ts.isNewExpression(e) && expressionName(e.expression) === 'Date') {
    return true;
  }
  return ts.forEachChild(e, (c) => readsTime(c) || undefined) ?? false;
}

/** Where a read in build() sits: the nearest attribute call holding it in its arguments (not through a callback such as
 *  an event handler), and whether a loop holds it. */
function uiContext(node: ts.Node, body: ts.Node): Pick<BuildRead, 'attribute' | 'inForEach'> {
  let attribute: string | undefined;
  let inForEach = false;
  let inCallback = false;
  for (let n: ts.Node = node; n !== body && n.parent; n = n.parent) {
    inCallback ||= isFunction(n);
    const call = n.parent;
    if (!(ts.isCallExpression(call) || ts.isEtsComponentExpression(call)) || !call.arguments.some((a) => a === n)) {
      continue;
    }
    const callee = call.expression;
    if (attribute === undefined && !inCallback && ts.isPropertyAccessExpression(callee) && onComponent(callee)) {
      attribute = callee.name.text;
    }
    if (ts.isIdentifier(callee) && LOOPS.has(callee.text)) {
      inForEach = true;
    }
  }
  return { attribute, inForEach };
}

/** An attribute call: `.name(…)` chained on a component (`Text(…).opacity(…)`, `Column() {…}.width(…)`), not a method of
 *  some object (`Math.max(…)`, `this.calc(…)`). Components are capitalized by ArkUI convention. */
function onComponent(callee: ts.PropertyAccessExpression): boolean {
  let e = callee.expression;
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    e = e.expression.expression;
  }
  if (!(ts.isCallExpression(e) || ts.isEtsComponentExpression(e)) || !ts.isIdentifier(e.expression)) {
    return false;
  }
  const first = e.expression.text[0] ?? '';
  return first >= 'A' && first <= 'Z';
}

/** Identifiers in an expression, `this` included, in order. */
function identifiersIn(e: ts.Node): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      out.add(n.text);
    } else if (n.kind === ts.SyntaxKind.ThisKeyword) {
      out.add('this');
    }
    ts.forEachChild(n, visit);
  };
  visit(e);
  return [...out];
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** For each line, the rules an `arkui-sem-disable-next-line R1, R3` comment on the line above disables. */
function directives(sf: ts.SourceFile, text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!text.includes(DISABLE_DIRECTIVE)) {
    return out;
  }
  const seen = new Set<number>();
  const read = (ranges: ts.CommentRange[] | undefined) => {
    for (const c of ranges ?? []) {
      if (seen.has(c.pos)) {
        continue;
      }
      seen.add(c.pos);
      const m = text.slice(c.pos, c.end).match(DISABLE);
      if (m) {
        const line = sf.getLineAndCharacterOfPosition(c.pos + (m.index ?? 0)).line + 2;
        const rules = m[1].split(/[\s,]+/).filter((r) => /^R\d+$/.test(r));
        out.set(line, [...new Set([...(out.get(line) ?? []), ...rules])]);
      }
    }
  };
  const visit = (n: ts.Node) => {
    for (const pos of [n.pos, n.end]) {
      read(ts.getLeadingCommentRanges(text, pos));
      read(ts.getTrailingCommentRanges(text, pos));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every call under node, in source order. */
function callsIn(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** `this.<name>` accesses under node whose name is in names: each access and whether it is called. */
function thisMembers(node: ts.Node, names: Set<string>): { name: string; called: boolean }[] {
  const out: { name: string; called: boolean }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && isThis(n.expression) && names.has(n.name.text)) {
      out.push({ name: n.name.text, called: ts.isCallExpression(n.parent) && n.parent.expression === n });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The receiver under chained listener calls: `bus.on(a, f).on(b, g)` registers both on `bus`. */
function chainRoot(e: ts.Expression): ts.Expression {
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const name = e.expression.name.text;
    if (name !== 'on' && name !== 'off' && !REGISTRATION.test(name)) {
      break;
    }
    e = e.expression.expression;
  }
  return e;
}

/** An `await` in scope that ends before pos, outside nested functions. */
function awaitsBefore(scope: ts.Node, pos: number): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || n.pos >= pos || (n !== scope && isFunction(n))) {
      return;
    }
    if (ts.isAwaitExpression(n) && n.end <= pos) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/**
 * Methods no code in the component reaches from build()/@Builder (calls or `this.m` references, e.g. `.onClick(this.m)`)
 * or from lifecycle hooks (calls): entry points for listeners, callbacks and other classes.
 */
function externalMethods(methods: Method[]): Set<string> {
  const names = new Set(methods.map((m) => m.name));
  const edges = new Map(
    methods.map((m) => {
      const calls = new Set<string>();
      const refs = new Set<string>();
      for (const use of thisMembers(m.body, names)) {
        if (use.name !== m.name) {
          (use.called ? calls : refs).add(use.name);
        }
      }
      return [m.name, { calls, refs }] as const;
    }),
  );
  function reach(roots: string[], viaRefs: boolean) {
    const seen = new Set(roots);
    const todo = [...roots];
    for (let m = todo.pop(); m !== undefined; m = todo.pop()) {
      const e = edges.get(m);
      if (!e) {
        continue;
      }
      for (const n of [...e.calls, ...(viaRefs ? e.refs : [])]) {
        if (!seen.has(n) && !LIFECYCLE.has(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
    return seen;
  }
  const roots = (f: (m: Method) => boolean) => methods.filter(f).map((m) => m.name);
  const fromBuild = reach(
    roots((m) => m.name === 'build' || m.decorators.includes('@Builder')),
    true,
  );
  const fromLifecycle = reach(
    roots((m) => LIFECYCLE.has(m.name)),
    false,
  );
  return new Set([...names].filter((n) => !LIFECYCLE.has(n) && !fromBuild.has(n) && !fromLifecycle.has(n)));
}

// --- The file ---

class FileScan {
  private readonly sf: ts.SourceFile;
  private readonly disabled: Map<number, string[]>;

  constructor(
    private readonly file: string,
    private readonly source: string,
    parser: EtsParser,
  ) {
    this.sf = parser.parse(file, source);
    this.disabled = directives(this.sf, source);
  }

  private line(n: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf)).line + 1;
  }

  private text(n: ts.Node): string {
    return oneLine(n.getText(this.sf));
  }

  private disabledAt(line: number): string[] {
    return this.disabled.get(line) ?? [];
  }

  /** The declared type, else the class of a `new X(…)` initializer. */
  private declared(
    type: ts.TypeNode | undefined,
    init: ts.Expression | undefined,
  ): Pick<ClassMember, 'type' | 'typeRef'> {
    if (type) {
      return { type: this.text(type), typeRef: typeRef(type) };
    }
    return (init && createdType(init, this.sf)) || {};
  }

  facts(): FileFacts {
    const components: ComponentFact[] = [];
    const types: Pick<
      FileFacts,
      | 'observedClasses'
      | 'observedV2Classes'
      | 'declaredClasses'
      | 'declaredTypes'
      | 'classMembers'
      | 'classParents'
      | 'arrayClasses'
    > = {
      observedClasses: [],
      observedV2Classes: [],
      declaredClasses: [],
      declaredTypes: [],
      classMembers: {},
      classParents: {},
      arrayClasses: {},
    };
    const called = new Set<string>();
    const visit = (n: ts.Node) => {
      if ((ts.isCallExpression(n) || ts.isEtsComponentExpression(n)) && ts.isIdentifier(n.expression)) {
        called.add(n.expression.text);
      }
      if (ts.isStructDeclaration(n)) {
        const c = this.component(n);
        if (c) {
          components.push(c);
        }
      } else if (ts.isClassDeclaration(n) && n.name) {
        this.classFacts(n, n.name.text, types);
      } else if (ts.isInterfaceDeclaration(n)) {
        types.declaredTypes.push(n.name.text);
        this.heritage(n, n.name.text, types);
        types.classMembers[n.name.text] = this.signatures(n.members);
      } else if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) {
        types.declaredTypes.push(n.name.text);
        types.classMembers[n.name.text] = this.signatures(n.type.members);
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    const links = this.moduleLinks();
    for (const i of links.imports) {
      i.called = called.has(i.local);
    }
    return {
      file: this.file,
      components,
      ...types,
      objectLinkTypes: components.flatMap((c) =>
        c.fields.flatMap((f) => {
          const held = f.decorators.includes('@ObjectLink') && f.typeRef ? heldClass(f.typeRef) : undefined;
          return held === undefined ? [] : [held];
        }),
      ),
      ...links,
      lines: this.source.split(/\r?\n/),
    };
  }

  // --- Classes, interfaces, object type aliases ---

  private classFacts(
    n: ts.ClassDeclaration,
    name: string,
    out: Pick<
      FileFacts,
      'observedClasses' | 'observedV2Classes' | 'declaredClasses' | 'classMembers' | 'classParents' | 'arrayClasses'
    >,
  ) {
    const decorators = decoratorNames(n);
    if (decorators.includes('@Observed')) {
      out.observedClasses.push(name);
    }
    if (decorators.includes('@ObservedV2')) {
      out.observedV2Classes.push(name);
    }
    out.declaredClasses.push(name);
    this.heritage(n, name, out);
    const members: Record<string, ClassMember> = {};
    for (const m of n.members) {
      if (ts.isPropertyDeclaration(m)) {
        const key = memberName(m.name);
        if (key !== undefined) {
          members[key] = {
            decorators: decoratorNames(m),
            setter: false,
            ...this.declared(m.type, m.initializer),
            literal: objectLiteral(m.initializer),
          };
        }
      } else if (ts.isMethodDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        const key = memberName(m.name);
        if (key !== undefined) {
          members[key] = { decorators: decoratorNames(m), setter: ts.isSetAccessorDeclaration(m) };
        }
      } else if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) {
          if (ts.isParameterPropertyDeclaration(p, m) && ts.isIdentifier(p.name)) {
            members[p.name.text] = {
              decorators: decoratorNames(p),
              setter: false,
              ...this.declared(p.type, p.initializer),
            };
          }
        }
      }
    }
    // A literal initializer is the value only while no code in the class reassigns the field.
    for (const assigned of this.assignedThisMembers(n)) {
      const m = Object.hasOwn(members, assigned) ? members[assigned] : undefined;
      if (m?.literal !== undefined) {
        members[assigned] = { ...m, literal: undefined };
      }
    }
    out.classMembers[name] = members;
  }

  private assignedThisMembers(node: ts.Node): Set<string> {
    const out = new Set<string>();
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        isThis(n.left.expression)
      ) {
        out.add(n.left.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  }

  /** What a class or interface extends: parents by name, and the element type when it extends Array<…>. */
  private heritage(
    n: ts.ClassDeclaration | ts.InterfaceDeclaration,
    name: string,
    out: Pick<FileFacts, 'classParents' | 'arrayClasses'>,
  ) {
    const parents: string[] = [];
    for (const clause of n.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
        continue;
      }
      for (const t of clause.types) {
        if (!ts.isIdentifier(t.expression)) {
          continue;
        }
        if (t.expression.text !== 'Array') {
          parents.push(t.expression.text);
        } else if (t.typeArguments?.length) {
          out.arrayClasses[name] = {
            element: typeRef(t.typeArguments[0]),
            params: (n.typeParameters ?? []).map((p) => p.name.text),
          };
        }
      }
    }
    if (parents.length > 0) {
      out.classParents[name] = parents;
    }
  }

  private signatures(members: ts.NodeArray<ts.TypeElement>): Record<string, ClassMember> {
    const out: Record<string, ClassMember> = {};
    for (const m of members) {
      const key = memberName(m.name);
      if (key === undefined) {
        continue;
      }
      if (ts.isPropertySignature(m)) {
        out[key] = { decorators: [], setter: false, ...this.declared(m.type, undefined) };
      } else if (ts.isMethodSignature(m)) {
        out[key] = { decorators: [], setter: false };
      } else if (ts.isSetAccessorDeclaration(m)) {
        out[key] = { decorators: [], setter: true };
      }
    }
    return out;
  }

  // --- Components ---

  private component(s: ts.StructDeclaration): ComponentFact | undefined {
    const decorators = decoratorNames(s);
    if (!s.name || (!decorators.includes('@Component') && !decorators.includes('@ComponentV2'))) {
      return undefined;
    }
    const fields: FieldFact[] = [];
    const methods: Method[] = [];
    for (const m of s.members) {
      const name = memberName(m.name);
      if (name === undefined) {
        continue;
      }
      if (ts.isPropertyDeclaration(m)) {
        const line = this.line(m.name);
        // The disable comment may sit above the decorators or directly above the field name.
        const disabledRules = [...new Set([...this.disabledAt(line), ...this.disabledAt(this.line(m))])];
        fields.push({
          name,
          line,
          decorators: decoratorNames(m),
          ...this.declared(m.type, m.initializer),
          hasInitializer: m.initializer !== undefined,
          literal: objectLiteral(m.initializer),
          readsInBuild: [],
          buildReads: [],
          writes: [],
          invoked: false,
          timeValue: timeValue(m.initializer),
          disabledRules,
        });
        const init = m.initializer && unwrap(m.initializer);
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          methods.push({ name, decorators: [], body: init });
        }
      } else if (ts.isMethodDeclaration(m) && m.body) {
        methods.push({ name, decorators: decoratorNames(m), body: m.body });
      }
    }
    const byName = new Map(fields.map((f) => [f.name, f]));
    for (const m of methods) {
      this.scanMethod(m, byName);
    }
    const external = externalMethods(methods);
    for (const f of fields) {
      for (const w of f.writes) {
        w.external = external.has(w.method);
      }
    }
    return {
      name: s.name.text,
      file: this.file,
      line: this.line(s.name),
      version: decorators.includes('@ComponentV2') ? 'V2' : 'V1',
      fields,
      resources: this.resources(methods),
    };
  }

  /** Reads (in build()/@Builder) and writes of the component's fields in one method. */
  private scanMethod(m: Method, fields: Map<string, FieldFact>) {
    const isBuild = m.name === 'build' || m.decorators.includes('@Builder');
    const visit = (n: ts.Node) => {
      const field = ts.isPropertyAccessExpression(n) && isThis(n.expression) ? fields.get(n.name.text) : undefined;
      if (field && ts.isPropertyAccessExpression(n)) {
        this.access(n, field, m, isBuild);
      }
      ts.forEachChild(n, visit);
    };
    visit(m.body);
  }

  /** One `this.<field>…` access: the path below the field, then whether it writes (assignment, update, mutating call). */
  private access(base: ts.PropertyAccessExpression, field: FieldFact, m: Method, isBuild: boolean) {
    const segments: PathSegment[] = [];
    const shown: string[] = [];
    let top: ts.Expression = base;
    for (;;) {
      const p = top.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === top) {
        segments.push({ prop: p.name.text });
        shown.push(`${p.questionDotToken ? '?.' : '.'}${p.name.text}`);
      } else if (ts.isElementAccessExpression(p) && p.expression === top) {
        const index = this.text(p.argumentExpression);
        segments.push({ index });
        shown.push(`${p.questionDotToken ? '?.' : ''}[${index}]`);
      } else if (!(ts.isNonNullExpression(p) && p.expression === top)) {
        break;
      }
      top = p;
    }
    const parent = top.parent;
    const last = segments.at(-1);
    const mutatingCall =
      ts.isCallExpression(parent) &&
      parent.expression === top &&
      last !== undefined &&
      'prop' in last &&
      MUTATING_CALLS.has(last.prop);
    const assignment =
      ts.isBinaryExpression(parent) && parent.left === top && isAssignment(parent.operatorToken.kind)
        ? parent
        : undefined;
    const updated =
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
    const line = this.line(base);
    if (segments.length === 0 && ts.isCallExpression(parent) && parent.expression === top) {
      field.invoked = true;
    }
    const assignedTime = assignment && timeValue(assignment.right);
    if (assignedTime && field.timeValue !== 'timer') {
      field.timeValue = assignedTime;
    }
    if (!mutatingCall && !assignment && !updated) {
      if (isBuild) {
        if (!field.readsInBuild.includes(line)) {
          field.readsInBuild.push(line);
        }
        field.buildReads.push({ line, path: segments, ...uiContext(base, m.body) });
      }
      return;
    }
    // A mutating call changes the container below its receiver: `[]` with no index stands for it.
    const path: PathSegment[] = mutatingCall ? [...segments.slice(0, -1), { index: '' }] : segments;
    const nestedPath = mutatingCall ? `${shown.slice(0, -1).join('')}[]` : shown.join('');
    // The write lands when the whole assignment, update or call is done: after any await in its own value or arguments.
    const context: WriteContext = this.deferred(parent, m.body)
      ? 'async-callback'
      : isBuild
        ? 'build-closure'
        : LIFECYCLE.has(m.name)
          ? 'lifecycle'
          : 'method';
    const write: WriteFact = {
      line,
      context,
      method: m.name,
      nestedPath: nestedPath || undefined,
      path: path.length ? path : undefined,
      value: mutatingCall ? undefined : assignedValue(assignment),
      disabledRules: this.disabledAt(line),
    };
    field.writes.push(write);
  }

  /** node completes later than its method starts: inside a callback passed to a deferring call, or after an await. */
  private deferred(node: ts.Node, body: ts.Node): boolean {
    // Every function between the node and the method: an await in any of them runs before a synchronous callback.
    const scopes: ts.Node[] = [body];
    for (let n: ts.Node = node; n !== body && n.parent; n = n.parent) {
      if (!isFunction(n)) {
        continue;
      }
      scopes.push(n);
      const call = n.parent;
      if (
        ts.isCallExpression(call) &&
        call.arguments.some((a) => a === n) &&
        DEFERRING_CALLS.has(calleeName(call) ?? '')
      ) {
        return true;
      }
    }
    return scopes.some((scope) => awaitsBefore(scope, node.end));
  }

  // --- Resources (R3) ---

  /** Listeners, subscriptions and timers acquired in an acquire hook (or a helper it calls) and their release. */
  private resources(methods: Method[]): ResourceFact[] {
    const names = new Set(methods.map((m) => m.name));
    // A lifecycle hook plus the same-component helpers it calls directly (one level), e.g. aboutToDisappear → this.unregisterAll().
    const scope = (hooks: Set<string>) =>
      methods
        .filter((m) => hooks.has(m.name))
        .flatMap((h) => [
          { m: h, via: h.name },
          ...[
            ...new Set(
              thisMembers(h.body, names)
                .filter((u) => u.called)
                .map((u) => u.name),
            ),
          ]
            .map((n) => methods.find((m) => m.name === n && !LIFECYCLE.has(n)))
            .filter((m): m is Method => m !== undefined)
            .map((m) => ({ m, via: `${h.name}→${m.name}` })),
        ]);
    const releases = scope(RELEASE_HOOKS).flatMap((s) => callsIn(s.m.body));
    const out: ResourceFact[] = [];
    const seen = new Set<string>();
    const add = (r: Omit<ResourceFact, 'disabledRules'>) => {
      if (!seen.has(r.key)) {
        seen.add(r.key);
        out.push({ ...r, disabledRules: this.disabledAt(r.acquireLine) });
      }
    };
    for (const { m, via } of scope(ACQUIRE_HOOKS)) {
      for (const call of callsIn(m.body)) {
        const name = calleeName(call);
        const callee = call.expression;
        // A chained call (`bus\n  .on(a, f)\n  .on(b, g)`) starts where the chain does: take its method name's line.
        const acquireLine = this.line(ts.isPropertyAccessExpression(callee) ? callee.name : call);
        if (ts.isPropertyAccessExpression(callee) && name === 'on' && call.arguments.length > 0) {
          // Event listeners: target.on('event' | CONST.EVENT, handler) ↔ target.off(same event).
          const event = this.eventName(call.arguments[0]);
          if (event !== undefined) {
            const root = chainRoot(callee.expression);
            const target = this.text(root);
            add({
              kind: 'listener',
              targetNames: identifiersIn(root),
              key: `${target}.on:${event}`,
              acquireLine,
              acquireIn: via,
              released: releases.some(
                (c) => calleeName(c) === 'off' && c.arguments.length > 0 && this.eventName(c.arguments[0]) === event,
              ),
              release: `${target}.off(${this.text(call.arguments[0])}, <same handler>)`,
            });
          }
        } else if (ts.isPropertyAccessExpression(callee) && name !== undefined && REGISTRATION.test(name)) {
          const root = chainRoot(callee.expression);
          const target = this.text(root);
          const undo = name.startsWith('add') ? `remove${name.slice(3)}` : `un${name}`;
          add({
            kind: 'subscription',
            targetNames: identifiersIn(root),
            key: `${target}.${name}`,
            acquireLine,
            acquireIn: via,
            released: releases.some((c) => calleeName(c)?.toLowerCase() === undo.toLowerCase()),
            release: `${target}.${undo}(...)`,
          });
        }
        if (name === 'setInterval') {
          const holder = this.timerHolder(call);
          add(
            holder
              ? {
                  kind: 'timer',
                  key: `timer:${holder}`,
                  targetNames: ['this', holder.slice('this.'.length)],
                  acquireLine,
                  acquireIn: via,
                  released: releases.some(
                    (c) =>
                      calleeName(c) === 'clearInterval' &&
                      c.arguments.length > 0 &&
                      this.text(unwrap(c.arguments[0])) === holder,
                  ),
                  release: `clearInterval(${holder})`,
                }
              : {
                  kind: 'timer',
                  key: `timer:anonymous@${acquireLine}`,
                  targetNames: [],
                  acquireLine,
                  acquireIn: via,
                  released: false,
                  release: 'clearInterval(<the interval id>)',
                },
          );
        }
      }
    }
    return out.sort((a, b) => a.acquireLine - b.acquireLine);
  }

  /** The event a listener call names: a string's contents, or a constant as written. */
  private eventName(e: ts.Expression): string | undefined {
    if (ts.isStringLiteralLike(e)) {
      return e.text;
    }
    return expressionName(e);
  }

  /** `this.x` when the interval id is assigned to it (`this.x = setInterval(…)`, also through a cast). */
  private timerHolder(call: ts.CallExpression): string | undefined {
    let value: ts.Node = call;
    while (isWrapper(value.parent)) {
      value = value.parent;
    }
    const p = value.parent;
    return ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === value &&
      ts.isPropertyAccessExpression(p.left) &&
      isThis(p.left.expression)
      ? `this.${p.left.name.text}`
      : undefined;
  }

  // --- Imports and exports ---

  private moduleLinks(): Pick<FileFacts, 'imports' | 'reexports' | 'exportAll' | 'defaultExport'> {
    const imports: ImportFact[] = [];
    const reexports: ReexportFact[] = [];
    const exportAll: string[] = [];
    let defaultExport: string | undefined;
    for (const st of this.sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
        const source = st.moduleSpecifier.text;
        const { name, namedBindings } = st.importClause;
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const el of namedBindings.elements) {
            imports.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, source, called: false });
          }
        }
        if (name) {
          imports.push({ imported: 'default', local: name.text, source, called: false });
        }
      } else if (ts.isExportDeclaration(st)) {
        const source =
          st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
        if (!st.exportClause) {
          if (source !== undefined) {
            exportAll.push(source);
          }
        } else if (ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            reexports.push({ exported: el.name.text, imported: (el.propertyName ?? el.name).text, source });
          }
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) {
        defaultExport = st.expression.text;
      } else if (
        (ts.isClassDeclaration(st) || ts.isStructDeclaration(st)) &&
        st.name &&
        hasModifier(st, ts.SyntaxKind.ExportKeyword) &&
        hasModifier(st, ts.SyntaxKind.DefaultKeyword)
      ) {
        defaultExport = st.name.text;
      }
    }
    return { imports, reexports, exportAll, defaultExport };
  }
}

/** What an assignment assigns: an object literal, a `new` instance, or anything else (compound and update writes too). */
function assignedValue(assignment: ts.BinaryExpression | undefined): WriteFact['value'] {
  if (assignment?.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return 'other';
  }
  const value = unwrap(assignment.right);
  return ts.isObjectLiteralExpression(value) ? 'object-literal' : ts.isNewExpression(value) ? 'new' : 'other';
}
