// Where a file instantiates components: `Child({ … })` in build(), @Builder and @LocalBuilder bodies and field initializers.
import type { ArgumentForm, ComponentArgument, ComponentUse } from '../analysis.js';
import { methodsOf, rendersUi } from './component.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { decoratorNames, isFunction, isThis, isWrapper, memberName, thisMember, unwrap } from './syntax.js';

type Site = Pick<ComponentUse, 'parent' | 'method'>;

/** Calls of the names in `callable`, the file's components and imports, which leaves out system components. */
export function componentUses(scan: FileScan, callable: Set<string>): ComponentUse[] {
  const out: ComponentUse[] = [];
  const collect = (body: ts.Node, site: Site, methods: Set<string>) => {
    const visit = (n: ts.Node) => {
      if ((ts.isCallExpression(n) || ts.isEtsComponentExpression(n)) && ts.isIdentifier(n.expression)) {
        if (callable.has(n.expression.text)) {
          out.push(use(n, n.expression.text, site, methods, scan));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };
  for (const st of scan.sf.statements) {
    if (ts.isStructDeclaration(st) && st.name) {
      const parent = st.name.text;
      const methods = methodsOf(st);
      const names = new Set(methods.map((m) => m.name));
      for (const m of methods.filter(rendersUi)) {
        collect(m.body, { parent, method: m.name }, names);
      }
      for (const m of st.members) {
        const field = memberName(m.name);
        if (ts.isPropertyDeclaration(m) && m.initializer && field !== undefined) {
          collect(m.initializer, { parent, method: field }, names);
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name && st.body && decoratorNames(st).includes('@Builder')) {
      collect(st.body, { method: `@Builder ${st.name.text}` }, new Set());
    }
  }
  return out;
}

function use(
  call: ts.CallExpression | ts.EtsComponentExpression,
  child: string,
  site: Site,
  methods: Set<string>,
  scan: FileScan,
): ComponentUse {
  const base = { child, ...site, line: scan.line(call) };
  const [first] = call.arguments;
  if (first === undefined) {
    return { ...base, args: [] };
  }
  const literal = unwrap(first);
  if (!ts.isObjectLiteralExpression(literal)) {
    return { ...base, args: [], opaqueArgs: true };
  }
  const args: ComponentArgument[] = [];
  let opaqueArgs = false;
  for (const p of literal.properties) {
    const field = ts.isSpreadAssignment(p) ? undefined : memberName(p.name);
    if (field === undefined) {
      opaqueArgs = true;
    } else {
      args.push({ field, line: scan.line(p), ...argumentValue(p, methods, scan) });
    }
  }
  return { ...base, args, ...(opaqueArgs ? { opaqueArgs } : {}) };
}

function argumentValue(
  p: ts.ObjectLiteralElementLike,
  methods: Set<string>,
  scan: FileScan,
): Pick<ComponentArgument, 'form' | 'text'> {
  if (ts.isPropertyAssignment(p)) {
    return { form: formOf(p.initializer, methods), text: scan.text(p.initializer) };
  }
  if (ts.isShorthandPropertyAssignment(p)) {
    return { form: formOf(p.name, methods), text: scan.text(p.name) };
  }
  return { form: ts.isMethodDeclaration(p) ? 'callback' : 'other', text: scan.text(p) };
}

function formOf(value: ts.Expression, methods: Set<string>): ArgumentForm {
  const e = unwrap(value);
  if (isLiteral(e)) {
    return 'literal';
  }
  if (isFunction(e)) {
    return 'callback';
  }
  if (ts.isIdentifier(e)) {
    return /^\$[^$]/.test(e.text) ? '$x' : 'other';
  }
  if (ts.isCallExpression(e)) {
    return isBoundMethod(e, methods) ? 'callback' : 'other';
  }
  const member = thisMember(e);
  if (member !== undefined) {
    if (methods.has(member)) {
      return 'callback';
    }
    return isTwoWay(value) ? 'this.x!!' : 'this.x';
  }
  return isPathBelowThis(e) ? 'this.x.y' : 'other';
}

/** `x!!`, under any parentheses: V2 two-way binding sugar. */
function isTwoWay(value: ts.Expression): boolean {
  const skipParens = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? skipParens(e.expression) : e;
  const outer = skipParens(value);
  return ts.isNonNullExpression(outer) && ts.isNonNullExpression(skipParens(outer.expression));
}

function isLiteral(e: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand))
  );
}

function isBoundMethod(call: ts.CallExpression, methods: Set<string>): boolean {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'bind') {
    return false;
  }
  const member = thisMember(unwrap(callee.expression));
  return member !== undefined && methods.has(member);
}

function isPathBelowThis(e: ts.Expression): boolean {
  let n = e;
  while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || isWrapper(n)) {
    n = n.expression;
  }
  return n !== e && isThis(n);
}
