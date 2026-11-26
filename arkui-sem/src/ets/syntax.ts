// Small readers of ohos-typescript nodes shared by the extractor.
import type { Branch, PathSegment } from '../facts.js';
import { ts } from './parse.js';

export function decoratorNames(n: ts.Node): string[] {
  // The parser files a decorator on a function (`@Builder function f`, ArkTS only) as illegal, as plain TypeScript would.
  const decorators = ts.canHaveDecorators(n)
    ? ts.getDecorators(n)
    : ts.isFunctionDeclaration(n)
      ? ts.getIllegalDecorators(n)
      : undefined;
  return (decorators ?? []).flatMap((d) => {
    const e = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return ts.isIdentifier(e) ? [`@${e.text}`] : [];
  });
}

export function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === kind)) || false;
}

export function memberName(name: ts.PropertyName | undefined): string | undefined {
  return name &&
    (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    ? name.text
    : undefined;
}

/** `X`, `a.b.X` or `this.x` as written in an expression; undefined for anything else. */
export function expressionName(e: ts.Expression): string | undefined {
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
export function unwrap(e: ts.Expression): ts.Expression {
  while (isWrapper(e)) {
    e = e.expression;
  }
  return e;
}

/** The values an expression may take: each arm of a conditional apart (`this.ready ? this.F.filter(…) : []`), each
 *  side of a fallback (`this.F ?? []`, `this.F || []`). */
export function armsOf(e: ts.Expression): ts.Expression[] {
  const value = unwrap(e);
  if (ts.isConditionalExpression(value)) {
    return [...armsOf(value.whenTrue), ...armsOf(value.whenFalse)];
  }
  const fallback =
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  return fallback ? [...armsOf(value.left), ...armsOf(value.right)] : [e];
}

/** `null` or `undefined`. */
export function isNullish(expr: ts.Expression): boolean {
  return expr.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined');
}

/** The literal `0`, possibly wrapped: `(0)`, `0 as number`. */
export function isZero(e: ts.Expression): boolean {
  const value = unwrap(e);
  return ts.isNumericLiteral(value) && value.text === '0';
}

/** Parentheses, a cast or a non-null assertion: a value passed through unchanged. */
export function isWrapper(
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

export function isThis(e: ts.Expression): boolean {
  // `$$this.x` is ArkTS two-way binding syntax for `this.x`.
  return e.kind === ts.SyntaxKind.ThisKeyword || isDollarThis(e);
}

/** `x!!`, under any parentheses: V2 two-way binding sugar. */
export function isDoubleBang(value: ts.Expression): boolean {
  const outer = skipParentheses(value);
  return ts.isNonNullExpression(outer) && ts.isNonNullExpression(skipParentheses(outer.expression));
}

/** `$$this.x`: two-way binding of a component's state to a built-in component. */
export function isDollarThis(e: ts.Expression): boolean {
  return ts.isIdentifier(e) && e.text === '$$this';
}

export function skipParentheses(e: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(e) ? skipParentheses(e.expression) : e;
}

/** `this.<name>` with name an identifier: the member it accesses. */
export function thisMember(n: ts.Node): string | undefined {
  return ts.isPropertyAccessExpression(n) && isThis(n.expression) ? n.name.text : undefined;
}

export function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
}

/** A loop whose rows a key generator identifies. */
export function isKeyedLoop(name: string): name is 'ForEach' | 'LazyForEach' {
  return name === 'ForEach' || name === 'LazyForEach';
}

export function isFunction(n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

/** The `if` arms between root and node, outermost first. */
export function branchesOf(node: ts.Node, root: ts.Node, sf: ts.SourceFile): Branch[] {
  const out: Branch[] = [];
  for (let child = node, parent = node.parent; parent && child !== root; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child !== parent.expression) {
      out.unshift({ at: parent.getStart(sf), arm: child === parent.thenStatement ? 'then' : 'else' });
    }
  }
  return out;
}

export function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** An argument of a call or component expression, with the call. */
export function argumentOf(n: ts.Node): ts.CallExpression | ts.EtsComponentExpression | undefined {
  const call = n.parent;
  return (ts.isCallExpression(call) || ts.isEtsComponentExpression(call)) && call.arguments.some((a) => a === n)
    ? call
    : undefined;
}

/** An attribute call: `.name(…)` chained on a component (`Text(…).opacity(…)`, `Column() {…}.width(…)`), not a method of
 *  some object (`Math.max(…)`, `this.calc(…)`). Components are capitalized by ArkUI convention. */
export function onComponent(callee: ts.PropertyAccessExpression): boolean {
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
export function identifiersIn(e: ts.Node): string[] {
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

/** parseDiagnostics is internal to the parser, absent from its public types. */
export function hasParseErrors(sf: ts.SourceFile): boolean {
  return (sf as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length > 0;
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** The property and index path below an expression, and the outermost access: through the nodes `through` accepts
 *  (`!`, or any wrapper). */
export function pathBelow(
  expr: ts.Expression,
  sf: ts.SourceFile,
  through: (n: ts.Node) => n is ts.Expression & { expression: ts.Expression },
): { top: ts.Expression; path: PathSegment[] } {
  const path: PathSegment[] = [];
  let top = expr;
  for (;;) {
    const parent = top.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === top) {
      path.push(parent.questionDotToken ? { prop: parent.name.text, optional: true } : { prop: parent.name.text });
    } else if (ts.isElementAccessExpression(parent) && parent.expression === top) {
      const index = oneLine(parent.argumentExpression.getText(sf));
      path.push(parent.questionDotToken ? { index, optional: true } : { index });
    } else if (!(through(parent) && parent.expression === top)) {
      return { top, path };
    }
    top = parent;
  }
}
