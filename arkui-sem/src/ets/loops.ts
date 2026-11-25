// ForEach and LazyForEach calls, and what rows and builders do with the values they are given.
import type { Branch, BuilderFact, LoopComparison, LoopFact, LoopKey, LoopSource, ValueUses } from '../facts.js';
import { type BuilderNames, climb, isBuilderCall } from './callbacks.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import {
  argumentOf,
  branchesOf,
  isFunction,
  isKeyedLoop,
  isWrapper,
  isZero,
  memberName,
  pathBelow,
  thisMember,
  unwrap,
} from './syntax.js';

/** What the component's fields and helpers are, for a loop's source. */
export interface Members {
  fields: Set<string>;
  /** A method called as `this.m(…)`, or a getter read as `this.g`. */
  isHelper(name: string, called: boolean): boolean;
  /** The fields a method or getter accesses outside handlers, through the helpers it uses there, transitively. */
  fieldsOf(name: string): string[];
  /** The field every value a method or getter returns is, as is (`return this.F`, after any other statements). */
  returnsField(name: string): string | undefined;
  /** The expressions a method or getter returns, outside the functions it holds; each arm of a conditional apart. */
  returned(name: string): ts.Expression[];
}

const COMPONENT_NAME = /^[A-Z]/;
/** Array calls whose result holds elements of the array itself. */
const KEEPS_ELEMENTS = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'toSorted', 'toReversed']);
/** Array calls that put the elements in another order. */
const REORDERS = new Set(['sort', 'reverse', 'toSorted', 'toReversed']);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

/** The ForEach and LazyForEach calls in a method that draws the UI, nested ones included. */
export function loopsIn(
  method: string,
  body: ts.Node,
  /** The `if` arms of build() the method runs in. */
  arms: Branch[],
  scan: FileScan,
  names: BuilderNames,
  members: Members,
): LoopFact[] {
  const out: LoopFact[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isCallExpression(node) || ts.isEtsComponentExpression(node)) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (isKeyedLoop(callee) && !climb(node, body, names).inHandler) {
        out.push(loopFact(node, callee, method, body, arms, scan, names, members));
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
  body: ts.Node,
  arms: Branch[],
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
    sourceLine: scan.line(source ? unwrap(source) : call),
    method,
    ...(itemParam === undefined ? {} : { itemParam }),
    ...(indexParam === undefined ? {} : { indexParam }),
    itemDeclaresIndex,
    source: source ? loopSource(source, scan, members) : { text: '', shape: 'other', fields: [] },
    key: loopKey(kind, keyGenerator, itemDeclaresIndex, scan, names),
    row: row?.body && itemParam !== undefined ? valueUses(itemParam, row.body, scan, names) : noUses(),
    creates: row?.body ? componentsIn(row.body, names) : [],
    comparisons: row?.body ? comparisonsIn(row.body, itemParam, indexParam, members, scan, names) : [],
    branches: [...arms, ...branchesOf(call, body, scan.sf)],
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
    const returns = members.returnsField(helper);
    const returned = members.returned(helper);
    // A guard that returns nothing (`return []`, `null`) or no field's array (`return DEFAULTS`) shows no other one.
    const roots = new Set(returned.flatMap((e) => (isEmptyValue(e) ? [] : (rootField(e, members) ?? []))));
    const [from] = roots.size === 1 ? roots : [];
    // A window end in one returned value that another reads otherwise is no window end.
    const ends = returned.map((e) => prefixEnds(e, members));
    const windowEnds = [...new Set(ends.flat())].filter((f) =>
      returned.every((e, i) => ends[i].includes(f) || !fieldsRead(e, members).includes(f)),
    );
    return {
      text,
      shape: 'call',
      ...(returns === undefined ? {} : { returns }),
      ...(from === undefined ? {} : { returnsFrom: from }),
      ...(returned.some(reordersArray) ? { reorders: true as const } : {}),
      ...(windowEnds.length ? { windowEnds } : {}),
      fields,
    };
  }
  if (fields.length === 0) {
    return { text, shape: 'other', fields };
  }
  const root = rootField(value, members);
  const filteredBy = root === undefined ? undefined : elementFilters(value);
  const items = filteredBy === undefined ? {} : { itemsOf: root, ...(filteredBy.length ? { filteredBy } : {}) };
  const reorders = reordersArray(value) ? { reorders: true as const } : {};
  const windowEnds = prefixEnds(value, members);
  return {
    text,
    shape: 'derived',
    ...(root === undefined ? {} : { root }),
    ...items,
    ...reorders,
    ...(windowEnds.length ? { windowEnds } : {}),
    fields,
  };
}

/** The fields the chain reads only in the end of a `.slice(0, n)` that nothing reorders after: a change shows more
 *  or fewer items at the end, and the same ones at each position. */
function prefixEnds(expr: ts.Expression, members: Members): string[] {
  const ends = new Set<ts.Node>();
  for (let value = unwrap(expr); ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression); ) {
    const method = value.expression.name.text;
    const [start, end] = value.arguments;
    if (REORDERS.has(method) || (method === 'slice' && start && fromEnd(start))) {
      break;
    }
    if (method === 'slice' && end && start && isZero(start)) {
      ends.add(end);
    }
    value = unwrap(value.expression.expression);
  }
  const elsewhere = new Set(fieldsRead(expr, members, ends));
  return [...new Set([...ends].flatMap((end) => fieldsRead(end, members)))].filter((f) => !elsewhere.has(f));
}

/** `[]`, `null` or `undefined`. */
function isEmptyValue(expr: ts.Expression): boolean {
  const value = unwrap(expr);
  return (
    (ts.isArrayLiteralExpression(value) && value.elements.length === 0) ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === 'undefined')
  );
}

/** A call chain that sorts or reverses an array, or cuts it from the end (`.slice(-5)`, `.slice(a.length - 5)`), so
 *  an item appended to the array moves the others. */
function reordersArray(expr: ts.Expression): boolean {
  for (let value = unwrap(expr); ts.isCallExpression(value); ) {
    if (!ts.isPropertyAccessExpression(value.expression)) {
      return false;
    }
    const method = value.expression.name.text;
    if (REORDERS.has(method) || (method === 'slice' && value.arguments[0] && fromEnd(value.arguments[0]))) {
      return true;
    }
    value = unwrap(value.expression.expression);
  }
  return false;
}

/** A negative number, or a value computed from a length. */
function fromEnd(start: ts.Expression): boolean {
  const value = unwrap(start);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) {
    return true;
  }
  const length = (n: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(n) && n.name.text === 'length') || ts.forEachChild(n, length) === true;
  return length(value);
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

/** The component's fields an expression reads, directly or through the helpers it uses, outside the `skip` nodes. */
function fieldsRead(expr: ts.Node, members: Members, skip?: Set<ts.Node>): string[] {
  const out = new Set<string>();
  const visit = (node: ts.Node) => {
    if (skip?.has(node)) {
      return;
    }
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

/** The field a chain of calls, property and element accesses starts from: `F` in `this.F.filter(…).slice(…)[0].p`,
 *  also through a copy (`[...this.F].reverse()`). */
function rootField(expr: ts.Expression, members: Members): string | undefined {
  for (let value = unwrap(expr); ; ) {
    const member = thisMember(value);
    if (member !== undefined) {
      return members.fields.has(member) ? member : undefined;
    }
    if (ts.isCallExpression(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      value = unwrap(value.expression);
    } else if (isSpreadCopy(value)) {
      value = unwrap(value.elements[0].expression);
    } else {
      return undefined;
    }
  }
}

/** `[...x]`: a copy of one array. */
function isSpreadCopy(value: ts.Expression): value is ts.ArrayLiteralExpression & { elements: [ts.SpreadElement] } {
  return ts.isArrayLiteralExpression(value) && value.elements.length === 1 && ts.isSpreadElement(value.elements[0]);
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
          // The properties down to the first index or method call: `s.album.id` → album.id, `s.id.toString()` → id.
          const end = path.findIndex((segment) => !('prop' in segment));
          const chain = (end < 0 ? path : path.slice(0, end)).map((segment) => ('prop' in segment ? segment.prop : ''));
          props.add((called && end < 0 ? chain.slice(0, -1) : chain).join('.'));
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

/** LoopFact.comparisons; a parameter an inner function redeclares is not the row's. */
function comparisonsIn(
  body: ts.Node,
  item: string | undefined,
  index: string | undefined,
  members: Members,
  scan: FileScan,
  names: BuilderNames,
): LoopComparison[] {
  const out: LoopComparison[] = [];
  const param = (side: ts.Expression): 'item' | 'index' | undefined => {
    const id = rootIdentifier(side);
    const named = id === undefined ? undefined : id.text === item ? 'item' : id.text === index ? 'index' : undefined;
    // `index` names a number: a path below it is no position.
    if (id === undefined || named === undefined || (named === 'index' && id !== unwrap(side))) {
      return undefined;
    }
    return climb(id, body, names).functions.some((inner) => shadows(inner, id.text)) ? undefined : named;
  };
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      for (const [mine, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        const field = thisMember(unwrap(mine));
        const compared = field !== undefined && members.fields.has(field) ? param(other) : undefined;
        if (field !== undefined && compared !== undefined && !climb(node, body, names).inHandler) {
          out.push({
            field,
            line: scan.line(node),
            against: compared,
            operand: scan.text(unwrap(other)),
            text: scan.text(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/** The identifier a chain of property and element accesses starts from: `item` in `item.tag.id`, `item[0]`. */
function rootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let value = unwrap(expr);
  while (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    value = unwrap(value.expression);
  }
  return ts.isIdentifier(value) ? value : undefined;
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
