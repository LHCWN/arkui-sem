// Small readers of ohos-typescript nodes shared by the extractor.
import { ts } from './parse.js';

export function decoratorNames(n: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(n) ? ts.getDecorators(n) : undefined;
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
  return e.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(e) && e.text === '$$this');
}

/** `this.<name>` with name an identifier: the member it accesses. */
export function thisMember(n: ts.Node): string | undefined {
  return ts.isPropertyAccessExpression(n) && isThis(n.expression) ? n.name.text : undefined;
}

export function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
}

export function isFunction(n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
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

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ');
}
