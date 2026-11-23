// ForEach and LazyForEach calls, and what rows and builders do with the values they are given.
import type { BuilderFact, LoopFact, LoopKey, LoopSource, ValueUses } from '../facts.js';
import { climb, isHandler } from './callbacks.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { argumentOf, isFunction, isWrapper, memberName, pathBelow, thisMember, unwrap } from './syntax.js';

/** The names a value can be passed to as a builder: the component's builder methods (`this.B(…)`), the file's builder
 *  functions, and imported names, which may be builders (`B(…)`). */
export interface BuilderNames {
  methods: Set<string>;
  functions: Set<string>;
  imports: Set<string>;
}

/** What the component's fields and helpers are, for a loop's source. */
export interface Members {
  fields: Set<string>;
  /** A method called as `this.m(…)`, or a getter read as `this.g`. */
  isHelper(name: string, called: boolean): boolean;
  /** The fields a method or getter accesses outside handlers, through the helpers it uses there, transitively. */
  fieldsOf(name: string): string[];
}

const COMPONENT_NAME = /^[A-Z]/;

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

/** The ForEach and LazyForEach calls in a method that draws the UI, nested ones included. */
export function loopsIn(
  method: string,
  body: ts.Node,
  scan: FileScan,
  names: BuilderNames,
  members: Members,
): LoopFact[] {
  const out: LoopFact[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isCallExpression(n) || ts.isEtsComponentExpression(n)) && ts.isIdentifier(n.expression)) {
      const callee = n.expression.text;
      if ((callee === 'ForEach' || callee === 'LazyForEach') && !climb(n, body).inHandler) {
        out.push(loopFact(n, callee, method, scan, names, members));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

function loopFact(
  call: ts.CallExpression | ts.EtsComponentExpression,
  kind: LoopFact['kind'],
  method: string,
  scan: FileScan,
  names: BuilderNames,
  members: Members,
): LoopFact {
  const [source, itemGenerator, keyGenerator] = call.arguments;
  const generator = itemGenerator && unwrap(itemGenerator);
  const row = generator && isFunction(generator) ? generator : undefined;
  const itemParam = row && paramName(row, 0);
  const indexParam = row && paramName(row, 1);
  const itemDeclaresIndex = (row?.parameters.length ?? 0) > 1;
  return {
    kind,
    line: scan.line(call),
    method,
    ...(itemParam === undefined ? {} : { itemParam }),
    ...(indexParam === undefined ? {} : { indexParam }),
    itemDeclaresIndex,
    source: source ? loopSource(source, scan, members) : { text: '', shape: 'other', fields: [] },
    key: loopKey(kind, keyGenerator, itemDeclaresIndex, scan),
    row: row?.body && itemParam !== undefined ? valueUses(itemParam, row.body, scan, names) : noUses(),
    disabledRules: scan.disabledFor(call),
  };
}

function loopSource(e: ts.Expression, scan: FileScan, members: Members): LoopSource {
  const text = scan.text(e);
  const v = unwrap(e);
  const member = thisMember(v);
  if (member !== undefined && members.fields.has(member)) {
    return { text, shape: 'field', root: member, fields: [member] };
  }
  const fields = fieldsRead(v, members);
  if (ts.isNewExpression(v)) {
    return { text, shape: 'new', fields };
  }
  const helper = ts.isCallExpression(v) ? thisMember(v.expression) : member;
  if (helper !== undefined && members.isHelper(helper, ts.isCallExpression(v))) {
    return { text, shape: 'call', fields };
  }
  if (fields.length === 0) {
    return { text, shape: 'other', fields };
  }
  const root = rootField(v, members);
  return { text, shape: 'derived', ...(root === undefined ? {} : { root }), fields };
}

/** The component's fields an expression reads, directly or through the helpers it uses. */
function fieldsRead(e: ts.Node, members: Members): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    const member = thisMember(n);
    if (member !== undefined) {
      const called = ts.isCallExpression(n.parent) && n.parent.expression === n;
      if (members.fields.has(member)) {
        out.add(member);
      } else if (members.isHelper(member, called)) {
        for (const f of members.fieldsOf(member)) {
          out.add(f);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(e);
  return [...out];
}

/** The field a chain of calls, property and element accesses starts from: `F` in `this.F.filter(…).slice(…)[0].p`. */
function rootField(e: ts.Expression, members: Members): string | undefined {
  for (let v = unwrap(e); ; ) {
    const member = thisMember(v);
    if (member !== undefined) {
      return members.fields.has(member) ? member : undefined;
    }
    if (ts.isCallExpression(v) || ts.isPropertyAccessExpression(v) || ts.isElementAccessExpression(v)) {
      v = unwrap(v.expression);
    } else {
      return undefined;
    }
  }
}

function loopKey(
  kind: LoopFact['kind'],
  generator: ts.Expression | undefined,
  itemDeclaresIndex: boolean,
  scan: FileScan,
): LoopKey {
  if (!generator || isNullish(unwrap(generator))) {
    return { kind: 'default', withIndex: true };
  }
  const text = scan.text(generator);
  const fn = unwrap(generator);
  if (!isFunction(fn) || !fn.body) {
    return { kind: 'other', text, withIndex: false };
  }
  const item = paramName(fn, 0);
  const index = paramName(fn, 1);
  let whole = false;
  let other = false;
  let readsIndex = false;
  const props = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && isReference(n) && !climb(n, fn.body).functions.some((f) => shadows(f, n.text))) {
      if (n.text === index) {
        readsIndex = true;
      } else if (n.text === item) {
        const { top, path } = pathBelow(n, scan.sf, isWrapper);
        const [first] = path;
        const called = ts.isCallExpression(top.parent) && top.parent.expression === top;
        if (first === undefined) {
          whole = true;
        } else if (!('prop' in first) || (path.length === 1 && called)) {
          other = true;
        } else {
          props.add(first.prop);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  const keyKind = whole ? 'whole' : other ? 'other' : props.size > 0 ? 'props' : readsIndex ? 'index' : 'other';
  // ForEach joins the index to the key when the item generator declares an index and the key generator doesn't.
  const joined = kind === 'ForEach' && itemDeclaresIndex && fn.parameters.length < 2;
  return {
    kind: keyKind,
    text,
    ...(keyKind === 'props' ? { props: [...props] } : {}),
    withIndex: readsIndex || joined,
  };
}

/** A @Builder or @LocalBuilder method, or a file-level @Builder function, with what it does with each parameter. */
export function builderFact(name: string, fn: FunctionNode, scan: FileScan, names: BuilderNames): BuilderFact {
  return {
    name,
    line: scan.line(fn.name ?? fn),
    params: fn.parameters.map((p) =>
      ts.isIdentifier(p.name) && fn.body
        ? { name: p.name.text, uses: valueUses(p.name.text, fn.body, scan, names) }
        : { uses: noUses() },
    ),
  };
}

/** What a function body does with the value named `name` (its parameter) outside handlers. */
export function valueUses(name: string, body: ts.Node, scan: FileScan, names: BuilderNames): ValueUses {
  const out = noUses();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === name && isReference(n)) {
      const where = climb(n, body);
      const handler = where.functions.some((f) => isHandler(f) && !passesBuilder(f, names));
      if (!handler && !where.functions.some((f) => shadows(f, name))) {
        recordUse(n, where.attribute, scan, names, out);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

function recordUse(
  id: ts.Identifier,
  attribute: string | undefined,
  scan: FileScan,
  names: BuilderNames,
  out: ValueUses,
) {
  const line = scan.line(id);
  const { top, path } = pathBelow(id, scan.sf, isWrapper);
  const at = attribute === undefined ? {} : { attribute };
  const call = argumentOf(top);
  if (call) {
    const callee = call.expression;
    const argument = call.arguments.indexOf(top);
    const method = thisMember(callee);
    if (method !== undefined && names.methods.has(method)) {
      out.builders.push({ line, builder: method, method: true, argument, path, ...at });
      return;
    }
    if (ts.isIdentifier(callee) && (names.functions.has(callee.text) || names.imports.has(callee.text))) {
      out.builders.push({ line, builder: callee.text, method: false, argument, path, ...at });
      return;
    }
  }
  const child = childArgument(top, names);
  if (child) {
    out.children.push({ line, ...child, path, ...at });
    return;
  }
  out.reads.push({ line, path, ...at });
}

/** A callback property that draws by calling a builder: `Child({ content: () => { this.B(item) } })` fills a
 *  @BuilderParam. */
function passesBuilder(fn: ts.Node, names: BuilderNames): boolean {
  if (!ts.isPropertyAssignment(fn.parent)) {
    return false;
  }
  const visit = (n: ts.Node): boolean => {
    if (ts.isCallExpression(n)) {
      const method = thisMember(n.expression);
      if (
        (method !== undefined && names.methods.has(method)) ||
        (ts.isIdentifier(n.expression) && names.functions.has(n.expression.text))
      ) {
        return true;
      }
    }
    return ts.forEachChild(n, visit) === true;
  };
  return ts.forEachChild(fn, visit) === true;
}

/** `Child({ field: e })` or `Child({ e })` with e the expression: the child and the field it initializes. A component
 *  is capitalized; a builder function taking an object is no child. */
function childArgument(e: ts.Expression, names: BuilderNames): { child: string; field: string } | undefined {
  const prop = e.parent;
  const field =
    ts.isShorthandPropertyAssignment(prop) || (ts.isPropertyAssignment(prop) && prop.initializer === e)
      ? memberName(prop.name)
      : undefined;
  const options = prop.parent;
  if (field === undefined || !ts.isObjectLiteralExpression(options)) {
    return undefined;
  }
  const call = argumentOf(options);
  const callee = call?.arguments[0] === options ? call.expression : undefined;
  return callee && ts.isIdentifier(callee) && COMPONENT_NAME.test(callee.text) && !names.functions.has(callee.text)
    ? { child: callee.text, field }
    : undefined;
}

/** An identifier that refers to a variable: not a property name, a declared name or a parameter. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  return !(
    ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) && p.name === id) ||
    ((ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isBindingElement(p)) && p.name === id) ||
    ((isFunction(p) || ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === id)
  );
}

/** A function declares `name` as a parameter, which hides an outer variable of that name. */
function shadows(fn: ts.Node, name: string): boolean {
  return isFunction(fn) && fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

function paramName(fn: ts.SignatureDeclarationBase, i: number): string | undefined {
  const p = fn.parameters[i];
  return p && ts.isIdentifier(p.name) ? p.name.text : undefined;
}

function isNullish(e: ts.Expression): boolean {
  return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
}

function noUses(): ValueUses {
  return { reads: [], builders: [], children: [] };
}
