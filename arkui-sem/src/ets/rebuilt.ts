// Element rebuilds: the new objects a write of a field puts where its elements were (WriteFact.rebuilt).
import type { RebuiltElement } from '../facts.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { argumentOf, isFunction, memberName, thisMember, unwrap } from './syntax.js';

const LOOPS = new Set(['ForEach', 'LazyForEach']);

type Form = RebuiltElement['form'];

/** What denotes the old element where a new object is built: names bound to it (a map or loop parameter, a ForEach
 *  item), and arrays whose `a[i]` is one (`this.F`, a copy of it). */
interface Elements {
  names: Set<string>;
  isArray(e: ts.Expression): boolean;
}

/** The new objects a write of `field` puts at existing elements' positions. top: the written expression (`this.F`,
 *  `this.F[i]`) or the receiver of a call (`this.F.splice`). */
export function rebuiltElements(field: string, top: ts.Expression, scan: FileScan): RebuiltElement[] {
  const isField = (e: ts.Expression) => thisMember(unwrap(e)) === field;
  const out: RebuiltElement[] = [];
  const parent = top.parent;
  if (ts.isBinaryExpression(parent) && parent.left === top && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = unwrap(top);
    if (isField(target)) {
      reassigned(parent.right, isField, scan, out);
    } else if (ts.isElementAccessExpression(target) && isField(target.expression)) {
      objectsIn(parent.right, positional(top, isField), 'index', scan, out);
    }
  } else if (
    ts.isCallExpression(parent) &&
    parent.expression === top &&
    ts.isPropertyAccessExpression(top) &&
    top.name.text === 'splice' &&
    isField(top.expression)
  ) {
    spliced(parent, positional(top, isField), 'splice', scan, out);
  }
  return out;
}

/** `this.F = value`: a map of this.F, or a local array built from this.F (pushed to in a loop over it, or a copy written
 *  at an index). */
function reassigned(
  value: ts.Expression,
  isField: (e: ts.Expression) => boolean,
  scan: FileScan,
  out: RebuiltElement[],
) {
  const v = unwrap(value);
  const alias = ts.isIdentifier(v) ? local(v) : undefined;
  const source = alias ? unwrap(alias.value) : v;
  const map = mapOf(source, isField);
  if (map) {
    mapped(map, isField, scan, out);
  } else if (alias && ts.isIdentifier(v)) {
    if (ts.isArrayLiteralExpression(source) && source.elements.length === 0) {
      pushedInLoops(v.text, alias.scope, isField, scan, out);
    } else if (isCopy(source, isField)) {
      copyWrites(v.text, alias.scope, isField, scan, out);
    }
  }
}

/** The callback of `this.F.map(cb)`. */
function mapOf(e: ts.Expression, isField: (e: ts.Expression) => boolean): ts.Expression | undefined {
  return ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'map' &&
    isField(e.expression.expression)
    ? e.arguments[0]
    : undefined;
}

function mapped(cb: ts.Expression, isField: (e: ts.Expression) => boolean, scan: FileScan, out: RebuiltElement[]) {
  const fn = unwrap(cb);
  if (!isFunction(fn) || !fn.body) {
    return;
  }
  const elements = { names: paramNames(fn), isArray: isField };
  const returned = ts.isBlock(fn.body) ? returnsOf(fn.body) : [fn.body];
  for (const e of returned) {
    objectsIn(e, elements, 'map', scan, out);
  }
}

/** `copy.push(obj)` inside a loop over this.F (for-of, an index loop, forEach). A push outside one appends. */
function pushedInLoops(
  name: string,
  scope: ts.Node,
  isField: (e: ts.Expression) => boolean,
  scan: FileScan,
  out: RebuiltElement[],
) {
  for (const call of callsOn(name, 'push', scope)) {
    const names = loopOver(call, scope, isField);
    if (names) {
      for (const arg of call.arguments) {
        objectsIn(arg, { names, isArray: isField }, 'loop', scan, out);
      }
    }
  }
}

/** `copy[i] = obj` and `copy.splice(i, n, obj)` on a copy of this.F. */
function copyWrites(
  name: string,
  scope: ts.Node,
  isField: (e: ts.Expression) => boolean,
  scan: FileScan,
  out: RebuiltElement[],
) {
  const isArray = (e: ts.Expression) => isField(e) || isNamed(e, name);
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(unwrap(n.left)) &&
      isNamed((unwrap(n.left) as ts.ElementAccessExpression).expression, name)
    ) {
      objectsIn(n.right, { names: forEachItems(n, isField), isArray }, 'copy-index', scan, out);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  for (const call of callsOn(name, 'splice', scope)) {
    spliced(call, { names: forEachItems(call, isField), isArray }, 'copy-index', scan, out);
  }
}

/** `a.splice(start, n, …items)`: the first n items replace elements. */
function spliced(call: ts.CallExpression, elements: Elements, form: Form, scan: FileScan, out: RebuiltElement[]) {
  const count = call.arguments[1] && unwrap(call.arguments[1]);
  const n = count && ts.isNumericLiteral(count) ? Number(count.text) : 0;
  for (const item of call.arguments.slice(2, 2 + n)) {
    objectsIn(item, elements, form, scan, out);
  }
}

/** For a write at an index of this.F or of its copy: the item of a ForEach over this.F that holds the write. */
function positional(at: ts.Node, isField: (e: ts.Expression) => boolean): Elements {
  return { names: forEachItems(at, isField), isArray: isField };
}

/** The objects an expression evaluates to, through conditionals and single-assignment locals. */
function objectsIn(e: ts.Expression, elements: Elements, form: Form, scan: FileScan, out: RebuiltElement[], depth = 0) {
  const v = unwrap(e);
  if (ts.isConditionalExpression(v)) {
    objectsIn(v.whenTrue, elements, form, scan, out, depth);
    objectsIn(v.whenFalse, elements, form, scan, out, depth);
    return;
  }
  if (ts.isIdentifier(v)) {
    const l = elements.names.has(v.text) || depth > 2 ? undefined : local(v);
    if (l) {
      objectsIn(l.value, elements, form, scan, out, depth + 1);
    }
    return;
  }
  const fact = objectFact(v, elements);
  if (fact) {
    out.push({ line: scan.line(v), form, ...fact });
  }
}

function objectFact(e: ts.Expression, elements: Elements): Omit<RebuiltElement, 'line' | 'form'> | undefined {
  if (ts.isNewExpression(e)) {
    return { value: 'new', kept: [], changed: [], keepsRest: false };
  }
  const guards = guardsAt(e, elements);
  if (ts.isObjectLiteralExpression(e)) {
    return { value: 'object-literal', ...literalProps([e], [], elements, guards) };
  }
  // Object.assign({}, e, { … }): a new object with the element's properties, then the literal's.
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === 'Object' &&
    e.expression.name.text === 'assign'
  ) {
    const [target, ...sources] = e.arguments.map(unwrap);
    if (target && ts.isObjectLiteralExpression(target) && target.properties.length === 0) {
      const literals = sources.filter(ts.isObjectLiteralExpression);
      const spread = sources.filter((s) => !ts.isObjectLiteralExpression(s));
      return { value: 'object-literal', ...literalProps(literals, spread, elements, guards) };
    }
  }
  return undefined;
}

/** The kept and changed properties of literals laid over the spread sources, in order. */
function literalProps(
  literals: ts.ObjectLiteralExpression[],
  spread: ts.Expression[],
  elements: Elements,
  guards: Map<string, string>,
): Pick<RebuiltElement, 'kept' | 'changed' | 'keepsRest'> {
  let keepsRest = spread.some((s) => isElement(s, elements));
  const kept = new Set<string>();
  const changed = new Set<string>();
  const set = (name: string, keeps: boolean) => {
    kept.delete(name);
    changed.delete(name);
    (keeps ? kept : changed).add(name);
  };
  for (const p of literals.flatMap((l) => [...l.properties])) {
    if (ts.isSpreadAssignment(p)) {
      keepsRest ||= isElement(p.expression, elements);
    } else if (ts.isPropertyAssignment(p)) {
      const name = memberName(p.name);
      if (name !== undefined) {
        set(name, keepsValue(name, p.initializer, elements, guards));
      }
    } else if (ts.isShorthandPropertyAssignment(p)) {
      set(p.name.text, guards.get(p.name.text) === p.name.text);
    }
  }
  return { kept: [...kept], changed: [...changed], keepsRest };
}

/** `p: e.p`, or `p: X` under a guard `e.p === X`. */
function keepsValue(name: string, value: ts.Expression, elements: Elements, guards: Map<string, string>): boolean {
  const v = unwrap(value);
  if (ts.isPropertyAccessExpression(v) && v.name.text === name && isElement(v.expression, elements)) {
    return true;
  }
  return guards.get(name) === v.getText();
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

/** e is the old element: a name bound to it, `a[i]` of an element array, or a local assigned once from either. */
function isElement(e: ts.Expression, elements: Elements, depth = 0): boolean {
  const v = unwrap(e);
  if (ts.isIdentifier(v)) {
    if (elements.names.has(v.text)) {
      return true;
    }
    const l = depth > 2 ? undefined : local(v);
    return l !== undefined && isElement(l.value, elements, depth + 1);
  }
  return ts.isElementAccessExpression(v) && elements.isArray(v.expression);
}

/** A local `const`/`let` given one value (its initializer, or one later assignment), with the function body that
 *  declares it. */
function local(id: ts.Identifier): { value: ts.Expression; scope: ts.Node } | undefined {
  const scope = scopeOf(id);
  if (!scope) {
    return undefined;
  }
  const declarations: ts.VariableDeclaration[] = [];
  const values: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text && scopeOf(n) === scope) {
      declarations.push(n);
      if (n.initializer) {
        values.push(n.initializer);
      }
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isNamed(n.left, id.text)
    ) {
      values.push(n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  const [decl] = declarations;
  const blockScoped = decl && (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) !== 0;
  return declarations.length === 1 && blockScoped && values.length === 1 ? { value: values[0], scope } : undefined;
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
function isCopy(e: ts.Expression, isField: (e: ts.Expression) => boolean): boolean {
  if (ts.isArrayLiteralExpression(e)) {
    const [only] = e.elements;
    return e.elements.length === 1 && ts.isSpreadElement(only) && isField(only.expression);
  }
  return (
    ts.isCallExpression(e) &&
    e.arguments.length === 0 &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'slice' &&
    isField(e.expression.expression)
  );
}

/** The loop over this.F that holds n inside scope, as the names bound to its element (none for an index loop, whose
 *  `this.F[i]` the element arrays cover); undefined outside such a loop. */
function loopOver(n: ts.Node, scope: ts.Node, isField: (e: ts.Expression) => boolean): Set<string> | undefined {
  for (let p = n.parent; p && p !== scope; p = p.parent) {
    if (ts.isForOfStatement(p) && isField(p.expression)) {
      const init = p.initializer;
      const decl = ts.isVariableDeclarationList(init) ? init.declarations[0] : undefined;
      return new Set(decl && ts.isIdentifier(decl.name) ? [decl.name.text] : []);
    }
    if (ts.isForStatement(p) && p.condition && readsLength(p.condition, isField)) {
      return new Set();
    }
    if (isFunction(p)) {
      const call = argumentOf(p);
      const callee = call && ts.isCallExpression(call) ? call.expression : undefined;
      if (
        callee &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'forEach' &&
        isField(callee.expression) &&
        call?.arguments[0] === p
      ) {
        return paramNames(p, 1);
      }
    }
  }
  return undefined;
}

/** `this.F.length` in a for loop's condition. */
function readsLength(cond: ts.Node, isField: (e: ts.Expression) => boolean): boolean {
  const visit = (n: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(n) && n.name.text === 'length' && isField(n.expression)) ||
    ts.forEachChild(n, visit) === true;
  return visit(cond);
}

/** The item parameters of the ForEach or LazyForEach rows over this.F that hold n. */
function forEachItems(n: ts.Node, isField: (e: ts.Expression) => boolean): Set<string> {
  const out = new Set<string>();
  for (let p = n.parent; p; p = p.parent) {
    if (!isFunction(p)) {
      continue;
    }
    const call = argumentOf(p);
    const [source, row] = call?.arguments ?? [];
    if (call && ts.isIdentifier(call.expression) && LOOPS.has(call.expression.text) && row === p && isField(source)) {
      for (const name of paramNames(p, 1)) {
        out.add(name);
      }
    }
  }
  return out;
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

function paramNames(fn: ts.SignatureDeclarationBase, count = 1): Set<string> {
  return new Set(fn.parameters.slice(0, count).flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
}

function isNamed(e: ts.Expression, name: string): boolean {
  const v = unwrap(e);
  return ts.isIdentifier(v) && v.text === name;
}
