// ForEach and LazyForEach calls, and what rows and builders do with the values they are given.
import type { BuilderFact, LoopFact, LoopKey, LoopSource, ValueUses } from '../facts.js';
import { type BuilderNames, climb, isBuilderCall } from './callbacks.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { argumentOf, isFunction, isKeyedLoop, isWrapper, memberName, pathBelow, thisMember, unwrap } from './syntax.js';

/** What the component's fields and helpers are, for a loop's source. */
export interface Members {
  fields: Set<string>;
  /** A method called as `this.m(…)`, or a getter read as `this.g`. */
  isHelper(name: string, called: boolean): boolean;
  /** The fields a method or getter accesses outside handlers, through the helpers it uses there, transitively. */
  fieldsOf(name: string): string[];
}

const COMPONENT_NAME = /^[A-Z]/;
/** Array calls whose result holds elements of the array itself. */
const KEEPS_ELEMENTS = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'toSorted', 'toReversed']);

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
  const visit = (node: ts.Node) => {
    if ((ts.isCallExpression(node) || ts.isEtsComponentExpression(node)) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (isKeyedLoop(callee) && !climb(node, body, names).inHandler) {
        out.push(loopFact(node, callee, method, scan, names, members));
      }
    }
    ts.forEachChild(node, visit);
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
    key: loopKey(kind, keyGenerator, itemDeclaresIndex, scan, names),
    row: row?.body && itemParam !== undefined ? valueUses(itemParam, row.body, scan, names) : noUses(),
    creates: row?.body ? componentsIn(row.body, names) : [],
    disabledRules: scan.disabledFor(call),
  };
}

function loopSource(expr: ts.Expression, scan: FileScan, members: Members): LoopSource {
  const text = scan.text(expr);
  const value = unwrap(expr);
  const member = thisMember(value);
  if (member !== undefined && members.fields.has(member)) {
    return { text, shape: 'field', root: member, itemsOf: member, fields: [member] };
  }
  const fields = fieldsRead(value, members);
  if (ts.isNewExpression(value)) {
    return { text, shape: 'new', fields };
  }
  const helper = ts.isCallExpression(value) ? thisMember(value.expression) : member;
  if (helper !== undefined && members.isHelper(helper, ts.isCallExpression(value))) {
    return { text, shape: 'call', fields };
  }
  if (fields.length === 0) {
    return { text, shape: 'other', fields };
  }
  const root = rootField(value, members);
  const filteredBy = root === undefined ? undefined : elementFilters(value);
  const items = filteredBy === undefined ? {} : { itemsOf: root, ...(filteredBy.length ? { filteredBy } : {}) };
  return { text, shape: 'derived', ...(root === undefined ? {} : { root }), ...items, fields };
}

/** For `this.F` through calls that keep its elements only (`this.F.filter(…).slice(…)`): the item properties the
 *  filter callbacks test as flags. Undefined for any other chain, or a filter whose callback is not written in place. */
function elementFilters(expr: ts.Expression): string[] | undefined {
  const props = new Set<string>();
  for (let value = unwrap(expr); thisMember(value) === undefined; ) {
    if (!(ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression))) {
      return undefined;
    }
    const method = value.expression.name.text;
    if (!KEEPS_ELEMENTS.has(method)) {
      return undefined;
    }
    if (method === 'filter') {
      const read = value.arguments[0] && predicateReads(value.arguments[0]);
      if (!read) {
        return undefined;
      }
      for (const prop of read) {
        props.add(prop);
      }
    }
    value = unwrap(value.expression.expression);
  }
  return [...props];
}

/** The properties of its item a filter callback tests as flags (flagsTested). Undefined unless it is a function
 *  written in place with a named item. */
function predicateReads(expr: ts.Expression): string[] | undefined {
  const fn = unwrap(expr);
  const item = isFunction(fn) && fn.body ? paramName(fn, 0) : undefined;
  if (!isFunction(fn) || !fn.body || item === undefined) {
    return undefined;
  }
  const [returned] = ts.isBlock(fn.body)
    ? fn.body.statements.flatMap((statement) =>
        ts.isReturnStatement(statement) && statement.expression ? [statement.expression] : [],
      )
    : [fn.body];
  return returned ? flagsTested(returned, item) : [];
}

/** The item properties a condition tests as flags (`s.liked`, `!s.hidden`, joined by `&&` or `||`): a change to one
 *  flips the condition. A comparison (`s.plays > 0`) may hold before and after a change, so it counts for nothing. */
function flagsTested(cond: ts.Expression, item: string): string[] {
  const value = unwrap(cond);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    return flagsTested(value.operand, item);
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...flagsTested(value.left, item), ...flagsTested(value.right, item)];
  }
  return ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === item
    ? [value.name.text]
    : [];
}

/** The component's fields an expression reads, directly or through the helpers it uses. */
function fieldsRead(expr: ts.Node, members: Members): string[] {
  const out = new Set<string>();
  const visit = (node: ts.Node) => {
    const member = thisMember(node);
    if (member !== undefined) {
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (members.fields.has(member)) {
        out.add(member);
      } else if (members.isHelper(member, called)) {
        for (const field of members.fieldsOf(member)) {
          out.add(field);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return [...out];
}

/** The field a chain of calls, property and element accesses starts from: `F` in `this.F.filter(…).slice(…)[0].p`. */
function rootField(expr: ts.Expression, members: Members): string | undefined {
  for (let value = unwrap(expr); ; ) {
    const member = thisMember(value);
    if (member !== undefined) {
      return members.fields.has(member) ? member : undefined;
    }
    if (ts.isCallExpression(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      value = unwrap(value.expression);
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
  names: BuilderNames,
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
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      isReference(node) &&
      !climb(node, fn.body, names).functions.some((inner) => shadows(inner, node.text))
    ) {
      if (node.text === index) {
        readsIndex = true;
      } else if (node.text === item) {
        const { top, path } = pathBelow(node, scan.sf, isWrapper);
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
    ts.forEachChild(node, visit);
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
    // A destructured parameter gets no uses: ArkTS rejects it (arkts-no-destruct-params), so such code doesn't build.
    params: fn.parameters.map((param) =>
      ts.isIdentifier(param.name) && fn.body
        ? { name: param.name.text, uses: valueUses(param.name.text, fn.body, scan, names) }
        : { uses: noUses() },
    ),
    creates: fn.body ? componentsIn(fn.body, names) : [],
  };
}

/** The components a body creates outside handlers, by name, each once. */
function componentsIn(body: ts.Node, names: BuilderNames): string[] {
  const out = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isCallExpression(node) || ts.isEtsComponentExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      COMPONENT_NAME.test(node.expression.text) &&
      !names.functions.has(node.expression.text) &&
      !climb(node, body, names).inHandler
    ) {
      out.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return [...out];
}

/** What a function body does with the value named `name` (its parameter) outside handlers. */
export function valueUses(name: string, body: ts.Node, scan: FileScan, names: BuilderNames): ValueUses {
  const out = noUses();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name && isReference(node)) {
      const where = climb(node, body, names);
      if (!where.inHandler && !where.functions.some((inner) => shadows(inner, name))) {
        recordUse(node, where.attribute, scan, names, out);
      }
    }
    ts.forEachChild(node, visit);
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
  if (call && isBuilderCall(call, names)) {
    const method = thisMember(call.expression);
    const builder = method ?? (ts.isIdentifier(call.expression) ? call.expression.text : '');
    const argument = call.arguments.indexOf(top);
    out.builders.push({ line, builder, method: method !== undefined, argument, path, ...at });
    return;
  }
  const child = childArgument(top, names);
  if (child) {
    out.children.push({ line, ...child, path, ...at });
    return;
  }
  out.reads.push({ line, path, ...at });
}

/** `Child({ field: e })` or `Child({ e })` with e the expression: the child and the field it initializes. A component
 *  is capitalized; a builder function taking an object is no child. */
function childArgument(value: ts.Expression, names: BuilderNames): { child: string; field: string } | undefined {
  const prop = value.parent;
  const field =
    ts.isShorthandPropertyAssignment(prop) || (ts.isPropertyAssignment(prop) && prop.initializer === value)
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
  const parent = id.parent;
  return !(
    ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === id) ||
    ((ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) &&
      parent.name === id) ||
    ((isFunction(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) &&
      parent.name === id)
  );
}

/** A function declares `name` as a parameter, which hides an outer variable of that name. */
function shadows(fn: ts.Node, name: string): boolean {
  return isFunction(fn) && fn.parameters.some((param) => ts.isIdentifier(param.name) && param.name.text === name);
}

function paramName(fn: ts.SignatureDeclarationBase, index: number): string | undefined {
  const param = fn.parameters[index];
  return param && ts.isIdentifier(param.name) ? param.name.text : undefined;
}

function isNullish(expr: ts.Expression): boolean {
  return expr.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined');
}

function noUses(): ValueUses {
  return { reads: [], builders: [], children: [] };
}
