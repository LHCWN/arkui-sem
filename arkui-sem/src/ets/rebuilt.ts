// Element rebuilds: the new objects a write of a field puts where its elements were (WriteFact.rebuilt).
import type { RebuiltElement } from '../facts.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { argumentOf, isFunction, isKeyedLoop, memberName, thisMember, unwrap } from './syntax.js';

type Form = RebuiltElement['form'];

/** One write's search: the field it writes and where its rebuilt elements go. */
interface Search {
  isField(expr: ts.Expression): boolean;
  scan: FileScan;
  out: RebuiltElement[];
}

/** What denotes the old element where a new object is built: names bound to it (a map or loop parameter, a ForEach
 *  item), and `a[index]` of an element array (`this.F`, a copy of it); any index when index is undefined. */
interface Elements {
  names: Set<string>;
  isArray(expr: ts.Expression): boolean;
  index?: string;
}

/** The new objects a write of `field` puts at existing elements' positions. top: the written expression (`this.F`,
 *  `this.F[i]`) or the receiver of a call (`this.F.splice`). */
export function rebuiltElements(field: string, top: ts.Expression, scan: FileScan): RebuiltElement[] {
  const search: Search = { isField: (expr) => thisMember(unwrap(expr)) === field, scan, out: [] };
  const parent = top.parent;
  const target = unwrap(top);
  if (ts.isBinaryExpression(parent) && parent.left === top && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (search.isField(target)) {
      reassigned(parent.right, search);
    } else if (ts.isElementAccessExpression(target) && search.isField(target.expression)) {
      objectsIn(parent.right, elementsAt(target, search.isField, target.argumentExpression), 'index', search);
    }
  } else if (
    ts.isCallExpression(parent) &&
    parent.expression === top &&
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'splice' &&
    search.isField(target.expression)
  ) {
    spliced(parent, search.isField, 'splice', search);
  }
  return search.out;
}

/** `this.F = value`: a map of this.F, or a local array built from this.F (pushed to in a loop over it, or a copy written
 *  at an index). */
function reassigned(value: ts.Expression, search: Search) {
  const assigned = unwrap(value);
  const name = ts.isIdentifier(assigned) ? assigned : undefined;
  const alias = name && local(name);
  const source = alias ? unwrap(alias.value) : assigned;
  const map = mapCallback(source, search);
  if (map) {
    mapped(map, search);
  } else if (name && alias) {
    if (ts.isArrayLiteralExpression(source) && source.elements.length === 0) {
      pushedInLoops(name.text, alias.scope, search);
    } else if (isCopy(source, search)) {
      copyWrites(name.text, alias.scope, search);
    }
  }
}

/** The callback of `this.F.map(cb)`. */
function mapCallback(expr: ts.Expression, search: Search): ts.Expression | undefined {
  return ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'map' &&
    search.isField(expr.expression.expression)
    ? expr.arguments[0]
    : undefined;
}

function mapped(callback: ts.Expression, search: Search) {
  const fn = unwrap(callback);
  if (!isFunction(fn) || !fn.body) {
    return;
  }
  const elements = { names: itemName(fn), isArray: search.isField };
  for (const returned of ts.isBlock(fn.body) ? returnsOf(fn.body) : [fn.body]) {
    objectsIn(returned, elements, 'map', search);
  }
}

/** `out.push(obj)` directly inside a loop over this.F (for-of, an index loop, forEach). A push outside one appends; a
 *  push in a loop nested in it flattens. */
function pushedInLoops(name: string, scope: ts.Node, search: Search) {
  for (const call of callsOn(name, 'push', scope)) {
    const elements = loopOver(call, scope, search);
    if (elements) {
      for (const arg of call.arguments) {
        objectsIn(arg, elements, 'loop', search);
      }
    }
  }
}

/** `copy[i] = obj` and `copy.splice(i, n, obj)` on a copy of this.F. */
function copyWrites(name: string, scope: ts.Node, search: Search) {
  const isArray = (expr: ts.Expression) => search.isField(expr) || isNamed(expr, name);
  const visit = (node: ts.Node) => {
    const left =
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && unwrap(node.left);
    if (left && ts.isElementAccessExpression(left) && isNamed(left.expression, name)) {
      objectsIn(node.right, elementsAt(node, isArray, left.argumentExpression), 'copy-index', search);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  for (const call of callsOn(name, 'splice', scope)) {
    spliced(call, isArray, 'copy-index', search);
  }
}

/** `a.splice(start, n, …items)`: the first n items replace elements from start on. */
function spliced(call: ts.CallExpression, isArray: (expr: ts.Expression) => boolean, form: Form, search: Search) {
  const [start, count] = call.arguments.map(unwrap);
  const replaced = count && ts.isNumericLiteral(count) ? Number(count.text) : 0;
  for (const item of call.arguments.slice(2, 2 + replaced)) {
    objectsIn(item, elementsAt(call, isArray, replaced === 1 ? start : undefined), form, search);
  }
}

/** For a write at an index: the element is `a[index]` of the arrays, or the item of a ForEach row over them that holds
 *  the write. */
function elementsAt(at: ts.Node, isArray: (expr: ts.Expression) => boolean, index?: ts.Expression): Elements {
  const names = new Set<string>();
  for (let node = at.parent; node; node = node.parent) {
    if (!isFunction(node)) {
      continue;
    }
    const call = argumentOf(node);
    const [source, row] = call?.arguments ?? [];
    if (
      call &&
      ts.isIdentifier(call.expression) &&
      isKeyedLoop(call.expression.text) &&
      row === node &&
      isArray(source)
    ) {
      for (const name of itemName(node)) {
        names.add(name);
      }
    }
  }
  return { names, isArray, ...(index ? { index: unwrap(index).getText() } : {}) };
}

/** The objects an expression evaluates to, through conditionals and single-assignment locals. */
function objectsIn(expr: ts.Expression, elements: Elements, form: Form, search: Search, depth = 0) {
  const value = unwrap(expr);
  if (ts.isConditionalExpression(value)) {
    objectsIn(value.whenTrue, elements, form, search, depth);
    objectsIn(value.whenFalse, elements, form, search, depth);
  } else if (ts.isIdentifier(value)) {
    const alias = elements.names.has(value.text) || depth > 2 ? undefined : local(value);
    if (alias) {
      objectsIn(alias.value, elements, form, search, depth + 1);
    }
  } else {
    const fact = objectFact(value, elements);
    if (fact) {
      search.out.push({ line: search.scan.line(value), form, ...fact });
    }
  }
}

function objectFact(expr: ts.Expression, elements: Elements): Omit<RebuiltElement, 'line' | 'form'> | undefined {
  if (ts.isNewExpression(expr)) {
    return { value: 'new', kept: [], changed: [], keepsRest: false };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return { value: 'object-literal', ...laidOver([expr], expr, elements) };
  }
  // Object.assign({}, a, b, …): a new object with the properties of a, then b, …
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    isNamed(expr.expression.expression, 'Object') &&
    expr.expression.name.text === 'assign'
  ) {
    const [target, ...sources] = expr.arguments.map(unwrap);
    if (target && ts.isObjectLiteralExpression(target) && target.properties.length === 0) {
      return { value: 'object-literal', ...laidOver(sources, expr, elements) };
    }
  }
  return undefined;
}

/** The kept and changed properties of an object built from parts in order: object literals, whose own spreads count
 *  in place, and other objects copied whole. A copy of the element keeps every property set before it. base: where the
 *  object sits below the element, for a literal nested in another (`cell: { ...e.cell, title: … }` changes
 *  `cell.title` only). */
function laidOver(
  parts: ts.Expression[],
  at: ts.Node,
  elements: Elements,
  base: string[] = [],
): Pick<RebuiltElement, 'kept' | 'changed' | 'keepsRest'> {
  let keepsRest = false;
  // Per property: the paths below the element it keeps and the ones it changes.
  const props = new Map<string, Pick<RebuiltElement, 'kept' | 'changed'>>();
  const keptWhole = (name: string) => ({ kept: [[...base, name].join('.')], changed: [] });
  let guards: Map<string, string> | undefined;
  const guarded = () => {
    guards ??= base.length === 0 ? guardsAt(at, elements) : new Map();
    return guards;
  };
  const copy = (expr: ts.Expression) => {
    if (samePath(pathBelowElement(expr, elements), base)) {
      keepsRest = true;
      for (const name of props.keys()) {
        props.set(name, keptWhole(name));
      }
    }
  };
  const set = (name: string, value: ts.Expression) => {
    const path = [...base, name];
    const given = unwrap(value);
    if (samePath(pathBelowElement(given, elements), path) || guarded().get(name) === given.getText()) {
      props.set(name, keptWhole(name));
    } else if (ts.isObjectLiteralExpression(given)) {
      const inner = laidOver([given], at, elements, path);
      // Without a copy of the old object, what the literal doesn't keep is gone.
      const changed = inner.keepsRest ? inner.changed : [path.join('.')];
      props.set(name, changed.length ? { kept: inner.kept, changed } : keptWhole(name));
    } else {
      props.set(name, { kept: [], changed: [path.join('.')] });
    }
  };
  for (const part of parts) {
    if (!ts.isObjectLiteralExpression(part)) {
      copy(part);
      continue;
    }
    for (const prop of part.properties) {
      if (ts.isSpreadAssignment(prop)) {
        copy(prop.expression);
      } else if (ts.isPropertyAssignment(prop)) {
        const name = memberName(prop.name);
        if (name !== undefined) {
          set(name, prop.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        set(prop.name.text, prop.name);
      }
    }
  }
  const entries = [...props];
  return {
    kept: entries.flatMap(([, value]) => value.kept),
    changed: entries.flatMap(([, value]) => value.changed),
    keepsRest,
  };
}

/** The properties below the element an expression reads: [] for the element, ['cell'] for `e.cell`. */
function pathBelowElement(expr: ts.Expression, elements: Elements): string[] | undefined {
  const value = unwrap(expr);
  if (ts.isPropertyAccessExpression(value)) {
    const owner = pathBelowElement(value.expression, elements);
    return owner && [...owner, value.name.text];
  }
  return isElement(value, elements) ? [] : undefined;
}

function samePath(a: string[] | undefined, b: string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((name, i) => name === b[i]);
}

/** The element's property values the code holding a node has checked: `e.p === X` (or `==`) in an enclosing `if` or
 *  `?:`, an else branch of `!==`, or an earlier `if (e.p !== X) return …` in an enclosing block. Property → X as
 *  written. */
function guardsAt(at: ts.Node, elements: Elements): Map<string, string> {
  const out = new Map<string, string>();
  const add = (cond: ts.Expression, holds: boolean) => {
    for (const [prop, value] of equalities(cond, holds, elements)) {
      out.set(prop, value);
    }
  };
  for (let node = at; node.parent && !isFunction(node) && !ts.isMethodDeclaration(node); node = node.parent) {
    const parent = node.parent;
    if (ts.isConditionalExpression(parent) && node !== parent.condition) {
      add(parent.condition, node === parent.whenTrue);
    } else if (ts.isIfStatement(parent) && node !== parent.expression) {
      add(parent.expression, node === parent.thenStatement);
    } else if (ts.isBlock(parent)) {
      for (const earlier of parent.statements.slice(0, parent.statements.indexOf(node as ts.Statement))) {
        if (ts.isIfStatement(earlier) && !earlier.elseStatement && exits(earlier.thenStatement)) {
          add(earlier.expression, false);
        }
      }
    }
  }
  return out;
}

/** `e.p === X` terms that hold when cond is `holds`: an `&&` chain of `===` when true, a single `!==` when false. */
function equalities(cond: ts.Expression, holds: boolean, elements: Elements): [string, string][] {
  const test = unwrap(cond);
  if (!ts.isBinaryExpression(test)) {
    return [];
  }
  const operator = test.operatorToken.kind;
  if (holds && operator === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...equalities(test.left, true, elements), ...equalities(test.right, true, elements)];
  }
  const equal = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
  const unequal =
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
  if (!(holds ? equal : unequal)) {
    return [];
  }
  const out: [string, string][] = [];
  for (const [side, other] of [
    [test.left, test.right],
    [test.right, test.left],
  ]) {
    const read = unwrap(side);
    if (ts.isPropertyAccessExpression(read) && isElement(read.expression, elements)) {
      out.push([read.name.text, unwrap(other).getText()]);
    }
  }
  return out;
}

/** A statement that always leaves the block: a return, a continue, or a block ending in one. */
function exits(statement: ts.Statement): boolean {
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && exits(last);
  }
  return ts.isReturnStatement(statement) || ts.isContinueStatement(statement);
}

/** expr is the old element: a name bound to it, `a[index]` of an element array, or a local assigned once from either. */
function isElement(expr: ts.Expression, elements: Elements, depth = 0): boolean {
  const value = unwrap(expr);
  if (ts.isIdentifier(value)) {
    if (elements.names.has(value.text)) {
      return true;
    }
    const alias = depth > 2 ? undefined : local(value);
    return alias !== undefined && isElement(alias.value, elements, depth + 1);
  }
  return (
    ts.isElementAccessExpression(value) &&
    elements.isArray(value.expression) &&
    (elements.index === undefined || unwrap(value.argumentExpression).getText() === elements.index)
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
    const found = locals.get(name) ?? { declarations: [], values: [] };
    locals.set(name, found);
    return found;
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && scopeOf(node) === scope) {
      const found = entry(node.name.text);
      found.declarations.push(node);
      if (node.initializer) {
        found.values.push(node.initializer);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) {
        entry(left.text).values.push(node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  localsCache.set(scope, locals);
  return locals;
}

/** The body of the function or method that holds a node. */
function scopeOf(at: ts.Node): ts.Node | undefined {
  for (let node = at.parent; node; node = node.parent) {
    if (isFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isAccessor(node)) {
      return node.body;
    }
  }
  return undefined;
}

/** `[...this.F]` or `this.F.slice()`. */
function isCopy(expr: ts.Expression, search: Search): boolean {
  if (ts.isArrayLiteralExpression(expr)) {
    const [only] = expr.elements;
    return expr.elements.length === 1 && ts.isSpreadElement(only) && search.isField(only.expression);
  }
  return (
    ts.isCallExpression(expr) &&
    expr.arguments.length === 0 &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'slice' &&
    search.isField(expr.expression.expression)
  );
}

/** The loop over this.F that directly holds a node inside scope, as the element it binds: the for-of variable, the
 *  forEach parameter, or `this.F[i]` of an index loop. Undefined outside such a loop, or with another loop or function
 *  between. */
function loopOver(at: ts.Node, scope: ts.Node, search: Search): Elements | undefined {
  for (let node = at.parent; node && node !== scope; node = node.parent) {
    if (ts.isForOfStatement(node) && search.isField(node.expression)) {
      return { names: declaredName(node.initializer), isArray: search.isField };
    }
    if (ts.isForStatement(node) && node.condition && node.initializer && readsLength(node.condition, search)) {
      const [index] = declaredName(node.initializer);
      return { names: new Set(), isArray: search.isField, ...(index === undefined ? {} : { index }) };
    }
    if (isFunction(node)) {
      const call = argumentOf(node);
      const callee = call?.expression;
      const overField =
        callee !== undefined &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'forEach' &&
        search.isField(callee.expression) &&
        call?.arguments[0] === node;
      return overField ? { names: itemName(node), isArray: search.isField } : undefined;
    }
    if (ts.isIterationStatement(node, false)) {
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
function readsLength(cond: ts.Node, search: Search): boolean {
  const visit = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === 'length' && search.isField(node.expression)) ||
    ts.forEachChild(node, visit) === true;
  return visit(cond);
}

/** `name.method(…)` calls in scope. */
function callsOn(name: string, method: string, scope: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method &&
      isNamed(node.expression.expression, name)
    ) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return out;
}

/** Return values in a function body, not in the functions it holds. */
function returnsOf(body: ts.Block): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      out.push(node.expression);
    } else if (!isFunction(node)) {
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(body, visit);
  return out;
}

/** The first parameter's name, unless it is destructured. */
function itemName(fn: ts.SignatureDeclarationBase): Set<string> {
  const [param] = fn.parameters;
  return new Set(param && ts.isIdentifier(param.name) ? [param.name.text] : []);
}

function isNamed(expr: ts.Expression, name: string): boolean {
  const value = unwrap(expr);
  return ts.isIdentifier(value) && value.text === name;
}
