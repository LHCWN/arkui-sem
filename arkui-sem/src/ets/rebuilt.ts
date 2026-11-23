// Element rebuilds: the new objects a write of a field puts where its elements were (WriteFact.rebuilt).
import type { RebuiltElement } from '../facts.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { argumentOf, isFunction, isKeyedLoop, memberName, thisMember, unwrap } from './syntax.js';

type Form = RebuiltElement['form'];

/** One write's search: the field it writes and where its rebuilt elements go. */
interface Context {
  isField(e: ts.Expression): boolean;
  scan: FileScan;
  out: RebuiltElement[];
}

/** What denotes the old element where a new object is built: names bound to it (a map or loop parameter, a ForEach
 *  item), and `a[index]` of an element array (`this.F`, a copy of it); any index when index is undefined. */
interface Elements {
  names: Set<string>;
  isArray(e: ts.Expression): boolean;
  index?: string;
}

/** The new objects a write of `field` puts at existing elements' positions. top: the written expression (`this.F`,
 *  `this.F[i]`) or the receiver of a call (`this.F.splice`). */
export function rebuiltElements(field: string, top: ts.Expression, scan: FileScan): RebuiltElement[] {
  const cx: Context = { isField: (e) => thisMember(unwrap(e)) === field, scan, out: [] };
  const parent = top.parent;
  const target = unwrap(top);
  if (ts.isBinaryExpression(parent) && parent.left === top && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (cx.isField(target)) {
      reassigned(parent.right, cx);
    } else if (ts.isElementAccessExpression(target) && cx.isField(target.expression)) {
      objectsIn(parent.right, elementsAt(target, cx.isField, target.argumentExpression), 'index', cx);
    }
  } else if (
    ts.isCallExpression(parent) &&
    parent.expression === top &&
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'splice' &&
    cx.isField(target.expression)
  ) {
    spliced(parent, cx.isField, 'splice', cx);
  }
  return cx.out;
}

/** `this.F = value`: a map of this.F, or a local array built from this.F (pushed to in a loop over it, or a copy written
 *  at an index). */
function reassigned(value: ts.Expression, cx: Context) {
  const v = unwrap(value);
  const name = ts.isIdentifier(v) ? v : undefined;
  const alias = name && local(name);
  const source = alias ? unwrap(alias.value) : v;
  const map = mapCallback(source, cx);
  if (map) {
    mapped(map, cx);
  } else if (name && alias) {
    if (ts.isArrayLiteralExpression(source) && source.elements.length === 0) {
      pushedInLoops(name.text, alias.scope, cx);
    } else if (isCopy(source, cx)) {
      copyWrites(name.text, alias.scope, cx);
    }
  }
}

/** The callback of `this.F.map(cb)`. */
function mapCallback(e: ts.Expression, cx: Context): ts.Expression | undefined {
  return ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'map' &&
    cx.isField(e.expression.expression)
    ? e.arguments[0]
    : undefined;
}

function mapped(cb: ts.Expression, cx: Context) {
  const fn = unwrap(cb);
  if (!isFunction(fn) || !fn.body) {
    return;
  }
  const elements = { names: itemName(fn), isArray: cx.isField };
  for (const e of ts.isBlock(fn.body) ? returnsOf(fn.body) : [fn.body]) {
    objectsIn(e, elements, 'map', cx);
  }
}

/** `out.push(obj)` directly inside a loop over this.F (for-of, an index loop, forEach). A push outside one appends; a
 *  push in a loop nested in it flattens. */
function pushedInLoops(name: string, scope: ts.Node, cx: Context) {
  for (const call of callsOn(name, 'push', scope)) {
    const elements = loopOver(call, scope, cx);
    if (elements) {
      for (const arg of call.arguments) {
        objectsIn(arg, elements, 'loop', cx);
      }
    }
  }
}

/** `copy[i] = obj` and `copy.splice(i, n, obj)` on a copy of this.F. */
function copyWrites(name: string, scope: ts.Node, cx: Context) {
  const isArray = (e: ts.Expression) => cx.isField(e) || isNamed(e, name);
  const visit = (n: ts.Node) => {
    const left = ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && unwrap(n.left);
    if (left && ts.isElementAccessExpression(left) && isNamed(left.expression, name)) {
      objectsIn(n.right, elementsAt(n, isArray, left.argumentExpression), 'copy-index', cx);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  for (const call of callsOn(name, 'splice', scope)) {
    spliced(call, isArray, 'copy-index', cx);
  }
}

/** `a.splice(start, n, …items)`: the first n items replace elements from start on. */
function spliced(call: ts.CallExpression, isArray: (e: ts.Expression) => boolean, form: Form, cx: Context) {
  const [start, count] = call.arguments.map(unwrap);
  const n = count && ts.isNumericLiteral(count) ? Number(count.text) : 0;
  for (const item of call.arguments.slice(2, 2 + n)) {
    objectsIn(item, elementsAt(call, isArray, n === 1 ? start : undefined), form, cx);
  }
}

/** For a write at an index: the element is `a[index]` of the arrays, or the item of a ForEach row over them that holds
 *  the write. */
function elementsAt(at: ts.Node, isArray: (e: ts.Expression) => boolean, index?: ts.Expression): Elements {
  const names = new Set<string>();
  for (let p = at.parent; p; p = p.parent) {
    if (!isFunction(p)) {
      continue;
    }
    const call = argumentOf(p);
    const [source, row] = call?.arguments ?? [];
    if (call && ts.isIdentifier(call.expression) && isKeyedLoop(call.expression.text) && row === p && isArray(source)) {
      for (const name of itemName(p)) {
        names.add(name);
      }
    }
  }
  return { names, isArray, ...(index ? { index: unwrap(index).getText() } : {}) };
}

/** The objects an expression evaluates to, through conditionals and single-assignment locals. */
function objectsIn(e: ts.Expression, elements: Elements, form: Form, cx: Context, depth = 0) {
  const v = unwrap(e);
  if (ts.isConditionalExpression(v)) {
    objectsIn(v.whenTrue, elements, form, cx, depth);
    objectsIn(v.whenFalse, elements, form, cx, depth);
  } else if (ts.isIdentifier(v)) {
    const l = elements.names.has(v.text) || depth > 2 ? undefined : local(v);
    if (l) {
      objectsIn(l.value, elements, form, cx, depth + 1);
    }
  } else {
    const fact = objectFact(v, elements);
    if (fact) {
      cx.out.push({ line: cx.scan.line(v), form, ...fact });
    }
  }
}

function objectFact(e: ts.Expression, elements: Elements): Omit<RebuiltElement, 'line' | 'form'> | undefined {
  if (ts.isNewExpression(e)) {
    return { value: 'new', kept: [], changed: [], keepsRest: false };
  }
  if (ts.isObjectLiteralExpression(e)) {
    return { value: 'object-literal', ...laidOver([e], e, elements) };
  }
  // Object.assign({}, a, b, …): a new object with the properties of a, then b, …
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    isNamed(e.expression.expression, 'Object') &&
    e.expression.name.text === 'assign'
  ) {
    const [target, ...sources] = e.arguments.map(unwrap);
    if (target && ts.isObjectLiteralExpression(target) && target.properties.length === 0) {
      return { value: 'object-literal', ...laidOver(sources, e, elements) };
    }
  }
  return undefined;
}

/** The kept and changed properties of an object built from parts in order: object literals, whose own spreads count
 *  in place, and other objects copied whole. A copy of the element keeps every property set before it. */
function laidOver(
  parts: ts.Expression[],
  at: ts.Node,
  elements: Elements,
): Pick<RebuiltElement, 'kept' | 'changed' | 'keepsRest'> {
  let keepsRest = false;
  const keeps = new Map<string, boolean>();
  let guards: Map<string, string> | undefined;
  const guarded = () => {
    guards ??= guardsAt(at, elements);
    return guards;
  };
  const copy = (e: ts.Expression) => {
    if (isElement(e, elements)) {
      keepsRest = true;
      for (const name of keeps.keys()) {
        keeps.set(name, true);
      }
    }
  };
  for (const part of parts) {
    if (!ts.isObjectLiteralExpression(part)) {
      copy(part);
      continue;
    }
    for (const p of part.properties) {
      if (ts.isSpreadAssignment(p)) {
        copy(p.expression);
      } else if (ts.isPropertyAssignment(p)) {
        const name = memberName(p.name);
        if (name !== undefined) {
          keeps.set(name, keepsValue(name, p.initializer, elements, guarded));
        }
      } else if (ts.isShorthandPropertyAssignment(p)) {
        keeps.set(p.name.text, guarded().get(p.name.text) === p.name.text);
      }
    }
  }
  const names = [...keeps.keys()];
  return { kept: names.filter((n) => keeps.get(n)), changed: names.filter((n) => !keeps.get(n)), keepsRest };
}

/** `p: e.p`, or `p: X` under a guard `e.p === X`. */
function keepsValue(
  name: string,
  value: ts.Expression,
  elements: Elements,
  guards: () => Map<string, string>,
): boolean {
  const v = unwrap(value);
  if (ts.isPropertyAccessExpression(v) && v.name.text === name && isElement(v.expression, elements)) {
    return true;
  }
  return guards().get(name) === v.getText();
}

/** The element's property values the code holding e has checked: `e.p === X` (or `==`) in an enclosing `if` or `?:`,
 *  an else branch of `!==`, or an earlier `if (e.p !== X) return …` in an enclosing block. Property → X as written. */
function guardsAt(e: ts.Node, elements: Elements): Map<string, string> {
  const out = new Map<string, string>();
  const add = (cond: ts.Expression, holds: boolean) => {
    for (const [prop, value] of equalities(cond, holds, elements)) {
      out.set(prop, value);
    }
  };
  for (let n = e; n.parent && !isFunction(n) && !ts.isMethodDeclaration(n); n = n.parent) {
    const p = n.parent;
    if (ts.isConditionalExpression(p) && n !== p.condition) {
      add(p.condition, n === p.whenTrue);
    } else if (ts.isIfStatement(p) && n !== p.expression) {
      add(p.expression, n === p.thenStatement);
    } else if (ts.isBlock(p)) {
      for (const s of p.statements.slice(0, p.statements.indexOf(n as ts.Statement))) {
        if (ts.isIfStatement(s) && !s.elseStatement && exits(s.thenStatement)) {
          add(s.expression, false);
        }
      }
    }
  }
  return out;
}

/** `e.p === X` terms that hold when cond is `holds`: an `&&` chain of `===` when true, a single `!==` when false. */
function equalities(cond: ts.Expression, holds: boolean, elements: Elements): [string, string][] {
  const c = unwrap(cond);
  if (!ts.isBinaryExpression(c)) {
    return [];
  }
  const op = c.operatorToken.kind;
  if (holds && op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...equalities(c.left, true, elements), ...equalities(c.right, true, elements)];
  }
  const equal = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const unequal = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!(holds ? equal : unequal)) {
    return [];
  }
  const out: [string, string][] = [];
  for (const [a, b] of [
    [c.left, c.right],
    [c.right, c.left],
  ]) {
    const v = unwrap(a);
    if (ts.isPropertyAccessExpression(v) && isElement(v.expression, elements)) {
      out.push([v.name.text, unwrap(b).getText()]);
    }
  }
  return out;
}

/** A statement that always leaves the block: a return, a continue, or a block ending in one. */
function exits(s: ts.Statement): boolean {
  if (ts.isBlock(s)) {
    const last = s.statements.at(-1);
    return last !== undefined && exits(last);
  }
  return ts.isReturnStatement(s) || ts.isContinueStatement(s);
}

/** e is the old element: a name bound to it, `a[index]` of an element array, or a local assigned once from either. */
function isElement(e: ts.Expression, elements: Elements, depth = 0): boolean {
  const v = unwrap(e);
  if (ts.isIdentifier(v)) {
    if (elements.names.has(v.text)) {
      return true;
    }
    const l = depth > 2 ? undefined : local(v);
    return l !== undefined && isElement(l.value, elements, depth + 1);
  }
  return (
    ts.isElementAccessExpression(v) &&
    elements.isArray(v.expression) &&
    (elements.index === undefined || unwrap(v.argumentExpression).getText() === elements.index)
  );
}

/** A function body's locals by name: their declarations there, and every value assigned to the name in it. */
type Locals = Map<string, { declarations: ts.VariableDeclaration[]; values: ts.Expression[] }>;
const localsCache = new WeakMap<ts.Node, Locals>();

/** A local `const`/`let` given one value (its initializer, or one later assignment), with the function body that
 *  declares it: the innermost body holding id that declares the name. */
function local(id: ts.Identifier): { value: ts.Expression; scope: ts.Node } | undefined {
  for (let scope = scopeOf(id); scope?.parent; scope = scopeOf(scope.parent)) {
    const found = localsOf(scope).get(id.text);
    const [decl] = found?.declarations ?? [];
    if (found && decl) {
      const blockScoped = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) !== 0;
      const single = found.declarations.length === 1 && found.values.length === 1;
      return blockScoped && single ? { value: found.values[0], scope } : undefined;
    }
  }
  return undefined;
}

/** One walk per body, cached: lookups for every identifier would otherwise walk it again each time. */
function localsOf(scope: ts.Node): Locals {
  const cached = localsCache.get(scope);
  if (cached) {
    return cached;
  }
  const locals: Locals = new Map();
  const entry = (name: string) => {
    const e = locals.get(name) ?? { declarations: [], values: [] };
    locals.set(name, e);
    return e;
  };
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && scopeOf(n) === scope) {
      const e = entry(n.name.text);
      e.declarations.push(n);
      if (n.initializer) {
        e.values.push(n.initializer);
      }
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(n.left);
      if (ts.isIdentifier(left)) {
        entry(left.text).values.push(n.right);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  localsCache.set(scope, locals);
  return locals;
}

/** The body of the function or method that holds n. */
function scopeOf(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p; p = p.parent) {
    if (isFunction(p) || ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p) || ts.isAccessor(p)) {
      return p.body;
    }
  }
  return undefined;
}

/** `[...this.F]` or `this.F.slice()`. */
function isCopy(e: ts.Expression, cx: Context): boolean {
  if (ts.isArrayLiteralExpression(e)) {
    const [only] = e.elements;
    return e.elements.length === 1 && ts.isSpreadElement(only) && cx.isField(only.expression);
  }
  return (
    ts.isCallExpression(e) &&
    e.arguments.length === 0 &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'slice' &&
    cx.isField(e.expression.expression)
  );
}

/** The loop over this.F that directly holds n inside scope, as the element it binds: the for-of variable, the forEach
 *  parameter, or `this.F[i]` of an index loop. Undefined outside such a loop, or with another loop or function between. */
function loopOver(n: ts.Node, scope: ts.Node, cx: Context): Elements | undefined {
  for (let p = n.parent; p && p !== scope; p = p.parent) {
    if (ts.isForOfStatement(p) && cx.isField(p.expression)) {
      return { names: declaredName(p.initializer), isArray: cx.isField };
    }
    if (ts.isForStatement(p) && p.condition && p.initializer && readsLength(p.condition, cx)) {
      const [index] = declaredName(p.initializer);
      return { names: new Set(), isArray: cx.isField, ...(index === undefined ? {} : { index }) };
    }
    if (isFunction(p)) {
      const call = argumentOf(p);
      const callee = call?.expression;
      const overField =
        callee !== undefined &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'forEach' &&
        cx.isField(callee.expression) &&
        call?.arguments[0] === p;
      return overField ? { names: itemName(p), isArray: cx.isField } : undefined;
    }
    if (ts.isIterationStatement(p, false)) {
      return undefined;
    }
  }
  return undefined;
}

/** The name a `const x` or `let i = 0` declaration list binds. */
function declaredName(init: ts.Node): Set<string> {
  const decl = ts.isVariableDeclarationList(init) ? init.declarations[0] : undefined;
  return new Set(decl && ts.isIdentifier(decl.name) ? [decl.name.text] : []);
}

/** `this.F.length` in a for loop's condition. */
function readsLength(cond: ts.Node, cx: Context): boolean {
  const visit = (n: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(n) && n.name.text === 'length' && cx.isField(n.expression)) ||
    ts.forEachChild(n, visit) === true;
  return visit(cond);
}

/** `name.method(…)` calls in scope. */
function callsOn(name: string, method: string, scope: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === method &&
      isNamed(n.expression.expression, name)
    ) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

/** Return values in a function body, not in the functions it holds. */
function returnsOf(body: ts.Block): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression) {
      out.push(n.expression);
    } else if (!isFunction(n)) {
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(body, visit);
  return out;
}

/** The first parameter's name, unless it is destructured. */
function itemName(fn: ts.SignatureDeclarationBase): Set<string> {
  const [p] = fn.parameters;
  return new Set(p && ts.isIdentifier(p.name) ? [p.name.text] : []);
}

function isNamed(e: ts.Expression, name: string): boolean {
  const v = unwrap(e);
  return ts.isIdentifier(v) && v.text === name;
}
