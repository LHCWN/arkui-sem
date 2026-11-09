// Where a file instantiates components: `Child({ … })` in build(), @Builder and @LocalBuilder bodies.
import type { ArgumentForm, ComponentArgument, ComponentUse } from '../analysis.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { decoratorNames, isFunction, isThis, isWrapper, memberName, thisMember, unwrap } from './syntax.js';

const STRUCT_BUILDERS = ['@Builder', '@LocalBuilder'];

type Site = Pick<ComponentUse, 'parent' | 'method'>;

/** Instantiations of the names in `components`: other capitalized calls are system components. */
export function componentUses(scan: FileScan, components: Set<string>): ComponentUse[] {
  const out: ComponentUse[] = [];
  const collect = (body: ts.Node, site: Site, methods: Set<string>) => {
    const visit = (n: ts.Node) => {
      if ((ts.isCallExpression(n) || ts.isEtsComponentExpression(n)) && ts.isIdentifier(n.expression)) {
        if (components.has(n.expression.text)) {
          out.push(use(n, n.expression.text, site, methods, scan));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };
  for (const st of scan.sf.statements) {
    if (ts.isStructDeclaration(st) && st.name) {
      const methods = methodNames(st);
      for (const m of st.members) {
        const name = memberName(m.name);
        if (ts.isMethodDeclaration(m) && m.body && name !== undefined && rendersUi(name, m)) {
          collect(m.body, { parent: st.name.text, method: name }, methods);
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name && st.body && decoratorNames(st).includes('@Builder')) {
      collect(st.body, { method: `@Builder ${st.name.text}` }, new Set());
    }
  }
  return out;
}

function rendersUi(name: string, m: ts.MethodDeclaration): boolean {
  return name === 'build' || decoratorNames(m).some((d) => STRUCT_BUILDERS.includes(d));
}

/** The struct's methods and its fields holding a function. */
function methodNames(s: ts.StructDeclaration): Set<string> {
  return new Set(
    s.members.flatMap((m) => {
      const name = memberName(m.name);
      const init = ts.isPropertyDeclaration(m) && m.initializer ? unwrap(m.initializer) : undefined;
      return name !== undefined && (ts.isMethodDeclaration(m) || (init && isFunction(init))) ? [name] : [];
    }),
  );
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
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
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
    return methods.has(member) ? 'callback' : 'this.x';
  }
  return isPathBelowThis(e) ? 'this.x.y' : 'other';
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
